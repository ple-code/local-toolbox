import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { readdir, readFile as readFileText } from "node:fs/promises";

export const DEFAULT_URL = "https://time.geekbang.org/column/article/999533?screen=full";
const DEFAULT_CHROME_MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_USER_AGENT = process.env.CHROME_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DEFAULT_ACCEPT_LANGUAGE = process.env.CHROME_ACCEPT_LANGUAGE || "zh-CN,zh;q=0.9,en;q=0.8";

export class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener("message", (event) => this.#onMessage(event));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to Chrome DevTools.")), 10000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Failed to connect to Chrome DevTools."));
      }, { once: true });
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        method
      });
    });
  }

  once(method, predicate = () => true, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      const handler = (message) => {
        if (!predicate(message)) {
          return;
        }
        cleanup();
        resolve(message);
      };

      const cleanup = () => {
        clearTimeout(timer);
        const handlers = this.listeners.get(method) || [];
        this.listeners.set(method, handlers.filter((item) => item !== handler));
      };

      const handlers = this.listeners.get(method) || [];
      handlers.push(handler);
      this.listeners.set(method, handlers);
    });
  }

  close() {
    this.ws?.close();
  }

  #onMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const handlers = this.listeners.get(message.method) || [];
    for (const handler of handlers) {
      handler(message);
    }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomDelayMs(minMs = 5000, maxMs = 15000) {
  const min = Math.max(0, Math.floor(minMs));
  const max = Math.max(min, Math.floor(maxMs));
  return min + Math.floor(Math.random() * (max - min + 1));
}

export function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    throw new Error("URL is empty.");
  }
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return new URL(withProtocol).toString();
}

export function parseUrlList(textOrList) {
  const values = Array.isArray(textOrList)
    ? textOrList
    : String(textOrList || "").split(/[\n,]+/);
  const urls = values.map((value) => String(value).trim()).filter(Boolean).map(normalizeUrl);
  return Array.from(new Set(urls));
}

export function pdfFilenameForUrl(url, used = new Set()) {
  const parsed = new URL(url);
  const articleId = parsed.pathname.split("/").filter(Boolean).at(-1) || "page";
  const host = parsed.hostname.replace(/^www\./, "");
  const base = `${host}-${articleId}`
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "page";

  let name = `${base}.pdf`;
  let counter = 2;
  while (used.has(name)) {
    name = `${base}-${counter}.pdf`;
    counter += 1;
  }
  used.add(name);
  return name;
}

export function defaultOutputFor(url) {
  return path.join("output", pdfFilenameForUrl(url));
}

export function ensureChromePath() {
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }
  if (process.platform === "darwin") {
    return DEFAULT_CHROME_MAC;
  }
  if (process.platform === "win32") {
    return "chrome.exe";
  }
  return "chromium-browser";
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function waitForChrome(port, timeoutMs = 20000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Chrome DevTools did not become ready. ${lastError?.message || ""}`.trim());
}

async function createDevtoolsTab(port, url = "about:blank") {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      method: "PUT",
      hostname: "127.0.0.1",
      port,
      path: `/json/new?${url.replaceAll("#", "%23")}`
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Chrome failed to create a tab: HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Chrome returned invalid tab JSON: ${error.message}`));
        }
      });
    });
    req.setTimeout(5000, () => {
      req.destroy(new Error("Chrome tab creation timed out."));
    });
    req.on("error", reject);
    req.end();
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 3000) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs)
  });
}

async function killChromeUsingProfile(profileDir) {
  if (process.platform !== "linux") {
    return;
  }
  const normalizedProfile = path.resolve(profileDir);
  const entries = await readdir("/proc", { withFileTypes: true }).catch(() => []);
  const currentPid = String(process.pid);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name) || entry.name === currentPid) {
      continue;
    }
    const cmdline = await readFileText(`/proc/${entry.name}/cmdline`, "utf8").catch(() => "");
    if (!cmdline.includes("chrome") || !cmdline.includes(`--user-data-dir=${normalizedProfile}`)) {
      continue;
    }
    try {
      process.kill(Number(entry.name), "SIGTERM");
    } catch {
      // The process may have exited between reading /proc and sending the signal.
    }
  }
  await sleep(800);
}

export async function navigateAndWait(cdp, sessionId, url, waitMs) {
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);

  const loaded = cdp.once(
    "Page.loadEventFired",
    (message) => message.sessionId === sessionId,
    45000
  ).catch(() => undefined);

  await cdp.send("Page.navigate", { url }, sessionId);
  await loaded;
  await sleep(waitMs);
}

export async function navigateAndPause(cdp, sessionId, url, waitMs) {
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  const ready = cdp.once(
    "Page.domContentEventFired",
    (message) => message.sessionId === sessionId,
    Math.max(3000, waitMs + 1500)
  ).catch(() => undefined);
  await cdp.send("Page.navigate", { url }, sessionId);
  await Promise.race([ready, sleep(Math.max(1500, waitMs))]);
}

async function waitForDocumentReady(cdp, sessionId, timeoutMs, expectedUrl) {
  const expectedHost = expectedUrl ? new URL(expectedUrl).hostname : undefined;
  const matchesExpectedHost = (currentUrl) => {
    if (!expectedHost) {
      return true;
    }
    try {
      return new URL(currentUrl).hostname === expectedHost;
    } catch {
      return false;
    }
  };
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `({
          readyState: document.readyState,
          url: location.href,
          title: document.title,
          textLength: (document.body?.innerText || '').trim().length
        })`
      }, sessionId, 5000);
      const value = result.result.value;
      const ready = value.readyState === "interactive" || value.readyState === "complete";
      const hasNavigated = !expectedUrl ||
        (value.url && value.url !== "about:blank" && matchesExpectedHost(value.url));
      if (ready && hasNavigated) {
        return value;
      }
    } catch {
      // The page may still be creating its execution context.
    }
    await sleep(250);
  }
  return undefined;
}

export async function preparePageForPdf(cdp, sessionId) {
  const result = await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise(async (resolve) => {
      const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
      const random = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
      const pageHeight = () => Math.max(
        document.body?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0
      );
      const isVisible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 80 &&
          rect.height > 80 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || 1) > 0;
      };
      const canScroll = (node) => {
        const style = getComputedStyle(node);
        const overflow = \`\${style.overflowY} \${style.overflow}\`;
        return /(auto|scroll|overlay)/.test(overflow) &&
          node.scrollHeight > node.clientHeight + Math.max(240, window.innerHeight * 0.25) &&
          isVisible(node);
      };
      const scrollables = Array.from(document.querySelectorAll('body *'))
        .filter(canScroll)
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))
        .slice(0, 3);

      const targets = [
        {
          kind: 'window',
          top: () => window.scrollY,
          maxTop: () => Math.max(0, pageHeight() - window.innerHeight),
          scrollTo: (top) => window.scrollTo({ top, behavior: 'auto' })
        },
        ...scrollables.map((node, index) => {
          node.setAttribute('data-html2pdf-scroll-root', String(index + 1));
          return {
            kind: 'element',
            node,
            top: () => node.scrollTop,
            maxTop: () => Math.max(0, node.scrollHeight - node.clientHeight),
            scrollTo: (top) => { node.scrollTop = top; }
          };
        })
      ];

      for (const target of targets) {
        let lastTop = -1;
        let stillCount = 0;
        let nextLongPause = random(4, 8);
        for (let stepIndex = 0; stepIndex < 180; stepIndex += 1) {
          const top = target.top();
          const maxTop = target.maxTop();
          if (maxTop <= 8 || top >= maxTop - 8) {
            stillCount += 1;
            await sleep(random(260, 620));
            if (stillCount >= 2) {
              break;
            }
          } else {
            const delta = Math.min(random(320, 820), maxTop - top);
            target.scrollTo(top + delta);
            await sleep(random(160, 520));
          }

          const currentTop = target.top();
          if (Math.abs(currentTop - lastTop) < 2) {
            stillCount += 1;
          } else {
            stillCount = 0;
          }
          lastTop = currentTop;

          if (stepIndex + 1 === nextLongPause) {
            await sleep(random(700, 1800));
            nextLongPause += random(4, 8);
          }
        }
        target.scrollTo(0);
        await sleep(random(350, 900));
      }

      window.scrollTo(0, 0);
      document.querySelectorAll('[class*="fixed"], [style*="position: fixed"], [style*="position:fixed"]').forEach((node) => {
        const rect = node.getBoundingClientRect();
        const tooTall = rect.height > window.innerHeight * 0.4;
        const bottomBar = rect.bottom > window.innerHeight - 2 && rect.height > 20;
        if (tooTall || bottomBar) {
          node.setAttribute('data-html2pdf-hidden', 'true');
        }
      });
      const style = document.createElement('style');
      style.textContent = \`
        @media print {
          [data-html2pdf-hidden="true"] { display: none !important; }
          [data-html2pdf-scroll-root] {
            height: auto !important;
            max-height: none !important;
            min-height: 0 !important;
            overflow: visible !important;
          }
          html, body {
            background: #fff !important;
            height: auto !important;
            max-height: none !important;
            overflow: visible !important;
          }
          a { color: inherit !important; text-decoration: none !important; }
        }
      \`;
      document.head.appendChild(style);
      await sleep(500);
      resolve({
        url: location.href,
        title: document.title,
        height: pageHeight(),
        textLength: (document.body?.innerText || '').trim().length
      });
    })`
  }, sessionId);
  return result.result.value;
}

export async function printToPdf(cdp, sessionId) {
  const pdf = await cdp.send("Page.printToPDF", {
    printBackground: true,
    preferCSSPageSize: false,
    paperWidth: 8.27,
    paperHeight: 11.69,
    marginTop: 0.35,
    marginBottom: 0.35,
    marginLeft: 0.35,
    marginRight: 0.35,
    scale: 0.92
  }, sessionId);
  return Buffer.from(pdf.data, "base64");
}

export class ChromePdfSession {
  constructor({ profileDir = ".chrome-profile", waitMs = 2000, keepBrowser = false, log = () => {} } = {}) {
    this.profileDir = path.resolve(profileDir);
    this.waitMs = waitMs;
    this.keepBrowser = keepBrowser;
    this.log = typeof log === "function" ? log : () => {};
  }

  async start() {
    if (this.cdp && this.chrome && !this.chrome.killed) {
      return;
    }

    this.log("启动远程 Chrome", { profileDir: this.profileDir });
    await mkdir(this.profileDir, { recursive: true });
    await killChromeUsingProfile(this.profileDir);
    this.port = await getFreePort();
    const chromeArgs = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--disable-default-apps",
      "--disable-popup-blocking",
      "--disable-dev-shm-usage",
      "--lang=zh-CN",
      `--user-agent=${DEFAULT_USER_AGENT}`,
      "--window-size=1365,900",
      "about:blank"
    ];

    const debugChrome = process.env.DEBUG_CHROME === "1";
    this.chrome = spawn(ensureChromePath(), chromeArgs, {
      stdio: ["ignore", "ignore", debugChrome ? "inherit" : "ignore"],
      detached: false
    });

    const version = await Promise.race([
      waitForChrome(this.port),
      new Promise((_, reject) => {
        this.chrome.once("error", (error) => reject(new Error(`Failed to start Chrome: ${error.message}`)));
      })
    ]);

    this.cdp = new CdpClient(version.webSocketDebuggerUrl);
    await this.cdp.connect();
    this.log("Chrome DevTools 已连接", { port: this.port });
  }

  async open(url, { waitMs = this.waitMs, waitForLoad = true } = {}) {
    await this.start();
    this.log("创建浏览器标签页", { url });
    const target = await createDevtoolsTab(this.port);
    this.log("标签页已创建", { targetId: target.id, url: target.url || url });
    const pageCdp = new CdpClient(target.webSocketDebuggerUrl);
    await pageCdp.connect();
    const tab = {
      targetId: target.id,
      sessionId: undefined,
      cdp: pageCdp
    };
    await pageCdp.send("Page.enable");
    await pageCdp.send("Runtime.enable");
    await pageCdp.send("Network.enable").catch(() => undefined);
    await pageCdp.send("Network.setUserAgentOverride", {
      userAgent: DEFAULT_USER_AGENT,
      acceptLanguage: DEFAULT_ACCEPT_LANGUAGE,
      platform: "Win32"
    }).catch(() => undefined);
    await pageCdp.send("Network.setExtraHTTPHeaders", {
      headers: {
        "Accept-Language": DEFAULT_ACCEPT_LANGUAGE
      }
    }).catch(() => undefined);
    this.log("跳转标签页到目标地址", { url });
    await pageCdp.send("Page.navigate", { url }, undefined, 10000).catch((error) => {
      this.log("跳转命令未返回确认，继续等待页面状态", { url, error: error.message });
    });
    const ready = await waitForDocumentReady(pageCdp, undefined, waitForLoad ? 30000 : Math.max(30000, waitMs + 5000), url);
    if (!ready) {
      throw new Error(`页面没有在超时内加载完成：${url}`);
    }
    this.log("页面已准备就绪", {
      url: ready?.url || url,
      title: ready?.title || "",
      textLength: ready?.textLength || 0
    });
    await sleep(waitMs);
    await this.closeOtherBlankTabs(target.id);
    return tab;
  }

  async openForLogin(url, options) {
    await this.closeLoginTab();
    this.log("打开登录页", { loginUrl: url });
    this.loginTarget = await this.open(url, { ...options, waitForLoad: false });
    return { ...this.loginTarget, profileDir: this.profileDir };
  }

  async autoLogin({ username, password, loginUrl, waitMs = this.waitMs }) {
    if (!username || !password) {
      throw new Error("username and password are required.");
    }
    if (!loginUrl) {
      throw new Error("loginUrl is required.");
    }
    this.log("开始自动登录", { loginUrl, username });
    const tab = await this.openForLogin(loginUrl, { waitMs });
    await sleep(1200);
    this.log("开始执行登录表单填充", { loginUrl });
    const loginResult = await this.loginTarget.cdp.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise(async (resolve) => {
        const username = ${JSON.stringify(username)};
        const password = ${JSON.stringify(password)};
        const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
        const visible = (node) => {
          if (!node) return false;
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const textOf = (node) => (node.innerText || node.textContent || '').trim();
        const areaOf = (node) => {
          const rect = node.getBoundingClientRect();
          return rect.width * rect.height;
        };
        const clickText = async (patterns) => {
          const nodes = Array.from(document.querySelectorAll('button, a, span, div, li'));
          const target = nodes.find((node) => visible(node) && patterns.some((pattern) => pattern.test(textOf(node))));
          if (!target) return false;
          target.click();
          await sleep(700);
          return true;
        };
        const setValue = (input, value) => {
          input.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter ? setter.call(input, value) : input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        await clickText([/密码登录/, /账号登录/, /帐号登录/, /账号密码/, /帐号密码/]);
        await sleep(500);
        const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
        const passwordInput = inputs.find((input) => input.type === 'password');
        const usernameInput = inputs.find((input) => {
          const hint = [
            input.type,
            input.name,
            input.id,
            input.autocomplete,
            input.placeholder,
            input.getAttribute('aria-label')
          ].join(' ').toLowerCase();
          return input !== passwordInput &&
            input.type !== 'hidden' &&
            !/code|captcha|verify|验证码|短信/.test(hint) &&
            (/tel|text|email|phone|mobile|user|account|账号|手机|邮箱/.test(hint) || input.type === '');
        }) || inputs.find((input) => input !== passwordInput && input.type !== 'hidden');
        if (!usernameInput || !passwordInput) {
          resolve({
            submitted: false,
            needsManualAction: true,
            reason: 'login inputs not found',
            currentUrl: location.href,
            title: document.title,
            text: document.body.innerText.slice(0, 240)
          });
          return;
        }
        setValue(usernameInput, username);
        usernameInput.dispatchEvent(new Event('blur', { bubbles: true }));
        await sleep(350);
        setValue(passwordInput, password);
        passwordInput.dispatchEvent(new Event('blur', { bubbles: true }));
        await sleep(350);
        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(visible);
        for (const checkbox of checkboxes) {
          if (!checkbox.checked) {
            checkbox.click();
            await sleep(250);
          }
        }
        const agreement = Array.from(document.querySelectorAll('input[type="checkbox"], [class*="AgreePanel"], div, span'))
          .filter(visible)
          .sort((a, b) => areaOf(a) - areaOf(b))
          .find((node) => {
            const text = textOf(node);
            return /我已阅读|用户协议|隐私政策/.test(text) && areaOf(node) < 26000;
          });
        if (agreement && agreement.tagName === 'INPUT') {
          if (!agreement.checked) {
            agreement.click();
            await sleep(250);
          }
        } else if (agreement) {
          agreement.click();
          await sleep(250);
        }
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div, span')).filter(visible);
        const submit = buttons.find((node) => {
          const text = textOf(node).replace(/\s+/g, '');
          const className = String(node.className || '');
          return /^登录$/i.test(text) &&
            !/注册|验证码|短信/.test(text) &&
            (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button' || /button/i.test(className));
        }) || buttons.find((node) => /submit|button/i.test(node.getAttribute('type') || ''));
        if (!submit) {
          resolve({
            submitted: false,
            needsManualAction: true,
            reason: 'submit button not found',
            currentUrl: location.href,
            title: document.title,
            text: document.body.innerText.slice(0, 240)
          });
          return;
        }
        submit.scrollIntoView({ block: 'center', inline: 'center' });
        await sleep(200);
        const rect = submit.getBoundingClientRect();
        const bodyText = document.body.innerText || '';
        resolve({
          readyToSubmit: true,
          submitted: false,
          submitRect: {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            width: rect.width,
            height: rect.height
          },
          currentUrl: location.href,
          title: document.title,
          needsManualAction: /验证码|滑块|扫码|二维码|短信|安全验证|人机/.test(bodyText),
          text: bodyText.slice(0, 240)
        });
      })`
    }, tab.sessionId, 20000);
    let resultValue = loginResult.result.value;
    if (resultValue.readyToSubmit && resultValue.submitRect) {
      const { x, y } = resultValue.submitRect;
      await this.loginTarget.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "none"
      }, tab.sessionId, 3000);
      await sleep(180);
      await this.loginTarget.cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1
      }, tab.sessionId, 3000);
      await sleep(120);
      await this.loginTarget.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1
      }, tab.sessionId, 3000);
      await sleep(6000);
      const afterClick = await this.loginTarget.cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const text = document.body?.innerText || '';
          const isAccountPage = location.hostname === 'account.geekbang.org';
          return {
            submitted: true,
            currentUrl: location.href,
            title: document.title,
            needsManualAction: isAccountPage && /验证码|滑块|扫码|二维码|短信|安全验证|人机/.test(text),
            text: text.slice(0, 240)
          };
        })()`
      }, tab.sessionId, 8000);
      resultValue = afterClick.result.value;
    }
    this.log("自动登录结果", {
      currentUrl: resultValue?.currentUrl || "",
      title: resultValue?.title || "",
      submitted: resultValue?.submitted,
      needsManualAction: resultValue?.needsManualAction,
      reason: resultValue?.reason
    });
    return resultValue;
  }

  async getLoginState() {
    if (!this.loginTarget?.cdp) {
      return { open: false };
    }
    this.log("读取登录页状态");
    const state = await this.loginTarget.cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const text = document.body?.innerText || '';
        return {
          open: true,
          currentUrl: location.href,
          title: document.title,
          needsManualAction: /验证码|滑块|扫码|二维码|短信|安全验证|人机/.test(text),
          text: text.slice(0, 240)
        };
      })()`
    }, this.loginTarget.sessionId, 8000);
    return state.result.value;
  }

  async captureLoginScreenshot() {
    if (!this.loginTarget?.cdp) {
      throw new Error("没有打开中的登录页面。");
    }
    this.log("抓取登录页截图");
    await this.loginTarget.cdp.send("Page.bringToFront", {}, this.loginTarget.sessionId, 3000).catch(() => undefined);
    const screenshot = await this.loginTarget.cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false
    }, this.loginTarget.sessionId, 8000);
    return Buffer.from(screenshot.data, "base64");
  }

  async closeLoginTab() {
    if (this.loginTarget?.targetId) {
      this.log("关闭登录页标签");
    }
    await this.closeTab(this.loginTarget);
    this.loginTarget = undefined;
  }

  async closeTab(tab) {
    if (!tab?.targetId) {
      return;
    }
    this.log("关闭标签页", { targetId: tab.targetId });
    tab.cdp?.close();
    if (this.port) {
      await fetchWithTimeout(`http://127.0.0.1:${this.port}/json/close/${tab.targetId}`, {}, 2000).catch(() => undefined);
    }
  }

  async closeOtherBlankTabs(keepTargetId) {
    if (!this.cdp) {
      return;
    }
    const targets = await fetchWithTimeout(`http://127.0.0.1:${this.port}/json/list`, {}, 2000)
      .then((response) => response.ok ? response.json() : [])
      .catch(() => []);
    this.log("清理空白标签页", { keepTargetId, count: targets.length });
    for (const target of targets) {
      if (
        target.type === "page" &&
        target.id !== keepTargetId &&
        (target.url === "about:blank" || target.url === "")
      ) {
        await fetchWithTimeout(`http://127.0.0.1:${this.port}/json/close/${target.id}`, {}, 1000).catch(() => undefined);
      }
    }
  }

  async openWarmupTab(url, { waitMs = this.waitMs } = {}) {
    this.log("打开预热标签页", { url });
    return this.open(url, { waitMs });
  }

  async pdfForUrl(url, { waitMs = this.waitMs, closeTab = true } = {}) {
    this.log("开始生成单页 PDF", { url });
    const tab = await this.open(url, { waitMs });
    try {
      const pageInfo = await preparePageForPdf(tab.cdp, tab.sessionId);
      this.log("页面已滚动并准备打印", { url, pageInfo });
      if (!pageInfo?.url || pageInfo.url === "about:blank" || (!pageInfo.title && pageInfo.textLength < 20)) {
        throw new Error(`页面内容为空，停止导出：${url}`);
      }
      const pdf = await printToPdf(tab.cdp, tab.sessionId);
      if (pdf.length < 5000) {
        throw new Error(`生成的 PDF 过小，疑似空白，停止下载：${Math.round(pdf.length / 1024)} KB`);
      }
      return pdf;
    } finally {
      if (closeTab) {
        await this.closeTab(tab);
      }
    }
  }

  async close() {
    this.log("关闭 Chrome 会话");
    await this.closeLoginTab();
    this.cdp?.close();
    this.cdp = undefined;
    if (!this.keepBrowser && this.chrome && !this.chrome.killed) {
      this.chrome.kill("SIGTERM");
    }
    this.chrome = undefined;
  }
}

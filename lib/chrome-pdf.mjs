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

function sanitizeFilenameBase(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .replace(/^-+|-+$/g, "")
    .trim()
    .slice(0, 120);
}

export function pdfFilenameForUrl(url, used = new Set(), title = "") {
  const parsed = new URL(url);
  const articleId = parsed.pathname.split("/").filter(Boolean).at(-1) || "page";
  const host = parsed.hostname.replace(/^www\./, "");
  const titleBase = sanitizeFilenameBase(title);
  const urlBase = `${host}-${articleId}`
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  const base = titleBase || urlBase || "page";

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

async function createDevtoolsTabOnce(port, url = "about:blank") {
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

async function createDevtoolsTab(port, url = "about:blank") {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await createDevtoolsTabOnce(port, url);
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleep(350 * attempt);
      }
    }
  }
  throw lastError;
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
      const findPrintableArticle = () => {
        const selectors = [
          '#article-content-container',
          '[class*="Index_articleContent"]',
          '[class*="RichContentPC_main"]',
          'article',
          'main'
        ];
        const candidates = selectors
          .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
          .filter((node, index, list) => list.indexOf(node) === index)
          .filter((node) => {
            const textLength = (node.innerText || '').trim().length;
            const rect = node.getBoundingClientRect();
            return textLength > 500 && rect.width > 200;
          })
          .sort((a, b) => {
            const aText = (a.innerText || '').trim().length;
            const bText = (b.innerText || '').trim().length;
            return bText - aText;
          });
        return candidates[0];
      };
      const findOriginalScrollCapture = () => {
        const article = findPrintableArticle();
        const scrollRoot = scrollables.find((node) => {
          const articleText = (article?.innerText || '').trim().length;
          const rootText = (node.innerText || '').trim().length;
          return article &&
            node.contains(article) &&
            articleText > 500 &&
            rootText >= articleText * 0.6 &&
            node.scrollHeight > node.clientHeight + window.innerHeight;
        });
        if (!article || !scrollRoot) {
          return undefined;
        }
        article.setAttribute('data-html2pdf-original-article', 'true');
        scrollRoot.setAttribute('data-html2pdf-original-scroll-root', 'true');
        const articleRect = article.getBoundingClientRect();
        const scrollRect = scrollRoot.getBoundingClientRect();
        return {
          enabled: true,
          reason: 'original-scroll-container',
          selector: article.id ? \`#\${article.id}\` : article.tagName.toLowerCase(),
          textLength: (article.innerText || '').trim().length,
          height: scrollRoot.scrollHeight,
          clientHeight: scrollRoot.clientHeight,
          articleRect: {
            x: Math.round(articleRect.x),
            y: Math.round(articleRect.y),
            width: Math.round(articleRect.width),
            height: Math.round(articleRect.height)
          },
          scrollRect: {
            x: Math.round(scrollRect.x),
            y: Math.round(scrollRect.y),
            width: Math.round(scrollRect.width),
            height: Math.round(scrollRect.height)
          }
        };
      };
      const makePrintOnlyArticle = async () => {
        if (document.querySelector('#html2pdf-print-root')) {
          return { enabled: true, reason: 'already-enabled' };
        }
        const article = findPrintableArticle();
        const bodyTextLength = (document.body?.innerText || '').trim().length;
        const needsPrintRoot = article &&
          bodyTextLength > 1000 &&
          pageHeight() <= window.innerHeight + 1200 &&
          Array.from(document.querySelectorAll('body *')).some((node) => {
            const style = getComputedStyle(node);
            return /(auto|scroll|overlay)/.test(\`\${style.overflowY} \${style.overflow}\`) &&
              node.scrollHeight > node.clientHeight + window.innerHeight;
          });
        if (!needsPrintRoot) {
          return { enabled: false, reason: article ? 'normal-document-flow' : 'article-not-found' };
        }
        const clone = article.cloneNode(true);
        clone.querySelectorAll('[data-html2pdf-hidden="true"], script, style, noscript, iframe').forEach((node) => node.remove());
        clone.querySelectorAll('img').forEach((img) => {
          const lazySrc = img.getAttribute('data-src') ||
            img.getAttribute('data-original') ||
            img.getAttribute('data-url') ||
            img.getAttribute('data-lazy-src');
          if (lazySrc && (!img.getAttribute('src') || img.getAttribute('src').startsWith('data:'))) {
            img.setAttribute('src', lazySrc);
          }
          img.setAttribute('loading', 'eager');
          img.removeAttribute('srcset');
          img.removeAttribute('sizes');
        });
        const root = document.createElement('main');
        root.id = 'html2pdf-print-root';
        root.appendChild(clone);
        document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => node.remove());
        document.documentElement.removeAttribute('style');
        document.body.removeAttribute('style');
        document.body.replaceChildren(root);
        document.documentElement.classList.add('html2pdf-print-mode');
        const simpleStyle = document.createElement('style');
        simpleStyle.setAttribute('data-html2pdf-style', 'true');
        simpleStyle.textContent = \`
          html,
          body {
            background: #fff !important;
            color: #111 !important;
            height: auto !important;
            min-height: 0 !important;
            max-height: none !important;
            margin: 0 !important;
            padding: 0 !important;
            overflow: visible !important;
            font: 16px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif !important;
          }
          #html2pdf-print-root {
            display: block !important;
            box-sizing: border-box !important;
            width: min(760px, calc(100% - 32px)) !important;
            margin: 0 auto !important;
            padding: 0 0 28px !important;
            overflow: visible !important;
            position: static !important;
            background: #fff !important;
          }
          #html2pdf-print-root,
          #html2pdf-print-root * {
            box-sizing: border-box !important;
            max-width: 100% !important;
          }
          #html2pdf-print-root h1,
          #html2pdf-print-root h2,
          #html2pdf-print-root h3 {
            color: #111 !important;
            line-height: 1.35 !important;
            margin: 24px 0 12px !important;
            font-weight: 700 !important;
          }
          #html2pdf-print-root h1 { font-size: 28px !important; }
          #html2pdf-print-root h2 { font-size: 22px !important; }
          #html2pdf-print-root h3 { font-size: 18px !important; }
          #html2pdf-print-root p,
          #html2pdf-print-root li {
            color: #222 !important;
            font-size: 16px !important;
            line-height: 1.8 !important;
          }
          #html2pdf-print-root p { margin: 0 0 14px !important; }
          #html2pdf-print-root ul,
          #html2pdf-print-root ol {
            padding-left: 1.4em !important;
            margin: 0 0 16px !important;
          }
          #html2pdf-print-root img,
          #html2pdf-print-root video,
          #html2pdf-print-root canvas,
          #html2pdf-print-root svg {
            display: block !important;
            max-width: 100% !important;
            height: auto !important;
            margin: 12px auto !important;
            break-inside: avoid !important;
          }
          #html2pdf-print-root pre,
          #html2pdf-print-root code {
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
          }
          #html2pdf-print-root pre {
            white-space: pre-wrap !important;
            word-break: break-word !important;
            overflow: visible !important;
            background: #f6f7f8 !important;
            border: 1px solid #e5e7eb !important;
            padding: 12px !important;
            margin: 14px 0 !important;
          }
          #html2pdf-print-root blockquote {
            border-left: 4px solid #d0d7de !important;
            margin: 16px 0 !important;
            padding: 2px 0 2px 14px !important;
            color: #444 !important;
          }
          #html2pdf-print-root table {
            width: 100% !important;
            border-collapse: collapse !important;
            margin: 14px 0 !important;
          }
          #html2pdf-print-root th,
          #html2pdf-print-root td {
            border: 1px solid #d8dee4 !important;
            padding: 6px 8px !important;
            vertical-align: top !important;
          }
          #html2pdf-print-root a {
            color: inherit !important;
            text-decoration: none !important;
          }
        \`;
        document.head.appendChild(simpleStyle);
        await Promise.race([
          Promise.all(Array.from(document.images).map((img) => img.complete ? undefined : new Promise((done) => {
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
          }))),
          sleep(5000)
        ]);
        return {
          enabled: true,
          reason: 'internal-scroll-container',
          selector: article.id ? \`#\${article.id}\` : article.tagName.toLowerCase(),
          textLength: (clone.innerText || '').trim().length,
          height: root.scrollHeight
        };
      };
      const printRootInfo = findOriginalScrollCapture() || await makePrintOnlyArticle();
      const style = document.createElement('style');
      style.textContent = \`
        html.html2pdf-print-mode,
        html.html2pdf-print-mode body {
          background: #fff !important;
          height: auto !important;
          min-height: 0 !important;
          max-height: none !important;
          overflow: visible !important;
        }
        html.html2pdf-print-mode body {
          margin: 0 !important;
        }
        html.html2pdf-print-mode body > :not(#html2pdf-print-root) {
          display: none !important;
        }
        #html2pdf-print-root {
          display: block !important;
          box-sizing: border-box !important;
          width: min(760px, calc(100% - 32px)) !important;
          min-height: 0 !important;
          height: auto !important;
          max-height: none !important;
          margin: 0 auto !important;
          padding: 0 0 24px !important;
          overflow: visible !important;
          position: static !important;
          background: #fff !important;
        }
        #html2pdf-print-root * {
          max-width: 100% !important;
          box-sizing: border-box !important;
        }
        #html2pdf-print-root img,
        #html2pdf-print-root video,
        #html2pdf-print-root canvas,
        #html2pdf-print-root svg {
          max-width: 100% !important;
          height: auto !important;
          break-inside: avoid;
        }
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
          #html2pdf-print-root {
            width: 100% !important;
            margin: 0 auto !important;
            padding: 0 !important;
          }
          #html2pdf-print-root [style*="position: fixed"],
          #html2pdf-print-root [style*="position:fixed"] {
            display: none !important;
          }
          a { color: inherit !important; text-decoration: none !important; }
        }
      \`;
      document.head.appendChild(style);
      await sleep(500);
      const printRoot = document.querySelector('#html2pdf-print-root');
      resolve({
        url: location.href,
        title: document.title,
        height: Math.max(pageHeight(), printRoot?.scrollHeight || 0),
        printRoot: printRootInfo,
        textLength: (document.body?.innerText || '').trim().length
      });
    })`
  }, sessionId);
  return result.result.value;
}

export async function printToPdf(cdp, sessionId, { timeoutMs = 120000 } = {}) {
  await cdp.send("Emulation.setEmulatedMedia", { media: "print" }, sessionId, 5000).catch(() => undefined);
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
  }, sessionId, timeoutMs);
  return Buffer.from(pdf.data, "base64");
}

export async function prepareBrowserPrintPageForPdf(cdp, sessionId, { platform = "generic" } = {}) {
  const result = await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise(async (resolve) => {
      const platform = ${JSON.stringify(platform)};
      const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
      const pageHeight = () => Math.max(
        document.body?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0
      );
      const loadLazyImages = () => {
        document.querySelectorAll('img').forEach((img) => {
          const src = img.getAttribute('data-src') ||
            img.getAttribute('data-original') ||
            img.getAttribute('data-backsrc') ||
            img.getAttribute('data-lazy-src');
          if (src && (!img.getAttribute('src') || img.getAttribute('src').startsWith('data:'))) {
            img.setAttribute('src', src);
          }
          img.setAttribute('loading', 'eager');
          img.removeAttribute('srcset');
          img.removeAttribute('sizes');
        });
      };
      loadLazyImages();
      let lastHeight = 0;
      for (let index = 0; index < 90; index += 1) {
        const maxTop = Math.max(0, pageHeight() - window.innerHeight);
        const nextTop = Math.min(maxTop, window.scrollY + Math.floor(window.innerHeight * 0.72));
        window.scrollTo({ top: nextTop, behavior: 'auto' });
        loadLazyImages();
        await sleep(180 + Math.floor(Math.random() * 180));
        const height = pageHeight();
        if (Math.abs(height - lastHeight) < 4 && nextTop >= maxTop - 8) {
          break;
        }
        lastHeight = height;
      }
      window.scrollTo(0, 0);
      await sleep(700);
      loadLazyImages();
      await Promise.race([
        Promise.all(Array.from(document.images).map((img) => img.complete ? undefined : new Promise((done) => {
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
        }))),
        sleep(8000)
      ]);

      const selectorsToHide = [
        '#js_pc_qr_code',
        '#js_reward_area',
        '#js_like_comment',
        '#js_cmt_area',
        '#js_tags',
        '#js_toobar3',
        '.rich_media_tool',
        '.qr_code_pc',
        '.reward_area',
        '.comment_primary',
        '.share_media',
        '.profile_container',
        '.read-more__area',
        '.rich_media_extra'
      ];
      selectorsToHide.forEach((selector) => {
        document.querySelectorAll(selector).forEach((node) => {
          node.setAttribute('data-html2pdf-hidden', 'true');
        });
      });
      document.querySelectorAll('[style*="position: fixed"], [style*="position:fixed"], [class*="fixed"]').forEach((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.height > 20 && (rect.bottom > window.innerHeight - 2 || rect.top < 2)) {
          node.setAttribute('data-html2pdf-hidden', 'true');
        }
      });

      const article = document.querySelector('#js_article') ||
        document.querySelector('#js_content')?.closest('.rich_media') ||
        document.querySelector('.rich_media') ||
        document.querySelector('article') ||
        document.querySelector('main') ||
        document.body;
      const selector = article.id ? \`#\${article.id}\` : article.tagName.toLowerCase();
      const bodyText = (article.innerText || document.body?.innerText || '').trim();
      const authChallenge = platform === 'zsxq' && (
        /登录|微信扫码|微信扫一扫|请使用微信|授权|验证码/.test(bodyText) ||
        /login|signin|passport/i.test(location.href)
      ) && bodyText.length < 1600;
      const clone = article.cloneNode(true);
      clone.querySelectorAll('[data-html2pdf-hidden="true"], script, noscript, iframe, video, audio').forEach((node) => node.remove());
      clone.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('data-src') ||
          img.getAttribute('data-original') ||
          img.getAttribute('data-backsrc') ||
          img.getAttribute('data-lazy-src') ||
          img.getAttribute('src');
        if (src) {
          img.setAttribute('src', src);
        }
        img.setAttribute('loading', 'eager');
        img.removeAttribute('srcset');
        img.removeAttribute('sizes');
      });
      const articleTitle = (clone.querySelector('#activity-name, .rich_media_title, h1, [class*="title"]')?.textContent || document.title || '')
        .replace(/\\s+/g, ' ')
        .trim();
      const root = document.createElement('main');
      root.id = 'html2pdf-browser-print-root';
      root.setAttribute('data-html2pdf-browser-print-root', 'true');
      root.appendChild(clone);
      document.documentElement.removeAttribute('style');
      document.body.removeAttribute('style');
      document.body.replaceChildren(root);
      document.title = articleTitle || document.title || '';
      const style = document.createElement('style');
      style.setAttribute('data-html2pdf-wechat-style', 'true');
      style.textContent = \`
        @page { size: A4; margin: 12mm 14mm; }
        @media print {
          html,
          body {
            background: #fff !important;
            height: auto !important;
            min-height: 0 !important;
            overflow: visible !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          body {
            margin: 0 !important;
          }
          [data-html2pdf-hidden="true"],
          iframe,
          video,
          audio,
          script,
          noscript {
            display: none !important;
          }
          [data-html2pdf-browser-print-root="true"] {
            display: block !important;
            width: 100% !important;
            max-width: 720px !important;
            margin: 0 auto !important;
            padding: 0 !important;
            background: #fff !important;
            color: #111 !important;
            overflow: visible !important;
          }
          #js_content,
          .rich_media_content {
            overflow: visible !important;
            height: auto !important;
            max-height: none !important;
            word-break: normal !important;
          }
          img,
          svg,
          canvas,
          table,
          pre,
          blockquote,
          figure {
            break-inside: avoid !important;
            page-break-inside: avoid !important;
          }
          img {
            max-width: 100% !important;
            height: auto !important;
          }
          a {
            color: inherit !important;
            text-decoration: none !important;
          }
        }
      \`;
      document.head.appendChild(style);
      resolve({
        url: location.href,
        title: articleTitle || document.title,
        height: pageHeight(),
        textLength: bodyText.length,
        authChallenge,
        printRoot: {
          enabled: false,
          reason: 'browser-print',
          selector
        }
      });
    })`
  }, sessionId, 30000);
  return result.result.value;
}

function numberForPdf(value) {
  return Number(value).toFixed(2).replace(/\.00$/, "");
}

function buildPdfFromJpegs(pages) {
  const pageWidthPt = 595.28;
  const pageHeightPt = 841.89;
  const horizontalMarginPt = 42;
  const verticalMarginPt = 28;
  const contentWidthPt = pageWidthPt - horizontalMarginPt * 2;
  const contentHeightPt = pageHeightPt - verticalMarginPt * 2;
  const objects = [];
  objects[1] = Buffer.from("<< /Type /Catalog /Pages 2 0 R >>\n", "ascii");

  const kids = [];
  pages.forEach((page, index) => {
    const pageObj = 3 + index * 3;
    const imageObj = pageObj + 1;
    const contentObj = pageObj + 2;
    const scale = Math.min(contentWidthPt / page.width, contentHeightPt / page.height);
    const imageWidthPt = page.width * scale;
    const imageHeightPt = page.height * scale;
    const imageXPt = (pageWidthPt - imageWidthPt) / 2;
    const imageYPt = pageHeightPt - verticalMarginPt - imageHeightPt;
    const content = [
      `q 1 1 1 rg 0 0 ${numberForPdf(pageWidthPt)} ${numberForPdf(pageHeightPt)} re f Q`,
      `q ${numberForPdf(imageWidthPt)} 0 0 ${numberForPdf(imageHeightPt)} ${numberForPdf(imageXPt)} ${numberForPdf(imageYPt)} cm /Im${index + 1} Do Q`,
      ""
    ].join("\n");
    kids.push(`${pageObj} 0 R`);
    objects[pageObj] = Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${numberForPdf(pageWidthPt)} ${numberForPdf(pageHeightPt)}] /Resources << /XObject << /Im${index + 1} ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>\n`,
      "ascii"
    );
    objects[imageObj] = Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${Math.round(page.width)} /Height ${Math.round(page.height)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.data.length} >>\nstream\n`,
        "ascii"
      ),
      page.data,
      Buffer.from("\nendstream\n", "ascii")
    ]);
    objects[contentObj] = Buffer.from(
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream\n`,
      "ascii"
    );
  });

  objects[2] = Buffer.from(`<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(" ")}] >>\n`, "ascii");

  const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets = [0];
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    chunks.push(Buffer.from(`${index} 0 obj\n`, "ascii"), objects[index], Buffer.from("endobj\n", "ascii"));
  }
  const xrefOffset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const xref = [
    "xref",
    `0 ${objects.length}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    ""
  ].join("\n");
  chunks.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(chunks);
}

async function originalScrollScreenshotPdf(cdp, sessionId) {
  await cdp.send("Page.bringToFront", {}, sessionId, 3000).catch(() => undefined);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1365,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false
  }, sessionId, 5000).catch(() => undefined);

  const initialResult = await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise(async (resolve) => {
      const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
      const scrollRoot = document.querySelector('[data-html2pdf-original-scroll-root]');
      const article = document.querySelector('[data-html2pdf-original-article]');
      if (!scrollRoot || !article) {
        resolve({ ok: false, reason: 'original scroll markers not found' });
        return;
      }
      scrollRoot.scrollTop = 0;
      await sleep(600);
      const articleRect = article.getBoundingClientRect();
      const rootRect = scrollRoot.getBoundingClientRect();
      const clipTop = Math.max(0, Math.ceil(Math.max(articleRect.top, rootRect.top)));
      const clipBottom = Math.min(window.innerHeight, Math.floor(Math.min(articleRect.bottom, rootRect.bottom)));
      const clipHeight = Math.max(1, clipBottom - clipTop);
      resolve({
        ok: true,
        totalHeight: Math.ceil(article.scrollHeight || articleRect.height),
        scrollHeight: Math.ceil(scrollRoot.scrollHeight),
        clientHeight: Math.ceil(scrollRoot.clientHeight),
        clip: {
          x: Math.max(0, Math.round(articleRect.left)),
          y: clipTop,
          width: Math.max(320, Math.round(articleRect.width)),
          height: clipHeight
        }
      });
    })`
  }, sessionId, 10000);
  const initial = initialResult.result.value;
  if (!initial?.ok) {
    throw new Error(initial?.reason || "original scroll capture is not available");
  }

  const width = Math.max(320, Math.min(1600, initial.clip.width));
  const visibleHeight = Math.max(320, Math.min(initial.clip.height, initial.clientHeight));
  const maxScrollTop = Math.max(0, initial.scrollHeight - initial.clientHeight);
  const minPageHeight = Math.max(260, Math.round(visibleHeight * 0.45));
  const bottomGuard = 28;
  const pages = [];

  let previousTop = -1;
  let capturedBottom = 0;
  for (let pageIndex = 0; capturedBottom < initial.totalHeight - 8 && pageIndex < 240; pageIndex += 1) {
    const requestedTop = Math.min(capturedBottom, maxScrollTop);
    const metricsResult = await cdp.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise(async (resolve) => {
        const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
        const requestedTop = ${JSON.stringify(requestedTop)};
        const previousTop = ${JSON.stringify(previousTop)};
        const capturedBottom = ${JSON.stringify(capturedBottom)};
        const minPageHeight = ${JSON.stringify(minPageHeight)};
        const bottomGuard = ${JSON.stringify(bottomGuard)};
        const scrollRoot = document.querySelector('[data-html2pdf-original-scroll-root]');
        const article = document.querySelector('[data-html2pdf-original-article]');
        scrollRoot.scrollTop = requestedTop;
        await sleep(380);
        const actualTop = Math.round(scrollRoot.scrollTop);
        const articleRect = article.getBoundingClientRect();
        const rootRect = scrollRoot.getBoundingClientRect();
        const visibleTop = Math.max(articleRect.top, rootRect.top, 0);
        const visibleBottom = Math.min(articleRect.bottom, rootRect.bottom, window.innerHeight);
        const contentTop = Math.max(0, Math.round(visibleTop - articleRect.top));
        const contentBottom = Math.max(contentTop, Math.round(contentTop + visibleBottom - visibleTop));
        const effectiveTop = Math.max(capturedBottom, contentTop);
        const articleHeight = Math.round(article.scrollHeight || articleRect.height);
        const isLast = contentBottom >= articleHeight - 8;
        const rawMaxBottom = isLast ? contentBottom : Math.max(effectiveTop + 20, contentBottom - bottomGuard);
        const blockBoxes = Array.from(article.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,table,img,figure,section,svg,canvas'))
          .map((node) => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            if (rect.height < 4 || rect.width < 20 || style.display === 'none' || style.visibility === 'hidden') {
              return undefined;
            }
            const tagName = node.tagName.toLowerCase();
            return {
              top: Math.round(rect.top - articleRect.top),
              bottom: Math.round(rect.bottom - articleRect.top),
              avoidSplit: /^(img|figure|pre|blockquote|table|svg|canvas)$/.test(tagName)
            };
          })
          .filter(Boolean)
          .sort((a, b) => a.top - b.top || a.bottom - b.bottom);
        const avoidSplitTop = blockBoxes
          .filter((box) =>
            box.avoidSplit &&
            box.top > effectiveTop + 120 &&
            box.top <= rawMaxBottom &&
            box.bottom > rawMaxBottom
          )
          .map((box) => box.top)
          .at(0);
        const breakpoints = blockBoxes
          .map((box) => box.bottom)
          .filter((bottom) => Number.isFinite(bottom) && bottom > effectiveTop + minPageHeight && bottom <= rawMaxBottom)
          .sort((a, b) => a - b);
        let safeBottom = isLast ? contentBottom : breakpoints.at(-1);
        if (!isLast && avoidSplitTop) {
          safeBottom = avoidSplitTop;
        }
        if (!safeBottom) {
          safeBottom = rawMaxBottom;
        }
        if (safeBottom <= effectiveTop + 20) {
          safeBottom = Math.min(contentBottom, effectiveTop + Math.max(120, Math.round((visibleBottom - visibleTop) * 0.85)));
        }
        resolve({
          ok: visibleBottom > visibleTop + 20 && safeBottom > effectiveTop + 20,
          actualTop,
          contentTop,
          safeBottom,
          clip: {
            x: Math.max(0, Math.round(articleRect.left)),
            y: Math.max(0, Math.ceil(visibleTop)),
            width: Math.max(320, Math.round(articleRect.width)),
            height: Math.max(1, Math.floor(visibleBottom - visibleTop))
          }
        });
      })`
    }, sessionId, 10000);
    const metrics = metricsResult.result.value;
    if (!metrics?.ok) {
      continue;
    }
    const cropTop = Math.max(0, capturedBottom - metrics.contentTop);
    const remainingHeight = Math.max(0, metrics.safeBottom - Math.max(capturedBottom, metrics.contentTop));
    const clipHeight = Math.min(Math.max(0, metrics.clip.height - cropTop), remainingHeight);
    if (clipHeight < 20) {
      previousTop = metrics.actualTop;
      continue;
    }
    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 88,
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: metrics.clip.x,
        y: metrics.clip.y + cropTop,
        width,
        height: Math.max(1, Math.round(clipHeight)),
        scale: 1
      }
    }, sessionId, 30000);
    pages.push({
      width,
      height: Math.max(1, Math.round(clipHeight)),
      data: Buffer.from(screenshot.data, "base64")
    });
    capturedBottom = Math.max(capturedBottom, metrics.safeBottom);
    previousTop = metrics.actualTop;
  }

  if (!pages.length) {
    throw new Error("original scroll capture produced no pages");
  }
  return {
    pdf: buildPdfFromJpegs(pages),
    pageCount: pages.length,
    height: initial.scrollHeight,
    mode: "original-scroll"
  };
}

export async function screenshotPdf(cdp, sessionId) {
  await cdp.send("Page.bringToFront", {}, sessionId, 3000).catch(() => undefined);
  const modeResult = await cdp.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `Boolean(document.querySelector('[data-html2pdf-original-scroll-root]') && document.querySelector('[data-html2pdf-original-article]'))`
  }, sessionId, 5000).catch(() => undefined);
  if (modeResult?.result?.value) {
    return originalScrollScreenshotPdf(cdp, sessionId);
  }
  const metricsResult = await cdp.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const root = document.querySelector('#html2pdf-print-root') ||
        document.querySelector('#html2pdf-browser-print-root') ||
        document.body ||
        document.documentElement;
      const rect = root.getBoundingClientRect();
      const rootY = rect.top + window.scrollY;
      const avoidNodes = new Set(Array.from(root.querySelectorAll('img,figure,table,pre,blockquote,canvas,svg')));
      root.querySelectorAll('img,svg,canvas,table,pre').forEach((node) => {
        const wrapper = node.closest('figure,p,section,div');
        if (wrapper && wrapper !== root) {
          const rect = wrapper.getBoundingClientRect();
          if (rect.height >= 40 && rect.height <= window.innerHeight * 1.4) {
            avoidNodes.add(wrapper);
          }
        }
      });
      const avoidRanges = Array.from(avoidNodes)
        .map((node) => {
          const nodeRect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || nodeRect.width < 20 || nodeRect.height < 24) {
            return undefined;
          }
          return {
            top: Math.max(0, Math.round(nodeRect.top + window.scrollY - rootY)),
            bottom: Math.max(0, Math.round(nodeRect.bottom + window.scrollY - rootY)),
            tag: node.tagName.toLowerCase()
          };
        })
        .filter((range) => range && range.bottom > range.top)
        .sort((a, b) => a.top - b.top || a.bottom - b.bottom);
      return {
        x: Math.max(0, rect.left),
        y: Math.max(0, rect.top + window.scrollY),
        width: Math.ceil(rect.width || document.documentElement.clientWidth || 760),
        height: Math.ceil(root.scrollHeight || rect.height || document.documentElement.scrollHeight || window.innerHeight),
        avoidRanges
      };
    })()`
  }, sessionId, 8000);
  const metrics = metricsResult.result.value;
  const width = Math.max(320, Math.min(1600, metrics.width));
  const totalHeight = Math.max(1, metrics.height);
  const sliceHeight = Math.max(480, Math.round(width * 1.4142));
  const minSliceHeight = Math.max(360, Math.round(sliceHeight * 0.45));
  const maxSliceHeight = Math.round(sliceHeight * 1.25);
  const avoidRanges = Array.isArray(metrics.avoidRanges) ? metrics.avoidRanges : [];
  const safeBottomFor = (top, targetBottom) => {
    if (targetBottom >= totalHeight) {
      return totalHeight;
    }
    const crossings = avoidRanges.filter((range) =>
      range.top > top + 12 &&
      range.top < targetBottom - 12 &&
      range.bottom > targetBottom + 12
    );
    if (!crossings.length) {
      return targetBottom;
    }
    const crossing = [...crossings].reverse().find((range) => range.top - top >= minSliceHeight) || crossings[0];
    if (crossing.top - top >= minSliceHeight) {
      return Math.max(top + 1, crossing.top);
    }
    if (crossing.bottom - top <= maxSliceHeight) {
      return Math.min(totalHeight, crossing.bottom);
    }
    return targetBottom;
  };
  const pages = [];
  for (let top = 0; top < totalHeight;) {
    const targetBottom = Math.min(totalHeight, top + sliceHeight);
    const safeBottom = Math.max(top + 1, safeBottomFor(top, targetBottom));
    const height = Math.min(safeBottom - top, totalHeight - top);
    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 88,
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: metrics.x,
        y: metrics.y + top,
        width,
        height,
        scale: 1
      }
    }, sessionId, 30000);
    pages.push({
      width,
      height,
      data: Buffer.from(screenshot.data, "base64")
    });
    top += height;
  }
  return {
    pdf: buildPdfFromJpegs(pages),
    pageCount: pages.length,
    height: totalHeight
  };
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
      const alive = await fetchWithTimeout(`http://127.0.0.1:${this.port}/json/version`, {}, 1000)
        .then((response) => response.ok)
        .catch(() => false);
      if (alive) {
        return;
      }
      this.log("Chrome DevTools 已断开，重新启动");
      this.cdp.close();
      this.cdp = undefined;
      this.chrome = undefined;
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
    let target;
    try {
      target = await createDevtoolsTab(this.port);
    } catch (error) {
      if (!/ECONNREFUSED|fetch failed|socket hang up|terminated|DevTools/i.test(error.message || "")) {
        throw error;
      }
      this.log("创建标签页失败，重启 Chrome 后重试", { url, error: error.message });
      this.cdp?.close();
      this.cdp = undefined;
      this.chrome = undefined;
      await this.start();
      target = await createDevtoolsTab(this.port);
    }
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

  async acceptLoginAgreement() {
    if (!this.loginTarget?.cdp) {
      throw new Error("没有打开中的登录页面。");
    }
    this.log("尝试勾选登录协议");
    const inspect = async () => {
      const result = await this.loginTarget.cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const visible = (node) => {
            if (!node) return false;
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden';
          };
          const textOf = (node) => (node.innerText || node.textContent || node.getAttribute('aria-label') || '').trim();
          const point = (x, y) => ({ x: Math.round(x), y: Math.round(y) });
          const center = (node) => {
            const rect = node.getBoundingClientRect();
            return point(rect.left + rect.width / 2, rect.top + rect.height / 2);
          };
          const addUnique = (points, item) => {
            if (!item || !Number.isFinite(item.x) || !Number.isFinite(item.y)) return;
            if (!points.some((pointItem) => Math.abs(pointItem.x - item.x) < 3 && Math.abs(pointItem.y - item.y) < 3)) {
              points.push(item);
            }
          };

          const agreementPoints = [];
          const checkboxInputs = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(visible);
          checkboxInputs.forEach((node) => addUnique(agreementPoints, center(node)));

          Array.from(document.querySelectorAll('label, span, div, i, p')).filter(visible).forEach((node) => {
            const text = textOf(node);
            const className = String(node.className || '');
            const isAgreement = /我已阅读|用户协议|隐私政策|同意/.test(text) || /checkbox|agree/i.test(className);
            if (!isAgreement) return;
            const rect = node.getBoundingClientRect();
            addUnique(agreementPoints, point(rect.left + 8, rect.top + rect.height / 2));
            addUnique(agreementPoints, point(rect.left - 10, rect.top + rect.height / 2));
            addUnique(agreementPoints, center(node));
            const parent = node.closest('label, div');
            if (parent && visible(parent)) {
              const parentRect = parent.getBoundingClientRect();
              addUnique(agreementPoints, point(parentRect.left + 12, parentRect.top + parentRect.height / 2));
            }
          });

          const qrButtonPoints = [];
          const consentButtonPoints = [];
          Array.from(document.querySelectorAll('button, div, span, a')).filter(visible).forEach((node) => {
            const text = textOf(node);
            if (/获取登录二维码|登录二维码|刷新二维码/.test(text)) {
              addUnique(qrButtonPoints, center(node));
            }
            if (/^同意$|^我同意$|^确认同意$/.test(text)) {
              addUnique(consentButtonPoints, center(node));
            }
          });

          const checkboxLike = Array.from(document.querySelectorAll('[role="checkbox"], [aria-checked], [class*="check"], [class*="agree"]')).filter(visible);
          const domChecked = checkboxInputs.some((node) => node.checked) ||
            checkboxLike.some((node) => /true/i.test(node.getAttribute('aria-checked') || '') || /checked|active|selected/i.test(String(node.className || '')));
          const bodyText = document.body?.innerText || '';
          const qrImageVisible = Array.from(document.querySelectorAll('img, canvas, svg')).some((node) => {
            const rect = node.getBoundingClientRect();
            return visible(node) && rect.width >= 90 && rect.height >= 90 && rect.top > 120;
          });
          const qrTextVisible = /扫一扫登录|微信扫一扫|使用微信扫码|使用微信扫一扫/.test(bodyText);
          return {
            currentUrl: location.href,
            title: document.title,
            agreementChecked: domChecked || ((qrImageVisible || qrTextVisible) && !/获取登录二维码/.test(bodyText)),
            qrVisible: (qrImageVisible || qrTextVisible) && !/获取登录二维码/.test(bodyText),
            agreementPoints: agreementPoints.slice(0, 10),
            qrButtonPoints: qrButtonPoints.slice(0, 5),
            consentButtonPoints: consentButtonPoints.slice(0, 5),
            text: bodyText.slice(0, 240)
          };
        })()`
      }, this.loginTarget.sessionId, 10000);
      return result.result.value || {};
    };

    const clickPoint = async ({ x, y }) => {
      await this.loginTarget.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y
      }, this.loginTarget.sessionId, 3000).catch(() => undefined);
      await this.loginTarget.cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1
      }, this.loginTarget.sessionId, 3000);
      await this.loginTarget.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1
      }, this.loginTarget.sessionId, 3000);
    };

    let clicked = false;
    let qrRequested = false;
    let state = await inspect();
    for (let attempt = 0; attempt < 3 && !state.agreementChecked; attempt += 1) {
      for (const point of state.agreementPoints || []) {
        await clickPoint(point);
        clicked = true;
        await sleep(350);
        state = await inspect();
        for (const consentPoint of state.consentButtonPoints || []) {
          await clickPoint(consentPoint);
          clicked = true;
          await sleep(500);
          state = await inspect();
          if (state.agreementChecked || !/同意\n不同意|不同意/.test(state.text || "")) {
            break;
          }
        }
        if (state.agreementChecked) {
          break;
        }
      }
    }

    if (state.agreementChecked && !state.qrVisible) {
      for (const point of state.qrButtonPoints || []) {
        await clickPoint(point);
        qrRequested = true;
        await sleep(800);
        state = await inspect();
        if (state.qrVisible || !/获取登录二维码/.test(state.text || "")) {
          break;
        }
      }
    }

    const result = {
      clicked,
      qrRequested,
      ...state
    };
    this.log("登录协议处理完成", result);
    return result;
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

  async pdfForUrl(url, { waitMs = this.waitMs, closeTab = true, platform = "generic", returnPageInfo = false } = {}) {
    this.log("开始生成单页 PDF", { url });
    const tab = await this.open(url, { waitMs });
    try {
      const browserPrintPlatforms = new Set(["wechat", "zsxq"]);
      const pageInfo = browserPrintPlatforms.has(platform)
        ? await prepareBrowserPrintPageForPdf(tab.cdp, tab.sessionId, { platform })
        : await preparePageForPdf(tab.cdp, tab.sessionId);
      this.log("页面已滚动并准备打印", { url, pageInfo });
      if (!pageInfo?.url || pageInfo.url === "about:blank" || (!pageInfo.title && pageInfo.textLength < 20)) {
        throw new Error(`页面内容为空，停止导出：${url}`);
      }
      if (pageInfo.authChallenge) {
        throw new Error("当前页面仍是登录或授权页面，请先打开登录窗口完成手动登录。");
      }
      let pdf;
      if (platform === "wechat") {
        this.log("微信公众号使用截图分页生成 PDF", {
          url,
          height: pageInfo.height,
          textLength: pageInfo.textLength
        });
        const screenshotResult = await screenshotPdf(tab.cdp, tab.sessionId);
        this.log("截图分页 PDF 已生成", {
          url,
          pages: screenshotResult.pageCount,
          height: screenshotResult.height,
          sizeKb: Math.round(screenshotResult.pdf.length / 1024)
        });
        pdf = screenshotResult.pdf;
      } else if (!browserPrintPlatforms.has(platform) && pageInfo.printRoot?.enabled) {
        this.log("使用截图分页生成 PDF", {
          url,
          height: pageInfo.height,
          textLength: pageInfo.textLength
        });
        const screenshotResult = await screenshotPdf(tab.cdp, tab.sessionId);
        this.log("截图分页 PDF 已生成", {
          url,
          pages: screenshotResult.pageCount,
          height: screenshotResult.height,
          sizeKb: Math.round(screenshotResult.pdf.length / 1024)
        });
        pdf = screenshotResult.pdf;
      } else {
        const printTimeoutMs = browserPrintPlatforms.has(platform) ? 30000 : 120000;
        this.log("开始调用浏览器打印", { url, timeoutMs: printTimeoutMs });
        try {
          pdf = await printToPdf(tab.cdp, tab.sessionId, { timeoutMs: printTimeoutMs });
          this.log("浏览器打印 PDF 已生成", { url, sizeKb: Math.round(pdf.length / 1024) });
        } catch (error) {
          if (!browserPrintPlatforms.has(platform)) {
            throw error;
          }
          this.log("浏览器打印失败，改用截图分页 PDF", { url, error: error.message });
          const screenshotResult = await screenshotPdf(tab.cdp, tab.sessionId);
          this.log("截图分页 PDF 已生成", {
            url,
            pages: screenshotResult.pageCount,
            height: screenshotResult.height,
            sizeKb: Math.round(screenshotResult.pdf.length / 1024)
          });
          pdf = screenshotResult.pdf;
        }
      }
      if (pdf.length < 5000) {
        throw new Error(`生成的 PDF 过小，疑似空白，停止下载：${Math.round(pdf.length / 1024)} KB`);
      }
      if (returnPageInfo) {
        return { pdf, pageInfo };
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

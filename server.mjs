#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChromePdfSession,
  DEFAULT_URL,
  parseUrlList,
  pdfFilenameForUrl,
  randomDelayMs,
  sleep
} from "./lib/chrome-pdf.mjs";
import { CredentialStore } from "./lib/credential-store.mjs";
import { createZip } from "./lib/zip.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 5187);
const host = process.env.HOST || "127.0.0.1";
const profileDir = process.env.CHROME_PROFILE_DIR || path.join(__dirname, ".chrome-profile");
const dataDir = process.env.LOCAL_TOOLBOX_DATA_DIR || path.join(__dirname, ".local-toolbox");
const waitMs = Number(process.env.WAIT_MS || 2000);
const minTabDelayMs = Number(process.env.MIN_TAB_DELAY_MS || 5000);
const maxTabDelayMs = Number(process.env.MAX_TAB_DELAY_MS || 15000);
const credentials = new CredentialStore({ dataDir });
let exportInProgress = false;
let nextLogId = 1;
const runLogs = [];

const platforms = new Map([
  ["geektime", { key: "geektime", name: "极客时间", authMode: "credentials" }],
  ["wechat", { key: "wechat", name: "微信公众号", authMode: "none" }],
  ["zsxq", { key: "zsxq", name: "知识星球", authMode: "manual" }],
  ["generic", { key: "generic", name: "通用网页", authMode: "none" }]
]);

function sanitizeLogMeta(meta = {}) {
  return Object.fromEntries(Object.entries(meta).filter(([key]) => !/password|secret|payload/i.test(key)));
}

function logStep(message, meta = {}) {
  const entry = {
    id: nextLogId,
    time: new Date().toISOString(),
    message,
    meta: sanitizeLogMeta(meta)
  };
  nextLogId += 1;
  runLogs.push(entry);
  if (runLogs.length > 300) {
    runLogs.splice(0, runLogs.length - 300);
  }
  const metaText = Object.keys(entry.meta).length ? ` ${JSON.stringify(entry.meta)}` : "";
  console.log(`[${entry.time}] ${message}${metaText}`);
  return entry;
}

const session = new ChromePdfSession({ profileDir, waitMs, keepBrowser: false, log: logStep });

function sameHostname(left, right) {
  try {
    return new URL(left).hostname === new URL(right).hostname;
  } catch {
    return false;
  }
}

function inferPlatformKey(urls) {
  if (urls.some((value) => {
    try {
      return new URL(value).hostname.endsWith("geekbang.org");
    } catch {
      return false;
    }
  })) {
    return "geektime";
  }
  if (urls.some((value) => {
    try {
      return new URL(value).hostname === "mp.weixin.qq.com";
    } catch {
      return false;
    }
  })) {
    return "wechat";
  }
  if (urls.some((value) => {
    try {
      return new URL(value).hostname.endsWith("zsxq.com");
    } catch {
      return false;
    }
  })) {
    return "zsxq";
  }
  return "generic";
}

function platformFromKey(value, urls = []) {
  const key = String(value || "").trim() || inferPlatformKey(urls);
  return platforms.get(key) || platforms.get("generic");
}

function delayRangeFromBody(body = {}) {
  const rawMin = Number(body.minTabDelayMs);
  const rawMax = Number(body.maxTabDelayMs);
  if (Number.isFinite(rawMin) && Number.isFinite(rawMax)) {
    const min = Math.max(0, Math.floor(rawMin));
    const max = Math.max(min, Math.floor(rawMax));
    return { minMs: min, maxMs: max, source: "custom" };
  }

  const pace = String(body.pace || "");
  if (pace.includes("快速")) {
    return { minMs: 1000, maxMs: 3000, source: "fast" };
  }
  if (pace.includes("标准")) {
    return { minMs: 4000, maxMs: 9000, source: "standard" };
  }
  if (pace.includes("稳妥")) {
    return { minMs: 5000, maxMs: 15000, source: "safe" };
  }
  return { minMs: minTabDelayMs, maxMs: maxTabDelayMs, source: "env" };
}

function runtimeHealth() {
  const hostLabel = host === "127.0.0.1" || host === "localhost" ? "本机" : "e540";
  return {
    host,
    port,
    hostLabel,
    profileDir,
    dataDir,
    waitMs,
    minTabDelayMs,
    maxTabDelayMs,
    exportInProgress
  };
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"]
]);

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length
  });
  res.end(body);
}

function errorJson(res, status, error) {
  json(res, status, { error: error.message || String(error) });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": contentTypes.get(ext) || "application/octet-stream",
      "cache-control": "no-store"
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function openForLogin(req, res) {
  const body = await readJson(req);
  const platform = platformFromKey(body.platform);
  if (platform.authMode === "none") {
    throw new Error(`${platform.name}无需登录。`);
  }
  const credential = platform.authMode === "credentials" ? await credentials.get(platform.key) : undefined;
  const setting = platform.authMode === "manual" ? await credentials.getLoginUrlMeta(platform.key) : undefined;
  const configuredLoginUrl = credential?.loginUrl || setting?.loginUrl || "";
  const rawLoginUrl = body.loginUrl || configuredLoginUrl;
  if (!rawLoginUrl) {
    throw new Error("没有找到登录地址，请先填写账密登录地址。");
  }
  const loginUrl = parseUrlList([rawLoginUrl])[0];
  logStep("打开登录窗口", { platform: platform.name, loginUrl });
  await session.openForLogin(loginUrl, { waitMs });
  logStep("登录窗口已打开", { platform: platform.name, loginUrl, profileDir });
  json(res, 200, {
    ok: true,
    profileDir,
    openedUrl: loginUrl
  });
}

async function credentialMeta(req, res, platformKey = "geektime") {
  const platform = platformFromKey(platformKey);
  if (platform.authMode === "none") {
    json(res, 200, {
      configured: false,
      service: platform.key,
      authMode: platform.authMode,
      loginRequired: false
    });
    return;
  }
  if (platform.authMode === "manual") {
    const meta = await credentials.getLoginUrlMeta(platform.key);
    json(res, 200, {
      ...meta,
      service: platform.key,
      authMode: platform.authMode,
      loginRequired: true,
      manualLogin: true
    });
    return;
  }
  const meta = await credentials.getMeta(platform.key);
  json(res, 200, {
    ...meta,
    service: platform.key,
    authMode: platform.authMode,
    loginRequired: true
  });
}

async function saveCredential(req, res, platformKey = "geektime") {
  const body = await readJson(req);
  const platform = platformFromKey(platformKey || body.platform);
  if (platform.authMode === "none") {
    throw new Error(`${platform.name}无需保存账密。`);
  }
  if (!body.loginUrl) {
    throw new Error("没有找到登录地址，请填写登录地址。");
  }
  const loginUrl = parseUrlList([body.loginUrl])[0];
  if (platform.authMode === "manual") {
    logStep("保存平台登录地址配置", {
      platform: platform.name,
      loginUrl
    });
    await credentials.saveLoginUrl(platform.key, loginUrl);
    await credentialMeta(req, res, platform.key);
    return;
  }
  logStep("保存平台账密配置", {
    platform: platform.name,
    username: body.username,
    loginUrl
  });
  await credentials.save(platform.key, {
    username: body.username,
    password: body.password,
    loginUrl
  });
  await credentialMeta(req, res, platform.key);
}

async function autoLogin(req, res) {
  const body = await readJson(req);
  const platform = platformFromKey(body.platform);
  if (platform.authMode !== "credentials") {
    throw new Error(`${platform.name}无需登录。`);
  }
  logStep("开始自动登录", { platform: platform.name });
  const credential = await credentials.get(platform.key);
  if (!credential) {
    throw new Error(`还没有保存${platform.name}账号密码。`);
  }
  if (!credential.loginUrl) {
    throw new Error("没有找到登录地址，请先填写账密登录地址。");
  }
  const loginUrl = parseUrlList([credential.loginUrl])[0];
  logStep("读取到登录配置", { platform: platform.name, username: credential.username, loginUrl });
  const result = await session.autoLogin({
    username: credential.username,
    password: credential.password,
    loginUrl,
    waitMs
  });
  const needsManualAction = !result.submitted ||
    (result.needsManualAction && sameHostname(result.currentUrl || loginUrl, loginUrl));
  if (!needsManualAction) {
    logStep("自动登录结束，关闭远程 Chrome", {
      platform: platform.name,
      currentUrl: result.currentUrl,
      submitted: result.submitted,
      reason: result.reason
    });
    await session.close();
  } else {
    logStep("自动登录需要人工处理", {
      platform: platform.name,
      currentUrl: result.currentUrl,
      reason: result.reason
    });
  }
  json(res, 200, {
    ok: true,
    platform: platform.key,
    username: credential.username,
    loginUrl,
    currentUrl: result.currentUrl,
    title: result.title,
    submitted: result.submitted,
    needsManualAction,
    reason: result.reason
  });
}

async function loginState(req, res) {
  logStep("检查登录页状态");
  json(res, 200, await session.getLoginState());
}

async function loginScreenshot(req, res) {
  logStep("刷新登录页截图");
  const image = await session.captureLoginScreenshot();
  res.writeHead(200, {
    "content-type": "image/png",
    "cache-control": "no-store",
    "content-length": image.length
  });
  res.end(image);
}

async function exportUrls(req, res) {
  if (exportInProgress) {
    errorJson(res, 409, new Error("已有导出任务正在运行，请稍后再试。"));
    return;
  }

  exportInProgress = true;
  try {
    const body = await readJson(req);
    const urls = parseUrlList(body.urls || DEFAULT_URL);
    const platform = platformFromKey(body.platform, urls);
    if (!urls.length) {
      throw new Error("至少需要一个 URL。");
    }
    const delayRange = delayRangeFromBody(body);
    logStep("开始导出任务", {
      count: urls.length,
      platform: platform.name,
      platformKey: platform.key,
      pace: delayRange.source,
      minDelayMs: delayRange.minMs,
      maxDelayMs: delayRange.maxMs
    });

    if (platform.authMode === "credentials") {
      const credential = await credentials.get(platform.key);
      if (credential?.username && credential?.password && credential?.loginUrl) {
        const loginUrl = parseUrlList([credential.loginUrl])[0];
        logStep("导出前确认平台登录", {
          platform: platform.name,
          username: credential.username,
          loginUrl
        });
        const loginResult = await session.autoLogin({
          username: credential.username,
          password: credential.password,
          loginUrl,
          waitMs
        });
        const needsManualAction = !loginResult.submitted ||
          (loginResult.needsManualAction && sameHostname(loginResult.currentUrl || loginUrl, loginUrl));
        logStep("导出前登录确认结果", {
          platform: platform.name,
          currentUrl: loginResult.currentUrl,
          title: loginResult.title,
          submitted: loginResult.submitted,
          needsManualAction,
          reason: loginResult.reason
        });
        if (needsManualAction) {
          throw new Error(`${platform.name}登录需要人工处理：${loginResult.reason || loginResult.currentUrl || "未知原因"}`);
        }
      } else {
        logStep("未配置完整平台账密，按现有浏览器登录态导出", { platform: platform.name });
      }
    } else if (platform.authMode === "manual") {
      logStep("当前平台使用手动登录态", { platform: platform.name });
    } else {
      logStep("当前平台无需登录", { platform: platform.name });
    }

    await session.closeLoginTab();
    logStep("打开预热页面", { url: urls[0] });
    const warmupTab = await session.openWarmupTab(urls[0], { waitMs });
    let warmupClosed = false;
    const usedNames = new Set();
    const pdfs = [];
    try {
      for (const url of urls) {
        const delayMs = randomDelayMs(delayRange.minMs, delayRange.maxMs);
        logStep("等待随机间隔后打开导出页面", { url, delayMs });
        await sleep(delayMs);
        if (!warmupClosed) {
          await session.closeTab(warmupTab);
          warmupClosed = true;
          logStep("预热页面已关闭");
        }
        logStep("开始生成 PDF", { url });
        const data = await session.pdfForUrl(url, { waitMs, platform: platform.key });
        logStep("PDF 已生成", { url, sizeKb: Math.round(data.length / 1024) });
        pdfs.push({
          name: pdfFilenameForUrl(url, usedNames),
          data
        });
      }
    } finally {
      if (!warmupClosed) {
        await session.closeTab(warmupTab);
      }
    }

    if (pdfs.length === 1) {
      logStep("返回 PDF 下载", { filename: pdfs[0].name, sizeKb: Math.round(pdfs[0].data.length / 1024) });
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${pdfs[0].name}"`,
        "content-length": pdfs[0].data.length
      });
      res.end(pdfs[0].data);
      return;
    }

    const zip = createZip(pdfs);
    logStep("返回 ZIP 下载", { count: pdfs.length, sizeKb: Math.round(zip.length / 1024) });
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="html2pdf-export.zip"',
      "content-length": zip.length
    });
    res.end(zip);
  } finally {
    await session.close();
    logStep("导出任务结束，远程 Chrome 已关闭");
    exportInProgress = false;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        profileDir,
        dataDir,
        runtime: runtimeHealth(),
        credentials: await credentials.getMeta("geektime")
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/logs") {
      const after = Number(url.searchParams.get("after") || 0);
      json(res, 200, {
        ok: true,
        logs: runLogs.filter((entry) => entry.id > after)
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/credentials/geektime") {
      await credentialMeta(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/credentials/geektime") {
      await saveCredential(req, res);
      return;
    }
    const credentialMatch = /^\/api\/credentials\/([^/]+)$/.exec(url.pathname);
    if (credentialMatch && req.method === "GET") {
      await credentialMeta(req, res, decodeURIComponent(credentialMatch[1]));
      return;
    }
    if (credentialMatch && req.method === "POST") {
      await saveCredential(req, res, decodeURIComponent(credentialMatch[1]));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/auto-login") {
      await autoLogin(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/login-state") {
      await loginState(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/login-screenshot") {
      await loginScreenshot(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/open-browser") {
      await openForLogin(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/export") {
      await exportUrls(req, res);
      return;
    }
    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }
    res.writeHead(405);
    res.end("Method not allowed");
  } catch (error) {
    logStep("请求失败", { method: req.method, url: req.url, error: error.message || String(error) });
    errorJson(res, 500, error);
  }
});

process.on("SIGINT", async () => {
  await session.close();
  process.exit(0);
});

server.listen(port, host, () => {
  logStep("服务已启动", {
    url: `http://${host}:${port}`,
    profileDir,
    dataDir
  });
});

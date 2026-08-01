#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChromePdfSession,
  DEFAULT_LOGIN_URL,
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
  const loginUrl = body.loginUrl ? parseUrlList([body.loginUrl])[0] : DEFAULT_LOGIN_URL;
  logStep("打开登录窗口", { loginUrl });
  await session.openForLogin(loginUrl, { waitMs });
  logStep("登录窗口已打开", { loginUrl, profileDir });
  json(res, 200, {
    ok: true,
    profileDir,
    openedUrl: loginUrl
  });
}

async function credentialMeta(req, res) {
  json(res, 200, await credentials.getMeta("geektime"));
}

async function saveCredential(req, res) {
  const body = await readJson(req);
  logStep("保存极客时间账密配置", {
    username: body.username,
    loginUrl: body.loginUrl || DEFAULT_LOGIN_URL
  });
  await credentials.save("geektime", {
    username: body.username,
    password: body.password,
    loginUrl: body.loginUrl
  });
  json(res, 200, await credentials.getMeta("geektime"));
}

async function autoLogin(req, res) {
  logStep("开始自动登录");
  const credential = await credentials.get("geektime");
  if (!credential) {
    throw new Error("还没有保存极客时间账号密码。");
  }
  const loginUrl = credential.loginUrl || DEFAULT_LOGIN_URL;
  logStep("读取到登录配置", { username: credential.username, loginUrl });
  const result = await session.autoLogin({
    username: credential.username,
    password: credential.password,
    loginUrl,
    waitMs
  });
  if (!result.needsManualAction) {
    logStep("自动登录结束，关闭远程 Chrome", {
      currentUrl: result.currentUrl,
      submitted: result.submitted,
      reason: result.reason
    });
    await session.close();
  } else {
    logStep("自动登录需要人工处理", {
      currentUrl: result.currentUrl,
      reason: result.reason
    });
  }
  json(res, 200, {
    ok: true,
    username: credential.username,
    loginUrl,
    currentUrl: result.currentUrl,
    title: result.title,
    submitted: result.submitted,
    needsManualAction: result.needsManualAction,
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
    if (!urls.length) {
      throw new Error("至少需要一个 URL。");
    }
    logStep("开始导出任务", { count: urls.length });

    await session.closeLoginTab();
    logStep("打开预热页面", { url: urls[0] });
    const warmupTab = await session.openWarmupTab(urls[0], { waitMs });
    let warmupClosed = false;
    const usedNames = new Set();
    const pdfs = [];
    try {
      for (const url of urls) {
        const delayMs = randomDelayMs(minTabDelayMs, maxTabDelayMs);
        logStep("等待随机间隔后打开导出页面", { url, delayMs });
        await sleep(delayMs);
        if (!warmupClosed) {
          await session.closeTab(warmupTab);
          warmupClosed = true;
          logStep("预热页面已关闭");
        }
        logStep("开始生成 PDF", { url });
        const data = await session.pdfForUrl(url, { waitMs });
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

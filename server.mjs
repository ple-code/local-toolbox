#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { TaskStore } from "./lib/task-store.mjs";
import { createZip } from "./lib/zip.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 5187);
const host = process.env.HOST || "127.0.0.1";
const profileDir = process.env.CHROME_PROFILE_DIR || path.join(__dirname, ".chrome-profile");
const dataDir = process.env.LOCAL_TOOLBOX_DATA_DIR || path.join(__dirname, ".local-toolbox");
const exportDir = process.env.LOCAL_TOOLBOX_EXPORT_DIR || path.join(dataDir, "exports");
const waitMs = Number(process.env.WAIT_MS || 2000);
const minTabDelayMs = Number(process.env.MIN_TAB_DELAY_MS || 5000);
const maxTabDelayMs = Number(process.env.MAX_TAB_DELAY_MS || 15000);
const credentials = new CredentialStore({ dataDir });
const taskStore = new TaskStore({ dataDir });
let exportInProgress = false;
let nextLogId = 1;
const runLogs = [];
let activeLogScope = "system";
let activeTaskId = undefined;
const pendingTaskIds = [];
const cancelledTaskIds = new Set();

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
  const cleanMeta = sanitizeLogMeta(meta);
  const entry = {
    id: nextLogId,
    time: new Date().toISOString(),
    scope: activeLogScope,
    taskId: activeTaskId,
    message,
    meta: cleanMeta
  };
  nextLogId += 1;
  runLogs.push(entry);
  if (activeTaskId && activeLogScope === "export") {
    const storedId = taskStore.addLogSync(activeTaskId, {
      time: entry.time,
      scope: entry.scope,
      message,
      meta: cleanMeta
    });
    if (storedId) {
      entry.persistedId = storedId;
    }
  }
  if (runLogs.length > 300) {
    runLogs.splice(0, runLogs.length - 300);
  }
  const metaText = Object.keys(entry.meta).length ? ` ${JSON.stringify(entry.meta)}` : "";
  console.log(`[${entry.time}] ${message}${metaText}`);
  return entry;
}

function logTaskStep(taskId, message, meta = {}) {
  const cleanMeta = sanitizeLogMeta(meta);
  const time = new Date().toISOString();
  taskStore.addLogSync(taskId, {
    time,
    scope: "export",
    message,
    meta: cleanMeta
  });
  const entry = {
    id: nextLogId,
    time,
    scope: "export",
    taskId,
    message,
    meta: cleanMeta
  };
  nextLogId += 1;
  runLogs.push(entry);
  if (runLogs.length > 300) {
    runLogs.splice(0, runLogs.length - 300);
  }
  const metaText = Object.keys(cleanMeta).length ? ` ${JSON.stringify(cleanMeta)}` : "";
  console.log(`[${time}] ${message}${metaText}`);
}

function publicLogEntry(entry) {
  return {
    id: entry.persistedId || entry.id,
    memoryId: entry.id,
    taskId: entry.taskId,
    time: entry.time,
    scope: entry.scope,
    message: entry.message,
    meta: entry.meta
  };
}

function rawUrlListForTask(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : String(value || "").split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
}

async function saveTaskOutput(taskId, filename, data) {
  const safeName = path.basename(filename);
  const dir = path.join(exportDir, taskId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, safeName);
  await writeFile(filePath, data);
  return filePath;
}

const session = new ChromePdfSession({ profileDir, waitMs, keepBrowser: false, log: logStep });

function sameHostname(left, right) {
  try {
    return new URL(left).hostname === new URL(right).hostname;
  } catch {
    return false;
  }
}

function samePlatformHost(platform, value) {
  try {
    const hostname = new URL(value).hostname;
    if (platform.key === "geektime") {
      return hostname.endsWith("geekbang.org");
    }
    if (platform.key === "zsxq") {
      return hostname.endsWith("zsxq.com");
    }
    if (platform.key === "wechat") {
      return hostname === "mp.weixin.qq.com";
    }
    return true;
  } catch {
    return false;
  }
}

function isZsxqAuthenticatedLoginState(state = {}, loginUrl = "") {
  try {
    const current = new URL(state.currentUrl || "");
    const login = loginUrl ? new URL(loginUrl) : undefined;
    const isZsxqHost = current.hostname.endsWith("zsxq.com");
    const isLoginPath = login
      ? current.hostname === login.hostname && current.pathname === login.pathname
      : /\/login\/?$/.test(current.pathname);
    const text = String(state.text || "");
    const hasLoggedInShell = /所有星球|加入的星球|创建\/管理的星球|最新动态|管理后台/.test(text);
    const hasLoginPrompt = /扫码登录|微信扫一扫|获取登录二维码|登录二维码/.test(text);
    return isZsxqHost && (!isLoginPath || hasLoggedInShell) && !state.qrVisible && !hasLoginPrompt;
  } catch {
    return false;
  }
}

async function resolveLoginUrlForPlatform(platform, explicitLoginUrl = "") {
  const parsedExplicit = parseUrlList([explicitLoginUrl])[0];
  if (parsedExplicit) {
    return parsedExplicit;
  }
  if (platform.authMode === "credentials") {
    return (await credentials.get(platform.key))?.loginUrl || "";
  }
  if (platform.authMode === "manual") {
    return (await credentials.getLoginUrlMeta(platform.key))?.loginUrl || "";
  }
  return "";
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

function acquireTaskLock(taskId) {
  if (exportInProgress) {
    throw new Error("已有导出任务正在运行，请稍后再试。");
  }
  exportInProgress = true;
  activeTaskId = taskId;
}

function releaseTaskLock(taskId) {
  if (!taskId || activeTaskId === taskId) {
    activeTaskId = undefined;
    exportInProgress = false;
  }
}

async function waitForTaskTurn(taskId) {
  if (exportInProgress || pendingTaskIds.length) {
    if (!pendingTaskIds.includes(taskId)) {
      pendingTaskIds.push(taskId);
    }
    const position = pendingTaskIds.indexOf(taskId) + 1;
    taskStore.updateTaskSync(taskId, { status: "queued" });
    logTaskStep(taskId, "任务排队中，等待前一个任务结束", { position });
  }
  try {
    while (exportInProgress || (pendingTaskIds.length && pendingTaskIds[0] !== taskId)) {
      throwIfTaskCancelled(taskId);
      await sleep(1000);
    }
    throwIfTaskCancelled(taskId);
    if (pendingTaskIds[0] === taskId) {
      pendingTaskIds.shift();
    }
    acquireTaskLock(taskId);
    taskStore.updateTaskSync(taskId, { status: "running" });
    logStep("任务开始执行，已取得单线程执行锁", { taskId });
  } catch (error) {
    const index = pendingTaskIds.indexOf(taskId);
    if (index >= 0) {
      pendingTaskIds.splice(index, 1);
    }
    throw error;
  }
}

class TaskCancelledError extends Error {
  constructor(message = "任务已手动停止。") {
    super(message);
    this.name = "TaskCancelledError";
  }
}

function isTaskCancelled(taskId) {
  return Boolean(taskId && cancelledTaskIds.has(taskId));
}

function throwIfTaskCancelled(taskId) {
  if (isTaskCancelled(taskId)) {
    throw new TaskCancelledError();
  }
}

async function cancellableSleep(ms, taskId) {
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    throwIfTaskCancelled(taskId);
    await sleep(Math.min(500, end - Date.now()));
  }
  throwIfTaskCancelled(taskId);
}

function markTaskError(taskId, error, resultSummary = {}) {
  if (!taskId) {
    return;
  }
  if (error instanceof TaskCancelledError || isTaskCancelled(taskId)) {
    taskStore.cancelTaskSync(taskId, error?.message || "任务已手动停止。", resultSummary);
    return;
  }
  taskStore.failTaskSync(taskId, error, resultSummary);
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

function contentDisposition(filename) {
  const safeName = path.basename(filename || "download");
  const asciiName = safeName
    .replace(/["\\]/g, "")
    .replace(/[^\x20-\x7E]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "download";
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function outputPathForTask(task) {
  const outputPath = task?.result?.outputPath;
  if (!outputPath) {
    return undefined;
  }
  const resolved = path.resolve(outputPath);
  const root = path.resolve(exportDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("任务文件路径不合法。");
  }
  return resolved;
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

async function loginScreenshot(req, res, searchParams = new URLSearchParams()) {
  const platform = platformFromKey(searchParams.get("platform"));
  if (platform.authMode === "none") {
    throw new Error(`${platform.name}无需登录。`);
  }
  const expectedLoginUrl = await resolveLoginUrlForPlatform(platform, searchParams.get("loginUrl") || "");
  const state = await session.getLoginState();
  if (!state.open) {
    throw new Error("没有打开中的登录页面。");
  }
  if (expectedLoginUrl && !samePlatformHost(platform, state.currentUrl || expectedLoginUrl)) {
    throw new Error(`当前登录窗口不是${platform.name}登录页，请先打开${platform.name}登录窗口。`);
  }
  logStep("刷新登录页截图", {
    platform: platform.name,
    currentUrl: state.currentUrl,
    expectedLoginUrl
  });
  const image = await session.captureLoginScreenshot();
  res.writeHead(200, {
    "content-type": "image/png",
    "cache-control": "no-store",
    "content-length": image.length
  });
  res.end(image);
}

function exportPlanFromBody(body) {
  const rawUrls = rawUrlListForTask(body.urls || DEFAULT_URL);
  const urls = parseUrlList(rawUrls);
  const platform = platformFromKey(body.platform, urls);
  if (!urls.length) {
    throw new Error("至少需要一个 URL。");
  }
  const delayRange = delayRangeFromBody(body);
  return { rawUrls, urls, platform, delayRange };
}

function createExportTask(body, { status = "running", extraConfig = {} } = {}) {
  const { rawUrls, urls, platform, delayRange } = exportPlanFromBody(body);
  const taskId = taskStore.createTaskSync({
    id: body.taskId,
    platform,
    rawUrls,
    normalizedUrls: urls,
    config: {
      pace: delayRange.source,
      minDelayMs: delayRange.minMs,
      maxDelayMs: delayRange.maxMs,
      waitMs,
      output: urls.length === 1 ? "pdf" : "zip",
      requestedPlatform: body.platform || "",
      profileDir,
      ...extraConfig
    }
  });
  if (status !== "running") {
    taskStore.updateTaskSync(taskId, { status });
  }
  return { taskId, rawUrls, urls, platform, delayRange };
}

function delayRangeFromTask(task) {
  return {
    minMs: Number(task.config?.minDelayMs ?? minTabDelayMs),
    maxMs: Number(task.config?.maxDelayMs ?? maxTabDelayMs),
    source: task.config?.pace || "stored"
  };
}

async function ensureCredentialsForExport(platform, urls = []) {
  if (platform.authMode === "credentials") {
    const probeUrl = urls[0];
    if (probeUrl) {
      const probe = await session.probeAuthState(probeUrl, { platform: platform.key, waitMs });
      logStep("导出前登录态探测结果", {
        platform: platform.name,
        url: probeUrl,
        authenticated: probe.authenticated,
        reason: probe.reason,
        currentUrl: probe.currentUrl,
        title: probe.title,
        textLength: probe.textLength,
        articleTextLength: probe.articleTextLength
      });
      if (probe.authenticated) {
        logStep("检测到已有平台登录态，跳过自动登录", { platform: platform.name });
        return;
      }
    }
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
    return;
  }
  if (platform.authMode === "manual") {
    logStep("当前平台使用手动登录态", { platform: platform.name });
    return;
  }
  logStep("当前平台无需登录", { platform: platform.name });
}

async function runExportTask({ taskId, urls, platform, delayRange }) {
  throwIfTaskCancelled(taskId);
  await ensureCredentialsForExport(platform, urls);
  throwIfTaskCancelled(taskId);
  logStep("打开预热页面", { url: urls[0] });
  const warmupTab = await session.openWarmupTab(urls[0], { waitMs });
  await session.closeLoginTab();
  let warmupClosed = false;
  const usedNames = new Set();
  const pdfs = [];
  try {
    for (const url of urls) {
      throwIfTaskCancelled(taskId);
      const delayMs = randomDelayMs(delayRange.minMs, delayRange.maxMs);
      const delaySeconds = (delayMs / 1000).toFixed(1);
      logStep(`等待随机间隔 ${delaySeconds} 秒后打开导出页面`, { url, delayMs, delaySeconds });
      await cancellableSleep(delayMs, taskId);
      logStep("开始生成 PDF", { url });
      const result = await session.pdfForUrl(url, { waitMs, platform: platform.key, returnPageInfo: true });
      throwIfTaskCancelled(taskId);
      const data = Buffer.isBuffer(result) ? result : result.pdf;
      const pageTitle = Buffer.isBuffer(result) ? "" : result.pageInfo?.title || "";
      if (!warmupClosed) {
        await session.closeTab(warmupTab);
        warmupClosed = true;
        logStep("预热页面已关闭");
      }
      const filename = pdfFilenameForUrl(url, usedNames, pageTitle);
      logStep("PDF 已生成", { url, title: pageTitle, filename, sizeKb: Math.round(data.length / 1024) });
      pdfs.push({ name: filename, data });
    }
  } finally {
    if (!warmupClosed) {
      await session.closeTab(warmupTab);
    }
  }
  return pdfs;
}

async function sendExportResult(res, taskId, pdfs) {
  if (pdfs.length === 1) {
    const outputPath = await saveTaskOutput(taskId, pdfs[0].name, pdfs[0].data);
    const resultSummary = {
      filename: pdfs[0].name,
      fileCount: 1,
      contentType: "application/pdf",
      sizeBytes: pdfs[0].data.length,
      sizeKb: Math.round(pdfs[0].data.length / 1024),
      outputPath
    };
    taskStore.finishTaskSync(taskId, resultSummary);
    logStep("返回 PDF 下载", { filename: pdfs[0].name, sizeKb: resultSummary.sizeKb, outputPath });
    res.writeHead(200, {
      "content-type": "application/pdf",
      "content-disposition": contentDisposition(pdfs[0].name),
      "x-local-toolbox-task-id": taskId,
      "content-length": pdfs[0].data.length
    });
    res.end(pdfs[0].data);
    return;
  }

  const zip = createZip(pdfs);
  const zipFilename = "html2pdf-export.zip";
  const outputPath = await saveTaskOutput(taskId, zipFilename, zip);
  const resultSummary = {
    filename: zipFilename,
    fileCount: pdfs.length,
    contentType: "application/zip",
    sizeBytes: zip.length,
    sizeKb: Math.round(zip.length / 1024),
    outputPath
  };
  taskStore.finishTaskSync(taskId, resultSummary);
  logStep("返回 ZIP 下载", { count: pdfs.length, sizeKb: resultSummary.sizeKb, outputPath });
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition": contentDisposition(zipFilename),
    "x-local-toolbox-task-id": taskId,
    "content-length": zip.length
  });
  res.end(zip);
}

async function exportUrls(req, res) {
  const previousLogScope = activeLogScope;
  activeLogScope = "export";
  let taskId;
  let resultSummary = {};
  try {
    await taskStore.init();
    const body = await readJson(req);
    const task = createExportTask(body);
    taskId = task.taskId;
    await waitForTaskTurn(taskId);
    logStep("开始导出任务", {
      taskId,
      count: task.urls.length,
      platform: task.platform.name,
      platformKey: task.platform.key,
      pace: task.delayRange.source,
      minDelayMs: task.delayRange.minMs,
      maxDelayMs: task.delayRange.maxMs
    });
    const pdfs = await runExportTask(task);
    await sendExportResult(res, taskId, pdfs);
  } catch (error) {
    if (taskId) {
      logStep("导出任务失败", { error: error.message || String(error) });
      markTaskError(taskId, error, resultSummary);
    }
    throw error;
  } finally {
    await session.close();
    logStep("导出任务结束，远程 Chrome 已关闭");
    activeLogScope = previousLogScope;
    releaseTaskLock(taskId);
    cancelledTaskIds.delete(taskId);
  }
}

async function prepareManualLoginExport(req, res) {
  const previousLogScope = activeLogScope;
  activeLogScope = "export";
  let taskId;
  try {
    await taskStore.init();
    const body = await readJson(req);
    const task = createExportTask(body, {
      status: "queued",
      extraConfig: { manualLoginPhase: "waiting_scan" }
    });
    taskId = task.taskId;
    if (task.platform.key !== "zsxq") {
      throw new Error("只有知识星球需要扫码确认流程。");
    }
    await waitForTaskTurn(taskId);
    const loginUrl = await resolveLoginUrlForPlatform(task.platform, body.loginUrl || "");
    if (!loginUrl) {
      throw new Error("没有找到知识星球登录地址，请先在平台配置里填写。");
    }
    logStep("开始知识星球扫码登录准备", {
      taskId,
      count: task.urls.length,
      loginUrl
    });
    await session.openForLogin(loginUrl, { waitMs });
    const agreement = await session.acceptLoginAgreement();
    if (isZsxqAuthenticatedLoginState(agreement, loginUrl)) {
      taskStore.updateTaskSync(taskId, {
        status: "waiting_login",
        config: { manualLoginPhase: "authenticated" }
      });
      logStep("检测到已有知识星球登录态，跳过扫码确认", {
        taskId,
        currentUrl: agreement.currentUrl,
        title: agreement.title
      });
      json(res, 200, {
        ok: true,
        taskId,
        status: "authenticated"
      });
      return;
    }
    taskStore.updateTaskSync(taskId, {
      status: "waiting_login",
      config: { manualLoginPhase: "waiting_scan" }
    });
    logStep("等待微信扫码确认", {
      taskId,
      loginUrl,
      agreementClicked: Boolean(agreement?.clicked)
    });
    json(res, 200, {
      ok: true,
      taskId,
      status: "waiting_login",
      screenshotUrl: `/api/login-screenshot?platform=zsxq&taskId=${encodeURIComponent(taskId)}&ts=${Date.now()}`
    });
  } catch (error) {
    if (taskId) {
      logStep("知识星球扫码准备失败", { error: error.message || String(error) });
      markTaskError(taskId, error);
    }
    await session.close();
    releaseTaskLock(taskId);
    throw error;
  } finally {
    activeLogScope = previousLogScope;
  }
}

async function continueManualLoginExport(req, res, taskId) {
  if (!exportInProgress || activeTaskId !== taskId) {
    errorJson(res, 409, new Error("没有找到等待中的知识星球任务。"));
    return;
  }

  const previousLogScope = activeLogScope;
  activeLogScope = "export";
  let resultSummary = {};
  try {
    await taskStore.init();
    const storedTask = taskStore.getTaskSync(taskId);
    if (!storedTask) {
      throw new Error("任务不存在。");
    }
    const canContinue = storedTask.platformKey === "zsxq" &&
      (storedTask.status === "waiting_login" ||
        (storedTask.status === "running" && storedTask.config?.manualLoginPhase === "authenticated"));
    if (!canContinue) {
      throw new Error("当前任务不是等待扫码确认的知识星球任务。");
    }
    const platform = platformFromKey(storedTask.platformKey);
    const urls = storedTask.normalizedUrls || [];
    const delayRange = delayRangeFromTask(storedTask);
    taskStore.updateTaskSync(taskId, {
      status: "running",
      config: { manualLoginPhase: "confirmed" }
    });
    logStep(
      storedTask.config?.manualLoginPhase === "authenticated" ? "已有登录态，继续导出任务" : "已确认扫码，继续导出任务",
      {
      taskId,
      count: urls.length,
      platform: platform.name
      }
    );
    const pdfs = await runExportTask({ taskId, urls, platform, delayRange });
    await sendExportResult(res, taskId, pdfs);
  } catch (error) {
    logStep("导出任务失败", { error: error.message || String(error) });
    markTaskError(taskId, error, resultSummary);
    throw error;
  } finally {
    await session.close();
    logStep("导出任务结束，远程 Chrome 已关闭");
    activeLogScope = previousLogScope;
    releaseTaskLock(taskId);
    cancelledTaskIds.delete(taskId);
  }
}

async function listTasks(req, res, searchParams) {
  await taskStore.init();
  const limit = Number(searchParams.get("limit") || 50);
  json(res, 200, {
    ok: true,
    tasks: taskStore.listTasksSync({ limit })
  });
}

async function taskDetail(req, res, taskId) {
  await taskStore.init();
  const task = taskStore.getTaskSync(taskId);
  if (!task) {
    errorJson(res, 404, new Error("任务不存在。"));
    return;
  }
  json(res, 200, { ok: true, task });
}

async function taskLogs(req, res, taskId, searchParams) {
  await taskStore.init();
  const task = taskStore.getTaskSync(taskId);
  if (!task) {
    errorJson(res, 404, new Error("任务不存在。"));
    return;
  }
  const after = Number(searchParams.get("after") || 0);
  const limit = Number(searchParams.get("limit") || 200);
  const logs = taskStore.getLogsSync(taskId, { after, limit });
  json(res, 200, {
    ok: true,
    task,
    lastId: logs.at(-1)?.id || after,
    logs
  });
}

async function downloadTaskOutput(req, res, taskId) {
  await taskStore.init();
  const task = taskStore.getTaskSync(taskId);
  if (!task) {
    errorJson(res, 404, new Error("任务不存在。"));
    return;
  }
  const outputPath = outputPathForTask(task);
  if (!outputPath) {
    errorJson(res, 404, new Error("任务没有可下载文件。"));
    return;
  }
  const file = await readFile(outputPath);
  const filename = task.result?.filename || path.basename(outputPath);
  res.writeHead(200, {
    "content-type": task.result?.contentType || "application/octet-stream",
    "content-disposition": contentDisposition(filename),
    "content-length": file.length,
    "cache-control": "no-store"
  });
  res.end(file);
}

async function stopTask(req, res, taskId) {
  await taskStore.init();
  const task = taskStore.getTaskSync(taskId);
  if (!task) {
    errorJson(res, 404, new Error("任务不存在。"));
    return;
  }
  if (!["queued", "running", "waiting_login"].includes(task.status)) {
    errorJson(res, 409, new Error("只有排队中、执行中或等待扫码的任务可以停止。"));
    return;
  }

  cancelledTaskIds.add(taskId);
  const queueIndex = pendingTaskIds.indexOf(taskId);
  if (queueIndex >= 0) {
    pendingTaskIds.splice(queueIndex, 1);
  }

  const reason = "任务已手动停止。";
  taskStore.cancelTaskSync(taskId, reason, task.result || {});
  logTaskStep(taskId, "任务已手动停止", {
    previousStatus: task.status,
    active: activeTaskId === taskId
  });

  if (activeTaskId === taskId) {
    await session.close().catch(() => undefined);
    if (task.status === "waiting_login" || task.config?.manualLoginPhase === "authenticated" || queueIndex >= 0) {
      releaseTaskLock(taskId);
      cancelledTaskIds.delete(taskId);
    }
  } else {
    cancelledTaskIds.delete(taskId);
  }

  json(res, 200, {
    ok: true,
    taskId,
    status: "cancelled"
  });
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
      const scope = String(url.searchParams.get("scope") || "").trim();
      json(res, 200, {
        ok: true,
        lastId: nextLogId - 1,
        logs: runLogs
          .filter((entry) => entry.id > after && (!scope || entry.scope === scope))
          .map(publicLogEntry)
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/tasks") {
      await listTasks(req, res, url.searchParams);
      return;
    }
    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
    if (taskMatch && req.method === "GET") {
      await taskDetail(req, res, decodeURIComponent(taskMatch[1]));
      return;
    }
    const taskLogsMatch = /^\/api\/tasks\/([^/]+)\/logs$/.exec(url.pathname);
    if (taskLogsMatch && req.method === "GET") {
      await taskLogs(req, res, decodeURIComponent(taskLogsMatch[1]), url.searchParams);
      return;
    }
    const taskDownloadMatch = /^\/api\/tasks\/([^/]+)\/download$/.exec(url.pathname);
    if (taskDownloadMatch && req.method === "GET") {
      await downloadTaskOutput(req, res, decodeURIComponent(taskDownloadMatch[1]));
      return;
    }
    const taskStopMatch = /^\/api\/tasks\/([^/]+)\/stop$/.exec(url.pathname);
    if (taskStopMatch && req.method === "POST") {
      await stopTask(req, res, decodeURIComponent(taskStopMatch[1]));
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
      await loginScreenshot(req, res, url.searchParams);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/open-browser") {
      await openForLogin(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/export/prepare-login") {
      await prepareManualLoginExport(req, res);
      return;
    }
    const continueExportMatch = /^\/api\/tasks\/([^/]+)\/continue$/.exec(url.pathname);
    if (continueExportMatch && req.method === "POST") {
      await continueManualLoginExport(req, res, decodeURIComponent(continueExportMatch[1]));
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
    const previousLogScope = activeLogScope;
    if (req.url?.startsWith("/api/export")) {
      activeLogScope = "export";
    }
    logStep("请求失败", { method: req.method, url: req.url, error: error.message || String(error) });
    activeLogScope = previousLogScope;
    errorJson(res, 500, error);
  }
});

process.on("SIGINT", async () => {
  await session.close();
  process.exit(0);
});

server.listen(port, host, () => {
  taskStore.init()
    .then(() => taskStore.markRunningInterruptedSync())
    .catch((error) => console.error(`Failed to initialize task store: ${error.message}`));
  logStep("服务已启动", {
    url: `http://${host}:${port}`,
    profileDir,
    dataDir
  });
});

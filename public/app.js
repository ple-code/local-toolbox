const urlsEl = document.querySelector("#urls");
const targetPlatformEl = document.querySelector("#targetPlatform");
const countEl = document.querySelector("#urlCount");
const profileMetaEl = document.querySelector("#profileMeta");
const statusDotEl = document.querySelector("#serverStatus");
const openBrowserEl = document.querySelector("#openBrowser");
const autoLoginEl = document.querySelector("#autoLogin");
const exportEl = document.querySelector("#export");
const clearEl = document.querySelector("#clear");
const credentialsFormEl = document.querySelector("#credentialsForm");
const usernameEl = document.querySelector("#username");
const loginUrlEl = document.querySelector("#loginUrl");
const passwordEl = document.querySelector("#password");
const saveCredentialsEl = document.querySelector("#saveCredentials");
const credentialMetaEl = document.querySelector("#credentialMeta");
const loginPreviewEl = document.querySelector("#loginPreview");
const refreshPreviewEl = document.querySelector("#refreshPreview");
const loginScreenshotEl = document.querySelector("#loginScreenshot");
const runStateEl = document.querySelector("#runState");
const stateTitleEl = document.querySelector("#stateTitle");
const stateDetailEl = document.querySelector("#stateDetail");
const logListEl = document.querySelector("#logList");
const logEmptyEl = document.querySelector("#logEmpty");
const logPanelEl = document.querySelector("#logPanel");
const prevLogPageEl = document.querySelector("#prevLogPage");
const nextLogPageEl = document.querySelector("#nextLogPage");
const logPageInfoEl = document.querySelector("#logPageInfo");
const toggleLogFullscreenEl = document.querySelector("#toggleLogFullscreen");
const downloadInfoEl = document.querySelector("#downloadInfo");
const downloadNameEl = document.querySelector("#downloadName");
const paceEl = document.querySelector("#pace");
const credentialPillEl = document.querySelector("#credentialPill");
const servicePillEl = document.querySelector("#servicePill");
const serviceTextEl = document.querySelector("#serviceText");
const hostMetaEl = document.querySelector("#hostMeta");
const platformValueEl = document.querySelector("#platformValue");
const platformLoginTextEl = document.querySelector("#platformLoginText");
const platformCredentialTextEl = document.querySelector("#platformCredentialText");
const historyLatestEl = document.querySelector("#historyLatest");
const queueListEl = document.querySelector("#queueList");
const queuePanelEl = document.querySelector("#queuePanel");
const queueSummaryEl = document.querySelector("#queueSummary");
const runPillEl = document.querySelector("#runPill");
const runSubtitleEl = document.querySelector("#runSubtitle");
const totalProgressEl = document.querySelector("#totalProgress");
const stepListEl = document.querySelector("#stepList");
const previewUrlEl = document.querySelector("#previewUrl");
const previewSkeletonEl = document.querySelector("#previewSkeleton");
const captureTagEl = document.querySelector("#captureTag");
const resultPillEl = document.querySelector("#resultPill");
const resultRowsEl = document.querySelector("#resultRows");
const sampleUrlsEl = document.querySelector("#sampleUrls");
const jumpLogsEl = document.querySelector("#jumpLogs");
const platformListViewEl = document.querySelector("#platformListView");
const platformConfigViewEl = document.querySelector("#platformConfigView");
const backToPlatformsEl = document.querySelector("#backToPlatforms");
const platformConfigTitleEl = document.querySelector("#platformConfigTitle");
const platformConfigCaptionEl = document.querySelector("#platformConfigCaption");
let lastLogId = 0;
let logPollTimer = 0;
let queueState = [];
let logEntries = [];
let logPage = 1;
const logPageSize = 20;

const stateTitleMap = new Map([
  ["Opening Chrome", "正在打开浏览器"],
  ["Chrome Ready", "浏览器已打开"],
  ["Open Failed", "打开失败"],
  ["Missing Credentials", "缺少账密"],
  ["Missing Login URL", "缺少登录地址"],
  ["Saving", "正在保存"],
  ["Saved", "已保存"],
  ["Save Failed", "保存失败"],
  ["Logging In", "正在登录"],
  ["Needs Check", "需要人工处理"],
  ["Login Submitted", "登录已提交"],
  ["Login Failed", "登录失败"],
  ["No URL", "缺少 URL"],
  ["Preparing", "正在准备"],
  ["Downloading", "正在下载"],
  ["Downloaded", "下载完成"],
  ["Export Failed", "导出失败"],
  ["Preview Updated", "截图已更新"],
  ["Preview Failed", "截图失败"],
  ["Ready", "准备就绪"]
]);

const platformDetails = {
  极客时间: "正文容器、付费登录态、滚动加载、PDF 分页",
  "知识库 / 文档站": "站点地图、侧边目录、批量层级导出",
  通用网页: "页面截图、正文识别、资源内联"
};

function localizeStateTitle(title) {
  return stateTitleMap.get(title) || title;
}

function parseUrls() {
  return urlsEl.value
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function setBusy(isBusy) {
  openBrowserEl.disabled = isBusy;
  autoLoginEl.disabled = isBusy;
  exportEl.disabled = isBusy;
  clearEl.disabled = isBusy;
  saveCredentialsEl.disabled = isBusy;
  refreshPreviewEl.disabled = isBusy;
}

function setState(kind, title, detail) {
  const displayTitle = localizeStateTitle(title);
  runStateEl.className = `run-card ${kind || ""}`.trim();
  stateTitleEl.textContent = displayTitle;
  stateDetailEl.textContent = detail;
  runPillEl.className = `status-pill ${kind === "done" ? "ok" : kind === "error" ? "error" : kind === "busy" ? "warn" : ""}`.trim();
  runPillEl.textContent = kind === "done" ? "已完成" : kind === "error" ? "失败" : kind === "busy" ? "执行中" : "待执行";
  runSubtitleEl.textContent = displayTitle;
  captureTagEl.textContent = detail || displayTitle;

  const progress = kind === "done" ? 100 : kind === "busy" ? 42 : kind === "error" ? 100 : 0;
  totalProgressEl.style.width = `${progress}%`;
  updateSteps(kind, displayTitle, detail);
}

function updateCount() {
  const urls = parseUrls();
  countEl.textContent = String(urls.length);
  renderQueue(urls);
}

function hostnameFromUrl(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return "invalid-url";
  }
}

function updateSteps(kind, title, detail = "") {
  const text = `${title} ${detail}`;
  let active = "ready";
  if (/打开|浏览器|登录|准备|预热/i.test(text)) active = "open";
  if (/scroll|滚动|加载/i.test(text)) active = "scroll";
  if (/PDF|生成|下载/i.test(text)) active = "pdf";
  if (kind === "done" || /完成|已生成|已关闭|结束/i.test(text)) active = "done";

  stepListEl.querySelectorAll(".step").forEach((step) => {
    step.classList.toggle("active", step.dataset.step === active);
  });
}

function renderQueue(urls = parseUrls()) {
  queuePanelEl.hidden = urls.length <= 1;
  queueState = urls.map((url, index) => ({
    url,
    host: hostnameFromUrl(url),
    duplicate: urls.indexOf(url) !== index,
    status: queueState[index]?.status || "waiting"
  }));

  const fragment = document.createDocumentFragment();
  queueState.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = `queue-item ${index === 0 ? "active" : ""}`.trim();

    const status = document.createElement("span");
    status.className = "queue-status";
    status.textContent = item.duplicate ? "!" : String(index + 1);

    const main = document.createElement("div");
    main.className = "queue-main";

    const url = document.createElement("div");
    url.className = "queue-url";
    url.textContent = item.url;

    const note = document.createElement("div");
    note.className = "queue-note";
    note.textContent = item.duplicate ? "重复地址，导出前建议处理" : "等待中";

    const host = document.createElement("span");
    host.className = "queue-host";
    host.textContent = item.host;

    main.append(url, note);
    row.append(status, main, host);
    fragment.append(row);
  });

  queueListEl.replaceChildren(fragment);
  queueSummaryEl.textContent = `0 / ${urls.length} 完成`;
  if (!urls.length) {
    queueSummaryEl.textContent = "0 / 0 完成";
    const empty = document.createElement("div");
    empty.className = "credential-meta";
    empty.textContent = "URL 列表为空。";
    queueListEl.append(empty);
  }

  const firstUrl = urls[0];
  previewUrlEl.textContent = firstUrl ? firstUrl.replace(/^https?:\/\//, "") : "等待 URL";
}

function filenameFromDisposition(header, fallback) {
  const match = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(header || "");
  if (!match) {
    return fallback;
  }
  return decodeURIComponent(match[1] || match[2]);
}

async function requestJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function formatLogTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString("zh-CN", { hour12: false });
}

function appendLogs(entries) {
  if (!entries?.length) {
    return;
  }
  const wasOnLastPage = logPage >= Math.max(1, Math.ceil(logEntries.length / logPageSize));
  for (const entry of entries) {
    lastLogId = Math.max(lastLogId, entry.id || 0);
    logEntries.push(entry);
    updateSteps("busy", entry.message || "", entry.meta ? JSON.stringify(entry.meta) : "");
  }
  if (logEntries.length > 300) {
    logEntries = logEntries.slice(-300);
  }
  if (wasOnLastPage) {
    logPage = Math.max(1, Math.ceil(logEntries.length / logPageSize));
  }
  renderLogs();
}

function renderLogs() {
  const totalPages = Math.max(1, Math.ceil(logEntries.length / logPageSize));
  logPage = Math.min(Math.max(1, logPage), totalPages);
  const pageEntries = logEntries.slice((logPage - 1) * logPageSize, logPage * logPageSize);
  const fragment = document.createDocumentFragment();

  for (const entry of pageEntries) {
    const row = document.createElement("div");
    row.className = "log-row";

    const head = document.createElement("div");
    head.className = "log-row-head";

    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = formatLogTime(entry.time);

    const message = document.createElement("span");
    message.className = "log-message";
    message.textContent = entry.message || "";

    head.append(time, message);
    row.append(head);

    if (entry.meta && Object.keys(entry.meta).length) {
      const meta = document.createElement("pre");
      meta.className = "log-meta";
      meta.textContent = JSON.stringify(entry.meta, null, 2);
      row.append(meta);
    }

    fragment.append(row);
  }
  logListEl.replaceChildren(fragment);
  logListEl.scrollTop = logListEl.scrollHeight;
  logEmptyEl.hidden = logEntries.length > 0;
  logListEl.hidden = pageEntries.length === 0;
  logPageInfoEl.textContent = `第 ${logPage} / ${totalPages} 页`;
  prevLogPageEl.disabled = logPage <= 1;
  nextLogPageEl.disabled = logPage >= totalPages;
}

async function refreshLogs() {
  const response = await fetch(`/api/logs?after=${lastLogId}`);
  if (!response.ok) {
    return;
  }
  const data = await response.json().catch(() => ({}));
  appendLogs(data.logs || []);
}

async function openLoginWindow() {
  setBusy(true);
  setState("busy", "Opening Chrome", "打开极客邦登录页。");
  try {
    const result = await requestJson("/api/open-browser", {
      loginUrl: loginUrlEl.value.trim()
    });
    setState("done", "Chrome Ready", result.openedUrl);
    try {
      await refreshLoginPreview();
    } catch (error) {
      setState("done", "Chrome Ready", `登录页已打开；截图刷新失败：${error.message}`);
    }
  } catch (error) {
    setState("error", "Open Failed", error.message);
  } finally {
    setBusy(false);
  }
}

function renderCredentialMeta(meta) {
  if (!meta?.configured) {
    credentialMetaEl.textContent = "未配置账密";
    credentialPillEl.className = "status-pill warn";
    credentialPillEl.textContent = "凭证未配置";
    platformCredentialTextEl.textContent = "未配置";
    platformLoginTextEl.textContent = "未配置";
    return;
  }
  usernameEl.value = meta.username || "";
  loginUrlEl.value = meta.loginUrl || "";
  credentialMetaEl.textContent = `已保存：${meta.username} · ${meta.updatedAt}`;
  credentialPillEl.className = "status-pill ok";
  credentialPillEl.textContent = "账号已配置";
  platformCredentialTextEl.textContent = `已保存：${meta.username || "未命名账号"}`;
  platformLoginTextEl.textContent = meta.loginUrl || "未配置";
}

async function saveCredentials(event) {
  event.preventDefault();
  const username = usernameEl.value.trim();
  const password = passwordEl.value;
  const loginUrl = loginUrlEl.value.trim();
  if (!username || !password) {
    setState("error", "Missing Credentials", "账号和密码都需要填写。");
    return;
  }
  if (!loginUrl) {
    setState("error", "Missing Login URL", "请填写账密登录地址。");
    return;
  }

  setBusy(true);
  setState("busy", "Saving", "账密会加密保存到本地 SQLite。");
  try {
    const meta = await requestJson("/api/credentials/geektime", {
      username,
      password,
      loginUrl
    });
    passwordEl.value = "";
    renderCredentialMeta(meta);
    setState("done", "Saved", "密码已加密保存，页面不会回显。");
  } catch (error) {
    setState("error", "Save Failed", error.message);
  } finally {
    setBusy(false);
  }
}

async function refreshLoginPreview() {
  const response = await fetch(`/api/login-screenshot?ts=${Date.now()}`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const oldSrc = loginScreenshotEl.src;
  loginScreenshotEl.src = URL.createObjectURL(blob);
  if (oldSrc.startsWith("blob:")) {
    URL.revokeObjectURL(oldSrc);
  }
  loginPreviewEl.hidden = false;
  previewSkeletonEl.hidden = true;
  captureTagEl.textContent = "登录截图已刷新";
}

async function autoLogin() {
  setBusy(true);
  setState("busy", "Logging In", "正在打开极客邦登录页并自动填写。");
  try {
    const result = await requestJson("/api/auto-login", {});
    const detail = result.needsManualAction
      ? "可能触发验证码、扫码或短信验证，需要人工接管。"
      : result.currentUrl || result.loginUrl || "登录流程已提交。";
    setState(result.needsManualAction ? "error" : "done", result.needsManualAction ? "Needs Check" : "Login Submitted", detail);
    if (result.needsManualAction) {
      await refreshLoginPreview();
    } else {
      loginPreviewEl.hidden = true;
    }
  } catch (error) {
    setState("error", "Login Failed", error.message);
    try {
      await refreshLoginPreview();
    } catch {
      // No open login page to preview.
    }
  } finally {
    setBusy(false);
  }
}

async function exportFiles() {
  const urls = parseUrls();
  if (!urls.length) {
    setState("error", "No URL", "请输入至少一个地址。");
    return;
  }

  setBusy(true);
  downloadInfoEl.hidden = true;
  setState("busy", "Preparing", "先打开预热页，再按随机间隔打开导出页。");
  try {
    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls, pace: paceEl.value, platform: targetPlatformEl.value })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    setState("busy", "Downloading", `${urls.length} 个文件`);
    const blob = await response.blob();
    const fallback = urls.length === 1 ? "html2pdf-export.pdf" : "html2pdf-export.zip";
    const filename = filenameFromDisposition(response.headers.get("content-disposition"), fallback);
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);

    downloadInfoEl.hidden = false;
    downloadNameEl.textContent = filename;
    renderDownloadResult(filename, blob.size, urls.length);
    setState("done", "Downloaded", `${Math.round(blob.size / 1024)} KB`);
  } catch (error) {
    setState("error", "Export Failed", error.message);
  } finally {
    setBusy(false);
  }
}

function renderDownloadResult(filename, size, urlCount) {
  const type = urlCount > 1 ? "ZIP" : "PDF";
  resultPillEl.className = "status-pill ok";
  resultPillEl.textContent = `${type} 已生成`;
  resultRowsEl.innerHTML = "";

  const row = document.createElement("tr");
  const file = document.createElement("td");
  file.className = "file-cell";
  file.textContent = filename;

  const kind = document.createElement("td");
  kind.textContent = type;

  const sizeCell = document.createElement("td");
  sizeCell.textContent = `${Math.max(1, Math.round(size / 1024))} KB`;

  row.append(file, kind, sizeCell);
  resultRowsEl.append(row);
  historyLatestEl.textContent = filename;
}

async function loadHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error("Server unavailable");
    }
    profileMetaEl.textContent = data.profileDir;
    renderCredentialMeta(data.credentials);
    statusDotEl.classList.add("ok");
    servicePillEl.className = "status-pill service ok";
    serviceTextEl.textContent = "服务在线";
    hostMetaEl.textContent = data.runtime?.hostLabel ||
      (location.hostname === "localhost" || location.hostname === "127.0.0.1" ? "本机" : "e540");
  } catch {
    profileMetaEl.textContent = "服务不可用";
    statusDotEl.classList.remove("ok");
    servicePillEl.className = "status-pill service error";
    serviceTextEl.textContent = "服务不可用";
  }
}

function startLogPolling() {
  if (logPollTimer) {
    return;
  }
  logPollTimer = window.setInterval(() => {
    refreshLogs().catch(() => undefined);
  }, 2000);
}

urlsEl.addEventListener("input", updateCount);
openBrowserEl.addEventListener("click", openLoginWindow);
autoLoginEl.addEventListener("click", autoLogin);
exportEl.addEventListener("click", exportFiles);
credentialsFormEl.addEventListener("submit", saveCredentials);
refreshPreviewEl.addEventListener("click", async () => {
  setBusy(true);
  try {
    await refreshLoginPreview();
    setState("done", "Preview Updated", "登录页截图已刷新。");
  } catch (error) {
    setState("error", "Preview Failed", error.message);
  } finally {
    setBusy(false);
  }
});
clearEl.addEventListener("click", () => {
  urlsEl.value = "";
  updateCount();
  setState("", "Ready", "单个地址下载 PDF，多个地址下载 ZIP。");
});

sampleUrlsEl.addEventListener("click", () => {
  urlsEl.value = "https://time.geekbang.org/column/article/999533?screen=full";
  updateCount();
  setState("", "Ready", "已填入极客时间示例地址。");
});

jumpLogsEl.addEventListener("click", () => {
  document.querySelector("#logPanel")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  logListEl.focus({ preventScroll: true });
});

prevLogPageEl.addEventListener("click", () => {
  logPage -= 1;
  renderLogs();
});

nextLogPageEl.addEventListener("click", () => {
  logPage += 1;
  renderLogs();
});

toggleLogFullscreenEl.addEventListener("click", () => {
  logPanelEl.classList.toggle("fullscreen");
  const isFullscreen = logPanelEl.classList.contains("fullscreen");
  toggleLogFullscreenEl.title = isFullscreen ? "退出全屏" : "日志全屏";
  toggleLogFullscreenEl.setAttribute("aria-label", toggleLogFullscreenEl.title);
});

document.querySelectorAll("[data-platform]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-platform]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    platformValueEl.textContent = button.dataset.platform || "自动识别";
  });
});

function populatePlatformSelect() {
  const platformRows = [...document.querySelectorAll("[data-platform-option]")].filter((row) => row.dataset.platformAvailable === "true");
  const options = platformRows.map((row) => {
    const option = document.createElement("option");
    option.value = row.dataset.platformOption || row.dataset.platformName;
    option.textContent = row.dataset.platformName || option.value;
    return option;
  });
  targetPlatformEl.replaceChildren(...options);
  if (![...targetPlatformEl.options].some((option) => option.value === "geektime")) {
    targetPlatformEl.add(new Option("极客时间", "geektime"), 0);
  }
  targetPlatformEl.value = "geektime";
}

function showPlatformList() {
  platformListViewEl.hidden = false;
  platformConfigViewEl.hidden = true;
}

function showPlatformConfig(platformName) {
  platformListViewEl.hidden = true;
  platformConfigViewEl.hidden = false;
  platformConfigTitleEl.textContent = `${platformName}配置`;
  platformConfigCaptionEl.textContent = platformDetails[platformName] || "平台导出策略配置";
}

document.querySelectorAll("[data-config-platform]").forEach((button) => {
  button.addEventListener("click", () => {
    showPlatformConfig(button.dataset.configPlatform || "平台");
  });
});

backToPlatformsEl.addEventListener("click", showPlatformList);

document.querySelectorAll("[data-config-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    const tab = button.dataset.configTab;
    document.querySelectorAll("[data-config-tab]").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelectorAll("[data-config-tab-panel]").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.configTabPanel === tab);
    });
  });
});

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    const view = button.dataset.view;
    document.querySelectorAll("[data-view]").forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    document.querySelectorAll("[data-view-panel]").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.viewPanel === view);
    });
    if (view === "platforms") {
      showPlatformList();
    }
  });
});

populatePlatformSelect();
updateCount();
renderLogs();
loadHealth().then(() => refreshLogs().catch(() => undefined));
startLogPolling();

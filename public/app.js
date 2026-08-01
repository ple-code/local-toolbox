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
const usernameFieldEl = usernameEl.closest(".field");
const loginUrlFieldEl = document.querySelector("#loginUrlField");
const passwordFieldEl = document.querySelector("#passwordField");
const saveCredentialsEl = document.querySelector("#saveCredentials");
const saveCredentialsTextEl = document.querySelector("#saveCredentialsText");
const credentialMetaEl = document.querySelector("#credentialMeta");
const loginUrlLabelEl = document.querySelector("#loginUrlLabel");
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
const platformLoginModeTextEl = document.querySelector("#platformLoginModeText");
const loginCaptionEl = document.querySelector("#loginCaption");
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
const refreshTasksEl = document.querySelector("#refreshTasks");
const taskHistoryListEl = document.querySelector("#taskHistoryList");
const taskHistoryEmptyEl = document.querySelector("#taskHistoryEmpty");
const taskHistoryPanelEl = document.querySelector("#taskHistoryPanel");
const taskDetailPanelEl = document.querySelector("#taskDetailPanel");
const taskDetailEl = document.querySelector("#taskDetail");
const taskDetailSubtitleEl = document.querySelector("#taskDetailSubtitle");
const downloadTaskFileEl = document.querySelector("#downloadTaskFile");
const backToTaskHistoryEl = document.querySelector("#backToTaskHistory");
const manualLoginPanelEl = document.querySelector("#manualLoginPanel");
const manualLoginScreenshotEl = document.querySelector("#manualLoginScreenshot");
const refreshManualLoginEl = document.querySelector("#refreshManualLogin");
const continueManualLoginEl = document.querySelector("#continueManualLogin");
let lastLogId = 0;
let logPollTimer = 0;
let queueState = [];
let logEntries = [];
let logPage = 1;
let currentConfigPlatformKey = "geektime";
let currentTaskId = "";
let selectedHistoryTaskId = "";
let taskLogActive = false;
let pendingManualLoginTaskId = "";
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
  ["Queued", "排队中"],
  ["Waiting Login", "等待扫码"],
  ["Downloading", "正在下载"],
  ["Downloaded", "下载完成"],
  ["Export Failed", "导出失败"],
  ["Preview Updated", "截图已更新"],
  ["Preview Failed", "截图失败"],
  ["Ready", "准备就绪"]
]);

const platformDetails = {
  极客时间: "正文容器、付费登录态、滚动加载、PDF 分页",
  微信公众号: "公开文章导出、无需登录、正文识别",
  知识星球: "付费内容登录态、滚动加载、PDF 分页",
  通用网页: "页面截图、正文识别、资源内联"
};

let platformCatalog = new Map();

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
  const authMode = platformCatalog.get(currentConfigPlatformKey)?.authMode || "credentials";
  const canOpenLogin = authMode === "credentials" || authMode === "manual";
  openBrowserEl.disabled = isBusy || !canOpenLogin;
  autoLoginEl.disabled = isBusy || authMode !== "credentials";
  exportEl.disabled = isBusy;
  clearEl.disabled = isBusy;
  saveCredentialsEl.disabled = isBusy || authMode === "none";
  refreshPreviewEl.disabled = isBusy || !canOpenLogin;
  refreshManualLoginEl.disabled = !pendingManualLoginTaskId;
  continueManualLoginEl.disabled = !pendingManualLoginTaskId;
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
  if (/排队|打开|浏览器|登录|扫码|准备|预热/i.test(text)) active = "open";
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

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value || "-" : date.toLocaleString("zh-CN", { hour12: false });
}

function statusText(status) {
  if (status === "succeeded") return "成功";
  if (status === "failed") return "失败";
  if (status === "running") return "执行中";
  if (status === "queued") return "排队中";
  if (status === "waiting_login") return "等待扫码";
  return status || "未知";
}

function statusClass(status) {
  if (status === "succeeded") return "ok";
  if (status === "failed") return "error";
  if (status === "running" || status === "queued" || status === "waiting_login") return "warn";
  return "";
}

function createTaskId() {
  return (crypto.randomUUID?.() || `task-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 80);
}

function appendLogs(entries) {
  if (!entries?.length) {
    return;
  }
  const wasOnNewestPage = logPage === 1;
  for (const entry of entries) {
    lastLogId = Math.max(lastLogId, entry.id || 0);
    logEntries.push(entry);
    updateSteps("busy", entry.message || "", entry.meta ? JSON.stringify(entry.meta) : "");
  }
  if (logEntries.length > 300) {
    logEntries = logEntries.slice(-300);
  }
  if (wasOnNewestPage) {
    logPage = 1;
  }
  renderLogs();
}

function renderLogs() {
  const totalPages = Math.max(1, Math.ceil(logEntries.length / logPageSize));
  logPage = Math.min(Math.max(1, logPage), totalPages);
  const newestFirstEntries = [...logEntries].reverse();
  const pageEntries = newestFirstEntries.slice((logPage - 1) * logPageSize, logPage * logPageSize);
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
      meta.hidden = true;
      message.classList.add("has-meta");
      message.tabIndex = 0;
      message.setAttribute("role", "button");
      message.title = "点击查看详情";
      const toggleMeta = () => {
        meta.hidden = !meta.hidden;
        row.classList.toggle("open", !meta.hidden);
      };
      message.addEventListener("click", toggleMeta);
      message.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleMeta();
        }
      });
      row.append(meta);
    }

    fragment.append(row);
  }
  logListEl.replaceChildren(fragment);
  logListEl.scrollTop = 0;
  logEmptyEl.hidden = logEntries.length > 0;
  logListEl.hidden = pageEntries.length === 0;
  logPageInfoEl.textContent = `第 ${logPage} / ${totalPages} 页`;
  prevLogPageEl.disabled = logPage <= 1;
  nextLogPageEl.disabled = logPage >= totalPages;
}

function clearLoginPreview() {
  const oldSrc = loginScreenshotEl.src;
  loginPreviewEl.hidden = true;
  loginScreenshotEl.removeAttribute("src");
  if (oldSrc?.startsWith("blob:")) {
    URL.revokeObjectURL(oldSrc);
  }
}

async function refreshLogs() {
  if (!taskLogActive || !currentTaskId) {
    return;
  }
  const response = await fetch(`/api/tasks/${encodeURIComponent(currentTaskId)}/logs?after=${lastLogId}`);
  if (!response.ok) {
    return;
  }
  const data = await response.json().catch(() => ({}));
  appendLogs(data.logs || []);
}

function startTaskLogSession(taskId) {
  currentTaskId = taskId;
  lastLogId = 0;
  logEntries = [];
  logPage = 1;
  taskLogActive = true;
  renderLogs();
}

async function refreshManualLoginPreview() {
  if (!pendingManualLoginTaskId) {
    return;
  }
  const response = await fetch(`/api/login-screenshot?platform=zsxq&taskId=${encodeURIComponent(pendingManualLoginTaskId)}&ts=${Date.now()}`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const oldSrc = manualLoginScreenshotEl.src;
  manualLoginScreenshotEl.src = URL.createObjectURL(blob);
  if (oldSrc?.startsWith("blob:")) {
    URL.revokeObjectURL(oldSrc);
  }
  manualLoginPanelEl.hidden = false;
}

function resetManualLoginPanel() {
  pendingManualLoginTaskId = "";
  const oldSrc = manualLoginScreenshotEl.src;
  manualLoginPanelEl.hidden = true;
  manualLoginScreenshotEl.removeAttribute("src");
  if (oldSrc?.startsWith("blob:")) {
    URL.revokeObjectURL(oldSrc);
  }
}

async function downloadFromResponse(response, urlCount) {
  setState("busy", "Downloading", `${urlCount} 个文件`);
  const blob = await response.blob();
  const fallback = urlCount === 1 ? "html2pdf-export.pdf" : "html2pdf-export.zip";
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
  renderDownloadResult(filename, blob.size, urlCount);
  setState("done", "Downloaded", `${Math.round(blob.size / 1024)} KB`);
}

async function openLoginWindow() {
  const platform = platformCatalog.get(currentConfigPlatformKey);
  if (platform?.authMode === "none") {
    setState("", "准备就绪", `${platform.name}无需登录。`);
    return;
  }
  setBusy(true);
  setState("busy", "Opening Chrome", `打开${platform?.name || "平台"}登录页。`);
  try {
    const result = await requestJson("/api/open-browser", {
      platform: currentConfigPlatformKey,
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

function renderCredentialMeta(meta, platform = platformCatalog.get(currentConfigPlatformKey)) {
  const platformName = platform?.name || "当前平台";
  const authMode = platform?.authMode || "credentials";
  const isManual = authMode === "manual";
  const canOpenLogin = authMode === "credentials" || authMode === "manual";
  loginCaptionEl.textContent = authMode === "credentials"
    ? `${platformName}账号与登录页`
    : authMode === "manual"
      ? `${platformName}微信扫码登录`
      : `${platformName}无需登录`;
  platformLoginModeTextEl.textContent = authMode === "credentials" ? "账号密码登录" : authMode === "manual" ? "手动扫码登录" : "无需登录";
  loginUrlLabelEl.textContent = isManual ? "手动登录地址" : "账密登录地址";
  saveCredentialsTextEl.textContent = isManual ? "保存登录地址" : "保存账密";
  usernameFieldEl.hidden = authMode !== "credentials";
  passwordFieldEl.hidden = authMode !== "credentials";
  loginUrlFieldEl.hidden = authMode === "none";
  autoLoginEl.hidden = authMode !== "credentials";
  usernameEl.disabled = authMode !== "credentials";
  passwordEl.disabled = authMode !== "credentials";
  loginUrlEl.disabled = authMode === "none";
  openBrowserEl.disabled = !canOpenLogin;
  autoLoginEl.disabled = authMode !== "credentials";
  saveCredentialsEl.disabled = authMode === "none";
  refreshPreviewEl.disabled = !canOpenLogin;

  if (authMode === "none") {
    usernameEl.value = "";
    passwordEl.value = "";
    loginUrlEl.value = "";
    credentialMetaEl.textContent = `${platformName}无需配置账密。`;
    credentialPillEl.className = "status-pill ok";
    credentialPillEl.textContent = "无需凭证";
    platformCredentialTextEl.textContent = "无需配置";
    platformLoginTextEl.textContent = "无需配置";
    return;
  }

  if (isManual) {
    usernameEl.value = "";
    passwordEl.value = "";
    loginUrlEl.value = meta?.loginUrl || "";
    credentialMetaEl.textContent = meta?.configured
      ? `已保存登录地址 · ${meta.updatedAt}`
      : "未配置手动登录地址";
    credentialPillEl.className = meta?.configured ? "status-pill ok" : "status-pill warn";
    credentialPillEl.textContent = meta?.configured ? "登录地址已配置" : "待配置登录地址";
    platformCredentialTextEl.textContent = "手动扫码登录";
    platformLoginTextEl.textContent = meta?.loginUrl || "未配置";
    return;
  }

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
  const platform = platformCatalog.get(currentConfigPlatformKey);
  if (platform?.authMode === "none") {
    setState("", "准备就绪", `${platform.name}无需保存账密。`);
    return;
  }
  const username = usernameEl.value.trim();
  const password = passwordEl.value;
  const loginUrl = loginUrlEl.value.trim();
  if (platform?.authMode === "credentials" && (!username || !password)) {
    setState("error", "Missing Credentials", "账号和密码都需要填写。");
    return;
  }
  if (!loginUrl) {
    setState("error", "Missing Login URL", platform?.authMode === "manual" ? "请填写手动登录地址。" : "请填写账密登录地址。");
    return;
  }

  setBusy(true);
  setState("busy", "Saving", platform?.authMode === "manual" ? "登录地址会保存到本地 SQLite。" : "账密会加密保存到本地 SQLite。");
  try {
    const meta = await requestJson(`/api/credentials/${encodeURIComponent(currentConfigPlatformKey)}`, {
      username,
      password,
      loginUrl
    });
    passwordEl.value = "";
    renderCredentialMeta(meta, platform);
    setState("done", "Saved", platform?.authMode === "manual" ? "登录地址已保存。" : "密码已加密保存，页面不会回显。");
  } catch (error) {
    setState("error", "Save Failed", error.message);
  } finally {
    setBusy(false);
  }
}

async function refreshLoginPreview() {
  const params = new URLSearchParams({
    ts: String(Date.now()),
    platform: currentConfigPlatformKey
  });
  const loginUrl = loginUrlEl.value.trim();
  if (loginUrl) {
    params.set("loginUrl", loginUrl);
  }
  const response = await fetch(`/api/login-screenshot?${params.toString()}`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    clearLoginPreview();
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
  const platform = platformCatalog.get(currentConfigPlatformKey);
  if (platform?.authMode !== "credentials") {
    const message = platform?.authMode === "manual" ? `${platform.name}需要打开登录窗口后手动扫码。` : `${platform.name}无需登录。`;
    setState("", "准备就绪", message);
    return;
  }
  setBusy(true);
  setState("busy", "Logging In", `正在打开${platform?.name || "平台"}登录页并自动填写。`);
  try {
    const result = await requestJson("/api/auto-login", { platform: currentConfigPlatformKey });
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
  resetManualLoginPanel();
  const taskId = createTaskId();
  startTaskLogSession(taskId);
  downloadInfoEl.hidden = true;
  setState("busy", "Preparing", "先打开预热页，再按随机间隔打开导出页。");
  try {
    if (targetPlatformEl.value === "zsxq") {
      const prepare = await requestJson("/api/export/prepare-login", {
        taskId,
        urls,
        pace: paceEl.value,
        platform: targetPlatformEl.value
      });
      pendingManualLoginTaskId = prepare.taskId || taskId;
      setState("busy", "Waiting Login", "知识星球登录页已打开，请扫码后继续导出。");
      try {
        await refreshManualLoginPreview();
      } catch (error) {
        manualLoginPanelEl.hidden = false;
        setState("error", "Preview Failed", `登录页已打开，但截图刷新失败：${error.message}`);
      }
      setBusy(true);
      return;
    }

    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId, urls, pace: paceEl.value, platform: targetPlatformEl.value })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    await downloadFromResponse(response, urls.length);
    loadTasks().catch(() => undefined);
  } catch (error) {
    setState("error", "Export Failed", error.message);
    loadTasks().catch(() => undefined);
    resetManualLoginPanel();
  } finally {
    refreshLogs().catch(() => undefined);
    if (!pendingManualLoginTaskId) {
      setBusy(false);
    }
  }
}

async function continueManualLoginExport() {
  if (!pendingManualLoginTaskId) {
    return;
  }
  const taskId = pendingManualLoginTaskId;
  const urls = parseUrls();
  setState("busy", "Preparing", "已确认扫码，继续导出知识星球文章。");
  setBusy(true);
  continueManualLoginEl.disabled = true;
  refreshManualLoginEl.disabled = true;
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    await downloadFromResponse(response, Math.max(1, urls.length));
    resetManualLoginPanel();
    loadTasks().catch(() => undefined);
  } catch (error) {
    setState("error", "Export Failed", error.message);
    resetManualLoginPanel();
    loadTasks().catch(() => undefined);
  } finally {
    refreshLogs().catch(() => undefined);
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

function appendKv(parent, label, value) {
  const row = document.createElement("div");
  row.className = "kv-row";
  const key = document.createElement("span");
  key.textContent = label;
  const val = document.createElement("strong");
  val.textContent = value || "-";
  row.append(key, val);
  parent.append(row);
}

function renderHistoryLogs(logs = []) {
  const list = document.createElement("div");
  list.className = "log-list history-log-list";
  if (!logs.length) {
    const empty = document.createElement("div");
    empty.className = "credential-meta";
    empty.textContent = "暂无任务日志";
    return empty;
  }

  for (const entry of logs) {
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
      meta.hidden = true;
      meta.textContent = JSON.stringify(entry.meta, null, 2);
      message.classList.add("has-meta");
      message.title = "点击查看详情";
      message.addEventListener("click", () => {
        meta.hidden = !meta.hidden;
      });
      row.append(meta);
    }
    list.append(row);
  }
  return list;
}

function renderTaskDetail(task, logs = []) {
  selectedHistoryTaskId = task.id;
  taskDetailSubtitleEl.textContent = `${task.platformName} · ${statusText(task.status)}`;
  downloadTaskFileEl.hidden = !(task.status === "succeeded" && task.result?.outputPath);
  taskDetailEl.replaceChildren();

  const summary = document.createElement("div");
  summary.className = "task-detail-grid";
  appendKv(summary, "任务 ID", task.id);
  appendKv(summary, "平台", task.platformName);
  appendKv(summary, "状态", statusText(task.status));
  appendKv(summary, "创建时间", formatDateTime(task.createdAt));
  appendKv(summary, "完成时间", formatDateTime(task.finishedAt));
  appendKv(summary, "文件", task.result?.filename || "无");
  appendKv(summary, "大小", task.result?.sizeKb ? `${task.result.sizeKb} KB` : "-");
  appendKv(summary, "错误", task.errorMessage || "-");

  const urls = document.createElement("div");
  urls.className = "task-section";
  const urlsTitle = document.createElement("h3");
  urlsTitle.textContent = "原始链接";
  const urlList = document.createElement("div");
  urlList.className = "task-url-list";
  for (const url of task.rawUrls || []) {
    const item = document.createElement("code");
    item.textContent = url;
    urlList.append(item);
  }
  urls.append(urlsTitle, urlList);

  const config = document.createElement("div");
  config.className = "task-section";
  const configTitle = document.createElement("h3");
  configTitle.textContent = "任务配置";
  const configBody = document.createElement("pre");
  configBody.className = "task-json";
  configBody.textContent = JSON.stringify(task.config || {}, null, 2);
  config.append(configTitle, configBody);

  const logSection = document.createElement("div");
  logSection.className = "task-section task-log-panel";
  const logHead = document.createElement("div");
  logHead.className = "task-section-head";
  const logTitle = document.createElement("h3");
  logTitle.textContent = "任务日志";
  const fullscreen = document.createElement("button");
  fullscreen.className = "icon-button";
  fullscreen.type = "button";
  fullscreen.title = "日志全屏";
  fullscreen.setAttribute("aria-label", "日志全屏");
  fullscreen.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
  fullscreen.addEventListener("click", () => {
    logSection.classList.toggle("fullscreen");
    const isFullscreen = logSection.classList.contains("fullscreen");
    fullscreen.title = isFullscreen ? "退出全屏" : "日志全屏";
    fullscreen.setAttribute("aria-label", fullscreen.title);
  });
  logHead.append(logTitle, fullscreen);
  logSection.append(logHead, renderHistoryLogs(logs));

  taskDetailEl.append(summary, urls, config, logSection);
}

async function loadTaskDetail(taskId) {
  const [taskResponse, logResponse] = await Promise.all([
    fetch(`/api/tasks/${encodeURIComponent(taskId)}`),
    fetch(`/api/tasks/${encodeURIComponent(taskId)}/logs?limit=500`)
  ]);
  const taskData = await taskResponse.json().catch(() => ({}));
  const logData = await logResponse.json().catch(() => ({}));
  if (!taskResponse.ok) {
    throw new Error(taskData.error || `HTTP ${taskResponse.status}`);
  }
  renderTaskDetail(taskData.task, logData.logs || []);
  taskHistoryPanelEl.hidden = true;
  taskDetailPanelEl.hidden = false;
}

function retryTask(task) {
  document.querySelector('[data-view="export"]')?.click();
  targetPlatformEl.value = task.platformKey || "generic";
  urlsEl.value = (task.rawUrls?.length ? task.rawUrls : task.normalizedUrls || []).join("\n");
  updateCount();
  resetManualLoginPanel();
  setState("", "Ready", "已从历史任务填入原始链接，可以重新导出。");
}

function renderTaskHistory(tasks = []) {
  taskHistoryListEl.replaceChildren();
  taskHistoryEmptyEl.hidden = tasks.length > 0;
  for (const task of tasks) {
    const row = document.createElement("div");
    row.className = "task-history-row";

    const main = document.createElement("div");
    main.className = "task-history-main";
    const title = document.createElement("strong");
    title.textContent = `${task.platformName} · ${task.rawUrls?.length || 0} 个 URL`;
    const meta = document.createElement("span");
    const fileName = task.result?.filename;
    const tail = fileName ? `文件：${fileName}` : (task.errorMessage || task.id);
    meta.textContent = `${formatDateTime(task.createdAt)} · ${tail}`;
    main.append(title, meta);

    const status = document.createElement("span");
    status.className = `status-pill ${statusClass(task.status)}`.trim();
    status.textContent = statusText(task.status);

    const detail = document.createElement("button");
    detail.className = "button secondary compact";
    detail.type = "button";
    detail.textContent = "详情";
    detail.addEventListener("click", () => {
      loadTaskDetail(task.id).catch((error) => {
        taskDetailEl.textContent = error.message;
      });
    });

    const download = document.createElement("button");
    download.className = "button primary compact";
    download.type = "button";
    download.textContent = "下载";
    download.hidden = !(task.status === "succeeded" && task.result?.outputPath);
    download.addEventListener("click", () => {
      window.location.href = `/api/tasks/${encodeURIComponent(task.id)}/download`;
    });

    const retry = document.createElement("button");
    retry.className = "button secondary compact";
    retry.type = "button";
    retry.textContent = "重试";
    retry.hidden = task.status !== "failed";
    retry.addEventListener("click", () => retryTask(task));

    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(status, detail, download, retry);
    row.append(main, actions);
    taskHistoryListEl.append(row);
  }
}

async function loadTasks() {
  const response = await fetch("/api/tasks?limit=50");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  renderTaskHistory(data.tasks || []);
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

refreshTasksEl.addEventListener("click", () => {
  taskHistoryPanelEl.hidden = false;
  taskDetailPanelEl.hidden = true;
  loadTasks().catch((error) => {
    taskHistoryEmptyEl.hidden = false;
    taskHistoryEmptyEl.textContent = error.message;
  });
});

downloadTaskFileEl.addEventListener("click", () => {
  if (!selectedHistoryTaskId) {
    return;
  }
  window.location.href = `/api/tasks/${encodeURIComponent(selectedHistoryTaskId)}/download`;
});

backToTaskHistoryEl.addEventListener("click", () => {
  taskDetailPanelEl.hidden = true;
  taskHistoryPanelEl.hidden = false;
});

refreshManualLoginEl.addEventListener("click", async () => {
  setBusy(true);
  try {
    await refreshManualLoginPreview();
    setState("busy", "Waiting Login", "二维码截图已刷新，扫码后继续导出。");
  } catch (error) {
    setState("error", "Preview Failed", error.message);
  } finally {
    setBusy(Boolean(pendingManualLoginTaskId));
  }
});

continueManualLoginEl.addEventListener("click", continueManualLoginExport);

function populatePlatformSelect() {
  const platformRows = [...document.querySelectorAll("[data-platform-option]")].filter((row) => row.dataset.platformAvailable === "true");
  platformCatalog = new Map(platformRows.map((row) => [row.dataset.platformOption, {
    key: row.dataset.platformOption,
    name: row.dataset.platformName || row.dataset.platformOption,
    authMode: row.dataset.platformAuthMode || "none",
    detail: platformDetails[row.dataset.platformName] || ""
  }]));
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

async function loadCredentialForPlatform(platformKey) {
  const platform = platformCatalog.get(platformKey);
  if (platform?.authMode === "none") {
    renderCredentialMeta({ configured: false }, platform);
    return;
  }
  try {
    const response = await fetch(`/api/credentials/${encodeURIComponent(platformKey)}`);
    const meta = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(meta.error || `HTTP ${response.status}`);
    }
    renderCredentialMeta(meta, platform);
  } catch (error) {
    renderCredentialMeta({ configured: false }, platform);
    credentialMetaEl.textContent = `读取${platform.name}账密配置失败：${error.message}`;
  }
}

function showPlatformList() {
  platformListViewEl.hidden = false;
  platformConfigViewEl.hidden = true;
}

function showPlatformConfig(platformName) {
  const platformRow = [...document.querySelectorAll("[data-platform-option]")]
    .find((row) => row.dataset.platformName === platformName);
  currentConfigPlatformKey = platformRow?.dataset.platformOption || currentConfigPlatformKey;
  const platform = platformCatalog.get(currentConfigPlatformKey);
  clearLoginPreview();
  platformListViewEl.hidden = true;
  platformConfigViewEl.hidden = false;
  platformConfigTitleEl.textContent = `${platform?.name || platformName}配置`;
  platformConfigCaptionEl.textContent = platform?.detail || platformDetails[platformName] || "平台导出策略配置";
  platformValueEl.textContent = platform?.name || platformName;
  loadCredentialForPlatform(currentConfigPlatformKey).catch(() => undefined);
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
    if (view === "history") {
      taskHistoryPanelEl.hidden = false;
      taskDetailPanelEl.hidden = true;
      loadTasks().catch((error) => {
        taskHistoryEmptyEl.hidden = false;
        taskHistoryEmptyEl.textContent = error.message;
      });
    }
  });
});

populatePlatformSelect();
updateCount();
renderLogs();
loadHealth();
loadTasks().catch(() => undefined);
startLogPolling();

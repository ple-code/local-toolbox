const urlsEl = document.querySelector("#urls");
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
const downloadInfoEl = document.querySelector("#downloadInfo");
const downloadNameEl = document.querySelector("#downloadName");
let lastLogId = 0;
let logPollTimer = 0;

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
  runStateEl.className = `run-state ${kind || ""}`.trim();
  stateTitleEl.textContent = title;
  stateDetailEl.textContent = detail;
}

function updateCount() {
  countEl.textContent = String(parseUrls().length);
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
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    lastLogId = Math.max(lastLogId, entry.id || 0);
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
  logListEl.append(fragment);
  while (logListEl.children.length > 50) {
    logListEl.firstElementChild.remove();
  }
  logListEl.scrollTop = logListEl.scrollHeight;
  logEmptyEl.hidden = logListEl.children.length > 0;
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
    await refreshLoginPreview();
  } catch (error) {
    setState("error", "Open Failed", error.message);
  } finally {
    setBusy(false);
  }
}

function renderCredentialMeta(meta) {
  if (!meta?.configured) {
    credentialMetaEl.textContent = "未配置账密";
    return;
  }
  usernameEl.value = meta.username || "";
  loginUrlEl.value = meta.loginUrl || "";
  credentialMetaEl.textContent = `已保存：${meta.username} · ${meta.updatedAt}`;
}

async function saveCredentials(event) {
  event.preventDefault();
  const username = usernameEl.value.trim();
  const password = passwordEl.value;
  if (!username || !password) {
    setState("error", "Missing Credentials", "账号和密码都需要填写。");
    return;
  }

  setBusy(true);
  setState("busy", "Saving", "账密会加密保存到本地 SQLite。");
  try {
    const meta = await requestJson("/api/credentials/geektime", {
      username,
      password,
      loginUrl: loginUrlEl.value.trim()
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
  setState("busy", "Preparing", "Warmup tab first, then random waits between tabs");
  try {
    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    setState("busy", "Downloading", `${urls.length} item${urls.length > 1 ? "s" : ""}`);
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
    setState("done", "Downloaded", `${Math.round(blob.size / 1024)} KB`);
  } catch (error) {
    setState("error", "Export Failed", error.message);
  } finally {
    setBusy(false);
  }
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
  } catch {
    profileMetaEl.textContent = "Server unavailable";
    statusDotEl.classList.remove("ok");
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

updateCount();
loadHealth().then(() => refreshLogs().catch(() => undefined));
startLogPolling();

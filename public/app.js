const urlsEl = document.querySelector("#urls");
const countEl = document.querySelector("#urlCount");
const profileMetaEl = document.querySelector("#profileMeta");
const statusDotEl = document.querySelector("#serverStatus");
const openBrowserEl = document.querySelector("#openBrowser");
const exportEl = document.querySelector("#export");
const clearEl = document.querySelector("#clear");
const runStateEl = document.querySelector("#runState");
const stateTitleEl = document.querySelector("#stateTitle");
const stateDetailEl = document.querySelector("#stateDetail");
const downloadInfoEl = document.querySelector("#downloadInfo");
const downloadNameEl = document.querySelector("#downloadName");

function parseUrls() {
  return urlsEl.value
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function setBusy(isBusy) {
  openBrowserEl.disabled = isBusy;
  exportEl.disabled = isBusy;
  clearEl.disabled = isBusy;
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

async function openLoginWindow() {
  const urls = parseUrls();
  if (!urls.length) {
    setState("error", "No URL", "请输入至少一个地址。");
    return;
  }

  setBusy(true);
  setState("busy", "Opening Chrome", "打开极客邦登录页。");
  try {
    const result = await requestJson("/api/open-browser", {});
    setState("done", "Chrome Ready", result.openedUrl);
  } catch (error) {
    setState("error", "Open Failed", error.message);
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
    statusDotEl.classList.add("ok");
  } catch {
    profileMetaEl.textContent = "Server unavailable";
    statusDotEl.classList.remove("ok");
  }
}

urlsEl.addEventListener("input", updateCount);
openBrowserEl.addEventListener("click", openLoginWindow);
exportEl.addEventListener("click", exportFiles);
clearEl.addEventListener("click", () => {
  urlsEl.value = "";
  updateCount();
  setState("", "Ready", "单个地址下载 PDF，多个地址下载 ZIP。");
});

updateCount();
loadHealth();

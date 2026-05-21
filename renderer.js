window.addEventListener("DOMContentLoaded", async () => {
  try {
    await window.api.getStartupData();
  } catch (err) {
    console.error(err);
  }
});

const mainEl = document.querySelector(".main");
const status = document.getElementById("version-b");
const localVersion = document.getElementById("local-version");
const serverVersion = document.getElementById("server-version");
const serverSource = document.getElementById("server-source");
const minimizeWindowBtn = document.getElementById("minimize-window-btn");
const closeWindowBtn = document.getElementById("close-window-btn");
const checkBtn = document.getElementById("check-btn");
const downloadBtn = document.getElementById("download-btn");
const cancelBtn = document.getElementById("cancel-btn");
const openFolderBtn = document.getElementById("open-folder-btn");
const launchBtn = document.getElementById("launch-btn");
const combinedProgress = document.getElementById("combined-progress");
const combinedPercent = document.getElementById("combined-percent");
const downloadStats = document.getElementById("download-stats");
const gameButtons = Array.from(document.querySelectorAll("[data-game]"));

const GAMES = {
  Barotrauma: {
    label: "Barotrauma",
    background: "assets/images/backgroundBarotrauma.png"
  },
  LethalCompany: {
    label: "Lethal Company",
    background: "assets/images/backgroundLethalCompany.jpg"
  },
  SlayTheSpire2: {
    label: "Slay the Spire 2",
    background: "assets/images/backgroundSlayTheSpire2.png"
  }
};

const DOWNLOAD_WEIGHT = 0.98;
const EXTRACT_WEIGHT = 0.02;

let currentGame = "Barotrauma";
let activeDownloadUrl = null;
let activeDownloadGame = null;
let isDownloadPaused = false;
let downloadInProgress = false;
let gameRunning = false;
let actionLock = false;
let versionCheckInProgress = false;

let downloadPercent = 0;
let extractPercent = 0;
let currentPhase = "idle";
let lastLoggedPercent = -1;
let lastLoggedReceived = 0;
let latestDownloadInfo = null;
let lastPeriodicLogMs = 0;
let lastSpeedSampleReceived = 0;
let lastSpeedSampleMs = 0;
let currentDownloadSpeedBps = 0;

const gamePresence = {};

function getPresence(gameName) {
  return gamePresence[gameName] || {
    installed: false,
    exeExists: false,
    updateAvailable: false,
    remoteAvailable: false,
    local: null,
    remote: null,
    downloadUrl: "",
    remoteSource: null
  };
}

function setPresence(gameName, installed, exeExists, updateAvailable = false, local = null, remote = null, remoteAvailable = false, downloadUrl = "", remoteSource = null) {
  gamePresence[gameName] = { installed, exeExists, updateAvailable, local, remote, remoteAvailable, downloadUrl, remoteSource };
}

function setStatusText(text) {
  status.textContent = text;
}

function formatVersion(value) {
  if (value === undefined || value === null || value === "") {
    return "\"-\"";
  }
  return "\"" + String(value) + "\"";
}

function setVersionText(local, remote) {
  if (localVersion) {
    localVersion.textContent = "ваша версия: " + formatVersion(local);
  }
  if (serverVersion) {
    serverVersion.textContent = "версия сервера: " + formatVersion(remote);
  }
}

function formatRemoteSource(source) {
  if (source === "github") return "GitHub";
  if (source === "yandex") return "Yandex Disk";
  return "-";
}

function setSourceText(source) {
  if (serverSource) {
    serverSource.textContent = "источник версии: " + formatRemoteSource(source);
  }
}

function renderCurrentGameStatus() {
  const presence = getPresence(currentGame);
  setVersionText(presence.local, presence.remote);
  setSourceText(presence.remoteSource);

  if (!presence.remoteAvailable) {
    status.textContent = "версия сервера недоступна";
  } else if (!presence.exeExists) {
    status.textContent = "игра не установлена";
  } else if (presence.updateAvailable) {
    status.textContent = "доступно обновление";
  } else {
    status.textContent = "игра установлена";
  }

  updatePlayButton();
}

function updateCombinedProgress() {
  const combined = Math.round(downloadPercent * DOWNLOAD_WEIGHT + extractPercent * EXTRACT_WEIGHT);
  combinedProgress.value = combined;
  combinedPercent.textContent = combined + "%";
}

function formatMegabytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function formatMegabytesOrDash(bytes) {
  return typeof bytes === "number" ? formatMegabytes(bytes) : "-";
}

function resetDownloadStats() {
  lastSpeedSampleReceived = 0;
  lastSpeedSampleMs = 0;
  currentDownloadSpeedBps = 0;
  if (downloadStats) {
    downloadStats.textContent = "";
  }
}

function updateDownloadStats(info) {
  if (!downloadStats) return;

  const now = Date.now();
  const received = Number(info.received) || 0;
  const total = Number(info.total) || 0;

  if (!lastSpeedSampleMs || received < lastSpeedSampleReceived) {
    lastSpeedSampleMs = now;
    lastSpeedSampleReceived = received;
  } else {
    const elapsedMs = now - lastSpeedSampleMs;
    const deltaBytes = received - lastSpeedSampleReceived;
    if (elapsedMs >= 250 && deltaBytes >= 0) {
      currentDownloadSpeedBps = deltaBytes / (elapsedMs / 1000);
      lastSpeedSampleMs = now;
      lastSpeedSampleReceived = received;
    }
  }

  const loadedText = total > 0
    ? formatMegabytes(received) + " / " + formatMegabytes(total) + " MB"
    : formatMegabytes(received) + " MB";
  downloadStats.textContent = loadedText + " · " + formatMegabytes(currentDownloadSpeedBps) + " MB/s";
}

async function pauseActiveDownload(statusText) {
  if (!downloadInProgress || currentPhase !== "download" || !activeDownloadUrl) return;

  isDownloadPaused = true;
  currentDownloadSpeedBps = 0;
  if (statusText) setStatusText(statusText);

  try {
    const res = await window.api.controlDownload("pause", activeDownloadUrl);
    if (!res || !res.ok) {
      console.warn("auto pause failed", res);
    } else if (typeof res.paused === "boolean") {
      isDownloadPaused = res.paused;
    }
  } catch (err) {
    console.warn("auto pause ipc error:", err);
  } finally {
    updatePlayButton();
  }
}

function updateDownloadButton() {
  if (downloadInProgress) {
    if (currentPhase === "extract") {
      downloadBtn.textContent = "extract";
      downloadBtn.disabled = true;
      return;
    }
    downloadBtn.textContent = isDownloadPaused ? "resume" : "pause";
    downloadBtn.disabled = false;
    return;
  }

  const presence = getPresence(currentGame);
  if (!presence.remoteAvailable) {
    downloadBtn.textContent = presence.installed && presence.exeExists ? "loaded" : "load";
    downloadBtn.disabled = true;
    return;
  }

  if (!presence.downloadUrl) {
    downloadBtn.textContent = presence.installed && presence.exeExists ? "update" : "load";
    downloadBtn.disabled = true;
    return;
  }

  if (presence.installed && presence.exeExists) {
    downloadBtn.textContent = presence.updateAvailable ? "update" : "loaded";
    downloadBtn.disabled = !presence.updateAvailable;
    return;
  }

  downloadBtn.textContent = "load";
  downloadBtn.disabled = false;
}

function updateCancelButton() {
  if (!cancelBtn) return;
  cancelBtn.disabled = !(downloadInProgress && currentPhase === "download" && activeDownloadUrl);
}

function updateCheckButton() {
  if (!checkBtn) return;
  checkBtn.disabled = downloadInProgress || versionCheckInProgress;
}

function updateFolderButton() {
  if (!openFolderBtn) return;
  const presence = getPresence(currentGame);
  openFolderBtn.disabled = downloadInProgress || !presence.installed;
}

function updatePlayButton() {
  updateDownloadButton();
  updateCancelButton();
  updateCheckButton();
  updateFolderButton();

  if (gameRunning) {
    launchBtn.textContent = "running";
    launchBtn.disabled = true;
    return;
  }
  if (downloadInProgress) {
    launchBtn.textContent = "play";
    launchBtn.disabled = true;
    return;
  }

  const presence = getPresence(currentGame);
  if (presence.installed && presence.exeExists) {
    launchBtn.textContent = "play";
    launchBtn.disabled = false;
    return;
  }

  launchBtn.textContent = "play";
  launchBtn.disabled = true;
}

function setCurrentGame(gameName, options = {}) {
  if (!GAMES[gameName]) return;
  const shouldRefresh = options.refresh !== false;
  if (downloadInProgress) {
    setStatusText("идет загрузка, переключение недоступно");
    return;
  }
  if (gameRunning) {
    setStatusText("игра запущена, переключение недоступно");
    return;
  }

  currentGame = gameName;
  resetDownloadStats();
  gameButtons.forEach(btn => {
    btn.classList.toggle("sidebar__button--active", btn.dataset.game === gameName);
  });

  if (mainEl) {
    mainEl.style.backgroundImage = "url(" + GAMES[gameName].background + ")";
  }

  if (shouldRefresh) {
    refreshVersionState(gameName);
  } else {
    renderCurrentGameStatus();
  }
  updatePlayButton();
}

gameButtons.forEach(btn => {
  btn.addEventListener("click", () => setCurrentGame(btn.dataset.game));
});

minimizeWindowBtn.addEventListener("click", () => {
  window.api.minimizeWindow();
});

closeWindowBtn.addEventListener("click", () => {
  window.api.closeWindow();
});

checkBtn.addEventListener("click", () => {
  refreshAllGames();
});

window.addEventListener("offline", () => {
  pauseActiveDownload("соединение прервано, загрузка на паузе");
});

window.addEventListener("online", () => {
  if (downloadInProgress && currentPhase === "download" && isDownloadPaused) {
    setStatusText("соединение восстановлено, нажмите resume");
    updatePlayButton();
  }
});

setInterval(() => {
  if (!downloadInProgress || currentPhase !== "download" || !latestDownloadInfo) return;
  const now = Date.now();
  if (now - lastPeriodicLogMs < 950) return;
  lastPeriodicLogMs = now;
  const received = latestDownloadInfo.received;
  const total = latestDownloadInfo.total;
  const pct = total > 0 ? Math.round((received / total) * 100) : 0;
  console.log("download", pct + "%", received, "/", total || "?");
}, 1000);

downloadBtn.addEventListener("click", async () => {
  if (actionLock) return;
  if (downloadInProgress) {
    if (!activeDownloadUrl || currentPhase !== "download") return;
    if (activeDownloadGame && activeDownloadGame !== currentGame) return;
    actionLock = true;
    const action = isDownloadPaused ? "resume" : "pause";
    try {
      const res = await window.api.controlDownload(action, activeDownloadUrl);
      if (!res || !res.ok) {
        console.warn("download-control failed", res);
      } else {
        isDownloadPaused = typeof res.paused === "boolean" ? res.paused : action === "pause";
        setStatusText(isDownloadPaused ? "загрузка на паузе" : "загрузка продолжается");
      }
    } finally {
      actionLock = false;
      updatePlayButton();
    }
    return;
  }

  const presence = getPresence(currentGame);
  if (!presence.remoteAvailable) {
    setStatusText("версия сервера недоступна");
    updatePlayButton();
    return;
  }
  const downloadUrl = presence.downloadUrl;
  if (!downloadUrl) {
    setStatusText("ссылка для скачивания не указана");
    updatePlayButton();
    return;
  }

  actionLock = true;
  try {
    downloadInProgress = true;
    isDownloadPaused = false;
    currentPhase = "download";
    activeDownloadGame = currentGame;
    resetDownloadStats();
    updatePlayButton();
    const res = await window.api.startDownload(downloadUrl, currentGame, presence.remote);
    activeDownloadUrl = downloadUrl;
    if (res && res.canceled) {
      downloadInProgress = false;
      activeDownloadUrl = null;
      activeDownloadGame = null;
      if (res.error === "remote_version_unavailable") {
        setStatusText("версия сервера недоступна");
      } else if (res.error === "download_url_unavailable") {
        setStatusText("ссылка для скачивания не указана");
      } else if (res.error === "download_already_running") {
        setStatusText("уже идет загрузка");
      } else if (res.error === "not_enough_space") {
        setStatusText("недостаточно места");
        if (downloadStats) {
          downloadStats.textContent = "свободно " + formatMegabytesOrDash(res.freeBytes) + " MB, нужно " + formatMegabytesOrDash(res.requiredBytes) + " MB";
        }
      }
      console.log("Download did not start", res.error || "canceled");
    } else {
      console.log("Download started, saving to", res.path);
    }
  } catch (err) {
    downloadInProgress = false;
    activeDownloadUrl = null;
    activeDownloadGame = null;
    console.error("Failed to start download:", err);
  } finally {
    actionLock = false;
    updatePlayButton();
  }
});

cancelBtn.addEventListener("click", async () => {
  if (actionLock || !downloadInProgress || currentPhase !== "download" || !activeDownloadUrl) return;

  actionLock = true;
  try {
    const res = await window.api.controlDownload("cancel", activeDownloadUrl);
    if (!res || !res.ok) {
      console.warn("download cancel failed", res);
    } else {
      setStatusText("отмена загрузки...");
    }
  } finally {
    actionLock = false;
    updatePlayButton();
  }
});

openFolderBtn.addEventListener("click", async () => {
  if (actionLock || downloadInProgress) return;

  const presence = getPresence(currentGame);
  if (!presence.installed) {
    setStatusText("папка игры не найдена");
    updatePlayButton();
    return;
  }

  actionLock = true;
  try {
    const res = await window.api.openGameFolder(currentGame);
    if (!res || !res.ok) {
      setStatusText(res && res.error === "not_found" ? "папка игры не найдена" : "ошибка открытия папки");
      console.warn("open folder failed", res);
    }
  } catch (err) {
    setStatusText("ошибка открытия папки");
    console.error("open folder ipc error:", err);
  } finally {
    actionLock = false;
    updatePlayButton();
  }
});

launchBtn.addEventListener("click", async () => {
  if (actionLock || gameRunning || downloadInProgress) return;

  const presence = getPresence(currentGame);
  if (!(presence.installed && presence.exeExists)) {
    setStatusText("игра не установлена");
    updatePlayButton();
    return;
  }

  actionLock = true;
  try {
    const res = await window.api.launchGame(currentGame);
    if (!res.ok) {
      if (res.error === "already_running") {
        gameRunning = true;
      } else if (res.error === "not_found") {
        setPresence(currentGame, false, false);
        setStatusText("файл запуска не найден");
      } else {
        console.warn("launch error:", res.message || res.error);
      }
    } else {
      gameRunning = true;
    }
  } catch (err) {
    console.error("launchGame ipc error:", err);
  } finally {
    actionLock = false;
    updatePlayButton();
  }
});

window.api.onDownloadProgress(info => {
  currentPhase = "download";
  latestDownloadInfo = info;
  downloadInProgress = true;
  isDownloadPaused = !!info.paused || info.state === "interrupted";
  if (isDownloadPaused) {
    currentDownloadSpeedBps = 0;
    setStatusText(info.canResume ? "соединение прервано, загрузка на паузе" : "загрузка прервана");
  }
  downloadPercent = info.total > 0 ? Math.round((info.received / info.total) * 100) : 0;
  updateDownloadStats(info);
  if (!info.total || info.total === 0) {
    if (info.received !== lastLoggedReceived) {
      console.log("download received", info.received);
      lastLoggedReceived = info.received;
    }
  } else if (downloadPercent !== lastLoggedPercent) {
    console.log("download", downloadPercent + "%", info.received, "/", info.total);
    lastLoggedPercent = downloadPercent;
  }
  updateCombinedProgress();
  updatePlayButton();
});

window.api.onDownloadDone(info => {
  activeDownloadUrl = null;
  isDownloadPaused = false;

  if (info.state !== "completed") {
    currentPhase = "error";
    downloadInProgress = false;
    activeDownloadGame = null;
    if (downloadStats) {
      downloadStats.textContent = info.state === "cancelled" ? "download canceled" : "download interrupted";
    }
    setStatusText(info.state === "cancelled" ? "загрузка отменена" : "ошибка загрузки");
    updatePlayButton();
    return;
  }
  currentPhase = "extract";
  if (downloadStats) {
    downloadStats.textContent = "checking archive...";
  }
  updatePlayButton();
});

window.api.onExtractStart(info => {
  currentPhase = "extract";
  extractPercent = 0;
  if (downloadStats) {
    downloadStats.textContent = "extracting...";
  }
  updateCombinedProgress();
  updatePlayButton();
});

window.api.onExtractProgress(info => {
  extractPercent = info.percent || 0;
  updateCombinedProgress();
});

window.api.onExtractDone(info => {
  extractPercent = 100;
  updateCombinedProgress();
  currentPhase = "done";
  downloadInProgress = false;
  activeDownloadGame = null;
  if (info.versionUpdate && !info.versionUpdate.ok && !info.versionUpdate.skipped) {
    console.warn("version update failed", info.versionUpdate);
  }
  if (downloadStats) {
    downloadStats.textContent = "ready";
  }
  refreshVersionState(currentGame);
  updatePlayButton();
});

window.api.onExtractError(info => {
  console.error(info.error);
  currentPhase = "error";
  downloadInProgress = false;
  activeDownloadGame = null;
  if (downloadStats) {
    downloadStats.textContent = "extract error";
  }
  setStatusText("ошибка архива");
  updatePlayButton();
});

window.api.onGameStarted(info => {
  gameRunning = true;
  updatePlayButton();
});

window.api.onGameExited(info => {
  gameRunning = false;
  updatePlayButton();
});

window.api.onGameError(info => {
  gameRunning = false;
  updatePlayButton();
  console.error("game error:", info.error || info.message || JSON.stringify(info));
});

async function refreshVersionState(gameName, options = {}) {
  const showLoading = options.showLoading !== false;

  try {
    if (showLoading && gameName === currentGame) {
      status.textContent = "проверка...";
      setVersionText(null, null);
      setSourceText(null);
      updatePlayButton();
    }

    const res = await window.api.checkVersion(gameName);
    if (!res.ok) {
      if (gameName === currentGame) {
        status.textContent = "ошибка проверки версии";
        updatePlayButton();
      }
      return;
    }

    setPresence(gameName, !!res.installed, !!res.exeExists, !!res.updateAvailable, res.local, res.remote, !!res.remoteAvailable, res.downloadUrl || "", res.remoteSource || null);
    if (gameName === currentGame) {
      renderCurrentGameStatus();
    }
  } catch (err) {
    console.error("refreshVersionState error:", err);
    if (gameName === currentGame) {
      status.textContent = "ошибка при проверке версии";
      setVersionText(null, null);
      setSourceText(null);
    }
  } finally {
    if (gameName === currentGame) {
      updatePlayButton();
    }
  }
}

async function refreshAllGames() {
  if (versionCheckInProgress || downloadInProgress) return;

  versionCheckInProgress = true;
  status.textContent = "проверка...";
  setVersionText(null, null);
  setSourceText(null);
  updatePlayButton();

  const checks = Object.keys(GAMES).map(gameName => (
    refreshVersionState(gameName, { showLoading: gameName === currentGame })
  ));

  try {
    await Promise.allSettled(checks);
  } finally {
    versionCheckInProgress = false;
    renderCurrentGameStatus();
    updatePlayButton();
  }
}

setCurrentGame(currentGame, { refresh: false });
refreshAllGames();

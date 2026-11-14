window.addEventListener("DOMContentLoaded", async () => {
  try {
    await window.api.getStartupData();
  } catch (err) {
    console.error(err);
  }
});

function normalizeRendererLogArg(arg) {
  if (arg instanceof Error) {
    return arg.stack || (arg.name + ": " + arg.message);
  }
  if (typeof arg === "string") {
    return arg;
  }
  if (arg === null || arg === undefined) {
    return String(arg);
  }
  if (typeof arg === "object") {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

function setupRendererLogging() {
  if (!window.api || typeof window.api.writeRendererLog !== "function") return;

  ["log", "warn", "error"].forEach(level => {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      try {
        const result = window.api.writeRendererLog(level, args.map(normalizeRendererLogArg));
        if (result && typeof result.catch === "function") {
          result.catch(() => {});
        }
      } catch {}
    };
  });
}

setupRendererLogging();

const mainEl = document.querySelector(".main");
const gamePlaceholder = document.getElementById("game-placeholder");
const status = document.getElementById("version-b");
const localVersion = document.getElementById("local-version");
const serverVersion = document.getElementById("server-version");
const serverSource = document.getElementById("server-source");
const launcherVersion = document.getElementById("launcher-version");
const launcherUpdateStatus = document.getElementById("launcher-update-status");
const launcherUpdateBtn = document.getElementById("launcher-update-btn");
const openLogsBtn = document.getElementById("open-logs-btn");
const firstRunOverlay = document.getElementById("first-run-overlay");
const firstRunChooseBtn = document.getElementById("first-run-choose-btn");
const firstRunError = document.getElementById("first-run-error");
const minimizeWindowBtn = document.getElementById("minimize-window-btn");
const closeWindowBtn = document.getElementById("close-window-btn");
const checkBtn = document.getElementById("check-btn");
const downloadBtn = document.getElementById("download-btn");
const cancelBtn = document.getElementById("cancel-btn");
const gamesDirBtn = document.getElementById("games-dir-btn");
const openFolderBtn = document.getElementById("open-folder-btn");
const launchBtn = document.getElementById("launch-btn");
const combinedProgress = document.getElementById("combined-progress");
const combinedPercent = document.getElementById("combined-percent");
const downloadStats = document.getElementById("download-stats");
const gamesFolder = document.getElementById("games-folder");
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
  },
  CasualtiesUnknown: {
    label: "Casualties Unknown",
    background: "assets/images/backgroundCasualtiesUnknown.png",
    backgroundSize: "cover"
  }
};

const DOWNLOAD_WEIGHT = 0.98;
const EXTRACT_WEIGHT = 0.02;
const WRITE_PERMISSION_MESSAGE = "Нет прав записи в папку игр. Выберите другую папку или запустите от имени администратора.";
const BUTTON_TEXT = {
  load: "Скачать",
  update: "Обновить",
  loaded: "Установлено",
  pause: "Пауза",
  resume: "Продолжить",
  extract: "Распаковка",
  play: "Играть",
  running: "Запущено"
};

let currentGame = "Barotrauma";
let activeDownloadUrl = null;
let activeDownloadGame = null;
let isDownloadPaused = false;
let downloadInProgress = false;
let gameRunning = false;
let actionLock = false;
let versionCheckInProgress = false;
let launcherWriteAccess = { ok: true };
let launcherUpdateState = { status: "idle", currentVersion: null };
let launcherUpdateActionLock = false;
let gamesDirPath = "";
let gamesDirConfigured = true;

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
    downloadPending: false,
    local: null,
    remote: null,
    downloadUrl: "",
    remoteSource: null,
    manifestOk: true,
    manifestMissing: [],
    dirName: null,
    exeName: null,
    expectedGameDir: null,
    expectedExePath: null,
    candidateGameDir: null,
    candidateExePath: null,
    candidateDirName: null
  };
}

function setPresence(gameName, installed, exeExists, updateAvailable = false, local = null, remote = null, remoteAvailable = false, downloadUrl = "", remoteSource = null, details = {}) {
  gamePresence[gameName] = {
    installed,
    exeExists,
    updateAvailable,
    local,
    remote,
    remoteAvailable,
    downloadPending: !!details.downloadPending,
    downloadUrl,
    remoteSource,
    manifestOk: details.manifestOk === undefined ? true : !!details.manifestOk,
    manifestMissing: Array.isArray(details.manifestMissing) ? details.manifestMissing : [],
    dirName: details.dirName || null,
    exeName: details.exeName || null,
    expectedGameDir: details.expectedGameDir || null,
    expectedExePath: details.expectedExePath || null,
    candidateGameDir: details.candidateGameDir || null,
    candidateExePath: details.candidateExePath || null,
    candidateDirName: details.candidateDirName || null
  };
}

function setStatusText(text, title = "") {
  status.textContent = text;
  status.title = title || "";
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

function formatMissingManifestFields(fields) {
  const list = Array.isArray(fields) ? fields.filter(Boolean) : [];
  return list.length ? list.join(", ") : "-";
}

function getExeDiagnosticTitle(info) {
  const lines = [];
  if (info.expectedExePath) {
    lines.push("Лаунчер ищет: " + info.expectedExePath);
  }
  if (info.candidateExePath) {
    lines.push("Найдено в другой папке: " + info.candidateExePath);
  }
  return lines.join("\n");
}

function setSourceText(source) {
  if (serverSource) {
    serverSource.textContent = "источник версии: " + formatRemoteSource(source);
  }
}

function setGamesFolderText(folderPath) {
  gamesDirPath = folderPath || "";
  if (!gamesFolder) return;
  gamesFolder.textContent = "папка игр: " + (gamesDirConfigured ? (gamesDirPath || "-") : "не выбрана");
  gamesFolder.title = gamesDirPath || "";
}

function setFirstRunVisible(visible) {
  if (!firstRunOverlay) return;
  firstRunOverlay.classList.toggle("first-run-overlay--hidden", !visible);
}

function setFirstRunError(text) {
  if (firstRunError) {
    firstRunError.textContent = text || "";
  }
}

function getLauncherUpdateStatusText(state) {
  const status = state && state.status ? state.status : "idle";
  const availableVersion = state && state.availableVersion ? state.availableVersion : null;
  const progress = state && state.progress ? state.progress : null;

  if (status === "dev") return "обновления доступны только в сборке";
  if (status === "checking") return "проверка обновления...";
  if (status === "available") return "доступна версия: " + availableVersion;
  if (status === "downloading") {
    const percent = progress && typeof progress.percent === "number" ? Math.round(progress.percent) : 0;
    return "загрузка обновления: " + percent + "%";
  }
  if (status === "downloaded") return "обновление готово к установке";
  if (status === "installing") return "установка обновления...";
  if (status === "none") return "обновлений нет";
  if (status === "error") return "ошибка проверки обновления";
  return "обновление не проверено";
}

function getLauncherUpdateButtonText(state) {
  const status = state && state.status ? state.status : "idle";
  if (status === "available") return "Обновить лаунчер";
  if (status === "downloaded") return "Перезапустить";
  if (status === "checking") return "Проверка...";
  if (status === "downloading") return "Загрузка...";
  if (status === "installing") return "Установка...";
  if (status === "dev") return "Dev режим";
  return "Проверить лаунчер";
}

function renderLauncherUpdateState(state) {
  launcherUpdateState = state || launcherUpdateState;
  if (launcherVersion) {
    launcherVersion.textContent = "версия лаунчера: " + formatVersion(launcherUpdateState.currentVersion);
  }
  if (launcherUpdateStatus) {
    launcherUpdateStatus.textContent = getLauncherUpdateStatusText(launcherUpdateState);
    launcherUpdateStatus.title = launcherUpdateState.error || "";
  }
  if (launcherUpdateBtn) {
    const status = launcherUpdateState.status || "idle";
    const busy = status === "checking" || status === "downloading" || status === "installing";
    launcherUpdateBtn.textContent = getLauncherUpdateButtonText(launcherUpdateState);
    launcherUpdateBtn.disabled = busy || status === "dev" || launcherUpdateActionLock || downloadInProgress || gameRunning;
  }
}

function renderCurrentGameStatus() {
  const presence = getPresence(currentGame);
  setVersionText(presence.local, presence.remote);
  setSourceText(presence.remoteSource);

  if (!gamesDirConfigured) {
    setStatusText("выберите папку установки игр");
  } else if (!launcherWriteAccess.ok) {
    setStatusText(WRITE_PERMISSION_MESSAGE);
  } else if (presence.downloadPending) {
    setStatusText(presence.exeExists ? "игра установлена, скачивание пока недоступно" : "скачивание пока недоступно");
  } else if (!presence.remoteAvailable) {
    setStatusText("версия сервера недоступна");
  } else if (presence.manifestOk === false) {
    setStatusText("данные сервера неполные: " + formatMissingManifestFields(presence.manifestMissing));
  } else if (!presence.exeExists && presence.candidateExePath) {
    setStatusText("папка игры не совпадает с сервером", getExeDiagnosticTitle(presence));
  } else if (!presence.exeExists) {
    setStatusText(presence.installed ? "файл запуска не найден" : "игра не установлена", getExeDiagnosticTitle(presence));
  } else if (presence.updateAvailable) {
    setStatusText("доступно обновление");
  } else {
    setStatusText("игра установлена");
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
      downloadBtn.textContent = BUTTON_TEXT.extract;
      downloadBtn.disabled = true;
      return;
    }
    downloadBtn.textContent = isDownloadPaused ? BUTTON_TEXT.resume : BUTTON_TEXT.pause;
    downloadBtn.disabled = false;
    return;
  }

  const presence = getPresence(currentGame);
  if (!gamesDirConfigured) {
    downloadBtn.textContent = BUTTON_TEXT.load;
    downloadBtn.disabled = true;
    return;
  }

  if (!launcherWriteAccess.ok) {
    downloadBtn.textContent = presence.installed && presence.exeExists
      ? (presence.updateAvailable ? BUTTON_TEXT.update : BUTTON_TEXT.loaded)
      : BUTTON_TEXT.load;
    downloadBtn.disabled = true;
    return;
  }

  if (!presence.remoteAvailable) {
    downloadBtn.textContent = presence.installed && presence.exeExists ? BUTTON_TEXT.loaded : BUTTON_TEXT.load;
    downloadBtn.disabled = true;
    return;
  }

  if (presence.manifestOk === false) {
    downloadBtn.textContent = presence.installed && presence.exeExists ? BUTTON_TEXT.update : BUTTON_TEXT.load;
    downloadBtn.disabled = true;
    return;
  }

  if (!presence.downloadUrl) {
    downloadBtn.textContent = presence.installed && presence.exeExists ? BUTTON_TEXT.update : BUTTON_TEXT.load;
    downloadBtn.disabled = true;
    return;
  }

  if (presence.installed && presence.exeExists) {
    downloadBtn.textContent = presence.updateAvailable ? BUTTON_TEXT.update : BUTTON_TEXT.loaded;
    downloadBtn.disabled = !presence.updateAvailable;
    return;
  }

  downloadBtn.textContent = BUTTON_TEXT.load;
  downloadBtn.disabled = false;
}

function updateCancelButton() {
  if (!cancelBtn) return;
  cancelBtn.disabled = !(downloadInProgress && currentPhase === "download" && activeDownloadUrl);
}

function updateCheckButton() {
  if (!checkBtn) return;
  checkBtn.disabled = !gamesDirConfigured || downloadInProgress || versionCheckInProgress;
}

function updateFolderButton() {
  if (!openFolderBtn) return;
  const presence = getPresence(currentGame);
  openFolderBtn.disabled = !gamesDirConfigured || downloadInProgress || (!presence.installed && !presence.candidateGameDir);
}

function updatePlayButton() {
  updateDownloadButton();
  updateCancelButton();
  updateCheckButton();
  updateFolderButton();
  renderLauncherUpdateState(launcherUpdateState);
  if (gamesDirBtn) {
    gamesDirBtn.disabled = downloadInProgress || gameRunning || versionCheckInProgress;
  }

  if (gameRunning) {
    launchBtn.textContent = BUTTON_TEXT.running;
    launchBtn.disabled = true;
    return;
  }
  if (downloadInProgress) {
    launchBtn.textContent = BUTTON_TEXT.play;
    launchBtn.disabled = true;
    return;
  }
  if (!gamesDirConfigured) {
    launchBtn.textContent = BUTTON_TEXT.play;
    launchBtn.disabled = true;
    return;
  }

  const presence = getPresence(currentGame);
  if (presence.installed && presence.exeExists) {
    launchBtn.textContent = BUTTON_TEXT.play;
    launchBtn.disabled = false;
    return;
  }

  launchBtn.textContent = BUTTON_TEXT.play;
  launchBtn.disabled = true;
}

async function refreshGamesDirState() {
  try {
    const res = await window.api.getGamesDir();
    gamesDirConfigured = !!(res && res.configured);
    setGamesFolderText(res && res.path ? res.path : "");
    setFirstRunVisible(!gamesDirConfigured);
    launcherWriteAccess = res && res.writeAccess && typeof res.writeAccess.ok === "boolean"
      ? res.writeAccess
      : { ok: false };
  } catch (err) {
    console.error("getGamesDir error:", err);
    gamesDirConfigured = false;
    setGamesFolderText("");
    setFirstRunVisible(true);
    launcherWriteAccess = { ok: false };
  } finally {
    renderCurrentGameStatus();
    updatePlayButton();
  }
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
    const background = GAMES[gameName].background;
    mainEl.style.backgroundImage = background ? "url(" + background + ")" : "none";
    mainEl.style.backgroundSize = GAMES[gameName].backgroundSize || "";
    mainEl.style.backgroundPosition = GAMES[gameName].backgroundSize ? "center" : "";
    mainEl.classList.toggle("main--no-background", !background);
    if (gamePlaceholder) {
      gamePlaceholder.textContent = GAMES[gameName].label;
      gamePlaceholder.hidden = !!background;
    }
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

launcherUpdateBtn.addEventListener("click", async () => {
  if (launcherUpdateActionLock || downloadInProgress || gameRunning) return;

  launcherUpdateActionLock = true;
  renderLauncherUpdateState(launcherUpdateState);
  try {
    const statusName = launcherUpdateState.status || "idle";
    if (statusName === "available") {
      const downloadedState = await window.api.downloadLauncherUpdate();
      renderLauncherUpdateState(downloadedState);
      if (downloadedState && (downloadedState.status === "downloaded" || downloadedState.downloaded)) {
        await window.api.installLauncherUpdate();
      }
      return;
    }

    if (statusName === "downloaded") {
      await window.api.installLauncherUpdate();
      return;
    }

    const checkedState = await window.api.checkLauncherUpdate();
    renderLauncherUpdateState(checkedState);
  } catch (err) {
    console.error("launcher update action failed:", err);
    renderLauncherUpdateState({
      ...launcherUpdateState,
      status: "error",
      error: err && err.message ? err.message : String(err)
    });
  } finally {
    launcherUpdateActionLock = false;
    renderLauncherUpdateState(launcherUpdateState);
  }
});

if (openLogsBtn) {
  openLogsBtn.addEventListener("click", async () => {
    try {
      const res = await window.api.openLogs();
      if (!res || !res.ok) {
        setStatusText("ошибка открытия логов");
        console.warn("open logs failed", res);
      }
    } catch (err) {
      setStatusText("ошибка открытия логов");
      console.error("open logs ipc error:", err);
    }
  });
}

async function chooseGamesDirFromUser() {
  if (actionLock || downloadInProgress || gameRunning) return;

  actionLock = true;
  setFirstRunError("");
  try {
    const res = await window.api.chooseGamesDir();
    if (!res || res.canceled) return;
    if (!res.ok) {
      gamesDirConfigured = !!res.configured;
      if (res.path) setGamesFolderText(res.path);
      launcherWriteAccess = res.writeAccess || { ok: false };
      setFirstRunVisible(!gamesDirConfigured);
      setFirstRunError("Нет прав записи в выбранную папку.");
      setStatusText(WRITE_PERMISSION_MESSAGE);
      updatePlayButton();
      return;
    }

    gamesDirConfigured = true;
    setGamesFolderText(res.path);
    setFirstRunVisible(false);
    launcherWriteAccess = res.writeAccess || { ok: true, path: res.path };
    setStatusText("папка игр выбрана");
    await refreshAllGames();
  } catch (err) {
    setStatusText("ошибка выбора папки");
    console.error("chooseGamesDir error:", err);
  } finally {
    actionLock = false;
    renderCurrentGameStatus();
    updatePlayButton();
  }
}

gamesDirBtn.addEventListener("click", chooseGamesDirFromUser);

if (firstRunChooseBtn) {
  firstRunChooseBtn.addEventListener("click", chooseGamesDirFromUser);
}

window.addEventListener("offline", () => {
  pauseActiveDownload("соединение прервано, загрузка на паузе");
});

window.addEventListener("online", () => {
  if (downloadInProgress && currentPhase === "download" && isDownloadPaused) {
    setStatusText("соединение восстановлено, нажмите Продолжить");
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
  if (!gamesDirConfigured) {
    setStatusText("выберите папку установки игр");
    setFirstRunVisible(true);
    updatePlayButton();
    return;
  }

  if (!launcherWriteAccess.ok) {
    setStatusText(WRITE_PERMISSION_MESSAGE);
    updatePlayButton();
    return;
  }

  if (!presence.remoteAvailable) {
    setStatusText("версия сервера недоступна");
    updatePlayButton();
    return;
  }
  if (presence.manifestOk === false) {
    setStatusText("данные сервера неполные: " + formatMissingManifestFields(presence.manifestMissing));
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
    const res = await window.api.startDownload(downloadUrl, currentGame, presence.remote, presence.dirName);
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
      } else if (res.error === "manifest_invalid") {
        setStatusText("данные сервера неполные: " + formatMissingManifestFields(res.missing));
      } else if (res.error === "not_enough_space") {
        setStatusText("недостаточно места");
        if (downloadStats) {
          downloadStats.textContent = "свободно " + formatMegabytesOrDash(res.freeBytes) + " MB, нужно " + formatMegabytesOrDash(res.requiredBytes) + " MB";
        }
      } else if (res.error === "games_dir_not_writable" || res.error === "launcher_dir_not_writable") {
        launcherWriteAccess = res.writeAccess || { ok: false };
        setStatusText(WRITE_PERMISSION_MESSAGE);
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
  if (!presence.installed && !presence.candidateGameDir) {
    setStatusText("папка игры не найдена", getExeDiagnosticTitle(presence));
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
        const diagnostic = {
          expectedExePath: res.expectedExePath,
          candidateExePath: res.candidateExePath
        };
        setStatusText(
          res.candidateExePath ? "папка игры не совпадает с сервером" : "файл запуска не найден",
          getExeDiagnosticTitle(diagnostic)
        );
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

window.api.onLauncherUpdateState(state => {
  renderLauncherUpdateState(state);
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
      downloadStats.textContent = info.state === "cancelled" ? "загрузка отменена" : "загрузка прервана";
    }
    setStatusText(info.state === "cancelled" ? "загрузка отменена" : "ошибка загрузки");
    updatePlayButton();
    return;
  }
  currentPhase = "extract";
  if (downloadStats) {
    downloadStats.textContent = "проверка архива...";
  }
  updatePlayButton();
});

window.api.onExtractStart(info => {
  currentPhase = "extract";
  extractPercent = 0;
  if (downloadStats) {
    downloadStats.textContent = "распаковка...";
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
    downloadStats.textContent = "готово";
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
    downloadStats.textContent = "ошибка распаковки";
  }
  if (info.code === "archive_root_mismatch") {
    setStatusText(
      "папка в архиве не совпадает с сервером",
      "Ожидалось: " + (info.expectedRootName || "-") + "\nВ архиве: " + (info.actualRootName || "-")
    );
  } else {
    setStatusText("ошибка архива", info.error || "");
  }
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

    setPresence(gameName, !!res.installed, !!res.exeExists, !!res.updateAvailable, res.local, res.remote, !!res.remoteAvailable, res.downloadUrl || "", res.remoteSource || null, {
      manifestOk: res.manifestOk,
      downloadPending: res.downloadPending,
      manifestMissing: res.manifestMissing,
      dirName: res.dirName,
      exeName: res.exeName,
      expectedGameDir: res.expectedGameDir,
      expectedExePath: res.expectedExePath,
      candidateGameDir: res.candidateGameDir,
      candidateExePath: res.candidateExePath,
      candidateDirName: res.candidateDirName
    });
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

async function refreshLauncherUpdateState() {
  try {
    const state = await window.api.getLauncherUpdateState();
    renderLauncherUpdateState(state);
  } catch (err) {
    console.error("getLauncherUpdateState error:", err);
  }
}

setCurrentGame(currentGame, { refresh: false });
refreshLauncherUpdateState();
refreshGamesDirState().then(() => {
  if (gamesDirConfigured) {
    refreshAllGames();
  }
}).catch(err => {
  console.error("initial games dir check failed:", err);
});

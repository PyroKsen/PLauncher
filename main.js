const { app, BrowserWindow, ipcMain, session } = require('electron/main')
const { shell, dialog, Menu, Notification, Tray } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('url');
const fs = require('fs');
const unzipper = require('unzipper');
const fsExtra = require('fs-extra');
const fsp = fs.promises;
const { pipeline } = require('node:stream/promises');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');


let gameLaunchInProgress = false;

const pending = new Map(); // url -> { savePath, gameName, version }
const active = new Map(); // url -> DownloadItem
const activePaths = new Map(); // url -> savePath
const activeMetadata = new Map(); // url -> { savePath, gameName, version }
const FREE_SPACE_BUFFER_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_SPACE_MULTIPLIER = 2;
const DOWNLOAD_FILE_PREFIX = '.plauncher-download-';
const WRITE_TEST_PREFIX = '.pl_launcher_write_test_';
const WINDOW_ICON = path.join(__dirname, 'assets', 'images', 'иконка лаунчер.png');
const TRAY_ICON = path.join(__dirname, 'assets', 'images', 'иконка-лаунчер.ico');
const APP_USER_MODEL_ID = 'com.pyroksen.plauncher';
const AUTOSTART_ARG = '--launch-in-tray';
const GAME_UPDATE_INTERVAL_MS = 30 * 60 * 1000;
const SETTINGS_FILE_NAME = 'settings.json';
const LAUNCHER_UPDATE_CHECK_DELAY_MS = 3000;
const LOGS_DIR_NAME = 'logs';
const LOG_FILE_NAME = 'launcher.log';
const OLD_LOG_FILE_NAME = 'launcher.old.log';
const MAX_LOG_FILE_BYTES = 1024 * 1024;
const REQUIRED_REMOTE_GAME_FIELDS = ['version', 'downloadUrl', 'dirName', 'exeName'];

const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};
let fileLoggingReady = false;
let fileLoggingFailed = false;
let mainWindow = null;
let tray = null;
let isQuitting = false;
let showWindowOnStart = !process.argv.includes(AUTOSTART_ARG);
let gameUpdateTimer = null;
let gameUpdateCheckInProgress = false;
const gameNotifications = new Map();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (hasSingleInstanceLock) {
  app.on('second-instance', (_event, argv) => {
    if (!argv.includes(AUTOSTART_ARG)) showMainWindow();
  });
} else {
  app.exit(0);
}

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    icon: WINDOW_ICON,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    minWidth: 1280,
    minHeight: 720,
    maxWidth: 1280,
    maxHeight: 720,
    webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
        
    }
  })
  mainWindow = win;
  win.once('ready-to-show', () => {
    if (showWindowOnStart || !tray) showMainWindow();
  });
  win.on('close', event => {
    if (!tray || isQuitting) return;
    event.preventDefault();
    showWindowOnStart = false;
    win.hide();
  });
  win.on('closed', () => { mainWindow = null; });
  win.loadFile(path.join(__dirname, 'index.html')).catch(err => {
    console.error('Could not load launcher window:', err);
  });
}

function showMainWindow() {
  if (isQuitting) return;
  showWindowOnStart = true;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function setupTray() {
  if (process.platform !== 'win32') return;
  try {
    tray = new Tray(TRAY_ICON);
    tray.setToolTip('PLauncher');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть', click: showMainWindow },
      { label: 'Закрыть полностью', click: () => app.quit() }
    ]));
    tray.on('click', showMainWindow);
  } catch (err) {
    tray?.destroy();
    tray = null;
    console.error('Could not initialize system tray:', err);
  }
}

function getAvailableName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base} (${i})${ext}`;
    i++;
  }
  return candidate;
}

function getLauncherDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }

  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    return path.dirname(process.env.PORTABLE_EXECUTABLE_FILE);
  }

  if (app.isPackaged) {
    return path.dirname(process.execPath);
  }
  return __dirname;
}

const launcherDir = getLauncherDir();

const legacyVersionsPath = path.join(getLauncherDir(), 'versions.json');

function getSettingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE_NAME);
}

function getLocalVersionsPath() {
  return path.join(app.getPath('userData'), 'versions.json');
}

function getLogsDir() {
  return path.join(app.getPath('userData'), LOGS_DIR_NAME);
}

function getLogPath() {
  return path.join(getLogsDir(), LOG_FILE_NAME);
}

function serializeLogArg(arg) {
  if (arg instanceof Error) {
    return arg.stack || `${arg.name}: ${arg.message}`;
  }
  if (typeof arg === 'string') {
    return arg;
  }
  if (arg === null || arg === undefined) {
    return String(arg);
  }
  if (typeof arg === 'object') {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

function rotateLogFileIfNeeded(logPath) {
  if (!fs.existsSync(logPath)) return;
  const stat = fs.statSync(logPath);
  if (stat.size <= MAX_LOG_FILE_BYTES) return;

  const oldLogPath = path.join(path.dirname(logPath), OLD_LOG_FILE_NAME);
  if (fs.existsSync(oldLogPath)) {
    fs.unlinkSync(oldLogPath);
  }
  fs.renameSync(logPath, oldLogPath);
}

function writeLogLine(level, args) {
  if (!fileLoggingReady) return;

  try {
    const logsDir = getLogsDir();
    const logPath = getLogPath();
    fs.mkdirSync(logsDir, { recursive: true });
    rotateLogFileIfNeeded(logPath);

    const message = args.map(serializeLogArg).join(' ');
    const line = `[${new Date().toISOString()}] [${String(level).toUpperCase()}] ${message}\n`;
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (err) {
    if (!fileLoggingFailed) {
      fileLoggingFailed = true;
      originalConsole.warn('File logging failed:', err && err.message ? err.message : err);
    }
  }
}

function setupFileLogging() {
  if (fileLoggingReady) return;
  fileLoggingReady = true;

  for (const level of ['log', 'warn', 'error']) {
    console[level] = (...args) => {
      originalConsole[level](...args);
      writeLogLine(level, args);
    };
  }

  writeLogLine('info', [
    'Launcher started',
    {
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      launcherDir,
      gamesDir: getGamesDir(),
      userData: app.getPath('userData')
    }
  ]);
}

function readSettings() {
  try {
    const content = fs.readFileSync(getSettingsPath(), 'utf8');
    return JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

async function saveSettings(settings) {
  const settingsPath = getSettingsPath();
  const tmpPath = settingsPath + '.tmp';
  await fsExtra.ensureDir(path.dirname(settingsPath));
  await fsp.writeFile(tmpPath, JSON.stringify(settings, null, 2), 'utf8');
  await fsp.rename(tmpPath, settingsPath);
}

async function configureLoginItem() {
  if (process.platform !== 'win32' || !app.isPackaged || !tray ||
      process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR) return;

  const settings = readSettings();
  if (settings.loginItemConfigured) return;
  const options = { name: 'PLauncher', path: process.execPath, args: [AUTOSTART_ARG] };
  try {
    const registered = app.getLoginItemSettings(options).launchItems?.some(item =>
      item.name === options.name && item.path.toLowerCase() === options.path.toLowerCase());
    if (!registered) app.setLoginItemSettings({ ...options, openAtLogin: true });
    await saveSettings({ ...settings, loginItemConfigured: true });
  } catch (err) {
    console.error('Could not configure PLauncher autostart:', err);
  }
}

function getConfiguredGamesDir() {
  const settings = readSettings();
  const configured = typeof settings.gamesDir === 'string' ? settings.gamesDir.trim() : '';
  return configured ? path.resolve(configured) : null;
}

function isGamesDirConfigured() {
  return !!getConfiguredGamesDir();
}

function getGamesDir() {
  return getConfiguredGamesDir() || launcherDir;
}

async function setGamesDir(dirPath) {
  const resolved = path.resolve(dirPath);
  const settings = readSettings();
  settings.gamesDir = resolved;
  await saveSettings(settings);
  return resolved;
}

async function checkDirectoryWriteAccess(dirPath) {
  const tempPath = path.join(dirPath, `${WRITE_TEST_PREFIX}${process.pid}_${Date.now()}`);
  try {
    await fsExtra.ensureDir(dirPath);
    await fsp.writeFile(tempPath, 'test');
    await fsp.unlink(tempPath);
    return { ok: true, path: dirPath, error: null };
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) await fsp.unlink(tempPath);
    } catch {}
    return {
      ok: false,
      path: dirPath,
      error: err && err.message ? err.message : String(err)
    };
  }
}

async function checkLauncherWriteAccess() {
  return checkDirectoryWriteAccess(launcherDir);
}

async function checkGamesWriteAccess() {
  return checkDirectoryWriteAccess(getGamesDir());
}

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

const launcherUpdateState = {
  status: app.isPackaged ? 'idle' : 'dev',
  currentVersion: app.getVersion(),
  availableVersion: null,
  downloaded: false,
  progress: null,
  error: null,
  isPackaged: app.isPackaged
};

let launcherUpdateCheckPromise = null;
let launcherUpdateDownloadPromise = null;

function getLauncherUpdateState() {
  return {
    ...launcherUpdateState,
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged
  };
}

function sendLauncherUpdateState() {
  const state = getLauncherUpdateState();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-update-state', state);
    }
  }
  return state;
}

function setLauncherUpdateState(patch) {
  Object.assign(launcherUpdateState, patch);
  return sendLauncherUpdateState();
}

function getUpdateErrorMessage(err) {
  if (!err) return null;
  return err.message || String(err);
}

function setupLauncherUpdater() {
  autoUpdater.on('checking-for-update', () => {
    setLauncherUpdateState({ status: 'checking', error: null, progress: null });
  });

  autoUpdater.on('update-available', info => {
    setLauncherUpdateState({
      status: 'available',
      availableVersion: info?.version || null,
      downloaded: false,
      progress: null,
      error: null
    });
  });

  autoUpdater.on('update-not-available', () => {
    setLauncherUpdateState({
      status: 'none',
      availableVersion: null,
      downloaded: false,
      progress: null,
      error: null
    });
  });

  autoUpdater.on('download-progress', progress => {
    setLauncherUpdateState({
      status: 'downloading',
      progress: {
        percent: Number(progress?.percent) || 0,
        transferred: Number(progress?.transferred) || 0,
        total: Number(progress?.total) || 0,
        bytesPerSecond: Number(progress?.bytesPerSecond) || 0
      },
      error: null
    });
  });

  autoUpdater.on('update-downloaded', info => {
    setLauncherUpdateState({
      status: 'downloaded',
      availableVersion: info?.version || launcherUpdateState.availableVersion,
      downloaded: true,
      progress: { percent: 100 },
      error: null
    });
  });

  autoUpdater.on('error', err => {
    setLauncherUpdateState({
      status: 'error',
      error: getUpdateErrorMessage(err)
    });
  });
}

async function checkLauncherUpdate() {
  if (!app.isPackaged) {
    return setLauncherUpdateState({ status: 'dev', error: null });
  }

  if (launcherUpdateCheckPromise) return launcherUpdateCheckPromise;

  launcherUpdateCheckPromise = autoUpdater.checkForUpdates()
    .then(() => getLauncherUpdateState())
    .catch(err => setLauncherUpdateState({ status: 'error', error: getUpdateErrorMessage(err) }))
    .finally(() => {
      launcherUpdateCheckPromise = null;
    });

  return launcherUpdateCheckPromise;
}

async function downloadLauncherUpdate() {
  if (!app.isPackaged) {
    return setLauncherUpdateState({ status: 'dev', error: null });
  }

  if (launcherUpdateState.status === 'downloaded') {
    return getLauncherUpdateState();
  }

  if (launcherUpdateDownloadPromise) return launcherUpdateDownloadPromise;

  setLauncherUpdateState({ status: 'downloading', progress: { percent: 0 }, error: null });
  launcherUpdateDownloadPromise = autoUpdater.downloadUpdate()
    .then(() => getLauncherUpdateState())
    .catch(err => setLauncherUpdateState({ status: 'error', error: getUpdateErrorMessage(err) }))
    .finally(() => {
      launcherUpdateDownloadPromise = null;
    });

  return launcherUpdateDownloadPromise;
}

function installLauncherUpdate() {
  if (!app.isPackaged) {
    return setLauncherUpdateState({ status: 'dev', error: null });
  }

  if (launcherUpdateState.status !== 'downloaded') {
    return setLauncherUpdateState({
      status: launcherUpdateState.status || 'idle',
      error: 'update_not_downloaded'
    });
  }

  setLauncherUpdateState({ status: 'installing', error: null });
  setImmediate(() => {
    autoUpdater.quitAndInstall(false, true);
  });
  return getLauncherUpdateState();
}

setupLauncherUpdater();

let remoteVersionsRequest = null;

function getRemoteVersions() {
  if (!remoteVersionsRequest) {
    remoteVersionsRequest = import(pathToFileURL(path.join(__dirname, 'startup.mjs')).href)
      .then(mod => mod.fetchManifest())
      .finally(() => { remoteVersionsRequest = null; });
  }
  return remoteVersionsRequest;
}

const GAME_CONFIG = {
  Barotrauma: {
    label: 'Barotrauma',
    dirName: 'Barotrauma',
    exeName: 'Barotrauma.exe'
  },
  LethalCompany: {
    label: 'Lethal Company',
    dirName: 'LethalCompany',
    exeName: 'Lethal Company.exe'
  },
  SlayTheSpire2: {
    label: 'Slay the Spire 2',
    dirName: 'Slay The Spire 2',
    exeName: 'SlayTheSpire2.exe'
  },
  CasualtiesUnknown: {
    label: 'Casualties Unknown',
    dirName: 'Casualties Unknown',
    exeName: 'CasualtiesUnknown.exe'
  },
  RiskOfRain2: {
    label: 'Risk of Rain 2',
    dirName: 'Risk of Rain 2',
    exeName: 'Risk of Rain 2.exe',
    preserveDirectories: ['FreeTP']
  }
};

function getRemoteGame(manifest, gameName) {
  if (!manifest || typeof manifest !== 'object') return null;
  const games = manifest.games && typeof manifest.games === 'object' ? manifest.games : manifest;
  const game = games[gameName];
  if (!game) return null;
  return typeof game === 'object' ? game : { version: game };
}

function getGameConfig(gameName, remoteGame = null) {
  const local = GAME_CONFIG[gameName] || {};
  const cfg = {
    dirName: remoteGame?.dirName || local.dirName,
    exeName: remoteGame?.exeName || local.exeName
  };
  if (!cfg.dirName || !cfg.exeName) return null;
  return cfg;
}

function validateRemoteGameConfig(remoteGame) {
  if (!remoteGame || typeof remoteGame !== 'object') {
    return { ok: false, missing: REQUIRED_REMOTE_GAME_FIELDS.slice() };
  }

  const missing = REQUIRED_REMOTE_GAME_FIELDS.filter(field => {
    const value = remoteGame[field];
    return value === null || value === undefined || String(value).trim() === '';
  });

  return {
    ok: missing.length === 0,
    missing
  };
}

function findExeCandidates(exeName, expectedGameDir = '') {
  if (!exeName) return [];

  const gamesDir = getGamesDir();
  const expectedPath = expectedGameDir ? path.resolve(expectedGameDir) : '';

  try {
    return fs.readdirSync(gamesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const gameDir = path.join(gamesDir, entry.name);
        const exePath = path.join(gameDir, exeName);
        return {
          dirName: entry.name,
          gameDir,
          exePath
        };
      })
      .filter(candidate => {
        if (expectedPath && path.resolve(candidate.gameDir) === expectedPath) return false;
        return fs.existsSync(candidate.exePath) && fs.statSync(candidate.exePath).isFile();
      });
  } catch (err) {
    console.warn('Failed to scan exe candidates:', err.message || err);
    return [];
  }
}

function compareVersions(a, b) {
  const sa = (a === undefined || a === null) ? '0' : String(a).trim();
  const sb = (b === undefined || b === null) ? '0' : String(b).trim();
  const pa = sa.split('.').map(s => Number(s) || 0);
  const pb = sb.split('.').map(s => Number(s) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function isGamePresent(gameName, remoteGame = null) {
  const cfg = getGameConfig(gameName, remoteGame);
  if (!cfg) {
    return { gameDir: '', exePath: '', dirExists: false, exeExists: false };
  }
  const gameDir = path.join(getGamesDir(), cfg.dirName);
  const exePath = path.join(gameDir, cfg.exeName);
  const dirExists = fs.existsSync(gameDir) && fs.statSync(gameDir).isDirectory();
  const exeExists = fs.existsSync(exePath) && fs.statSync(exePath).isFile();
  const candidates = exeExists ? [] : findExeCandidates(cfg.exeName, gameDir);
  return {
    gameDir,
    exePath,
    dirExists,
    exeExists,
    dirName: cfg.dirName,
    exeName: cfg.exeName,
    candidates
  };
}

function getGameVersionState(gameName, local, manifest, remoteError = null) {
  const remoteGame = getRemoteGame(manifest, gameName);
  const remote = remoteGame?.version ?? null;
  const downloadUrl = remoteGame?.downloadUrl || null;
  const manifestCheck = validateRemoteGameConfig(remoteGame);
  const presence = isGamePresent(gameName, remoteGame);
  const installed = presence.dirExists;
  const remoteAvailable = remote !== null;

  return {
    ok: true,
    installed,
    dirExists: installed,
    exeExists: presence.exeExists,
    updateAvailable: remoteAvailable && (!installed || compareVersions(remote, local) > 0),
    local,
    remote,
    remoteAvailable,
    downloadPending: !!manifest && !downloadUrl,
    remoteSource: manifest?.__source || null,
    remoteSourceUrl: manifest?.__sourceUrl || null,
    remoteError,
    manifestOk: manifestCheck.ok,
    manifestMissing: manifestCheck.missing,
    downloadUrl,
    dirName: presence.dirName || remoteGame?.dirName || null,
    exeName: presence.exeName || remoteGame?.exeName || null,
    expectedGameDir: presence.gameDir || null,
    expectedExePath: presence.exePath || null,
    candidateGameDir: presence.candidates?.[0]?.gameDir || null,
    candidateExePath: presence.candidates?.[0]?.exePath || null,
    candidateDirName: presence.candidates?.[0]?.dirName || null
  };
}

function notifyGameUpdate(gameName, state) {
  if (process.platform !== 'win32' || !Notification.isSupported() ||
      !state.exeExists || !state.updateAvailable || !state.manifestOk ||
      compareVersions(state.local, '0') <= 0) return;

  const version = String(state.remote);
  if (gameNotifications.get(gameName)?.version === version) return;
  const notification = new Notification({
    title: `Обновление: ${GAME_CONFIG[gameName].label}`,
    body: `Установлена версия ${state.local}. Доступна версия ${version}.`,
    icon: WINDOW_ICON
  });
  notification.once('click', showMainWindow);
  notification.once('failed', (_event, error) => {
    if (gameNotifications.get(gameName)?.notification === notification) gameNotifications.delete(gameName);
    console.warn('Game update notification failed:', gameName, error);
  });
  gameNotifications.set(gameName, { version, notification });
  notification.show();
}

async function checkGameUpdatesInBackground() {
  if (gameUpdateCheckInProgress || isQuitting || !isGamesDirConfigured()) return;
  gameUpdateCheckInProgress = true;
  try {
    const manifest = await getRemoteVersions();
    if (isQuitting || !isGamesDirConfigured()) return;

    const versions = readLocalVersions();
    const states = {};
    for (const gameName of Object.keys(GAME_CONFIG)) {
      try {
        const state = getGameVersionState(gameName, versions[gameName] ?? '0', manifest);
        states[gameName] = state;
        notifyGameUpdate(gameName, state);
      } catch (err) {
        console.warn('Background version check failed for', gameName, err.message || err);
      }
    }
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
      mainWindow.webContents.send('game-versions-checked', states);
    }
  } catch (err) {
    console.warn('Background version check failed:', err.message || err);
  } finally {
    gameUpdateCheckInProgress = false;
  }
}

function readLocalVersions() {
  const paths = [getLocalVersionsPath(), legacyVersionsPath];
  try {
    for (const filePath of paths) {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const clean = content.replace(/^\uFEFF/, '');
      return JSON.parse(clean);
    }
    return {};
  } catch (err) {
    console.error('readLocalVersions error:', err.message);
    return {};
  }
}

async function saveLocalVersions(obj) {
  try {
    if (!obj || typeof obj !== 'object') throw new Error('Invalid versions object');
    const versionsPath = getLocalVersionsPath();
    const tmpPath = versionsPath + '.tmp';
    const data = JSON.stringify(obj, null, 2);
    await fsExtra.ensureDir(path.dirname(versionsPath));
    await fsp.writeFile(tmpPath, data, 'utf8');
    await fsp.rename(tmpPath, versionsPath);
    return { ok: true };
  } catch (err) {
    console.error('saveLocalVersions error:', err);
    return { ok: false, error: String(err) };
  }
}

function getSafeDownloadName(gameName) {
  const rawName = String(gameName || 'game');
  const safeName = rawName.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'game';
  return `${DOWNLOAD_FILE_PREFIX}${safeName}-${Date.now()}.zip`;
}

function isLauncherTemporaryFile(fileName) {
  return (
    fileName.startsWith(DOWNLOAD_FILE_PREFIX) ||
    fileName.startsWith(WRITE_TEST_PREFIX) ||
    fileName === 'versions.json.tmp'
  );
}

async function cleanupTemporaryFilesInDir(dirPath) {
  let deleted = 0;
  let failed = 0;

  let entries;
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    console.warn('Failed to scan temp files:', dirPath, err.message || err);
    return { deleted, failed: failed + 1 };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !isLauncherTemporaryFile(entry.name)) continue;

    const filePath = path.join(dirPath, entry.name);
    try {
      await fsp.unlink(filePath);
      deleted++;
    } catch (err) {
      failed++;
      console.warn('Failed to delete temp file:', filePath, err.message || err);
    }
  }

  return { deleted, failed };
}

async function cleanupTemporaryFiles() {
  const dirs = new Set([getLauncherDir(), getGamesDir()]);
  try {
    dirs.add(app.getPath('userData'));
  } catch (err) {
    console.warn('Failed to resolve userData for temp cleanup:', err.message || err);
  }

  let deleted = 0;
  let failed = 0;
  for (const dirPath of dirs) {
    const result = await cleanupTemporaryFilesInDir(dirPath);
    deleted += result.deleted;
    failed += result.failed;
  }

  return { deleted, failed };
}

async function getFreeSpaceBytes(dirPath) {
  const stats = await fsp.statfs(dirPath);
  return Number(stats.bavail) * Number(stats.bsize);
}

function parsePositiveInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function getRemoteContentLength(url) {
  const headers = { 'User-Agent': 'PLauncher' };

  try {
    const res = await fetch(url, { method: 'HEAD', headers });
    const size = parsePositiveInt(res.headers.get('content-length'));
    if (res.ok && size) return size;
  } catch (err) {
    console.warn('HEAD size check failed:', err.message || err);
  }

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...headers, Range: 'bytes=0-0' }
    });
    const contentRange = res.headers.get('content-range') || '';
    const rangeMatch = contentRange.match(/\/(\d+)$/);
    const rangeSize = rangeMatch ? parsePositiveInt(rangeMatch[1]) : null;
    const contentLength = parsePositiveInt(res.headers.get('content-length'));
    if (res.body && typeof res.body.cancel === 'function') {
      await res.body.cancel();
    }
    if (res.ok && rangeSize) return rangeSize;
    if (res.ok && contentLength) return contentLength;
  } catch (err) {
    console.warn('Range size check failed:', err.message || err);
  }

  return null;
}

async function checkFreeSpaceForDownload(targetDir, downloadUrl) {
  let freeBytes = null;
  let downloadBytes = null;

  try {
    freeBytes = await getFreeSpaceBytes(targetDir);
  } catch (err) {
    console.warn('Free space check failed:', err.message || err);
  }

  try {
    downloadBytes = await getRemoteContentLength(downloadUrl);
  } catch (err) {
    console.warn('Remote file size check failed:', err.message || err);
  }

  const requiredBytes = downloadBytes
    ? Math.ceil(downloadBytes * DOWNLOAD_SPACE_MULTIPLIER + FREE_SPACE_BUFFER_BYTES)
    : FREE_SPACE_BUFFER_BYTES;

  return {
    ok: freeBytes === null || freeBytes >= requiredBytes,
    freeBytes,
    requiredBytes,
    downloadBytes,
    estimated: !!downloadBytes
  };
}

function cleanupDownloadFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.warn('Failed to delete download file:', err.message || err);
  }
}

function getDownloadState(item, url, state = null) {
  let currentState = state;
  let paused = false;
  let canResume = false;
  let received = 0;
  let total = 0;

  try { currentState = currentState || item.getState(); } catch {}
  try { paused = item.isPaused(); } catch {}
  try { canResume = item.canResume(); } catch {}
  try { received = item.getReceivedBytes(); } catch {}
  try { total = item.getTotalBytes(); } catch {}

  return {
    url,
    state: currentState,
    paused: paused || currentState === 'interrupted',
    canResume,
    received,
    total
  };
}

async function validateZipArchive(zipPath, targetDir, expectedRootName = null) {
  const stat = await fsp.stat(zipPath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error('Downloaded archive is empty or missing');
  }

  const dir = await unzipper.Open.file(zipPath);
  const topNames = new Set();
  const filesToExtract = [];

  for (const entry of dir.files) {
    const entryPath = entry.path.replace(/\\/g, '/');
    if (!entryPath) continue;

    if (
      entryPath.includes('\0') ||
      entryPath.split('/').includes('..') ||
      path.posix.isAbsolute(entryPath) ||
      path.win32.isAbsolute(entryPath)
    ) {
      throw new Error(`Unsafe archive path: ${entry.path}`);
    }

    const first = entryPath.split('/')[0];
    if (first === '.' || first === '..') {
      throw new Error(`Unsafe archive root folder: ${entry.path}`);
    }
    if (first) topNames.add(first);
    if (entry.type === 'File') {
      if (!entryPath.includes('/')) {
        throw new Error(`Archive file is not inside a root folder: ${entry.path}`);
      }
      filesToExtract.push(entry);
    }
  }

  if (topNames.size !== 1) {
    throw new Error(`Expected exactly one root folder in archive, found: ${[...topNames].join(', ')}`);
  }

  if (filesToExtract.length === 0) {
    throw new Error('Archive does not contain files to extract');
  }

  const rootName = [...topNames][0];
  const expectedName = expectedRootName === null || expectedRootName === undefined ? '' : String(expectedRootName).trim();
  if (expectedName && rootName.toLocaleLowerCase() !== expectedName.toLocaleLowerCase()) {
    const err = new Error(`Archive root folder mismatch: expected "${expectedName}", got "${rootName}"`);
    err.code = 'archive_root_mismatch';
    err.expectedRootName = expectedName;
    err.actualRootName = rootName;
    throw err;
  }

  const rootTargetDir = path.join(targetDir, rootName);
  const normalizedTargetRoot = path.resolve(rootTargetDir);

  for (const entry of dir.files) {
    const entryPath = entry.path.replace(/\\/g, '/');
    if (entryPath !== rootName && !entryPath.startsWith(rootName + '/')) {
      throw new Error(`Unexpected archive entry outside root folder: ${entry.path}`);
    }

    const relativeUnderRoot = (entryPath === rootName) ? '' : entryPath.substring(rootName.length + 1);
    const destPath = relativeUnderRoot ? path.join(rootTargetDir, relativeUnderRoot) : rootTargetDir;
    const normalizedDest = path.resolve(destPath);

    if (normalizedDest !== normalizedTargetRoot && !normalizedDest.startsWith(normalizedTargetRoot + path.sep)) {
      throw new Error(`Unsafe archive destination: ${entry.path}`);
    }
  }

  return { dir, rootName, rootTargetDir, filesToExtract };
}























if (hasSingleInstanceLock) app.whenReady().then(async () => {
    setupFileLogging();
    if (process.platform === 'win32' && app.isPackaged) {
      try {
        app.setAppUserModelId(APP_USER_MODEL_ID);
      } catch (err) {
        console.warn('Could not set Windows application ID:', err);
      }
    }
    setupTray();
    await configureLoginItem();

    try {
      const cleanupResult = await cleanupTemporaryFiles();
      if (cleanupResult.deleted || cleanupResult.failed) {
        console.log('Temporary file cleanup:', cleanupResult);
      }
    } catch (e) {
      console.error('Failed to cleanup temporary files:', e);
    }

    ipcMain.handle('get-launcher-update-state', () => getLauncherUpdateState());
    ipcMain.handle('check-launcher-update', () => checkLauncherUpdate());
    ipcMain.handle('download-launcher-update', () => downloadLauncherUpdate());
    ipcMain.handle('install-launcher-update', () => installLauncherUpdate());
    ipcMain.handle('get-log-path', () => ({
      ok: true,
      dir: getLogsDir(),
      path: getLogPath()
    }));
    ipcMain.handle('open-logs', async () => {
      const logsDir = getLogsDir();
      const logPath = getLogPath();
      await fsExtra.ensureDir(logsDir);
      await fsp.appendFile(logPath, '', 'utf8');
      const message = await shell.openPath(logsDir);
      if (message) {
        return { ok: false, error: 'open_failed', message, dir: logsDir, path: logPath };
      }
      console.log('Logs folder opened', { dir: logsDir, path: logPath });
      return { ok: true, dir: logsDir, path: logPath };
    });
    ipcMain.handle('renderer-log', (event, level, args = []) => {
      const safeLevel = ['log', 'warn', 'error'].includes(level) ? `renderer:${level}` : 'renderer:log';
      const safeArgs = Array.isArray(args) ? args : [args];
      writeLogLine(safeLevel, safeArgs);
      return { ok: true };
    });
    ipcMain.handle('get-launcher-write-access', async () => checkLauncherWriteAccess());
    ipcMain.handle('get-games-dir', async () => {
      const gamesDir = getGamesDir();
      return {
        ok: true,
        path: gamesDir,
        configured: isGamesDirConfigured(),
        writeAccess: await checkGamesWriteAccess()
      };
    });
    ipcMain.handle('choose-games-dir', async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const currentDir = getGamesDir();
      const dialogOptions = {
        title: 'Выберите папку для игр',
        defaultPath: currentDir,
        properties: ['openDirectory', 'createDirectory']
      };
      const result = win
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

      if (result.canceled || !result.filePaths || !result.filePaths[0]) {
        return { ok: false, canceled: true, path: currentDir, configured: isGamesDirConfigured() };
      }

      const selectedDir = path.resolve(result.filePaths[0]);
      const writeAccess = await checkDirectoryWriteAccess(selectedDir);
      if (!writeAccess.ok) {
        return {
          ok: false,
          error: 'games_dir_not_writable',
          path: currentDir,
          attemptedPath: selectedDir,
          configured: isGamesDirConfigured(),
          writeAccess
        };
      }

      const savedDir = await setGamesDir(selectedDir);
      void checkGameUpdatesInBackground();
      return { ok: true, path: savedDir, configured: true, writeAccess };
    });
    ipcMain.handle('minimize-window', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) win.minimize();
      return { ok: true };
    });
    ipcMain.handle('close-window', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) win.close();
      return { ok: true };
    });
    ipcMain.handle('open-game-folder', async (event, gameName = 'Barotrauma') => {
      let remoteGame = null;
      try {
        const remote = await getRemoteVersions();
        remoteGame = getRemoteGame(remote, gameName);
      } catch (err) {
        console.warn('Remote game config unavailable for open folder:', err.message || err);
      }

      const cfg = getGameConfig(gameName, remoteGame);
      if (!cfg) return { ok: false, error: 'unknown_game' };

      const presence = isGamePresent(gameName, remoteGame);
      const candidate = presence.candidates?.[0] || null;
      const gameDir = presence.dirExists ? presence.gameDir : candidate?.gameDir || path.join(getGamesDir(), cfg.dirName);
      if (!fs.existsSync(gameDir) || !fs.statSync(gameDir).isDirectory()) {
        return {
          ok: false,
          error: 'not_found',
          path: gameDir,
          expectedGameDir: presence.gameDir,
          expectedExePath: presence.exePath,
          candidateGameDir: candidate?.gameDir || null,
          candidateExePath: candidate?.exePath || null
        };
      }

      const errorMessage = await shell.openPath(gameDir);
      if (errorMessage) {
        return { ok: false, error: 'open_failed', message: errorMessage, path: gameDir };
      }

      console.log('Game folder opened', {
        gameName,
        path: gameDir,
        expectedGameDir: presence.gameDir,
        usedCandidate: !!candidate && !presence.dirExists
      });

      return {
        ok: true,
        path: gameDir,
        expectedGameDir: presence.gameDir,
        expectedExePath: presence.exePath,
        candidateGameDir: candidate?.gameDir || null,
        candidateExePath: candidate?.exePath || null
      };
    });
    ipcMain.handle('check-version', async (event, gameName = 'Barotrauma') => {
      try {
        const local = readLocalVersions()[gameName] ?? '0';
        let manifest = null;
        let remoteError = null;
        try {
          manifest = await getRemoteVersions();
        } catch (err) {
          remoteError = String(err);
          console.warn('Remote version unavailable:', err.message || err);
        }
        return getGameVersionState(gameName, local, manifest, remoteError);
      } catch (err) {
        console.error('check-version handler error:', err);
        return { ok: false, error: String(err) };
      }
    });

    async function extractSingleRootFolderWithProgress(zipPath, targetDir, expectedRootName = null, webContents = null, url = null, preserveDirectories = []) {
      const { dir, rootName, rootTargetDir, filesToExtract } = await validateZipArchive(zipPath, targetDir, expectedRootName);
      console.log('Archive validated', { zipPath, targetDir, rootName, expectedRootName });

      const preservedDirectories = new Set();
      for (const directoryName of preserveDirectories) {
        try {
          await fsp.lstat(path.join(rootTargetDir, directoryName));
          preservedDirectories.add(directoryName.toLowerCase());
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      }

      // Leave existing save folders in place, including archive entries using Windows path aliases.
      const entriesToExtract = dir.files.filter(entry => {
        const entryPath = entry.path.replace(/\\/g, '/');
        const relativeUnderRoot = entryPath === rootName ? '' : entryPath.substring(rootName.length + 1);
        const relativeDestination = path.relative(rootTargetDir, path.resolve(rootTargetDir, relativeUnderRoot));
        const topDirectory = relativeDestination.split(path.sep)[0].split(':')[0].replace(/[ .]+$/g, '').toLowerCase();
        return !preservedDirectories.has(topDirectory);
      });
      const totalFiles = entriesToExtract.filter(entry => entry.type === 'File').length;
      const skippedFiles = filesToExtract.length - totalFiles;
      if (preservedDirectories.size) {
        console.log('Existing game folders preserved', {
          rootTargetDir,
          directories: [...preservedDirectories],
          skippedFiles
        });
      }
      await fsExtra.ensureDir(rootTargetDir);

      let processedFiles = 0;
    
      if (webContents && url) {
        webContents.send('extract-start', { url, zip: zipPath, dest: rootTargetDir, totalFiles });
      }
    
      const normalizedTargetRoot = path.resolve(rootTargetDir) + path.sep;
    
      for (const entry of entriesToExtract) {
        let entryPath = entry.path.replace(/\\/g, '/');
    
        if (!entryPath.startsWith(rootName + '/') && entryPath !== rootName) {
          console.warn('Skipping unexpected entry not under root folder:', entry.path);
          continue;
        }
    
        const relativeUnderRoot = (entryPath === rootName) ? '' : entryPath.substring(rootName.length + 1);
        const destPath = relativeUnderRoot ? path.join(rootTargetDir, relativeUnderRoot) : rootTargetDir;
    
        const normalizedDest = path.resolve(destPath);
        if (!normalizedDest.startsWith(normalizedTargetRoot)) {
          console.warn('Skipping unexpected entry not under root folder:', entry.path);
          continue;
        }
    
        if (entry.type === 'Directory') {
          await fsExtra.ensureDir(destPath);
        } else { // File
          await fsExtra.ensureDir(path.dirname(destPath));
          await pipeline(entry.stream(), fs.createWriteStream(destPath));
    
          processedFiles++;
          if (webContents && url) {
            const percent = totalFiles > 0 ? Math.round((processedFiles / totalFiles) * 100) : 100;
            webContents.send('extract-progress', {
              url,
              file: path.join(rootName, relativeUnderRoot),
              processedFiles,
              totalFiles,
              percent
            });
          }
        }
      }
    
      if (webContents && url) {
        webContents.send('extract-progress', {
          url,
          file: null,
          processedFiles,
          totalFiles,
          percent: totalFiles > 0 ? Math.round((processedFiles / totalFiles) * 100) : 100
        });
      }
    
      return { rootName, totalFiles, processedFiles, skippedFiles, preservedDirectories: [...preservedDirectories] };
    }


    session.defaultSession.on('will-download', (event, item, webContents) => {
      const itemUrl = item.getURL();
      const urlChain = typeof item.getURLChain === 'function' ? item.getURLChain() : [];
      const pendingKey = [itemUrl, ...urlChain].find(downloadUrl => pending.has(downloadUrl));
      const pendingDownload = pendingKey ? pending.get(pendingKey) : null;
      const controlUrl = pendingDownload?.url || pendingKey || itemUrl;
      let savePath = pendingDownload?.savePath || path.join(getGamesDir(), item.getFilename());
      if (pendingKey) pending.delete(pendingKey);
      else pending.delete(itemUrl);
    
      if (!path.extname(savePath)) savePath += '.zip';
      if (!savePath.toLowerCase().endsWith('.zip')) savePath += '.zip';
    
      const dir = path.dirname(savePath);
      const name = path.basename(savePath);
      const safeName = getAvailableName(dir, name);
      const finalSavePath = path.join(dir, safeName);
    
      try {
        item.setSavePath(finalSavePath);
      } catch (err) {
        console.error('setSavePath error', err);
      }
    
      active.set(controlUrl, item);
      activePaths.set(controlUrl, finalSavePath);
      activeMetadata.set(controlUrl, {
        savePath: finalSavePath,
        gameName: pendingDownload?.gameName || null,
        version: pendingDownload?.version ?? null,
        dirName: pendingDownload?.dirName || null,
        exeName: pendingDownload?.exeName || null,
        targetDir: pendingDownload?.targetDir || getGamesDir()
      });
      console.log('Download started', {
        gameName: pendingDownload?.gameName || null,
        version: pendingDownload?.version ?? null,
        savePath: finalSavePath,
        targetDir: pendingDownload?.targetDir || getGamesDir(),
        url: controlUrl
      });
    
      item.on('updated', (event, state) => {
        if (state === 'interrupted') {
          try {
            if (!item.isPaused()) item.pause();
          } catch (err) {
            console.warn('Failed to pause interrupted download:', err.message || err);
          }
        }

        webContents.send('download-progress', getDownloadState(item, controlUrl, state));
      });
    
      item.once('done', async (e, state) => {
        try {
          pending.delete(controlUrl);
          active.delete(controlUrl);
          activePaths.delete(controlUrl);
          const metadata = activeMetadata.get(controlUrl);
          activeMetadata.delete(controlUrl);
          console.log('Download finished', {
            gameName: metadata?.gameName || null,
            state,
            path: finalSavePath
          });
    
          webContents.send('download-done', { url: controlUrl, state, path: finalSavePath });
    
          if (state !== 'completed') {
            cleanupDownloadFile(finalSavePath);
            return;
          }
    
          const ext = path.extname(finalSavePath).toLowerCase();
          if (ext === '.zip') {
            const targetDir = metadata?.targetDir || getGamesDir();

            const preserveDirectories = GAME_CONFIG[metadata?.gameName]?.preserveDirectories || [];
            const res = await extractSingleRootFolderWithProgress(finalSavePath, targetDir, metadata?.dirName || null, webContents, controlUrl, preserveDirectories);
            console.log('Extraction finished', {
              gameName: metadata?.gameName || null,
              targetDir,
              rootName: res.rootName,
              files: res.processedFiles
            });

            let versionUpdate = { ok: false, skipped: true };
            if (metadata?.gameName && metadata.version !== null && metadata.version !== undefined && metadata.version !== '') {
              const localVersions = readLocalVersions();
              localVersions[metadata.gameName] = String(metadata.version);
              versionUpdate = await saveLocalVersions(localVersions);
            }
    
            try {
    
              await fsp.unlink(finalSavePath);
    
            } catch (e) {
    
              console.warn('Failed to remove downloaded archive:', e.message || e);
    
            }
    
            webContents.send('extract-done', { url: controlUrl, dest: path.join(targetDir, res.rootName), stats: res, versionUpdate });
          }
        } catch (err) {
          console.error('Download failed:', err);
          cleanupDownloadFile(finalSavePath);
          webContents.send('extract-error', {
            url: controlUrl,
            error: String(err),
            code: err?.code || null,
            expectedRootName: err?.expectedRootName || null,
            actualRootName: err?.actualRootName || null
          });
        }
      });
    });

    if (isQuitting) return;
    createWindow();
    app.on('activate', () => {
      if (!mainWindow) createWindow();
      showMainWindow();
    });

    void checkGameUpdatesInBackground();
    gameUpdateTimer = setInterval(checkGameUpdatesInBackground, GAME_UPDATE_INTERVAL_MS);
    if (app.isPackaged) {
      setTimeout(() => {
        if (!isQuitting) void checkLauncherUpdate();
      }, LAUNCHER_UPDATE_CHECK_DELAY_MS);
    }
}).catch(err => {
  console.error('Launcher initialization failed:', err);
  if (showWindowOnStart) dialog.showErrorBox('PLauncher', 'Не удалось запустить лаунчер. Подробности в журнале.');
  app.exit(1);
});






ipcMain.handle('start-download', async (event, url, gameName = null, remoteVersion = null, remoteDirName = null) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const gamesDir = getGamesDir();

  if (pending.size > 0 || active.size > 0) {
    return { canceled: true, error: 'download_already_running' };
  }

  let downloadUrl = url;
  let version = remoteVersion;
  let dirName = remoteDirName;
  let exeName = null;
  let remoteGame = null;
  if (gameName) {
    try {
      const remote = await getRemoteVersions();
      remoteGame = getRemoteGame(remote, gameName);
      const manifestCheck = validateRemoteGameConfig(remoteGame);
      if (!manifestCheck.ok) {
        return { canceled: true, error: 'manifest_invalid', missing: manifestCheck.missing };
      }
      if (!downloadUrl) downloadUrl = remoteGame?.downloadUrl || '';
      if (version === null || version === undefined || version === '') version = remoteGame?.version;
      if (!dirName) dirName = remoteGame?.dirName || '';
      exeName = remoteGame?.exeName || null;
    } catch (err) {
      console.warn('Failed to resolve remote game data for download:', err.message || err);
    }

    const cfg = getGameConfig(gameName, remoteGame);
    if (!dirName) dirName = cfg?.dirName || null;
    if (!exeName) exeName = cfg?.exeName || null;
  }

  if (!downloadUrl) {
    return { canceled: true, error: 'download_url_unavailable' };
  }

  if (gameName && (!dirName || !exeName || version === null || version === undefined || version === '')) {
    const missing = [];
    if (version === null || version === undefined || version === '') missing.push('version');
    if (!downloadUrl) missing.push('downloadUrl');
    if (!dirName) missing.push('dirName');
    if (!exeName) missing.push('exeName');
    return { canceled: true, error: 'manifest_invalid', missing };
  }

  const writeAccess = await checkGamesWriteAccess();
  if (!writeAccess.ok) {
    return { canceled: true, error: 'games_dir_not_writable', writeAccess };
  }

  const targetDir = gamesDir;
  const filename = getSafeDownloadName(gameName);
  const safeName = getAvailableName(targetDir, filename);
  const savePath = path.join(targetDir, safeName);

  if (gameName && (version === null || version === undefined || version === '')) {
    return { canceled: true, error: 'remote_version_unavailable' };
  }

  const spaceCheck = await checkFreeSpaceForDownload(targetDir, downloadUrl);
  if (!spaceCheck.ok) {
    return { canceled: true, error: 'not_enough_space', ...spaceCheck };
  }

  pending.set(downloadUrl, { url: downloadUrl, savePath, gameName, version, dirName, exeName, targetDir });
  console.log('Download queued', {
    gameName,
    version,
    dirName,
    exeName,
    savePath,
    targetDir,
    size: spaceCheck.downloadBytes
  });

  const bw = BrowserWindow.fromWebContents(event.sender);
  if (!bw) throw new Error('No browser window available for download');

  bw.webContents.downloadURL(downloadUrl);

  return { canceled: false, path: savePath, spaceCheck };
});

// pause/resume/cancel
ipcMain.handle('download-control', (event, action, url) => {
  const item = active.get(url);
  if (!item) return { ok: false, message: 'no active download for url' };
  try {
    if (action === 'pause') {
      const state = typeof item.getState === 'function' ? item.getState() : null;
      if (state !== 'interrupted' && !item.isPaused()) item.pause();
      return { ok: true, ...getDownloadState(item, url, state || 'progressing'), paused: true };
    }

    if (action === 'resume') {
      item.resume();
      return { ok: true, ...getDownloadState(item, url, 'progressing'), paused: false };
    }

    if (action === 'cancel') {
      item.cancel();
      return { ok: true };
    }

    return { ok: false, message: 'unknown download action' };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
});
















ipcMain.handle('launch-game', async (event, gameName = 'Barotrauma') => {
  if (gameLaunchInProgress) {
    return { ok: false, error: 'already_running' };
  }

  let remoteGame = null;
  try {
    const remote = await getRemoteVersions();
    remoteGame = getRemoteGame(remote, gameName);
  } catch (err) {
    console.warn('Remote game config unavailable for launch:', err.message || err);
  }

  const cfg = getGameConfig(gameName, remoteGame);
  if (!cfg) {
    return { ok: false, error: 'unknown_game' };
  }

  const presence = isGamePresent(gameName, remoteGame);
  const candidate = presence.candidates?.[0] || null;
  const exePath = presence.exePath || path.join(getGamesDir(), cfg.dirName, cfg.exeName);
  console.log('Launch requested', {
    gameName,
    exePath,
    expectedGameDir: presence.gameDir,
    candidateExePath: candidate?.exePath || null
  });

  if (!fs.existsSync(exePath)) {
    return {
      ok: false,
      error: 'not_found',
      message: `File not found: ${exePath}`,
      expectedGameDir: presence.gameDir,
      expectedExePath: exePath,
      candidateGameDir: candidate?.gameDir || null,
      candidateExePath: candidate?.exePath || null,
      candidateDirName: candidate?.dirName || null
    };
  }

  gameLaunchInProgress = true;
  const win = BrowserWindow.fromWebContents(event.sender);

  try {
    const child = spawn(exePath, [], {
      cwd: path.dirname(exePath),
      stdio: 'ignore',
    });
    gameLaunchInProgress = false;

    if (win && !win.isDestroyed()) {
      win.webContents.send('game-started', { path: exePath });
    }

    child.once('exit', (code, signal) => {
      console.log('Game exited', { gameName, path: exePath, code, signal });
      if (win && !win.isDestroyed()) {
        win.webContents.send('game-exited', { path: exePath, code, signal });
      }
    });

    child.once('error', (err) => {
      console.error('Game process error:', { gameName, path: exePath, error: String(err) });
      if (win && !win.isDestroyed()) {
        win.webContents.send('game-error', { error: String(err) });
      }
    });

    return { ok: true };
  } catch (err) {
    gameLaunchInProgress = false;
    if (win && !win.isDestroyed()) {
      win.webContents.send('game-error', { error: String(err) });
    }
    return { ok: false, error: 'launch_failed', message: String(err) };
  }
});












ipcMain.handle('update-local-version', async (event, gameName, newVersion) => {
  try {
    if (!gameName) return { ok: false, error: 'no_game_name' };
    const local = await readLocalVersions();
    local[gameName] = String(newVersion);
    const res = await saveLocalVersions(local);
    if (!res.ok) return { ok: false, error: res.error || 'save_failed' };
    return { ok: true };
  } catch (err) {
    console.error('update-local-version handler error:', err);
    return { ok: false, error: String(err) };
  }
});












app.on('before-quit', () => {
  isQuitting = true;
  clearInterval(gameUpdateTimer);
  for (const [url, item] of active) {
    try {
      item.cancel();
    } catch (err) {
      console.warn('Failed to cancel download:', url, err.message || err);
    }
    cleanupDownloadFile(activePaths.get(url));
  }

  for (const pendingDownload of pending.values()) {
    cleanupDownloadFile(pendingDownload?.savePath || pendingDownload);
  }

  active.clear();
  activePaths.clear();
  activeMetadata.clear();
  pending.clear();
});

app.on('will-quit', () => {
  tray?.destroy();
  tray = null;
});

app.on('window-all-closed', () => {
  if (!tray && process.platform !== 'darwin') {
    app.quit()
  }
})

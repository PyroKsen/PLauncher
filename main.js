const { app, BrowserWindow, ipcMain, session } = require('electron/main')
const { shell, dialog } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('url');
const fs = require('fs');
const unzipper = require('unzipper');
const fsExtra = require('fs-extra');
const fsp = fs.promises;
const { spawn } = require('child_process');


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
const SETTINGS_FILE_NAME = 'settings.json';

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    icon: WINDOW_ICON,
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
  win.setResizable(false)
  win.setMaximizable(false)
  win.setFullScreenable(false)
  win.loadFile('index.html')
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

function getGamesDir() {
  const settings = readSettings();
  const configured = typeof settings.gamesDir === 'string' ? settings.gamesDir.trim() : '';
  return configured ? path.resolve(configured) : launcherDir;
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

async function getRemoteVersions() {
  const mod = await import(pathToFileURL(path.join(__dirname, 'startup.mjs')).href);
  if (mod.fetchManifest) return await mod.fetchManifest();
  if (typeof mod.default === 'function') return await mod.default();
  return mod.default;
}

const GAME_CONFIG = {
  Barotrauma: {
    dirName: 'Barotrauma',
    exeName: 'Barotrauma.exe'
  },
  LethalCompany: {
    dirName: 'LethalCompany',
    exeName: 'Lethal Company.exe'
  },
  SlayTheSpire2: {
    dirName: 'Slay The Spire 2',
    exeName: 'SlayTheSpire2.exe'
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

function compareVersions(a, b) {
  const sa = (a === undefined || a === null) ? '0' : String(a).trim();
  const sb = (b === undefined || b === null) ? '0' : String(b).trim();
  const na = Number(sa), nb = Number(sb);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
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
  return { gameDir, exePath, dirExists, exeExists };
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

async function validateZipArchive(zipPath, targetDir) {
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























app.whenReady().then(async () => {
    try {
      const cleanupResult = await cleanupTemporaryFiles();
      if (cleanupResult.deleted || cleanupResult.failed) {
        console.log('Temporary file cleanup:', cleanupResult);
      }
    } catch (e) {
      console.error('Failed to cleanup temporary files:', e);
    }

    let startupData = {};
    try {
      startupData = await getRemoteVersions();
    } catch (e) {
      console.error('Failed to fetch versions:', e);
    }

    ipcMain.handle('get-startup-data', () => startupData);
    ipcMain.handle('get-launcher-write-access', async () => checkLauncherWriteAccess());
    ipcMain.handle('get-games-dir', async () => {
      const gamesDir = getGamesDir();
      return {
        ok: true,
        path: gamesDir,
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
        return { ok: false, canceled: true, path: currentDir };
      }

      const selectedDir = path.resolve(result.filePaths[0]);
      const writeAccess = await checkDirectoryWriteAccess(selectedDir);
      if (!writeAccess.ok) {
        return { ok: false, error: 'games_dir_not_writable', path: selectedDir, writeAccess };
      }

      const savedDir = await setGamesDir(selectedDir);
      return { ok: true, path: savedDir, writeAccess };
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

      const gameDir = path.join(getGamesDir(), cfg.dirName);
      if (!fs.existsSync(gameDir) || !fs.statSync(gameDir).isDirectory()) {
        return { ok: false, error: 'not_found', path: gameDir };
      }

      const errorMessage = await shell.openPath(gameDir);
      if (errorMessage) {
        return { ok: false, error: 'open_failed', message: errorMessage, path: gameDir };
      }

      return { ok: true, path: gameDir };
    });
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })


    ipcMain.handle('check-version', async (event, gameName = 'Barotrauma') => {
      try {
        const localObj = await readLocalVersions();
        const localRaw = localObj[gameName] ?? '0';

        let remoteGame = null;
        let remoteRaw = null;
        let remoteDownloadUrl = null;
        let remoteSource = null;
        let remoteSourceUrl = null;
        let remoteError = null;
        try {
          const remote = await getRemoteVersions();
          remoteGame = getRemoteGame(remote, gameName);
          remoteRaw = remoteGame?.version ?? null;
          remoteDownloadUrl = remoteGame?.downloadUrl || null;
          remoteSource = remote?.__source || null;
          remoteSourceUrl = remote?.__sourceUrl || null;
        } catch (err) {
          remoteError = String(err);
          console.warn('Remote version unavailable:', err.message || err);
        }

        const presence = isGamePresent(gameName, remoteGame); // { dirExists, exeExists, ... }
        const installed = presence.dirExists;
        const remoteAvailable = remoteRaw !== null && remoteRaw !== undefined;
        let updateAvailable = false;
        if (!remoteAvailable) {
          updateAvailable = false;
        } else if (!installed) {
          updateAvailable = true;
        } else {
          updateAvailable = compareVersions(String(remoteRaw), String(localRaw)) > 0;
        }
    
        return {
          ok: true,
          installed,
          dirExists: presence.dirExists,
          exeExists: presence.exeExists,
          updateAvailable,
          local: localRaw,
          remote: remoteRaw,
          remoteAvailable,
          remoteSource,
          remoteSourceUrl,
          remoteError,
          downloadUrl: remoteDownloadUrl,
          dirName: remoteGame?.dirName || null,
          exeName: remoteGame?.exeName || null
        };
      } catch (err) {
        console.error('check-version handler error:', err);
        return { ok: false, error: String(err) };
      }
    });

    async function extractSingleRootFolderWithProgress(zipPath, targetDir, webContents = null, url = null) {
      const { dir, rootName, rootTargetDir, filesToExtract } = await validateZipArchive(zipPath, targetDir);
      await fsExtra.ensureDir(rootTargetDir);

      const totalFiles = filesToExtract.length;
      let processedFiles = 0;
    
      if (webContents && url) {
        webContents.send('extract-start', { url, zip: zipPath, dest: rootTargetDir, totalFiles });
      }
    
      const normalizedTargetRoot = path.resolve(rootTargetDir) + path.sep;
    
      for (const entry of dir.files) {
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
          await new Promise((resolve, reject) => {
            entry.stream()
              .pipe(fs.createWriteStream(destPath))
              .on('finish', resolve)
              .on('error', reject);
          });
    
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
    
      return { rootName, totalFiles, processedFiles };
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
        targetDir: pendingDownload?.targetDir || getGamesDir()
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
    
          webContents.send('download-done', { url: controlUrl, state, path: finalSavePath });
    
          if (state !== 'completed') {
            cleanupDownloadFile(finalSavePath);
            return;
          }
    
          const ext = path.extname(finalSavePath).toLowerCase();
          if (ext === '.zip') {
            const targetDir = metadata?.targetDir || getGamesDir();

            const res = await extractSingleRootFolderWithProgress(finalSavePath, targetDir, webContents, controlUrl);

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
          webContents.send('extract-error', { url: controlUrl, error: String(err) });
        }
      });
    });
});






ipcMain.handle('start-download', async (event, url, gameName = null, remoteVersion = null) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const gamesDir = getGamesDir();

  if (pending.size > 0 || active.size > 0) {
    return { canceled: true, error: 'download_already_running' };
  }

  let downloadUrl = url;
  let version = remoteVersion;
  if (gameName && (!downloadUrl || version === null || version === undefined || version === '')) {
    try {
      const remote = await getRemoteVersions();
      const remoteGame = getRemoteGame(remote, gameName);
      if (!downloadUrl) downloadUrl = remoteGame?.downloadUrl || '';
      if (version === null || version === undefined || version === '') version = remoteGame?.version;
    } catch (err) {
      console.warn('Failed to resolve remote game data for download:', err.message || err);
    }
  }

  if (!downloadUrl) {
    return { canceled: true, error: 'download_url_unavailable' };
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

  pending.set(downloadUrl, { url: downloadUrl, savePath, gameName, version, targetDir });

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

  const exePath = path.join(getGamesDir(), cfg.dirName, cfg.exeName);

  if (!fs.existsSync(exePath)) {
    return { ok: false, error: 'not_found', message: `File not found: ${exePath}` };
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
      if (win && !win.isDestroyed()) {
        win.webContents.send('game-exited', { path: exePath, code, signal });
      }
    });

    child.once('error', (err) => {
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

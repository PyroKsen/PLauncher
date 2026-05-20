const { app, BrowserWindow, ipcMain, session } = require('electron/main')
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

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
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
  win.webContents.openDevTools();
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
  if (app.isPackaged) {
    return path.dirname(process.execPath);
  }
  return __dirname;
}

const launcherDir = getLauncherDir();

const versionsPath = path.join(getLauncherDir(), 'versions.json');

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
  const gameDir = path.join(launcherDir, cfg.dirName);
  const exePath = path.join(gameDir, cfg.exeName);
  const dirExists = fs.existsSync(gameDir) && fs.statSync(gameDir).isDirectory();
  const exeExists = fs.existsSync(exePath) && fs.statSync(exePath).isFile();
  return { gameDir, exePath, dirExists, exeExists };
}

function readLocalVersions() {
  try {
    const content = fs.readFileSync(versionsPath, 'utf8');
    const clean = content.replace(/^\uFEFF/, '');
    const parsed = JSON.parse(clean);
    return parsed;
  } catch (err) {
    console.error('readLocalVersions error:', err.message);
    return {};
  }
}

async function saveLocalVersions(obj) {
  try {
    if (!obj || typeof obj !== 'object') throw new Error('Invalid versions object');
    const tmpPath = versionsPath + '.tmp';
    const data = JSON.stringify(obj, null, 2);
    await fsp.writeFile(tmpPath, data, 'utf8');
    await fsp.rename(tmpPath, versionsPath);
    return { ok: true };
  } catch (err) {
    console.error('saveLocalVersions error:', err);
    return { ok: false, error: String(err) };
  }
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
    let startupData = {};
    try {
      startupData = await getRemoteVersions();
    } catch (e) {
      console.error('Failed to fetch versions:', e);
    }

    ipcMain.handle('get-startup-data', () => startupData);
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
        let remoteError = null;
        try {
          const remote = await getRemoteVersions();
          remoteGame = getRemoteGame(remote, gameName);
          remoteRaw = remoteGame?.version ?? null;
          remoteDownloadUrl = remoteGame?.downloadUrl || null;
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
      let savePath = pendingDownload?.savePath || path.join(getLauncherDir(), item.getFilename());
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
        version: pendingDownload?.version ?? null
      });
    
      item.on('updated', () => {
        webContents.send('download-progress', { url: controlUrl, received: item.getReceivedBytes(), total: item.getTotalBytes() });
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
            const targetDir = getLauncherDir();

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
  const launcherDir = getLauncherDir();

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

  let filename;
  try {
    filename = decodeURIComponent(new URL(downloadUrl).pathname.split('/').pop()) || 'file';
  } catch {
    filename = 'file';
  }

  let targetDir = launcherDir;
  try {
    const tempPath = path.join(targetDir, `.pl_launcher_write_test_${Date.now()}`);
    fs.writeFileSync(tempPath, 'test');
    fs.unlinkSync(tempPath);
  } catch (err) {
    console.warn('No write permission in launcher dir, falling back to userData:', err.message);
    targetDir = app.getPath('userData');
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch (e) {}
  }

  const safeName = getAvailableName(targetDir, filename);
  const savePath = path.join(targetDir, safeName);

  if (gameName && (version === null || version === undefined || version === '')) {
    return { canceled: true, error: 'remote_version_unavailable' };
  }

  pending.set(downloadUrl, { url: downloadUrl, savePath, gameName, version });

  const bw = BrowserWindow.fromWebContents(event.sender);
  if (!bw) throw new Error('No browser window available for download');

  bw.webContents.downloadURL(downloadUrl);

  return { canceled: false, path: savePath };
});

// pause/resume/cancel
ipcMain.handle('download-control', (event, action, url) => {
  const item = active.get(url);
  if (!item) return { ok: false, message: 'no active download for url' };
  if (action === 'pause') item.pause();
  else if (action === 'resume') item.resume();
  else if (action === 'cancel') item.cancel();
  return { ok: true };
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

  const exePath = path.join(launcherDir, cfg.dirName, cfg.exeName);

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

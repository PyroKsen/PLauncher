const { app, BrowserWindow, ipcMain, dialog, session } = require('electron/main')
const path = require('node:path')
const { pathToFileURL } = require('url');
const fs = require('fs');
const extract = require('extract-zip')
const unzipper = require('unzipper');
const fsExtra = require('fs-extra');
const fsp = fs.promises;
const { spawn } = require('child_process');


let gameLaunchInProgress = false;
let runningChild = null;

const pending = new Map(); // url -> savePath
const active = new Map(); // url -> DownloadItem

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 690,
    frame: false,
    transparent: true,
    resizeble: false,
    webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
        
    }
  })
  win.isResizable(false)
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
  // Если приложение упаковано, process.execPath указывает на исполняемый файл — возьмём его папку
  if (app.isPackaged) {
    return path.dirname(process.execPath);
  }
  // В режиме разработки обычно __dirname — корень проекта рядом с main.js
  return __dirname;
}

const launcherDir = getLauncherDir();










const versionsPath = path.join(getLauncherDir(), 'versions.json');

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

function isGamePresent() {
  const gameDir = path.join(launcherDir, 'Barotrauma');
  const exePath = path.join(gameDir, 'barotrauma.exe');
  const dirExists = fs.existsSync(gameDir) && fs.statSync(gameDir).isDirectory();
  const exeExists = fs.existsSync(exePath) && fs.statSync(exePath).isFile();
  return { gameDir, exePath, dirExists, exeExists };
}

function readLocalVersions() {
  try {
    console.log('versionsPath=', versionsPath);
    const content = fs.readFileSync(versionsPath, 'utf8'); // 'utf8' достаточно
    console.log(content)
    // Убираем возможный BOM и парсим JSON
    const clean = content.replace(/^\uFEFF/, '');
    const parsed = JSON.parse(clean);
    console.log(parsed)
    return parsed;
  } catch (err) {
    console.error('readLocalVersions error:', err.message);
    // Если файла нет или JSON некорректен — вернуть пустой объект
    return {};
  }
}

readLocalVersions()

async function saveLocalVersions(obj) {
  try {
    // валидация: должен быть объект
    if (!obj || typeof obj !== 'object') throw new Error('Invalid versions object');
    const tmpPath = versionsPath + '.tmp';
    // Красиво форматируем JSON, чтобы файл был читаем
    const data = JSON.stringify(obj, null, 2);
    console.log(data)
    await fsp.writeFile(tmpPath, data, 'utf8');
    await fsp.rename(tmpPath, versionsPath); // атомарно заменим файл
    return { ok: true };
  } catch (err) {
    console.error('saveLocalVersions error:', err);
    return { ok: false, error: String(err) };
  }
}

function isNewVersionAvailable(localVer, remoteVer) {
  // Простой числовой или строковый сравнительный вызов
  return Number(remoteVer) > Number(localVer);
}






















app.whenReady().then(async () => {

  async function getRemoteVersions() {
    // относительный путь от main.js
    const mod = await import(pathToFileURL(path.join(__dirname, 'startup.mjs')).href);
    // либо просто await import('./startup.mjs') если Node поддерживает относительные ESM-импорты
    return mod.default; // parsed объект из startup.mjs
  }

    try {
      const versions = await getRemoteVersions();
      console.log('Remote versions:', versions);
      // дальше инициализация окна и т.д.
    } catch (e) {
      console.error('Ошибка получения версий:', e);
    }

    const startup = await import(pathToFileURL(path.join(__dirname, 'startup.mjs')).href);
    const data = startup.default
    ipcMain.handle('get-startup-data', () => data);
    try {
      await import(path.join(app.getAppPath(), 'startup.mjs'));
      console.log('startup script finished');
    } catch (err) {
      console.error('startup script error:', err);
    }
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })


    ipcMain.handle('check-version', async (event, gameName = 'Barotrauma') => {
      try {
        const remote = await getRemoteVersions(); // может вернуть null при ошибке
        const localObj = await readLocalVersions();
        const localRaw = localObj[gameName] ?? '0';
        const remoteRaw = remote && (gameName in remote) ? remote[gameName] : null;
    
        const presence = isGamePresent(); // { dirExists, exeExists, ... }
        const installed = presence.dirExists; // либо require exeExists если нужно точнее
    
        // Логика:
        // - если game отсутствует -> доступна кнопка (даже если версии совпадают)
        // - если присутствует и remote отсутствует -> считать отсутствие обновления (disabled)
        // - если присутствует и remote > local -> enabled
        // - если присутствует и remote <= local -> disabled
        let updateAvailable = false;
        if (!installed) {
          updateAvailable = true;
        } else if (remoteRaw === null) {
          updateAvailable = false;
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
          remote: remoteRaw
        };
      } catch (err) {
        console.error('check-version handler error:', err);
        return { ok: false, error: String(err) };
      }
    });

    async function extractSingleRootFolderWithProgress(zipPath, targetDir, webContents = null, url = null) {
      const dir = await unzipper.Open.file(zipPath);
    
      // Собираем корневые имена (первый сегмент каждого пути)
      const topNames = new Set();
      for (const entry of dir.files) {
        const p = entry.path.replace(/\\/g, '/');
        if (!p) continue;
        const first = p.split('/')[0];
        if (first) topNames.add(first);
      }
    
      if (topNames.size !== 1) {
        throw new Error(`Ожидалась ровно одна корневая папка в архиве, найдено: ${[...topNames].join(', ')}`);
      }
    
      const rootName = [...topNames][0];
      const rootTargetDir = path.join(targetDir, rootName);
      await fsExtra.ensureDir(rootTargetDir);
    
      // Подсчёт файлов (только файлов, не директорий), которые начинаются с rootName/
      const filesToExtract = dir.files.filter(entry => {
        const p = entry.path.replace(/\\/g, '/');
        return entry.type === 'File' && (p === rootName ? false : p.startsWith(rootName + '/'));
      });
      const totalFiles = filesToExtract.length;
      let processedFiles = 0;
    
      // Сообщаем старт распаковки
      if (webContents && url) {
        webContents.send('extract-start', { url, zip: zipPath, dest: rootTargetDir, totalFiles });
      }
    
      // Нормализованные значения для защиты от path traversal
      const normalizedTargetRoot = path.resolve(rootTargetDir) + path.sep;
    
      // Проходим по всем записям и записываем их, сохраняя корневой сегмент (то есть записываем rootName/...)
      for (const entry of dir.files) {
        let entryPath = entry.path.replace(/\\/g, '/');
    
        // Должно начинаться с rootName (или быть точно rootName)
        if (!entryPath.startsWith(rootName + '/') && entryPath !== rootName) {
          console.warn('Пропускаем неожиданный entry, не начинающийся с rootName:', entry.path);
          continue;
        }
    
        const relativeUnderRoot = (entryPath === rootName) ? '' : entryPath.substring(rootName.length + 1);
        const destPath = relativeUnderRoot ? path.join(rootTargetDir, relativeUnderRoot) : rootTargetDir;
    
        // безопасность: итоговый путь должен быть внутри rootTargetDir
        const normalizedDest = path.resolve(destPath);
        if (!normalizedDest.startsWith(normalizedTargetRoot)) {
          console.warn('Skipping unsafe entry:', entry.path);
          continue;
        }
    
        if (entry.type === 'Directory') {
          await fsExtra.ensureDir(destPath);
        } else { // File
          await fsExtra.ensureDir(path.dirname(destPath));
          // Пишем файл потоком и ждём finish
          await new Promise((resolve, reject) => {
            entry.stream()
              .pipe(fs.createWriteStream(destPath))
              .on('finish', resolve)
              .on('error', reject);
          });
    
          // обновляем прогресс по файлам
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
    
      // Если файлов не было (totalFiles === 0), всё равно посылаем progress=100
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
      const url = item.getURL();
    
      // подготовим путь для сохранения заранее и положим в finalSavePath
      let savePath = pending.get(url) || path.join(getLauncherDir(), item.getFilename());
      pending.delete(url);
    
      // Гарантируем .zip
      if (!path.extname(savePath)) savePath += '.zip';
      if (!savePath.toLowerCase().endsWith('.zip')) savePath += '.zip';
    
      // Не перезаписываем существующий файл
      const dir = path.dirname(savePath);
      const name = path.basename(savePath);
      const safeName = getAvailableName(dir, name);
      const finalSavePath = path.join(dir, safeName);
    
      try {
        item.setSavePath(finalSavePath);
      } catch (err) {
        console.error('setSavePath error', err);
      }
    
      active.set(url, item);
    
      item.on('updated', () => {
        webContents.send('download-progress', { url, received: item.getReceivedBytes(), total: item.getTotalBytes() });
      });
    
      item.once('done', async (e, state) => {
        // обязательно оборачиваем в try/catch
        try {
          pending.delete(url);
          active.delete(url);
    
          webContents.send('download-done', { url, state, path: finalSavePath });
    
          if (state !== 'completed') {
            // при отмене/ошибке можно удалить файл частичный, если нужно
            return;
          }
    
          // распаковка .zip (ваша функция с прогрессом)
          const ext = path.extname(finalSavePath).toLowerCase();
          if (ext === '.zip') {
            const targetDir = getLauncherDir();
    
            webContents.send('extract-start', { url, zip: finalSavePath, dest: targetDir });
    
            const res = await extractSingleRootFolderWithProgress(finalSavePath, targetDir, webContents, url);
    
            // удаляем архив после успешной распаковки
            try { await fsp.unlink(finalSavePath); } catch (e) { console.warn('Не удалён zip:', e); }
    
            webContents.send('extract-done', { url, dest: path.join(targetDir, res.rootName), stats: res });
          }
        } catch (err) {
          // логируем и сообщаем рендеру об ошибке распаковки/обработки
          console.error('Ошибка в обработчике will-download done:', err);
          webContents.send('extract-error', { url, error: String(err) });
        }
      });
    });
});






// попросить сохранить и начать загрузку
ipcMain.handle('start-download', async (event, url) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const launcherDir = getLauncherDir();

  // Получаем предполагаемое имя файла из URL (fallback 'file')
  let filename;
  try {
    filename = decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'file';
  } catch {
    filename = 'file';
  }

  // Убедимся, что папка доступна для записи; если нет — fallback на userData
  let targetDir = launcherDir;
  try {
    // пытаемся написать временный файл (небольшая проверка прав)
    const tempPath = path.join(targetDir, `.pl_launcher_write_test_${Date.now()}`);
    fs.writeFileSync(tempPath, 'test');
    fs.unlinkSync(tempPath);
  } catch (err) {
    console.warn('No write permission in launcher dir, falling back to userData:', err.message);
    targetDir = app.getPath('userData');
    // при необходимости можно создавать поддиректорию: path.join(targetDir, 'downloads')
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch (e) {}
  }

  const safeName = getAvailableName(targetDir, filename);
  const savePath = path.join(targetDir, safeName);

  // Сохраняем в pending — will-download использует это значение и установит item.setSavePath
  pending.set(url, savePath);

  // Запускаем загрузку
  const bw = BrowserWindow.fromWebContents(event.sender);
  if (!bw) throw new Error('Не удалось определить окно для загрузки');

  bw.webContents.downloadURL(url);

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
















ipcMain.handle('launch-game', async (event) => {
  if (isLaunching) {
    return { ok: false, error: 'already_running' };
  }

  const exePath = path.join(launcherDir, 'Barotrauma', 'Barotrauma.exe');

  if (!fs.existsSync(exePath)) {
    return { ok: false, error: 'not_found', message: `Не найден файл: ${exePath}` };
  }

  isLaunching = true;
  const win = BrowserWindow.fromWebContents(event.sender);

  try {
    const child = spawn(exePath, [], {
      cwd: path.dirname(exePath),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    isLaunching = false;

    if (win && !win.isDestroyed()) {
      win.webContents.send('game-started', { path: exePath });
    }
    return { ok: true };
  } catch (err) {
    isLaunching = false;
    if (win && !win.isDestroyed()) {
      win.webContents.send('game-error', { error: String(err) });
    }
    return { ok: false, error: 'launch_failed', message: String(err) };
  }
});












ipcMain.handle('update-local-version', async (event, gameName, newVersion) => {
  try {
    if (!gameName) return { ok: false, error: 'no_game_name' };
    // Прочитаем, обновим и сохраним
    const local = await readLocalVersions();
    local[gameName] = String(newVersion);
    const res = await saveLocalVersions(local);
    if (!res.ok) return { ok: false, error: res.error || 'save_failed' };
    // Можно послать событие window.webContents.send('local-version-updated', { gameName, newVersion })
    return { ok: true };
  } catch (err) {
    console.error('update-local-version handler error:', err);
    return { ok: false, error: String(err) };
  }
});












ipcMain.handle('is-game-launching', () => {
  return { launching: gameLaunchInProgress };
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
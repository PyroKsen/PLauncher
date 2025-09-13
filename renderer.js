// import { parsed } from "./startup.mjs";
// import { readFile } from 'node:fs/promises'

// const filePathJS = 'versions.json';

// async function readJsonFile() {
//   try {
//     const fileContent = await readFile(filePathJS, { encoding: 'utf8' });
//     const jsonData = JSON.parse(fileContent);
//     console.log(jsonData)
//     return jsonData

//   } catch (error) {
//     if (error.code === 'ENOENT') {
//       console.error(`Ошибка: Файл '${filePathJS}' не найден.`);
//     } else if (error instanceof SyntaxError) {
//       console.error(`Ошибка парсинга JSON в файле '${filePathJS}':`, error.message);
//     } else {
//       console.error('Произошла непредвиденная ошибка при чтении файла:', error);
//     }
//   }
// }

// readJsonFile();

window.addEventListener('DOMContentLoaded', async () => {
    try {
      const data = await window.api.getStartupData();
    //   console.log(data, JSON.stringify(data), data.Barotrauma, JSON.stringify(data).Barotrauma)
      document.getElementById('version-b').innerHTML = `Версия игры: ${data.Barotrauma}`;
    } catch (err) {
      console.error(err);
    }
});

// вызвать скачивание
document.getElementById('downloadBtn').addEventListener('click', async () => {
  const url = 'https://www.googleapis.com/drive/v3/files/1xobaAk4lxCGvNYo61qSU9YxWi5uDbqZs?alt=media&key=AIzaSyDfECQYvW78rYESsoie9KUto8uzRtAaIO8';
  const res = await window.api.startDownload(url);
  if (res.canceled) {
    console.log('Скачивание отменено пользователем');
  } else {
    console.log('Загрузка началась, сохранится в', res.path);
  }
});

// слушаем прогресс
window.api.onProgress(({ url, received, total }) => {
  if (!total || total === 0) {
    // неизвестный объём — показываем полученные байты
    console.log(url, 'received', received);
  } else {
    const pct = Math.round((received / total) * 100);
    console.log(url, pct + '%', received, '/', total);
  }
});

// слушаем завершение
window.api.onDone(({ url, state, savePath }) => {
  console.log('done', url, state, savePath);
  if (state === 'completed') {
    // готово
  } else {
    // interrupted / cancelled
  }
});

window.api.onExtractStart(info => console.log('Распаковка началась', info));
window.api.onExtractDone(info => console.log('Распаковка завершена', info));
window.api.onExtractError(info => console.error('Ошибка распаковки', info));

const progressLabel = document.getElementById('progress-label');
const combinedProgress = document.getElementById('combined-progress');
const combinedPercent = document.getElementById('combined-percent');
const btn = document.getElementById('downloadBtn');

const DOWNLOAD_WEIGHT = 0.7;
const EXTRACT_WEIGHT = 0.3;

let downloadPercent = 0;
let extractPercent = 0;

// let isBusy = false;
let currentPhase = 'idle'; // 'download' | 'extract' | 'done'

// function setBusy(flag, labelWhenBusy = 'Занято...') {
//   isBusy = flag;
//   btn.disabled = flag;
//   if (flag) {
//     btn.dataset.origText = btn.textContent;
//     btn.textContent = labelWhenBusy;
//     btn.classList.add('disabled');
//   } else {
//     btn.textContent = btn.dataset.origText || 'Скачать и установить';
//     btn.classList.remove('disabled');
//   }
// }

// btn.addEventListener('click', async () => {
//   if (isBusy) return; // двойной клик не пройдёт
//   setBusy(true, 'Подготовка...');
//   try {
//     // вызов IPC старта скачивания (подставь свой URL/логику)
//     const url = getDownloadUrlSomehow(); // твой способ получить URL
//     const res = await window.api.startDownload(url);
//     if (res && res.canceled) {
//       // пользователь отменил выбор файла — разблокируем
//       setBusy(false);
//       return;
//     }
//     currentPhase = 'download';
//   } catch (err) {
//     console.error('Ошибка запуска скачивания:', err);
//     setBusy(false);
//   }
// });

function updateCombinedProgress() {
  updateDownloadButton('Barotrauma')
  const combined = Math.round(downloadPercent * DOWNLOAD_WEIGHT + extractPercent * EXTRACT_WEIGHT);
  combinedProgress.value = combined;
  combinedPercent.textContent = combined + '%';

  if (combined < 100) {
    progressLabel.textContent = currentPhase === 'download'
      ? `Скачивание... (${downloadPercent}%)`
      : (currentPhase === 'extract'
        ? `Распаковка... (${extractPercent}%)`
        : 'Подготовка...');
  } else {
    progressLabel.textContent = 'Готово!';
  }
}

// События скачивания
window.api.onDownloadProgress(info => {
  currentPhase = 'download';
  downloadPercent = info.total > 0 ? Math.round((info.received / info.total) * 100) : 0;
  updateCombinedProgress();
});

window.api.onDownloadDone(info => {
  // если загрузка не completed — разблокируем и выходим
  if (info.state !== 'completed') {
    currentPhase = 'error';
    setBusy(false);
    return;
  }
  currentPhase = 'extract'; // дальше начнётся распаковка
});

// События распаковки
window.api.onExtractStart(info => {
  currentPhase = 'extract';
  extractPercent = 0;
  updateCombinedProgress();
});

window.api.onExtractProgress(info => {
  extractPercent = info.percent || 0;
  updateCombinedProgress();
});

window.api.onExtractDone(info => {
  extractPercent = 100;
  updateCombinedProgress();
  currentPhase = 'done';
});

window.api.onExtractError(info => {
  progressLabel.textContent = 'Ошибка при распаковке: ' + info.error;
  console.error(info.error);
});









const status = document.getElementById('version-b');

async function updateDownloadButton(gameName) {
  const res = await window.api.checkVersion(gameName);
  if (!res.ok) {
    status.textContent = 'Ошибка проверки версии.';
    btn.disabled = true;
    return;
  }

  if (res.updateAvailable) {
    status.textContent = `Доступна новая версия: ${res.remote} (установлена: ${res.local})`;
    btn.disabled = false;
  } else {
    status.textContent = `Версия актуальна: ${res.local}`;
    btn.disabled = true;
  }
}













const launchBtn = document.getElementById('launch-btn');
const statusEl = document.getElementById('game-status');

let busy = false;

function setBusy(flag, text) {
  busy = flag;
  launchBtn.disabled = flag;
  statusEl.textContent = text || (flag ? 'Запуск...' : '');
}

launchBtn.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true, 'Проверка и запуск игры...');
  try {
    const res = await window.api.launchGame();
    if (!res.ok) {
      // Обработаем наиболее вероятные ошибки
      if (res.error === 'not_found') {
        setBusy(false, 'Файл запуска не найден. Убедитесь, что Barotrauma распакована.');
      } else if (res.error === 'wine_missing') {
        setBusy(false, 'Wine не установлен — нельзя запустить .exe на этой системе.');
      } else if (res.error === 'already_running') {
        setBusy(false, 'Идёт запуск — подождите.');
      } else {
        setBusy(false, 'Ошибка запуска: ' + (res.message || res.error));
      }
      return;
    }
    updateDownloadButton('Barotrauma')
    // Успех: игра запущена (детач — лаунчер продолжает работать)
    setBusy(false, 'Игра запущена.');
  } catch (err) {
    console.error('launchGame ipc error:', err);
    setBusy(false, 'Ошибка при попытке запустить игру: ' + String(err));
  }
});

window.api.onGameStarted(info => {
  updateDownloadButton('Barotrauma')
  setBusy(false, 'Игра запущена: ' + (info.path || ''));
});

window.api.onGameError(info => {
  setBusy(false, 'Ошибка запуска: ' + (info.error || info.message || JSON.stringify(info)));
});





const btnDownload = document.getElementById('downloadBtn');

async function refreshVersionState(gameName = 'Barotrauma') {
  try {
    btnDownload.disabled = true;
    status.textContent = 'Проверка...';
    const res = await window.api.checkVersion(gameName);
    console.log('checkVersion result:', res);
    if (!res.ok) {
      status.textContent = 'Ошибка проверки версии: ' + (res.error || 'unknown');
      btnDownload.disabled = true;
      return;
    }

    // if game not present -> allow download
    if (!res.installed) {
      status.textContent = 'Игра не установлена. Нажмите "Скачать и установить".';
      btnDownload.disabled = false;
      return;
    }

    // game is present: if updateAvailable true => allow; otherwise disable
    if (res.updateAvailable) {
      status.textContent = `Доступна новая версия ${res.remote} (локальная ${res.local}).`;
      btnDownload.disabled = false;
    } else {
      status.textContent = `Версия актуальна: ${res.local}.`;
      btnDownload.disabled = true;
    }
  } catch (err) {
    console.error('refreshVersionState error:', err);
    status.textContent = 'Ошибка при проверке версии';
    btnDownload.disabled = true;
  }
}

// Вызываем при загрузке UI
refreshVersionState('Barotrauma');

// После успешной установки/распаковки вызывай:
async function onInstallSucceeded(gameName, remoteVersion) {
  // обновим локальную версию на новую
  const upd = await window.api.updateLocalVersion(gameName, remoteVersion);
  const res = await window.api.checkVersion(gameName);
  status.textContent = `Версия актуальна: ${res.local}.`;
  if (!upd.ok) {
    console.error('updateLocalVersion failed', upd);
  }
  // затем обновим UI
  await refreshVersionState(gameName);
}

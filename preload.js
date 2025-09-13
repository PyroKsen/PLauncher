const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('versions', {
  node: () => process.versions.node,
  chrome: () => process.versions.chrome,
  electron: () => process.versions.electron
  // we can also expose variables, not just functions
})

contextBridge.exposeInMainWorld('api', {
  getStartupData: () => ipcRenderer.invoke('get-startup-data'),
  startDownload: (url) => ipcRenderer.invoke('start-download', url),
  controlDownload: (action, url) => ipcRenderer.invoke('download-control', action, url),
  onProgress: (cb) => ipcRenderer.on('download-progress', (e, data) => cb(data)),
  onDone: (cb) => ipcRenderer.on('download-done', (e, data) => cb(data)),
  onExtractStart: (cb) => ipcRenderer.on('extract-start', (e, d) => cb(d)),
  onExtractDone: (cb) => ipcRenderer.on('extract-done', (e, d) => cb(d)),
  onExtractError: (cb) => ipcRenderer.on('extract-error', (e, d) => cb(d)),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (e, d) => cb(d)),
  onDownloadDone: (cb) => ipcRenderer.on('download-done', (e, d) => cb(d)),
  onExtractProgress: (cb) => ipcRenderer.on('extract-progress', (e, d) => cb(d)),

  launchGame: () => ipcRenderer.invoke('launch-game'),
  isGameLaunching: () => ipcRenderer.invoke('is-game-launching'),
  onGameStarted: (cb) => ipcRenderer.on('game-started', (e, d) => cb(d)),
  onGameError: (cb) => ipcRenderer.on('game-error', (e, d) => cb(d)),
  checkVersion: (gameName) => ipcRenderer.invoke('check-version', gameName),
  updateLocalVersion: (gameName, newVersion) => ipcRenderer.invoke('update-local-version', gameName, newVersion),
});
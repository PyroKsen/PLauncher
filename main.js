const { app, BrowserWindow, ipcMain } = require('electron/main')
const path = require('node:path')
const { pathToFileURL } = require('url');



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

app.whenReady().then(async () => {
    const startup = await import(pathToFileURL(path.join(__dirname, 'startup.mjs')).href);
    const data = startup.default
    console.log(data)
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
});


app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
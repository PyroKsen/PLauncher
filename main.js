const { app, BrowserWindow } = require('electron/main')
const path = require('node:path')

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 690,
    frame: false,
    transparent: true,
    resizeble: false,
    
    webPreferences: {
        preload: path.join(__dirname, 'preload.js')
        
    }
  })
  win.isResizable(false)
//   win.webContents.openDevTools();
  win.loadFile('index.html')
}

app.whenReady().then(async () => {
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
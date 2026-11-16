// CR 코치 — Windows / macOS 데스크톱 앱
const { app, BrowserWindow, ipcMain, desktopCapturer, session, net, shell, screen } = require('electron');
const path = require('path');

let win = null, chosenSource = null, normalBounds = null;

function createWindow(){
  win = new BrowserWindow({
    width: 1500, height: 960, minWidth: 380, minHeight: 300,
    backgroundColor: '#0f2f78', title: 'CR 코치', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, '..', 'www', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // 화면 공유 요청 → 사용자가 고른 창(예: scrcpy 미러링 창)을 넘겨줌
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
      const src = sources.find(s => s.id === chosenSource) || sources[0];
      callback({ video: src });
    } catch (e) { callback({}); }
  });
}

// 화면 소스 목록 (썸네일 포함)
ipcMain.handle('list-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 200 } });
  return sources.map(s => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
});
ipcMain.handle('choose-source', (e, id) => { chosenSource = id; return true; });

// 뉴스 등 외부 데이터 (CORS 우회)
ipcMain.handle('fetch-text', async (e, url) => {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 CR-Coach' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.text();
});

// 미니 모드: 작은 창으로 줄이고 항상 위에 표시
ipcMain.handle('mini-mode', (e, on) => {
  if (!win) return false;
  if (on) {
    normalBounds = win.getBounds();
    const wa = screen.getPrimaryDisplay().workArea;
    win.setAlwaysOnTop(true, 'floating');
    win.setBounds({ width: 360, height: 250, x: wa.x + wa.width - 380, y: wa.y + 20 });
  } else {
    win.setAlwaysOnTop(false);
    if (normalBounds) win.setBounds(normalBounds);
  }
  return on;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

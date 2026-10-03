'use strict';
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { GuardSession } = require('./session.cjs');

let window; let session; let tray; let quitting = false;
const smoke = process.argv.includes('--smoke-test');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(async () => {
    session = new GuardSession({ dataDir: smoke ? path.join(os.tmpdir(), `cdg-smoke-${process.pid}`) : app.getPath('userData') });
    try { await session.init(); } catch (e) { session.reason = e.message; session.findings = [{ severity: 'error', message: e.message }]; }
    window = new BrowserWindow({ width: 1080, height: 900, minWidth: 840, minHeight: 680,
      title: 'Claude Desktop Guard', backgroundColor: '#edf2f8', show: false,
      icon: path.join(__dirname, '../assets/icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true,
        contextIsolation: true, nodeIntegration: false, webSecurity: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('devtools:') && !details.url.startsWith('data:') }));
    const allowedSender = event => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Недопустимый источник команды.');
    };
    for (const [command, action] of Object.entries({ snapshot: () => session.snapshot(),
      probe: input => session.probe(input), pin: input => session.pin(input),
      start: input => session.start(input), stop: () => session.stop(), restore: () => session.restore(),
    })) {
      ipcMain.handle(`guard:${command}`, async (event, input) => {
        allowedSender(event);
        if (smoke && !['snapshot', 'probe', 'pin'].includes(command)) throw new Error('Настройки Desktop не меняются в режиме проверки интерфейса.');
        return action(input);
      });
    }
    session.on('change', state => { if (!window.isDestroyed()) window.webContents.send('guard:state', state); });
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '../assets/tray.png')));
    tray.setToolTip('Claude Desktop Guard');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть Guard', click: () => window.show() },
      { label: 'Выход', click: async () => {
        if (session.busy) { window.show(); return; }
        if (session.gate) {
          const { response } = await dialog.showMessageBox(window, { type: 'warning',
            message: 'Остановить барьер и выйти?', detail: 'Туннели закроются. Настройки Claude останутся привязаны к закрытому прокси. Для возврата прежнего маршрута запустите Guard и нажмите «Восстановить настройки».',
            buttons: ['Продолжить работу', 'Остановить и выйти'], defaultId: 0, cancelId: 0 });
          if (response !== 1) return;
          await session.stop();
        }
        quitting = true; app.quit();
      } },
    ]));
    tray.on('click', () => window.show());
    window.on('close', event => { if (!quitting && session.gate) { event.preventDefault(); window.hide(); } });
    window.once('ready-to-show', () => window.show());
    await window.loadFile(path.join(__dirname, '../ui/index.html'));
    app.on('activate', () => window.show());
  }).catch(error => { dialog.showErrorBox('Guard не запущен', error.message); app.quit(); });
}
app.on('window-all-closed', () => { if (!session?.gate) { quitting = true; app.quit(); } });
app.on('before-quit', () => { quitting = true; session?.gate?.lock('Приложение Guard закрывается.'); });

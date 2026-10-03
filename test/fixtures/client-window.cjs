'use strict';
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await window.loadURL('http://client-mask.invalid/');
});

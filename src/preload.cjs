'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('guard', Object.freeze({
  snapshot: () => ipcRenderer.invoke('guard:snapshot'),
  probe: input => ipcRenderer.invoke('guard:probe', input),
  pin: input => ipcRenderer.invoke('guard:pin', input),
  start: input => ipcRenderer.invoke('guard:start', input),
  stop: () => ipcRenderer.invoke('guard:stop'),
  restore: () => ipcRenderer.invoke('guard:restore'),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('guard:state', listener);
    return () => ipcRenderer.removeListener('guard:state', listener);
  },
}));

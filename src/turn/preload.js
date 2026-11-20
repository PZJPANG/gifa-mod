'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('turnApi', {
  onTurn: (cb) => ipcRenderer.on('turn:show', (_e, t) => cb(t)),
  onMode: (cb) => ipcRenderer.on('turn:mode', (_e, m) => cb(m)),
  lock: () => ipcRenderer.invoke('turn:edit', false)
});

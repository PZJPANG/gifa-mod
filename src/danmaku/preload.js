'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dmApi', {
  onItems: (cb) => ipcRenderer.on('dm:items', (_e, payload) => cb(payload)),
  onTime: (cb) => ipcRenderer.on('dm:time', (_e, payload) => cb(payload)),
  onStyle: (cb) => ipcRenderer.on('dm:style', (_e, style) => cb(style))
});

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  onBearing: (cb) => ipcRenderer.on('bearing', (_e, payload) => cb(payload)),
  onMode: (cb) => ipcRenderer.on('mode', (_e, mode) => cb(mode)),
  // 视频角色定位：截屏配置、视频小地图切片、上报学到的比例 / 状态
  onLocateConfig: (cb) => ipcRenderer.on('locate:config', (_e, c) => cb(c)),
  onLocatePatch: (cb) => ipcRenderer.on('locate:patch', (_e, p) => cb(p)),
  locateLearned: (scale) => ipcRenderer.send('locate:learned', scale),
  locateStatus: (s) => ipcRenderer.send('locate:status', s),
  locateDiag: (d) => ipcRenderer.send('locate:odiag', d)
});

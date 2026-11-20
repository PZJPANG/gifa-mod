'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('subApi', {
  onCues: (cb) => ipcRenderer.on('sub:cues', (_e, payload) => cb(payload)),
  onTime: (cb) => ipcRenderer.on('sub:time', (_e, payload) => cb(payload)),
  // 实时模式：播放器屏幕上正在显示的那一行（字幕正文下载不了时的兜底）
  onLive: (cb) => ipcRenderer.on('sub:live', (_e, text) => cb(text)),
  // 一次性提示（比如「已自动暂停」），亮几秒自己消失
  onNotice: (cb) => ipcRenderer.on('sub:notice', (_e, text) => cb(text)),
  onMode: (cb) => ipcRenderer.on('sub:mode', (_e, mode) => cb(mode)),
  onStyle: (cb) => ipcRenderer.on('sub:style', (_e, style) => cb(style)),
  // 编辑模式下自绘的缩放把手：透明窗在 Windows 上不能靠系统边框缩放
  setBounds: (b) => ipcRenderer.send('subtitle:set-bounds', b),
  style: (patch) => ipcRenderer.invoke('subtitle:style', patch),
  lock: () => ipcRenderer.invoke('subtitle:edit', false)
});

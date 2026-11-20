'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  boot: () => ipcRenderer.invoke('app:boot'),
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  action: (name, payload) => ipcRenderer.invoke('win:action', name, payload),
  load: (payload) => ipcRenderer.invoke('bili:load', payload),
  nav: () => ipcRenderer.invoke('bili:nav'),
  // 游戏内热键需要管理员身份（UIPI），由用户在启动器里按需触发 UAC 提权重启
  relaunchElevated: () => ipcRenderer.invoke('app:relaunch-elevated'),
  updateHotkeys: (hotkeys) => ipcRenderer.invoke('hotkeys:update', hotkeys),
  resetHotkeys: () => ipcRenderer.invoke('hotkeys:reset'),

  // 方位标记：角度是高频数据，用单向 send 避免 invoke 的往返开销
  bearing: (payload) => ipcRenderer.send('overlay:bearing', payload),
  // 视频角色定位：博主小地图切片（每秒约 4 次，单向 send）
  minimapPatch: (payload) => ipcRenderer.send('locate:patch', payload),
  locateState: () => ipcRenderer.invoke('locate:state'),
  onLocateState: (cb) => ipcRenderer.on('locate:state', (_e, s) => cb(s)),
  overlayEnable: (on) => ipcRenderer.invoke('overlay:enable', on),
  // 不传参数即切换；传布尔值是幂等设置
  overlayPlace: (on) => ipcRenderer.invoke('overlay:place', on),
  overlayPlaceState: () => ipcRenderer.invoke('overlay:place-state'),
  overlayRadius: (r) => ipcRenderer.invoke('overlay:radius', r),
  // 手动自动定心的结果：由浮窗转交主进程，把修正写进该视频的标定
  autoCenterResult: (r) => ipcRenderer.invoke('bearing:auto-center-result', r),
  onAutoCenterResult: (cb) => ipcRenderer.on('auto-center-result', (_e, r) => cb(r)),
  saveDump: (p) => ipcRenderer.invoke('overlay:dump-save', p),
  revealDump: () => ipcRenderer.invoke('overlay:reveal-dump'),
  onBearingState: (cb) => ipcRenderer.on('bearing:state', (_e, s) => cb(s)),

  // 游戏内字幕：浮窗上报播放心跳（高频，单向 send）；启动器开关 / 调位置 / 调样式
  subtitleTime: (payload) => ipcRenderer.send('subtitle:time', payload),
  subtitleTracks: (payload) => ipcRenderer.send('subtitle:tracks', payload),
  subtitleLive: (text) => ipcRenderer.send('subtitle:live', text),
  subtitleEnable: (on) => ipcRenderer.invoke('subtitle:enable', on),
  // 不传参数即切换；传布尔值是幂等设置
  subtitleEdit: (on) => ipcRenderer.invoke('subtitle:edit', on),
  subtitleStyle: (patch) => ipcRenderer.invoke('subtitle:style', patch),
  subtitleState: () => ipcRenderer.invoke('subtitle:state'),
  onSubtitleState: (cb) => ipcRenderer.on('subtitle:state', (_e, s) => cb(s)),

  // 全屏弹幕
  danmakuEnable: (on) => ipcRenderer.invoke('danmaku:enable', on),
  danmakuStyle: (patch) => ipcRenderer.invoke('danmaku:style', patch),
  danmakuState: () => ipcRenderer.invoke('danmaku:state'),
  onDanmakuState: (cb) => ipcRenderer.on('danmaku:state', (_e, s) => cb(s)),
  // 输入状态：告诉主进程现在是不是在输入框里打字、是不是在录制新热键，
  // 这两段时间单键热键要让路，其余情况（包括窗口在前台）都该正常触发
  typing: (on) => ipcRenderer.send('ui:typing', !!on),
  capturing: (on) => ipcRenderer.send('ui:capture', !!on),

  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, action) => cb(action)),
  onNotice: (cb) => ipcRenderer.on('app:notice', (_e, text) => cb(text)),
  onPlaybackState: (cb) => ipcRenderer.on('playback:state', (_e, state) => cb(state)),
  onWinState: (cb) => ipcRenderer.on('win:state', (_e, state) => cb(state)),
  onLogin: (cb) => ipcRenderer.on('login:state', (_e, nav) => cb(nav)),

  // 启动器 ↔ 浮窗
  onFloatState: (cb) => ipcRenderer.on('float:state', (_e, s) => cb(s)),
  onFloatCmd: (cb) => ipcRenderer.on('float:cmd', (_e, c) => cb(c)),
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', (_e, s) => cb(s))
});

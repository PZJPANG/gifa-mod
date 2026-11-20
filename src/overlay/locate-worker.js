'use strict';

/**
 * 视频角色定位的后台线程。一次匹配约 50~100ms，放在叠加层主线程会让箭头动画卡顿，所以放这里。
 *
 * 消息：
 *   { type: 'reset', savedScale }   换视频 / 红圈动了：清空学习状态；有之前存下的比例就直接锁定
 *   { type: 'frame', patch, bitmap, origin, centre, ringR, now }
 *        patch   视频小地图切片（灰度 + 图标标记，小地图半径 = patch.R）
 *        bitmap  你屏幕上小地图附近的一块截图（ImageBitmap，左上角在截屏坐标 origin）
 *        centre  你小地图圆心（截屏坐标），ringR 你小地图半径（截屏像素）
 *   { type: 'tick', now }            一段时间没有新切片：让点按时过期
 * 回复：
 *   { type: 'result', dot, locked, scale, trusted, ms }
 *   { type: 'learned', scale }       比例第一次锁定 —— 主进程按视频存起来，下次直接用
 */

importScripts('./locate-core.js');
const L = self.GifaLocate;

let state = {};
let tracker = L.createTracker();
let canvas = null;
let ctx = null;

function reset(savedScale) {
  state = savedScale ? { scale: savedScale, locked: true, hist: [] } : {};
  tracker = L.createTracker();
}

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'reset') {
    reset(m.savedScale);
    return;
  }
  if (m.type === 'tick') {
    const dot = tracker.push(null, m.now);
    self.postMessage({ type: 'result', dot, locked: !!state.locked, scale: state.scale || 0, trusted: false, ms: 0 });
    return;
  }
  if (m.type !== 'frame') return;

  const { patch, bitmap, origin, centre, ringR } = m;
  const N = patch.n;
  const R = patch.R;
  if (!canvas || canvas.width !== N) {
    canvas = new OffscreenCanvas(N, N);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  // 按给定比例从截图里裁出「你的小地图」：小地图半径 ringR·s 对应切片里的 R 像素（与视频切片同一约定）
  const sampleGame = (s) => {
    const half = (N / 2 / R) * ringR * s;
    ctx.clearRect(0, 0, N, N);
    ctx.drawImage(bitmap, centre.x - half - origin.x, centre.y - half - origin.y, 2 * half, 2 * half, 0, 0, N, N);
    return L.splitRgba(ctx.getImageData(0, 0, N, N).data, N);
  };

  const t0 = performance.now();
  const wasLocked = !!state.locked;
  let r = null;
  try {
    r = L.locateFrame({ gray: Float64Array.from(patch.gray), skip: patch.skip, cover: patch.cover }, sampleGame, N, R, state);
  } finally {
    bitmap.close();
  }
  const dot = tracker.push(r, m.now);
  if (!wasLocked && state.locked) self.postMessage({ type: 'learned', scale: state.scale });
  self.postMessage({
    type: 'result',
    dot,
    locked: !!state.locked,
    scale: state.scale || 0,
    trusted: !!(r && r.trusted),
    ms: performance.now() - t0
  });
};

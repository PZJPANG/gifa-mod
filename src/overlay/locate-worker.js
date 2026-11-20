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
  } catch (err) {
    bitmap.close();
    throw err;
  }
  const dot = tracker.push(r, m.now);
  if (!wasLocked && state.locked) self.postMessage({ type: 'learned', scale: state.scale });
  self.postMessage({
    type: 'result',
    dot,
    locked: !!state.locked,
    scale: state.scale || 0,
    trusted: !!(r && r.trusted),
    ms: performance.now() - t0,
    // 诊断：这一帧的匹配分数（NCC 峰值、第二高峰、几个比例一致、最佳比例）
    score: r ? { ncc: +r.ncc.toFixed(3), second: +r.second.toFixed(3), support: r.support, top: +(r.scale || 0).toFixed(3) } : null
  });

  // 诊断截图：一直认不出来时，把「视频小地图切片」和「按当前比例裁出的你的小地图」各存一张，方便肉眼比对
  if (m.dump) {
    const N2 = N * N;
    const vid = new Uint8ClampedArray(N2 * 4);
    for (let i = 0; i < N2; i += 1) {
      const v = patch.gray[i];
      const flag = patch.skip && patch.skip[i];
      vid[i * 4] = flag ? 255 : v;
      vid[i * 4 + 1] = flag ? 0 : v;
      vid[i * 4 + 2] = flag ? 255 : v;
      vid[i * 4 + 3] = 255;
    }
    const s = state.scale || 1;
    const half = (N / 2 / R) * ringR * s;
    // 截图原样（彩色）裁一张，不经过灰度 / 图标处理
    let game = null;
    try {
      ctx.clearRect(0, 0, N, N);
      ctx.drawImage(bitmap, centre.x - half - origin.x, centre.y - half - origin.y, 2 * half, 2 * half, 0, 0, N, N);
      game = new Uint8ClampedArray(ctx.getImageData(0, 0, N, N).data);
    } catch {
      /* ignore */
    }
    // 再存一张截图整块（不裁），看看你的小地图在不在截到的范围里、位置对不对
    let whole = null;
    try {
      const W = Math.min(256, bitmap.width);
      const H = Math.round((bitmap.height / bitmap.width) * W);
      const c2 = new OffscreenCanvas(W, H);
      const x2 = c2.getContext('2d');
      x2.drawImage(bitmap, 0, 0, W, H);
      // 标出算法认为的「你的小地图圆」
      x2.strokeStyle = '#ff0000';
      x2.lineWidth = 1;
      x2.beginPath();
      x2.arc(((centre.x - origin.x) / bitmap.width) * W, ((centre.y - origin.y) / bitmap.height) * H, (ringR / bitmap.width) * W, 0, Math.PI * 2);
      x2.stroke();
      whole = { w: W, h: H, data: new Uint8ClampedArray(x2.getImageData(0, 0, W, H).data) };
    } catch {
      /* ignore */
    }
    self.postMessage({ type: 'dump', n: N, R, scale: s, video: vid, game, whole });
  }
  bitmap.close();
};

'use strict';

/**
 * 全屏弹幕层：透明、鼠标穿透、盖在整块屏幕上。
 *
 * 主进程一次性下发整集弹幕（dm:items，按时间排好序），之后转发播放心跳（dm:time）。
 * 本地按倍速外推出当前视频时间，把「出现时间刚好走过」的弹幕放进轨道。
 *  · 拖进度 / 倒退 / 一下跳好几秒：清屏，从新位置接着放，不把中间几百条一口气喷出来；
 *  · 暂停：弹幕原地停住；
 *  · 滚动弹幕按「不追尾」分配轨道，排不下就丢掉（和 B 站密度控制一个思路）。
 *
 * 每条弹幕生成时先画进一张小画布（描边 + 填色只画一次），之后每帧只贴图，几百条也不卡。
 */

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');

let items = [];
let clock = { current: 0, playing: false, rate: 1, at: 0 };
let style = { opacity: 0.85, fontSize: 25, duration: 8, area: 0.5 };
// 小地图避让区（本窗口坐标）：这一块不画弹幕；null = 不避让
let mask = null;
const MASK_FADE = 28; // 避让区边缘的淡出宽度，字不会被一刀切断

let W = 0;
let H = 0;
let dpr = 1;
let nextIdx = 0;
let lastT = null;
let lastFrame = 0;
let dirty = true;

const scrolling = []; // { sprite, w, h, x, y, lane, speed }
const pinned = []; // { sprite, w, h, x, y, lane, top, life }
let scrollLanes = []; // 每条轨道上最后进来的那条
let topLanes = [];
let bottomLanes = [];

const MAX_ACTIVE = 300;
const PIN_SECONDS = 4;
const GAP = 24;
const MAX_EXTRAPOLATE_MS = 3000;

function nowTime() {
  if (!clock.playing) return clock.current;
  const dt = Math.min(MAX_EXTRAPOLATE_MS, Math.max(0, Date.now() - clock.at));
  return clock.current + (dt / 1000) * (clock.rate || 1);
}

function laneHeight() {
  return Math.round(style.fontSize * 1.3);
}

function laneCount() {
  return Math.max(1, Math.floor((H * style.area) / laneHeight()));
}

function resetLanes() {
  const n = laneCount();
  scrollLanes = new Array(n).fill(null);
  topLanes = new Array(n).fill(null);
  bottomLanes = new Array(n).fill(null);
}

function clearAll() {
  scrolling.length = 0;
  pinned.length = 0;
  resetLanes();
  dirty = true;
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  clearAll();
}

/** 第一个出现时间 >= t 的下标 */
function lowerBound(t) {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function hex(color) {
  return '#' + (color & 0xffffff).toString(16).padStart(6, '0');
}

/** 深色字配浅描边，其余一律深描边 */
function strokeFor(color) {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 60 ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.75)';
}

/** 只量尺寸（便宜）：先看有没有轨道，排得下才真正画图 */
function measure(item) {
  const px = Math.round(style.fontSize * (item.size / 25));
  const font = `bold ${px}px "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif`;
  ctx.font = font;
  const pad = Math.ceil(px / 8) + 2;
  const w = Math.ceil(ctx.measureText(item.text).width) + pad * 2;
  const h = Math.ceil(px * 1.3);
  return { px, font, pad, w, h };
}

function makeSprite(item, m) {
  const { px, font, pad, w, h } = m;
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * dpr);
  c.height = Math.ceil(h * dpr);
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  g.font = font;
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = Math.max(2, px / 9);
  g.strokeStyle = strokeFor(item.color);
  g.strokeText(item.text, pad, h / 2);
  g.fillStyle = hex(item.color);
  g.fillText(item.text, pad, h / 2);
  return c;
}

/** 滚动轨道：前一条的尾巴已经完全进屏并留出间距，而且新的这条在前一条出屏前追不上它 */
function freeScrollLane(speed) {
  for (let i = 0; i < scrollLanes.length; i += 1) {
    const last = scrollLanes[i];
    if (!last || last.x + last.w < 0) return i;
    const tail = last.x + last.w;
    if (tail + GAP > W) continue;
    if (speed <= last.speed) return i;
    const catchUp = (W - tail) / (speed - last.speed);
    const lastLeft = tail / last.speed;
    if (catchUp >= lastLeft) return i;
  }
  return -1;
}

function freePinLane(lanes) {
  for (let i = 0; i < lanes.length; i += 1) {
    const it = lanes[i];
    if (!it || it.life <= 0) return i;
  }
  return -1;
}

function spawn(item) {
  if (scrolling.length + pinned.length >= MAX_ACTIVE) return;
  const lh = laneHeight();
  const m = measure(item);
  const { w, h } = m;
  if (item.mode === 1) {
    const speed = (W + w) / style.duration;
    const lane = freeScrollLane(speed);
    if (lane < 0) return;
    const d = { sprite: makeSprite(item, m), w, h, x: W, y: lane * lh, lane, speed };
    scrollLanes[lane] = d;
    scrolling.push(d);
  } else {
    const top = item.mode === 5;
    const lanes = top ? topLanes : bottomLanes;
    const lane = freePinLane(lanes);
    if (lane < 0) return;
    const areaBottom = Math.round(H * style.area);
    const y = top ? lane * lh : areaBottom - (lane + 1) * lh;
    const d = { sprite: makeSprite(item, m), w, h, x: Math.round((W - w) / 2), y, lane, top, life: PIN_SECONDS };
    lanes[lane] = d;
    pinned.push(d);
  }
  dirty = true;
}

function step(dt) {
  if (!clock.playing || dt <= 0) return;
  for (let i = scrolling.length - 1; i >= 0; i -= 1) {
    const d = scrolling[i];
    d.x -= d.speed * dt;
    if (d.x + d.w < 0) {
      if (scrollLanes[d.lane] === d) scrollLanes[d.lane] = null;
      scrolling.splice(i, 1);
    }
  }
  for (let i = pinned.length - 1; i >= 0; i -= 1) {
    const d = pinned[i];
    d.life -= dt;
    if (d.life <= 0) {
      const lanes = d.top ? topLanes : bottomLanes;
      if (lanes[d.lane] === d) lanes[d.lane] = null;
      pinned.splice(i, 1);
    }
  }
  if (scrolling.length || pinned.length) dirty = true;
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  ctx.globalAlpha = style.opacity;
  for (const d of scrolling) ctx.drawImage(d.sprite, d.x, d.y, d.w, d.h);
  for (const d of pinned) ctx.drawImage(d.sprite, d.x, d.y, d.w, d.h);
  ctx.globalAlpha = 1;
  if (mask && mask.w > 0 && mask.h > 0) eraseMask();
}

/**
 * 把小地图那一块擦掉：先整块挖空，再沿右边、下边各画一条渐变，
 * 让弹幕滑进避让区时是淡出而不是被切成半个字。
 * 用 destination-out 擦，不管上面画了多少条都只要三次填充。
 */
function eraseMask() {
  const { x, y, w, h } = mask;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, w, h);
  const right = ctx.createLinearGradient(x + w + MASK_FADE, 0, x + w, 0);
  right.addColorStop(0, 'rgba(0,0,0,0)');
  right.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = right;
  ctx.fillRect(x + w, y, MASK_FADE, h + MASK_FADE);
  const below = ctx.createLinearGradient(0, y + h + MASK_FADE, 0, y + h);
  below.addColorStop(0, 'rgba(0,0,0,0)');
  below.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = below;
  ctx.fillRect(x, y + h, w, MASK_FADE);
  ctx.restore();
}

function frame(ts) {
  const dt = lastFrame ? Math.min(0.1, (ts - lastFrame) / 1000) : 0;
  lastFrame = ts;

  const t = nowTime();
  if (lastT === null || t < lastT - 0.5 || t - lastT > 3) {
    // 刚载入 / 拖进度 / 倒退：清屏，从新位置开始
    if (scrolling.length || pinned.length) clearAll();
    nextIdx = lowerBound(t);
  } else if (clock.playing) {
    // 排不下的在 spawn 里只量一下尺寸就丢掉，很便宜；上限只防极端刷屏卡一帧
    let n = 0;
    while (nextIdx < items.length && items[nextIdx].t <= t && n < 400) {
      spawn(items[nextIdx]);
      nextIdx += 1;
      n += 1;
    }
    while (nextIdx < items.length && items[nextIdx].t <= t) nextIdx += 1;
  }
  lastT = t;

  step(dt);
  if (dirty) {
    draw();
    dirty = false;
  }
  requestAnimationFrame(frame);
}

window.dmApi.onItems((p) => {
  items = Array.isArray(p && p.items) ? p.items : [];
  lastT = null;
  clearAll();
});

window.dmApi.onTime((t) => {
  if (!t) return;
  clock = {
    current: Number(t.current) || 0,
    playing: !!t.playing,
    rate: Number(t.rate) || 1,
    at: Number(t.at) || Date.now()
  };
});

window.dmApi.onStyle((s) => {
  if (!s) return;
  const next = { ...style };
  if (Number.isFinite(s.opacity)) next.opacity = Math.min(1, Math.max(0.1, s.opacity));
  if (Number.isFinite(s.fontSize)) next.fontSize = Math.min(48, Math.max(14, s.fontSize));
  if (Number.isFinite(s.duration)) next.duration = Math.min(20, Math.max(3, s.duration));
  if (Number.isFinite(s.area)) next.area = Math.min(1, Math.max(0.1, s.area));
  const relayout = next.fontSize !== style.fontSize || next.area !== style.area;
  style = next;
  if ('mask' in s) {
    const m = s.mask;
    mask = m && [m.x, m.y, m.w, m.h].every(Number.isFinite) ? { x: m.x, y: m.y, w: m.w, h: m.h } : null;
  }
  // 字号 / 区域变了，轨道要重排，已经在屏上的那批直接清掉
  if (relayout) clearAll();
  dirty = true;
});

window.addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);

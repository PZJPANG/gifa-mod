'use strict';

/**
 * 游戏内字幕层。
 *
 * 主进程一次性下发整条字幕（sub:cues），之后只转发播放心跳（sub:time）：
 * { current, playing, rate, at }。心跳大约 4 次/秒，中间用本地时钟按倍速外推，
 * 字幕切换不会卡在心跳的节拍上。
 *
 * 锁定时整窗鼠标穿透；编辑模式下整块可拖，边缘把手缩放，滚轮调字号。
 */

const textEl = document.getElementById('text');

let cues = [];
let status = { state: 'idle', message: '' };
let clock = { current: 0, playing: false, rate: 1, at: 0 };
let editing = false;
let fontSize = 30;
let shown = null;

/** 心跳断了别一直往前跑：最多外推 3 秒 */
const MAX_EXTRAPOLATE_MS = 3000;

function nowTime() {
  if (!clock.playing) return clock.current;
  const dt = Math.min(MAX_EXTRAPOLATE_MS, Math.max(0, Date.now() - clock.at));
  return clock.current + (dt / 1000) * (clock.rate || 1);
}

/** 与 subtitle-source.js 的 cueAt 同一算法（这边是隔离的渲染进程，不能 require） */
function cueAt(t) {
  if (!cues.length || !Number.isFinite(t)) return '';
  let lo = 0;
  let hi = cues.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].from <= t) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const lines = [];
  for (let i = idx; i >= 0 && i > idx - 4; i -= 1) {
    if (cues[i].to > t) lines.unshift(cues[i].text);
  }
  return lines.join('\n');
}

function placeholder() {
  if (status.state === 'ready') return '字幕预览 · 拖到合适的位置后点「锁定」';
  return status.message || '字幕预览 · 当前没有可用字幕';
}

/** 锁定状态下没字幕时，原因（没字幕 / 要登录 / 出错）也要在游戏画面上亮几秒，不然看着像坏了 */
const NOTICE_MS = 6000;
let noticeUntil = 0;

let liveText = '';
let flash = { text: '', until: 0 };

function render() {
  let text = cueAt(nowTime()) || (cues.length ? '' : liveText);
  let hint = false;
  if (flash.text && Date.now() < flash.until) {
    text = flash.text;
    hint = true;
  } else if (!text && editing) {
    text = placeholder();
    hint = true;
  } else if (!text && status.message && Date.now() < noticeUntil) {
    text = status.message;
    hint = true;
  }
  const key = `${hint ? 'h' : 'c'}|${text}`;
  if (key === shown) return;
  shown = key;
  if (text) textEl.textContent = text;
  textEl.classList.toggle('empty', !text);
  textEl.classList.toggle('hint', hint);
}

setInterval(render, 50);

window.subApi.onCues((p) => {
  cues = Array.isArray(p && p.cues) ? p.cues : [];
  status = { state: (p && p.state) || 'idle', message: (p && p.message) || '' };
  noticeUntil = status.state === 'none' || status.state === 'error' ? Date.now() + NOTICE_MS : 0;
  shown = null;
  render();
});

window.subApi.onNotice((text) => {
  flash = { text: String(text || ''), until: Date.now() + 5000 };
  render();
});

window.subApi.onLive((text) => {
  liveText = String(text || '');
  render();
});

window.subApi.onTime((t) => {
  if (!t) return;
  clock = {
    current: Number(t.current) || 0,
    playing: !!t.playing,
    rate: Number(t.rate) || 1,
    at: Number(t.at) || Date.now()
  };
  render();
});

window.subApi.onStyle((s) => {
  if (!s) return;
  if (Number.isFinite(s.fontSize)) {
    fontSize = s.fontSize;
    document.documentElement.style.setProperty('--size', `${fontSize}px`);
  }
  if (Number.isFinite(s.bgOpacity)) {
    document.documentElement.style.setProperty('--bg', `rgba(0, 0, 0, ${s.bgOpacity})`);
  }
});

window.subApi.onMode((mode) => {
  editing = mode === 'edit';
  document.body.classList.toggle('editing', editing);
  shown = null;
  render();
});

document.getElementById('btnLock').addEventListener('click', () => window.subApi.lock());

/* ---- 滚轮调字号（只在编辑模式） ---- */
window.addEventListener(
  'wheel',
  (e) => {
    if (!editing) return;
    e.preventDefault();
    const next = Math.min(72, Math.max(14, fontSize + (e.deltaY < 0 ? 2 : -2)));
    if (next === fontSize) return;
    fontSize = next;
    document.documentElement.style.setProperty('--size', `${fontSize}px`);
    window.subApi.style({ fontSize });
  },
  { passive: false }
);

/* ---- 边缘缩放 ---- */
const MIN_W = 200;
const MIN_H = 60;

for (const h of document.querySelectorAll('.h')) {
  h.addEventListener('pointerdown', (e) => {
    if (!editing) return;
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    const dir = h.dataset.dir;
    const start = {
      sx: e.screenX,
      sy: e.screenY,
      x: window.screenX,
      y: window.screenY,
      w: window.outerWidth,
      h: window.outerHeight
    };
    let pending = null;
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (pending) window.subApi.setBounds(pending);
    };
    const move = (ev) => {
      const dx = ev.screenX - start.sx;
      const dy = ev.screenY - start.sy;
      let { x, y, w, h: hh } = start;
      if (dir.includes('e')) w = Math.max(MIN_W, start.w + dx);
      if (dir.includes('s')) hh = Math.max(MIN_H, start.h + dy);
      if (dir === 'w') {
        w = Math.max(MIN_W, start.w - dx);
        x = start.x + (start.w - w);
      }
      if (dir === 'n') {
        hh = Math.max(MIN_H, start.h - dy);
        y = start.y + (start.h - hh);
      }
      pending = { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(hh) };
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const up = () => {
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      h.removeEventListener('pointercancel', up);
      flush();
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
  });
}

render();

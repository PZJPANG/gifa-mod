'use strict';

/**
 * 方位标记叠加层。
 *
 * 画两个**独立**的量：
 *   · 红箭头   行进方向 —— 青色三角解出来的，人往哪走
 *   · 绿弧段   视角方向 —— 白色扇形（镜头视锥）解出来的，镜头朝哪看
 *
 * 这两者在原神里本来就能不一致：站着不动把鼠标往后拉，人没动、视角转了 180°。
 * 所以绝不能合成一个角度 —— 一旦合并，两种状态都会被对方带歪。各算各的、
 * 各补各的间、各画各的。
 *
 * 坐标约定：两者都是罗盘角（0°=北、顺时针），画到 canvas 上要减 90°。
 */

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');

let placing = false;

/* 两路角度各有一套补间状态，互不干扰 */
const tween = {
  arrow: { target: null, shown: null, raf: 0 },
  view: { target: null, shown: null, raf: 0, conf: 0, width: 0, at: 0 }
};

// 视觉常量：与浮窗的深色主题保持同一套红
const RED = '#ff2f2f';
const RED_DEEP = '#c4121d'; // 箭尾：往深处压一档，整支箭有「从暗到亮射出去」的方向感
const RED_TIP = '#ff5a48'; // 箭尖：略偏暖，最亮的一点落在指向上
const RED_SOFT = 'rgba(255, 47, 47, 0.72)';
const WHITE = 'rgba(255, 255, 255, 0.96)';
const GREEN = '#35d96b';
const GREEN_LIGHT = '#93f7b4'; // 弧内缘高光
const GREEN_DEEP = '#1fae52'; // 弧外缘
const GREEN_EDGE = 'rgba(4, 36, 17, 0.8)'; // 绿弧的暗描边
const SHADOW = 'rgba(0, 0, 0, 0.5)';

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** 视角多久没更新就把绿弧收起来，避免画面里明明没视锥却挂一段假绿 */
const VIEW_STALE_MS = 1500;

function shortAngle(a, b) {
  return ((a - b + 540) % 360) - 180;
}

function radius(w, h) {
  return (Math.min(w, h) / 2) * 0.86;
}

/**
 * 补间一帧。
 *
 * 识别端已经做到「有新帧才算」，但 IPC 到这边是一跳一跳的。
 * 每帧追 45% 的差值，大约 3~4 帧收敛，视觉上是连续转动而不是硬切，代价 ~50ms。
 */
function step(key) {
  const t = tween[key];
  t.raf = 0;
  if (t.shown === null || t.target === null) return;

  const d = shortAngle(t.target, t.shown);
  if (Math.abs(d) < 0.25) {
    t.shown = t.target;
    draw();
    return;
  }
  t.shown = (t.shown + d * 0.45 + 360) % 360;
  draw();
  t.raf = requestAnimationFrame(() => step(key));
}

/**
 * 设目标角度。大跳（>90°，比如切镜头、认到别处）不补间，直接就位，
 * 否则会看到画面绕一整圈转过去，比硬切还难看。
 */
function setTarget(key, deg) {
  const t = tween[key];
  t.target = deg;
  if (t.shown === null || Math.abs(shortAngle(deg, t.shown)) > 90) {
    t.shown = deg;
    draw();
    return;
  }
  if (!t.raf) t.raf = requestAnimationFrame(() => step(key));
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;

  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = `${w}px`;
  cv.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function drawRing(cx, cy, r) {
  ctx.save();
  ctx.setLineDash([6, 7]);
  ctx.strokeStyle = RED_SOFT;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = RED_SOFT;
  ctx.beginPath();
  ctx.moveTo(cx - 9, cy);
  ctx.lineTo(cx + 9, cy);
  ctx.moveTo(cx, cy - 9);
  ctx.lineTo(cx, cy + 9);
  ctx.stroke();
  ctx.restore();
}

/**
 * 外环绿弧：一段带圆头的弧，标出视角朝向。
 *
 * 弧的半张角不直接照搬实体视锥（用户确认恒为 90°），而是夹在 18°~34°：
 * 太长会把整圈环糊掉，太短又看不出朝向。按参考图的比例，
 * 整段弧大约占圆周的 1/6 到 1/5，一眼能读出方向又不抢戏。
 *
 * 造型：中段等厚、两端收细并圆头的「月牙」，正中向外顶出一个小尖。
 * 等宽粗线只能读出「大概这一片」，中间的小尖才是精确朝向；两端收细
 * 则让视线自然落回中段，不会把弧的端点误当成方向。
 *
 * 所有尺寸都按 r 缩放 —— 标记大小可在 50~400 之间调，写死像素会在
 * 大标记上细得看不见、小标记上糊成一团。
 */
function drawViewArc(cx, cy, r, deg, conf, width) {
  const dpr = window.devicePixelRatio || 1;
  const half = Math.max(18, Math.min(34, (width > 0 ? width : 60) * 0.45));
  const halfRad = (half * Math.PI) / 180;
  const mid = ((deg - 90) * Math.PI) / 180;

  const lw = Math.max(4.5, r * 0.085); // 中段厚度
  const edge = clamp(r * 0.013, 1.25, 2.5); // 暗描边宽度
  const alpha = 0.5 + 0.5 * clamp(conf, 0, 1);

  // 正中的小尖：两侧内凹、平滑地从弧面收成一个尖（见 outerR 里的平方项）。
  // 直边三角贴在弧上像个疙瘩，内凹的才像是从弧里「长」出来的指针。
  // 高度另有上限：窗口只比圆环多留 16% 余量，小尖连描边不能超过 1.15r
  const tickH = Math.max(0, Math.min(lw * 0.85, r * 0.15 - lw / 2 - edge));
  const tickHalf = (lw * 1.5) / r;

  // t：相对弧中点的偏角（弧度）。中间 40% 保持满厚，往两端平滑收到 45%
  const thick = (t) => {
    const k = clamp((Math.abs(t) / halfRad - 0.4) / 0.6, 0, 1);
    return lw * (1 - 0.55 * k * k * (3 - 2 * k));
  };
  const outerR = (t) => {
    const u = Math.max(0, 1 - Math.abs(t) / tickHalf);
    return r + thick(t) / 2 + tickH * u * u;
  };
  const innerR = (t) => r - thick(t) / 2;

  // 弧身每 2° 采一个点；小尖是曲线，单独加密采样，
  // 并且尖顶（t=0）必须恰好落在采样点上，否则尖会被削平
  const n = Math.ceil(half);
  const ts = [];
  for (let i = 0; i <= n; i += 1) ts.push(-halfRad + (2 * halfRad * i) / n);
  for (let i = -8; i <= 8; i += 1) ts.push((tickHalf * i) / 8);
  ts.sort((p, q) => p - q);

  const capR = thick(halfRad) / 2;
  const a0 = mid - halfRad;
  const a1 = mid + halfRad;

  ctx.beginPath();
  for (let i = 0; i < ts.length; i += 1) {
    const ro = outerR(ts[i]);
    const x = cx + Math.cos(mid + ts[i]) * ro;
    const y = cy + Math.sin(mid + ts[i]) * ro;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  // 末端圆头：圆心压在弧的中线上，从外缘绕到内缘
  ctx.arc(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, capR, a1, a1 + Math.PI);
  for (let i = ts.length - 1; i >= 0; i -= 1) {
    const ri = innerR(ts[i]);
    ctx.lineTo(cx + Math.cos(mid + ts[i]) * ri, cy + Math.sin(mid + ts[i]) * ri);
  }
  ctx.arc(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, capR, a0 + Math.PI, a0 + Math.PI * 2);
  ctx.closePath();

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';

  // 暗描边 + 柔和投影：绿弧压在草地/水面这类同色系地形上，
  // 没有一圈暗边会糊成一团。投影只挂在描边上，主体保持干净
  ctx.shadowColor = SHADOW;
  ctx.shadowBlur = clamp(r * 0.05, 3, 10) * dpr;
  ctx.strokeStyle = GREEN_EDGE;
  ctx.lineWidth = edge * 2;
  ctx.stroke();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;

  // 主体：沿径向由内缘高光过渡到外缘深绿，薄薄一条也有体积感
  const g = ctx.createRadialGradient(cx, cy, r - lw / 2, cx, cy, r + lw / 2 + tickH);
  g.addColorStop(0, GREEN_LIGHT);
  g.addColorStop(0.45, GREEN);
  g.addColorStop(1, GREEN_DEEP);
  ctx.fillStyle = g;
  ctx.fill();

  ctx.restore();
}

/**
 * 行进方向箭头：一整块闭合轮廓（细尾 → 渐宽箭杆 → 后掠箭头），
 * 而不是「一根线 + 一个三角」拼起来 —— 拼接处的描边会鼓出一个疙瘩，
 * 而且线宽写死像素后不随标记大小缩放。
 */
function drawArrow(cx, cy, r, deg) {
  const dpr = window.devicePixelRatio || 1;
  const a = ((deg - 90) * Math.PI) / 180;

  // 起点靠近中心、尖端落在圆环**内侧**：外环还要留给绿弧，
  // 箭头探出环外会和绿弧叠在一起，两样都看不清。
  // 中心 0.4r 以内不画东西，玩家自己小地图上的角色图标不能被盖住
  const tipX = r * 0.9;
  const tailX = r * 0.4;
  const headL = Math.max(13, r * 0.24);
  const headW = headL * 0.56; // 箭头半宽
  const barbX = tipX - headL; // 两翼最后端
  const neckX = tipX - headL * 0.74; // 箭杆接入箭头的位置，比两翼靠前 = 后掠
  const neckW = Math.max(2.6, headL * 0.2); // 箭杆在颈部的半宽
  const tailW = neckW * 0.45; // 箭尾半宽：收细但不收成针尖，描边才包得住
  const outline = clamp(r * 0.02, 1.5, 3.5);

  ctx.save();
  // 转到箭头自己的坐标系：+x 就是指向，后面的轮廓全部按轴对称来写
  ctx.translate(cx, cy);
  ctx.rotate(a);
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(tailX, -tailW);
  ctx.lineTo(neckX, -neckW);
  ctx.lineTo(barbX, -headW);
  ctx.lineTo(tipX, 0);
  ctx.lineTo(barbX, headW);
  ctx.lineTo(neckX, neckW);
  ctx.lineTo(tailX, tailW);
  ctx.closePath();

  // 第一遍：白描边 + 暗投影。白边管深色地形，投影管雪地 —— 两层缺一层
  // 都会在某种地形上丢轮廓
  ctx.shadowColor = SHADOW;
  ctx.shadowBlur = clamp(r * 0.06, 3, 12) * dpr;
  ctx.shadowOffsetY = dpr;
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = outline * 2;
  ctx.stroke();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // 第二遍：红色主体，尾深尖亮
  const g = ctx.createLinearGradient(tailX, 0, tipX, 0);
  g.addColorStop(0, RED_DEEP);
  g.addColorStop(0.55, RED);
  g.addColorStop(1, RED_TIP);
  ctx.fillStyle = g;
  ctx.fill();

  // 第三遍：沿中轴一侧压一层淡高光，做成导航箭头那种两面折光，
  // 小尺寸下也能一眼分出「这是个有朝向的箭头」而不是一坨红
  ctx.clip();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.17)';
  ctx.fillRect(tailX - outline, -headW - outline, tipX - tailX + outline * 2, headW + outline);

  ctx.restore();
}

function draw() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const r = radius(w, h);

  if (placing) drawRing(cx, cy, r);

  // 绿弧画在箭头下面：两者重叠时箭头要压在上面看得清
  const v = tween.view;
  if (v.shown !== null && Date.now() - v.at < VIEW_STALE_MS) {
    drawViewArc(cx, cy, r, v.shown, v.conf, v.width);
  }
  if (tween.arrow.shown !== null) drawArrow(cx, cy, r, tween.arrow.shown);
  // 视频角色的位置点画在最上面：它是「去哪」，比方向更重要
  if (locate.dot && !placing) drawLocateDot(cx, cy, r, locate.dot);
}

/* ------------------------------------------------------------ 视频角色位置 */

/**
 * 把视频里博主的小地图和「你屏幕上的小地图」做匹配，在你的小地图上画出博主所在的点。
 * 匹配算法在 locate-core.js / locate-worker.js；这里只管截屏、裁剪、画点。
 *
 * 截屏会拍到本程序自己的窗口（这个红圈、弹幕、字幕……），主进程开启定位时给它们打了
 * 「不参与截屏」的标记（Windows 的 WDA_EXCLUDEFROMCAPTURE），所以截到的只有游戏画面。
 */
const locate = {
  enabled: false,
  sourceId: '',
  display: null,
  stream: null,
  video: null,
  worker: null,
  busy: false,
  dot: null,
  lastPatchAt: 0,
  lastResult: null,
  status: '',
  tick: 0
};

// 博主小地图切片里，小地图半径 = patch.R 像素；dot 坐标单位相同（比例 1 下）
const LOCATE_PATCH_R = 40;
// 学习阶段最大会按 1.65 × 1.03 的比例去裁，截图要给够这么大一块
const LOCATE_MAX_SCALE = 1.75;

function setLocateStatus(s, extra) {
  if (locate.status === s && !extra) return;
  locate.status = s;
  window.overlayApi.locateStatus({ status: s, ...(extra || {}) });
}

function drawLocateDot(cx, cy, r, dot) {
  const ox = (dot.x / LOCATE_PATCH_R) * r;
  const oy = (dot.y / LOCATE_PATCH_R) * r;
  const dist = Math.hypot(ox, oy);
  // 点在你小地图之外 = 你离博主太远（不在路线上），不画
  if (dist > r * 0.97) return;
  const dpr = window.devicePixelRatio || 1;
  const x = cx + ox;
  const y = cy + oy;
  const size = clamp(r * 0.075, 4, 10);
  ctx.save();
  ctx.globalAlpha = dot.held ? 0.45 : 1;
  // 从你（圆心外一点）到博主的一条细虚线：一眼看出「往哪走」
  if (dist > size * 3) {
    const ux = ox / dist;
    const uy = oy / dist;
    ctx.setLineDash([4, 5]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255, 214, 64, 0.7)';
    ctx.beginPath();
    ctx.moveTo(cx + ux * r * 0.18, cy + uy * r * 0.18);
    ctx.lineTo(x - ux * size * 1.6, y - uy * size * 1.6);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // 点本身：金黄实心 + 白描边 + 暗投影，草地雪地都看得清
  ctx.shadowColor = SHADOW;
  ctx.shadowBlur = 6 * dpr;
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd640';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = Math.max(1.5, size * 0.32);
  ctx.strokeStyle = WHITE;
  ctx.stroke();
  ctx.restore();
}

function stopLocateCapture() {
  if (locate.stream) for (const t of locate.stream.getTracks()) t.stop();
  locate.stream = null;
  if (locate.video) {
    locate.video.srcObject = null;
    locate.video = null;
  }
}

async function startLocateCapture() {
  stopLocateCapture();
  if (!locate.sourceId) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: locate.sourceId, maxFrameRate: 6 } }
    });
    if (!locate.enabled) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    const v = document.createElement('video');
    v.muted = true;
    v.srcObject = stream;
    await v.play();
    locate.stream = stream;
    locate.video = v;
    setLocateStatus('waiting');
  } catch (err) {
    setLocateStatus('error', { message: String((err && err.message) || err) });
  }
}

function ensureWorker() {
  if (locate.worker) return locate.worker;
  const w = new Worker('./locate-worker.js');
  w.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'learned') {
      window.overlayApi.locateLearned(m.scale);
      return;
    }
    if (m.type !== 'result') return;
    locate.busy = false;
    locate.lastResult = m;
    const had = !!locate.dot;
    locate.dot = m.dot;
    if (had || locate.dot) draw();
    setLocateStatus(m.dot ? 'tracking' : m.locked ? 'searching' : 'learning', m.locked ? { scale: m.scale } : null);
  };
  w.onerror = (e) => {
    locate.busy = false;
    setLocateStatus('error', { message: e.message || 'worker error' });
  };
  locate.worker = w;
  return w;
}

/** 视频小地图切片到了：截一块你小地图附近的屏幕，交给后台线程匹配（上一次没算完就丢掉这一帧） */
async function onLocatePatch(patch) {
  if (!locate.enabled || placing || !patch || !patch.gray) return;
  locate.lastPatchAt = Date.now();
  const v = locate.video;
  const d = locate.display;
  if (!v || !d || !v.videoWidth || locate.busy) return;
  const k = v.videoWidth / d.width; // 截屏像素 / 屏幕逻辑像素
  const ringR = radius(window.innerWidth, window.innerHeight);
  const centre = {
    x: (window.screenX + window.innerWidth / 2 - d.x) * k,
    y: (window.screenY + window.innerHeight / 2 - d.y) * k
  };
  const ringRs = ringR * k;
  const half = Math.ceil((64 / LOCATE_PATCH_R) * ringRs * LOCATE_MAX_SCALE);
  const x0 = Math.max(0, Math.floor(centre.x - half));
  const y0 = Math.max(0, Math.floor(centre.y - half));
  const x1 = Math.min(v.videoWidth, Math.ceil(centre.x + half));
  const y1 = Math.min(v.videoHeight, Math.ceil(centre.y + half));
  if (x1 - x0 < 16 || y1 - y0 < 16) return;
  locate.busy = true;
  try {
    const bitmap = await createImageBitmap(v, x0, y0, x1 - x0, y1 - y0);
    ensureWorker().postMessage(
      { type: 'frame', patch, bitmap, origin: { x: x0, y: y0 }, centre, ringR: ringRs, now: Date.now() },
      [bitmap]
    );
  } catch (err) {
    locate.busy = false;
    setLocateStatus('error', { message: String((err && err.message) || err) });
  }
}

window.overlayApi.onLocatePatch((p) => {
  onLocatePatch(p);
});

window.overlayApi.onLocateConfig((c) => {
  if (!c) return;
  const was = locate.enabled;
  const sourceChanged = c.sourceId !== locate.sourceId;
  locate.enabled = !!c.enabled && !!c.sourceId;
  locate.sourceId = c.sourceId || '';
  locate.display = c.display || null;
  if (c.reset || !was) {
    ensureWorker().postMessage({ type: 'reset', savedScale: c.savedScale || 0 });
    locate.dot = null;
    draw();
  }
  if (!locate.enabled) {
    stopLocateCapture();
    locate.dot = null;
    draw();
    setLocateStatus(c.enabled ? 'error' : 'off', c.enabled ? { message: '找不到要截取的屏幕' } : null);
    return;
  }
  if (sourceChanged || !locate.stream) startLocateCapture();
});

// 一段时间没有新切片（视频暂停、过场、没小地图）：让点按时消失，别挂一个过期的点
setInterval(() => {
  if (!locate.enabled || !locate.worker || locate.busy) return;
  if (locate.dot && Date.now() - locate.lastPatchAt > 600) locate.worker.postMessage({ type: 'tick', now: Date.now() });
  if (!locate.dot && locate.lastPatchAt && Date.now() - locate.lastPatchAt > 3000) setLocateStatus('waiting');
}, 300);

/** 视角有更新时续期，并在过期那一刻重绘一次把绿弧收掉 */
let viewExpireTimer = 0;
function touchView() {
  tween.view.at = Date.now();
  clearTimeout(viewExpireTimer);
  viewExpireTimer = setTimeout(draw, VIEW_STALE_MS + 50);
}

window.addEventListener('resize', resize);

window.overlayApi.onBearing((payload) => {
  if (!payload) return;

  // 箭头：hold 表示这一帧的判据是「疑似反向」，保持原角度不动，不要跟着转
  if (!payload.hold && typeof payload.angle === 'number') {
    setTarget('arrow', payload.angle);
  }

  // 视角：可能是 null（这一帧没识别到扇形）。
  // 这时**不续期**，让绿弧自然过期消失 —— 否则会挂一段没有证据的假方向。
  if (typeof payload.view === 'number') {
    tween.view.conf = payload.viewConfidence || 0;
    tween.view.width = payload.viewWidth || 0;
    setTarget('view', payload.view);
    touchView();
  }
});

window.overlayApi.onMode((mode) => {
  placing = mode === 'place';
  document.body.classList.toggle('placing', placing);
  draw();
});

resize();

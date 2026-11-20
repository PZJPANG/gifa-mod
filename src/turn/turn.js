'use strict';

/**
 * 转向提醒。主进程检测到博主左转 / 右转 / 掉头时发 turn:show，这里弹出约 2 秒后淡出。
 * 调整位置模式下常驻显示一个示例，方便拖到合适的地方。
 *
 * 图标是导航软件那种转弯箭头：圆头粗线从下往上走，圆滑地拐进转弯方向，末端一个圆角箭头。
 * 坐标系 viewBox -50..50；左转是右转的镜像。
 */

const card = document.getElementById('card');
const icon = document.getElementById('icon');
const text = document.getElementById('text');
const deg = document.getElementById('deg');

const SVG = 'http://www.w3.org/2000/svg';

// 右转：竖杆往上，圆角拐向右，箭头朝右
const RIGHT = {
  stroke: 'M -14 26 L -14 2 Q -14 -12 0 -12 L 12 -12',
  head: 'M 10 -25 L 27 -12 L 10 1 Z'
};
// 掉头：右边往上，顶上绕半圈，左边往下，箭头朝下
const BACK = {
  stroke: 'M 13 26 L 13 -4 A 13 13 0 0 0 -13 -4 L -13 8',
  head: 'M -26 6 L -13 23 L 0 6 Z'
};

const LABELS = { left: '左转', right: '右转', back: '掉头' };

function drawIcon(dir) {
  icon.textContent = '';
  const shape = dir === 'back' ? BACK : RIGHT;
  const g = document.createElementNS(SVG, 'g');
  // 按视觉重心居中（箭头头部更重，整体往反方向挪一点）；左转是右转的镜像
  const t = { right: 'translate(-6 -2)', left: 'scale(-1 1) translate(-6 -2)', back: 'translate(4 -4)' };
  g.setAttribute('transform', t[dir] || t.right);
  const s = document.createElementNS(SVG, 'path');
  s.setAttribute('class', 'stroke');
  s.setAttribute('d', shape.stroke);
  const h = document.createElementNS(SVG, 'path');
  h.setAttribute('class', 'head');
  h.setAttribute('d', shape.head);
  g.append(s, h);
  icon.append(g);
}

let editing = false;
let hideTimer = 0;
let outTimer = 0;

function paint(dir, degrees) {
  drawIcon(dir);
  text.textContent = LABELS[dir] || '';
  deg.textContent = dir === 'back' ? '方向反过来了' : Number.isFinite(degrees) ? `约 ${degrees}°` : '';
  card.classList.remove('left', 'right', 'back');
  card.classList.add(dir);
}

function show(dir, degrees) {
  clearTimeout(hideTimer);
  clearTimeout(outTimer);
  paint(dir, degrees);
  card.classList.remove('show', 'out');
  void card.offsetWidth; // 重新触发入场动画
  card.classList.add('show');
  if (editing) return;
  hideTimer = setTimeout(() => {
    card.classList.add('out');
    outTimer = setTimeout(() => card.classList.remove('show', 'out'), 440);
  }, 2000);
}

window.turnApi.onTurn((t) => {
  if (!t) return;
  show(t.dir, t.deg);
});

window.turnApi.onMode((mode) => {
  editing = mode === 'edit';
  document.body.classList.toggle('editing', editing);
  if (editing) show('right', 90);
  else card.classList.remove('show', 'out');
});

document.getElementById('btnLock').addEventListener('click', () => window.turnApi.lock());

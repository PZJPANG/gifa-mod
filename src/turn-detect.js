'use strict';

/**
 * 转向检测：博主在视频里左转 / 右转 / 掉头时发出提示，屏幕上弹一个大箭头。
 *
 * 输入是红箭头那一路「行进方向」（罗盘角，0 = 北，顺时针为正），不是镜头方向 ——
 * 站着转镜头不算转弯。判定一次转弯需要三件事同时成立：
 *   1. 1.6~2.8 秒前方向是稳的（全部样本离均值 ≤ 20°）—— 转弯之前在直走；
 *   2. 最近 0.6 秒方向也是稳的 —— 转完了、又在直走；
 *   3. 两段均值相差 ≥ minTurn（默认 60°）。≥150° 算掉头。
 * 慢慢拐的弧线、单帧误判（包括 180° 翻转）都满足不了「前后都稳」，不会误报。
 * 样本之间断档超过 0.8 秒（暂停、拖进度、画面里没小地图）就从断档之后重新算，
 * 拖进度条造成的方向跳变不会被当成转弯。
 */

function shortAngle(a, b) {
  return ((a - b + 540) % 360) - 180;
}

function circMean(list) {
  let sx = 0;
  let sy = 0;
  for (const s of list) {
    sx += Math.cos((s.a * Math.PI) / 180);
    sy += Math.sin((s.a * Math.PI) / 180);
  }
  return ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
}

function createTurnDetector(opts = {}) {
  let minTurn = opts.minTurn ?? 60;
  const recentMs = opts.recentMs ?? 600;
  const pastFrom = opts.pastFromMs ?? 1600;
  const pastTo = opts.pastToMs ?? 2800;
  const maxGap = opts.maxGapMs ?? 800;
  const stable = opts.stableDeg ?? 20;
  const cooldown = opts.cooldownMs ?? 2500;
  let samples = [];
  let lastFire = -Infinity;

  return {
    /** 喂一个样本（罗盘角、毫秒时间戳）。转弯时返回 { dir: 'left'|'right'|'back', deg }，否则 null */
    push(angle, t) {
      if (!Number.isFinite(angle) || !Number.isFinite(t)) return null;
      if (samples.length && t - samples[samples.length - 1].t > maxGap) samples = [];
      samples.push({ a: ((angle % 360) + 360) % 360, t });
      while (samples.length && t - samples[0].t > pastTo + 200) samples.shift();
      if (t - lastFire < cooldown) return null;

      const recent = samples.filter((s) => t - s.t <= recentMs);
      // 「之前」那一段必须完全在上一次提示之后，同一个弯不会报两次
      const past = samples.filter((s) => t - s.t >= pastFrom && t - s.t <= pastTo && s.t >= lastFire);
      if (recent.length < 2 || past.length < 2) return null;
      const r = circMean(recent);
      const p = circMean(past);
      if (recent.some((s) => Math.abs(shortAngle(s.a, r)) > stable)) return null;
      if (past.some((s) => Math.abs(shortAngle(s.a, p)) > stable)) return null;
      const d = shortAngle(r, p);
      if (Math.abs(d) < minTurn) return null;
      lastFire = t;
      return { dir: Math.abs(d) >= 150 ? 'back' : d > 0 ? 'right' : 'left', deg: Math.round(Math.abs(d)) };
    },
    /** 画面里没小地图 / 换视频：清空 */
    reset() {
      samples = [];
    },
    setMinTurn(v) {
      if (Number.isFinite(v)) minTurn = v;
    }
  };
}

module.exports = { createTurnDetector, shortAngle, circMean };

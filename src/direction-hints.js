'use strict';

/**
 * 从字幕里认出「博主说的方向」：往左 / 往右 / 掉头。
 * 说到的那一刻在屏幕上弹出转向提示（turn/index.html），和懒人妈宝的方向提醒是同一种体验。
 *
 * 规则：
 *   · 先去掉标点空白（AI 字幕断句很乱）；
 *   · 「左右」整体忽略：「十秒左右」「左右两边」都不是指路；
 *   · 一句里同时有多个方向，取最先说到的那个；
 *   · 「掉头 / 往回走」优先识别为掉头。
 */

const PUNCT = /[\s，。、,.!！?？:：;；"'“”‘’()（）【】\[\]…~～\-—·]/g;

const RULES = [
  { dir: 'back', re: /(掉头|调头|回头走|往回走|往回跑|往回游|原路返回|往后走|往后退|转身)/ },
  { dir: 'left', re: /(往左|向左|朝左|左转|左拐|拐左|转左|靠左|左手边|左手|左边|左侧|左面)/ },
  { dir: 'right', re: /(往右|向右|朝右|右转|右拐|拐右|转右|靠右|右手边|右手|右边|右侧|右面)/ }
];

/** 返回 { dir: 'left'|'right'|'back', phrase } 或 null */
function parseDirection(text) {
  const s = String(text || '')
    .replace(PUNCT, '')
    .replace(/左右/g, '__');
  if (!s) return null;
  let best = null;
  for (const r of RULES) {
    const m = r.re.exec(s);
    if (m && (!best || m.index < best.index)) best = { dir: r.dir, index: m.index, phrase: m[0] };
  }
  return best ? { dir: best.dir, phrase: best.phrase } : null;
}

/**
 * 时间从 prev 走到 t（正常播放）时，有没有一句「刚开始说」的字幕提到方向。
 * 以句首为准：博主一说出口就提示，不等整句说完。
 */
function crossedDirectionCue(cues, prev, t) {
  if (!cues || !cues.length || !(t > prev)) return null;
  for (const cue of cues) {
    if (cue.from > t) break;
    if (cue.from > prev && cue.from <= t) {
      const hit = parseDirection(cue.text);
      if (hit) return { ...hit, text: cue.text };
    }
  }
  return null;
}

module.exports = { parseDirection, crossedDirectionCue };

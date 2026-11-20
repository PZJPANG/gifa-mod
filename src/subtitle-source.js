'use strict';

/**
 * 字幕数据源 —— 只管「拿到 B 站视频的 CC / AI 字幕」，不碰窗口。
 *
 * 流程：BV 号 + 分 P → cid（view 接口）→ 字幕轨列表（player/wbi/v2）→ 字幕 JSON。
 *
 * 为什么要 WBI 签名：老的 x/player/v2 不签名也能用，但未登录时会把 AI 字幕
 * 张冠李戴成别的视频的字幕（B 站侧已知问题）。wbi/v2 签了名才可靠，
 * 失败时才退回老接口兜底。
 *
 * fetch 由调用方注入：主进程传 biliFetch（带登录 Cookie，AI 字幕要登录才给地址），
 * 离线测试可以直接传全局 fetch。
 */

const crypto = require('node:crypto');

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52
];

const WBI_TTL_MS = 60 * 60 * 1000;

function keyFromUrl(u) {
  const m = /\/([^/]+?)(?:\.\w+)?$/.exec(String(u || ''));
  return m ? m[1] : '';
}

function mixinKey(imgKey, subKey) {
  const orig = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((i) => orig[i] || '').join('').slice(0, 32);
}

/** 纯函数：给参数加 wts / w_rid，返回查询串。now 可注入便于离线回归 */
function signWbi(params, key, now = Date.now()) {
  const all = { ...params, wts: Math.round(now / 1000) };
  const query = Object.keys(all)
    .sort()
    .map((k) => {
      const v = String(all[k]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');
  const wRid = crypto.createHash('md5').update(query + key).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

/** 语言偏好：用户选过的优先；否则人工中文 > AI 中文 > 第一条 */
const ZH_HUMAN = ['zh-CN', 'zh-Hans', 'zh-Hant', 'zh-HK', 'zh-TW'];
function pickTrack(tracks, lang) {
  const usable = (tracks || []).filter((t) => t && t.url);
  if (!usable.length) return null;
  if (lang) {
    const hit = usable.find((t) => t.lan === lang);
    if (hit) return hit;
  }
  for (const lan of ZH_HUMAN) {
    const hit = usable.find((t) => t.lan === lan);
    if (hit) return hit;
  }
  return usable.find((t) => /^ai-zh/.test(t.lan)) || usable[0];
}

/** 把字幕 JSON 的 body 整理成按开始时间排好序的 [{from,to,text}] */
function normalizeCues(body) {
  if (!Array.isArray(body)) return [];
  return body
    .map((c) => ({
      from: Number(c && c.from),
      to: Number(c && c.to),
      text: String((c && c.content) || '').trim()
    }))
    .filter((c) => Number.isFinite(c.from) && Number.isFinite(c.to) && c.to > c.from && c.text)
    .sort((a, b) => a.from - b.from);
}

/**
 * 时间 t（秒）处应显示的字幕文本；没有则返回 ''。
 * 二分找最后一条 from <= t 的，再往前看几条处理重叠（AI 字幕偶尔会叠两句）。
 */
function cueAt(cues, t) {
  if (!cues || !cues.length || !Number.isFinite(t)) return '';
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

/* ---- 自动暂停：字幕里出现「过完剧情」之类的话 ---- */

/**
 * 关键词写法：普通文字按原样匹配；「*」= 中间可以夹 0~6 个字。
 * 例：「过完*剧情」能匹配「过完剧情之后」「过完这段剧情」「过完前面的剧情」。
 * AI 字幕常把标点、空格断得乱七八糟，比较前两边都去掉标点和空白。
 */
const DEFAULT_PAUSE_KEYWORDS = ['过完*剧情', '剧情过完', '看完*剧情', '剧情*结束后'];

const PUNCT_RE = /[\s，。、,.!！?？:：;；"'“”‘’()（）【】\[\]…~～\-—·]/g;

function normalizeLine(text) {
  return String(text || '').replace(PUNCT_RE, '');
}

function compileKeywords(list) {
  return (Array.isArray(list) ? list : [])
    .map((k) => normalizeLine(String(k || '').replace(/\*/g, '\u0000')).replace(/\u0000/g, '*'))
    .filter((k) => k.replace(/\*/g, ''))
    .slice(0, 30)
    .map((k) => ({
      word: k,
      re: new RegExp(
        k
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.{0,6}')
      )
    }));
}

/** 命中返回关键词本身，否则 '' */
function matchKeyword(text, compiled) {
  const line = normalizeLine(text);
  if (!line) return '';
  const hit = (compiled || []).find((k) => k.re.test(line));
  return hit ? hit.word : '';
}

/** 「逗号 / 顿号 / 换行」分隔的关键词字符串 → 数组（去重、去空） */
function parseKeywordText(text) {
  const out = [];
  for (const raw of String(text || '').split(/[,，、;；\n]/)) {
    const k = raw.trim().slice(0, 30);
    if (k && !out.includes(k)) out.push(k);
  }
  return out.slice(0, 30);
}

/**
 * 时间从 prev 走到 t（正常播放，不是拖动）时，有没有一句命中关键词的字幕「刚说完」。
 * 以句末为准：整句听完再停，下一句的走法不会被截掉一半。
 * 返回命中的那一句 { cue, word }，没有返回 null。
 */
function crossedPauseCue(cues, prev, t, compiled) {
  if (!cues || !cues.length || !(t > prev)) return null;
  for (const cue of cues) {
    if (cue.from > t) break; // cues 按开始时间排好序
    if (cue.to > prev && cue.to <= t) {
      const word = matchKeyword(cue.text, compiled);
      if (word) return { cue, word };
    }
  }
  return null;
}

/* ---- 弹幕：x/v1/dm/list.so 返回的 XML ---- */

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * <d p="出现时间,模式,字号,颜色,发送时间,弹幕池,用户哈希,id,屏蔽等级">内容</d>
 * 模式：1~3 滚动、4 底部、5 顶部、6 逆向（按滚动处理）、7 高级 / 8 代码弹幕（丢掉，画不了）。
 * 输出按出现时间排好序：[{ t, mode, size, color, text }]，mode 只剩 1 / 4 / 5。
 */
function parseDanmakuXml(xml) {
  const out = [];
  const re = /<d\s+p="([^"]*)"[^>]*>([^<]*)<\/d>/g;
  let m;
  while ((m = re.exec(String(xml || ''))) && out.length < 20000) {
    const p = m[1].split(',');
    const t = Number(p[0]);
    let mode = Number(p[1]);
    if (!Number.isFinite(t) || t < 0) continue;
    if (mode === 2 || mode === 3 || mode === 6) mode = 1;
    if (mode !== 1 && mode !== 4 && mode !== 5) continue;
    const text = decodeEntities(m[2]).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const size = Number(p[2]);
    const color = Number(p[3]);
    out.push({
      t,
      mode,
      size: Number.isFinite(size) && size > 0 ? Math.min(64, size) : 25,
      color: Number.isFinite(color) ? color & 0xffffff : 0xffffff,
      text: text.slice(0, 100)
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

function toTracks(list) {
  return (Array.isArray(list) ? list : []).map((s) => ({
    lan: String((s && s.lan) || ''),
    name: String((s && (s.lan_doc || s.lan)) || '字幕'),
    ai: !!(s && s.ai_type) || /^ai-/.test(String((s && s.lan) || '')),
    url: s && s.subtitle_url ? String(s.subtitle_url).replace(/^\/\//, 'https://').replace(/^http:/, 'https:') : ''
  }));
}

/**
 * 把 x/player/(wbi/)v2 的 data（主进程自己请求的，或页面里旁听 / 主动请求到的）
 * 整理成 { tracks, needLogin }。
 *
 * needLogin：未登录时 B 站干脆不返回 AI 字幕轨（列表为空、need_login_subtitle=true），
 * 不能当成「没有字幕」；有轨但地址全空也是同一回事。
 */
function tracksFromPlayerData(data) {
  const tracks = toTracks(data && data.subtitle && data.subtitle.subtitles);
  const loggedOut = !!data && !data.login_mid;
  const needLogin =
    (tracks.length > 0 && tracks.every((t) => !t.url)) ||
    (tracks.length === 0 && loggedOut && !!(data && data.need_login_subtitle));
  return { tracks, needLogin };
}

function createSubtitleSource(fetchImpl) {
  let wbi = { key: '', at: 0 };
  const cidCache = new Map(); // `${id}` -> [{page,cid}]

  async function getJson(url) {
    const res = await fetchImpl(url);
    return res.json();
  }

  async function wbiKey() {
    if (wbi.key && Date.now() - wbi.at < WBI_TTL_MS) return wbi.key;
    // 未登录时 nav 返回 code -101，但 wbi_img 照样给
    const json = await getJson('https://api.bilibili.com/x/web-interface/nav');
    const img = json && json.data && json.data.wbi_img;
    if (!img) throw new Error('拿不到 WBI 密钥');
    wbi = { key: mixinKey(keyFromUrl(img.img_url), keyFromUrl(img.sub_url)), at: Date.now() };
    return wbi.key;
  }

  async function cidFor(id, p) {
    let pages = cidCache.get(id);
    if (!pages) {
      const q = id.startsWith('av') ? `aid=${id.slice(2)}` : `bvid=${id}`;
      const json = await getJson(`https://api.bilibili.com/x/web-interface/view?${q}`);
      if (!json || json.code !== 0) throw new Error((json && json.message) || '读取视频信息失败');
      const d = json.data || {};
      pages = (d.pages || []).map((x) => ({ page: x.page, cid: x.cid }));
      if (!pages.length && d.cid) pages = [{ page: 1, cid: d.cid }];
      pages.aid = d.aid;
      pages.bvid = d.bvid;
      cidCache.set(id, pages);
    }
    const hit = pages.find((x) => x.page === p) || pages[0];
    if (!hit) throw new Error('找不到分 P');
    return { cid: hit.cid, aid: pages.aid, bvid: pages.bvid };
  }

  /**
   * 读字幕轨列表。返回 { tracks, needLogin }。
   * needLogin：有轨但地址全空 —— AI 字幕未登录时就是这样。
   */
  async function loadTracks(id, p) {
    const { cid, aid, bvid } = await cidFor(id, p);
    const base = bvid ? { bvid, cid } : { aid, cid };
    let data = null;
    try {
      const qs = signWbi(base, await wbiKey());
      const json = await getJson(`https://api.bilibili.com/x/player/wbi/v2?${qs}`);
      if (json && json.code === 0) data = json.data;
      else if (json && json.code === -403) wbi = { key: '', at: 0 }; // 密钥过期，下次重取
    } catch {
      /* 退回老接口 */
    }
    if (!data) {
      const q = Object.entries(base).map(([k, v]) => `${k}=${v}`).join('&');
      const json = await getJson(`https://api.bilibili.com/x/player/v2?${q}`);
      if (json && json.code === 0) data = json.data;
      else throw new Error((json && json.message) || '字幕接口没有返回数据');
    }
    return tracksFromPlayerData(data);
  }

  async function loadCues(track) {
    if (!track || !track.url) return [];
    const json = await getJson(track.url);
    return normalizeCues(json && json.body);
  }

  /** 整集弹幕（B 站按视频长度给最近的若干条，长视频一般几千条）。cid 已知（页面上报过）就省掉一次 view 请求 */
  async function loadDanmaku(id, p, knownCid) {
    const cid = knownCid || (await cidFor(id, p)).cid;
    const urls = [`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, `https://comment.bilibili.com/${cid}.xml`];
    let lastErr = null;
    for (const url of urls) {
      try {
        const res = await fetchImpl(url);
        const xml = await res.text();
        if (/<d\s+p=/.test(xml) || /<i>/.test(xml)) return parseDanmakuXml(xml);
        lastErr = new Error('弹幕接口返回的不是弹幕');
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('读取弹幕失败');
  }

  return { loadTracks, loadCues, loadDanmaku };
}

module.exports = {
  createSubtitleSource,
  tracksFromPlayerData,
  pickTrack,
  cueAt,
  normalizeCues,
  signWbi,
  mixinKey,
  DEFAULT_PAUSE_KEYWORDS,
  compileKeywords,
  matchKeyword,
  parseKeywordText,
  crossedPauseCue,
  parseDanmakuXml
};

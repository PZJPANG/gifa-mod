// Run with GIFA's bundled Node:  $env:ELECTRON_RUN_AS_NODE='1'; & ..\GIFA.exe tests\test-subtitle.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');

const src = path.join(__dirname, '..', 'src');
let fail = 0;
for (const f of ['main.js', 'preload.js', 'webview-preload.js', 'subtitle-source.js', 'renderer/app.js', 'console/console.js', 'subtitle/subtitle.js', 'subtitle/preload.js', 'danmaku/danmaku.js', 'danmaku/preload.js', 'overlay/overlay.js', 'overlay/preload.js', 'overlay/locate-core.js', 'overlay/locate-worker.js', 'screen-grab.js', 'direction-hints.js', 'turn/turn.js', 'turn/preload.js', 'hotkey-config.js']) {
  try {
    new vm.Script(`(function(require,module,exports,__dirname,__filename){${fs.readFileSync(path.join(src, f), 'utf8')}\n})`, { filename: f });
    console.log('syntax ok  ', f);
  } catch (e) {
    fail++;
    console.log('SYNTAX FAIL', f, e.message);
  }
}

const S = require(path.join(src, 'subtitle-source.js'));
const { mergeHotkeys } = require(path.join(src, 'hotkey-config.js'));

// cueAt
const cues = S.normalizeCues([
  { from: 3, to: 5, content: ' second ' },
  { from: 1, to: 2.5, content: 'first' },
  { from: 4.5, to: 6, content: 'overlap' },
  { from: 7, to: 7, content: 'zero-length' },
  { from: 8, to: 9, content: '' }
]);
assert.strictEqual(cues.length, 3);
assert.strictEqual(S.cueAt(cues, 0.5), '');
assert.strictEqual(S.cueAt(cues, 1), 'first');
assert.strictEqual(S.cueAt(cues, 2.7), '');
assert.strictEqual(S.cueAt(cues, 4), 'second');
assert.strictEqual(S.cueAt(cues, 4.7), 'second\noverlap');
assert.strictEqual(S.cueAt(cues, 5.5), 'overlap');
assert.strictEqual(S.cueAt(cues, 100), '');
assert.strictEqual(S.cueAt([], 1), '');

// pickTrack
const tracks = [
  { lan: 'en-US', url: 'u1' },
  { lan: 'ai-zh', url: 'u2' },
  { lan: 'zh-CN', url: 'u3' },
  { lan: 'ja', url: '' }
];
assert.strictEqual(S.pickTrack(tracks, '').lan, 'zh-CN');
assert.strictEqual(S.pickTrack(tracks, 'en-US').lan, 'en-US');
assert.strictEqual(S.pickTrack(tracks, 'ja').lan, 'zh-CN'); // ja has no url
assert.strictEqual(S.pickTrack(tracks.slice(0, 2), '').lan, 'ai-zh');
assert.strictEqual(S.pickTrack([{ lan: 'x', url: '' }], ''), null);

// WBI: known vector from bilibili-API-collect docs
const key = S.mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
assert.strictEqual(key, 'ea1db124af3c7062474693fa704f4ff8');
const qs = S.signWbi({ foo: '114', bar: '514', zab: 1919810 }, key, 1702204169 * 1000);
assert.strictEqual(qs, 'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');

// hotkeys: old settings without the new keys get defaults; conflicting saved key leaves it blank
const defaults = { toggleVisible: 'Alt+H', toggleSubtitle: 'Alt+C', moveSubtitle: 'Alt+V' };
assert.deepStrictEqual(mergeHotkeys(defaults, { toggleVisible: 'Alt+H' }), defaults);
assert.strictEqual(mergeHotkeys(defaults, { toggleVisible: 'Alt+C' }).toggleSubtitle, '');
// page-reported payload, shaped the way main.js rebuilds it from webview-preload's message
let pt = S.tracksFromPlayerData({ subtitle: { subtitles: [{ lan: 'ai-zh', lan_doc: '中文（自动生成）', ai_type: 1, subtitle_url: '//aisubtitle.hdslb.com/a.json' }] }, login_mid: 1, need_login_subtitle: false });
assert.deepStrictEqual([pt.tracks.length, pt.tracks[0].ai, pt.tracks[0].url, pt.needLogin], [1, true, 'https://aisubtitle.hdslb.com/a.json', false]);
pt = S.tracksFromPlayerData({ subtitle: { subtitles: [] }, login_mid: 0, need_login_subtitle: true });
assert.deepStrictEqual([pt.tracks.length, pt.needLogin], [0, true]);
pt = S.tracksFromPlayerData(null);
assert.deepStrictEqual([pt.tracks.length, pt.needLogin], [0, false]);
// protobuf track extractor from webview-preload.js (pure part only)
{
  const wsrc = fs.readFileSync(path.join(src, 'webview-preload.js'), 'utf8');
  const a = wsrc.indexOf('const utf8 = new TextDecoder');
  const b = wsrc.indexOf('async function inspectSubtitleView');
  assert(a > 0 && b > a, 'extractor slice not found');
  const ctx = vm.createContext({ TextDecoder });
  vm.runInContext(wsrc.slice(a, b) + '\nthis.collectPbTracks = collectPbTracks;', ctx);
  const varint = (n) => { const o = []; do { let x = n % 128; n = Math.floor(n / 128); if (n) x |= 128; o.push(x); } while (n); return o; };
  const fld = (no, bytes) => [...varint(no * 8 + 2), ...varint(bytes.length), ...bytes];
  const num = (no, n) => [...varint(no * 8), ...varint(n)];
  const str = (no, s) => fld(no, [...Buffer.from(s, 'utf8')]);
  const track = (id, lan, doc, url) => [...num(1, id), ...str(2, lan), ...str(3, doc), ...num(5, 1), ...str(6, url)];
  const msg = [
    ...num(1, 1),
    ...fld(3, [
      ...fld(1, track(42, 'ai-zh', '中文（自动生成）', 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/abc?auth_key=1-2-3')),
      ...fld(1, track(43, 'en-US', '英语（美国）', '//i0.hdslb.com/bfs/subtitle/xyz.json')),
      ...fld(1, [...str(1, 'zh-CN'), ...str(2, 'x'.repeat(10))]) // ten-byte string -> length byte 0x0a; no url
    ])
  ];
  const out = [];
  ctx.collectPbTracks(Uint8Array.from(msg), 0, out);
  assert.deepStrictEqual(out.map((t) => [t.lan, t.lan_doc, t.ai_type, t.subtitle_url]), [
    ['ai-zh', '中文（自动生成）', 1, 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/abc?auth_key=1-2-3'],
    ['en-US', '英语（美国）', 0, '//i0.hdslb.com/bfs/subtitle/xyz.json']
  ]);
  // logged-out response seen live: "\n\0" -> no tracks, no crash
  const none = [];
  ctx.collectPbTracks(Uint8Array.from([0x0a, 0x00]), 0, none);
  assert.strictEqual(none.length, 0);
  // garbage must not throw
  ctx.collectPbTracks(Uint8Array.from([0xff, 0xff, 0xff, 0x01, 0x07]), 0, []);
  console.log('protobuf extractor tests ok');
}
// auto-pause keyword matching
{
  const kw = S.compileKeywords(S.DEFAULT_PAUSE_KEYWORDS);
  const yes = ['过完剧情之后我们往左走', '好 过完这段剧情以后', '过完，剧情之后', '等剧情过完了再说', '看完前面的剧情', '剧情对话结束后传送'];
  const no = ['我们先过去拿宝箱', '这个剧情很长', '过完桥往右', ''];
  for (const s of yes) assert(S.matchKeyword(s, kw), 'should match: ' + s);
  for (const s of no) assert.strictEqual(S.matchKeyword(s, kw), '', 'should not match: ' + s);
  // * spans at most 6 chars
  assert.strictEqual(S.matchKeyword('过完了一大段非常非常长的剧情', S.compileKeywords(['过完*剧情'])), '');
  // custom words, regex metachars are literal
  const custom = S.compileKeywords(S.parseKeywordText('跳过动画，a.b（测试）, , 跳过动画'));
  assert.deepStrictEqual(custom.map((k) => k.word), ['跳过动画', 'ab测试']);
  assert(S.matchKeyword('先跳过动画', custom));
  assert.strictEqual(S.matchKeyword('axb测试', custom), '');
  assert.deepStrictEqual(S.parseKeywordText(''), []);

  // pause when the matching line FINISHES during normal playback
  const cues = S.normalizeCues([
    { from: 10, to: 12, content: '往前走' },
    { from: 12.5, to: 15, content: '过完剧情之后往左' },
    { from: 15.2, to: 17, content: '然后上楼' }
  ]);
  assert.strictEqual(S.crossedPauseCue(cues, 13, 14.8, kw), null); // still speaking
  assert.strictEqual(S.crossedPauseCue(cues, 14.8, 15.1, kw).cue.text, '过完剧情之后往左'); // just finished
  assert.strictEqual(S.crossedPauseCue(cues, 15.1, 15.4, kw), null); // after resume: no re-trigger
  assert.strictEqual(S.crossedPauseCue(cues, 15.1, 15.1, kw), null); // paused heartbeat
  assert.strictEqual(S.crossedPauseCue([], 1, 2, kw), null);
  console.log('auto-pause tests ok');
}
// danmaku XML parser
{
  const xml = `<?xml version="1.0" encoding="UTF-8"?><i><chatserver>chat.bilibili.com</chatserver>
    <d p="12.5,1,25,16777215,1700000000,0,abc,1,10">前方高能</d>
    <d p="3.2,5,25,16711680,1700000000,0,abc,2,10">顶部&amp;红色 &lt;3</d>
    <d p="4,4,36,65280,1700000000,0,abc,3,10">底部</d>
    <d p="5,7,25,16777215,1700000000,0,abc,4,10">[0,0,"1-1",4.5,"高级"]</d>
    <d p="6,6,25,16777215,1700000000,0,abc,5,10">逆向&#x1F600;</d>
    <d p="7,1,25,16777215,1700000000,0,abc,6,10">   </d>
    <d p="bad,1,25,16777215,1,0,abc,7,10">坏</d></i>`;
  const dm = S.parseDanmakuXml(xml);
  assert.deepStrictEqual(dm.map((d) => [d.t, d.mode, d.text]), [
    [3.2, 5, '顶部&红色 <3'],
    [4, 4, '底部'],
    [6, 1, '逆向😀'],
    [12.5, 1, '前方高能']
  ]);
  assert.strictEqual(dm[0].color, 0xff0000);
  assert.strictEqual(dm[1].size, 36);
  assert.deepStrictEqual(S.parseDanmakuXml('<i></i>'), []);
  console.log('danmaku parser tests ok');
}

// danmaku overlay renderer, simulated headless
{
  const handlers = {};
  let rafCb = null;
  const fakeCtx = () => ({
    font: '25px x',
    setTransform() {}, scale() {}, clearRect() {}, drawImage() {}, fillRect() {}, strokeText() {}, fillText() {},
    save() {}, restore() {}, createLinearGradient: () => ({ addColorStop() {} }),
    measureText(t) { const px = Number((/(\d+)px/.exec(this.font) || [0, 25])[1]); return { width: [...t].length * px }; }
  });
  const ctx = vm.createContext({
    Date, Math, Number, Array, String,
    window: { devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080, addEventListener() {},
      dmApi: { onItems: (cb) => (handlers.items = cb), onTime: (cb) => (handlers.time = cb), onStyle: (cb) => (handlers.style = cb) } },
    document: { getElementById: () => ({ getContext: fakeCtx }), createElement: () => ({ getContext: fakeCtx }) },
    requestAnimationFrame: (cb) => { rafCb = cb; }
  });
  const dsrc = fs.readFileSync(path.join(src, 'danmaku', 'danmaku.js'), 'utf8');
  vm.runInContext(dsrc + '\nthis.__t = { scrolling, pinned, get mask() { return mask; }, laneCount };', ctx);
  const T = ctx.__t;
  let now = 0; // ms of fake frame time
  const frame = () => { now += 16; const cb = rafCb; rafCb = null; cb(now); };

  // 200 scrolling danmaku all at t=1..3s -> lanes fill, rest dropped, no rear-ending in a lane
  const items = [];
  for (let i = 0; i < 200; i++) items.push({ t: 1 + (i % 20) * 0.1, mode: 1, size: 25, color: 0xffffff, text: '弹幕测试'.repeat(1 + (i % 3)) });
  items.push({ t: 1.5, mode: 5, size: 25, color: 0xff0000, text: '顶部' });
  items.sort((a, b) => a.t - b.t);
  handlers.style({ opacity: 0.85, fontSize: 25, duration: 8, area: 0.5, mask: { x: 0, y: 0, w: 300, h: 290 } });
  handlers.items({ items });
  const base = Date.now();
  handlers.time({ current: 0.9, playing: true, rate: 1, at: base });
  frame();
  handlers.time({ current: 3.5, playing: true, rate: 1, at: Date.now() });
  frame();
  const lanes = T.laneCount();
  assert.strictEqual(lanes, Math.floor((1080 * 0.5) / Math.round(25 * 1.3)));
  assert(T.scrolling.length > 0 && T.scrolling.length <= lanes, 'scrolling count within lanes: ' + T.scrolling.length);
  assert.strictEqual(T.pinned.length, 1);
  assert(T.mask && T.mask.w === 300, 'mask applied');
  const ys = T.scrolling.map((d) => d.y);
  assert.strictEqual(new Set(ys).size, ys.length, 'one danmaku per lane in a single burst');
  assert(T.scrolling.every((d) => d.y + d.h <= 1080 * 0.5 + 40), 'stays in area');

  // moving: x decreases while playing, frozen while paused
  const x0 = T.scrolling[0].x;
  for (let i = 0; i < 10; i++) frame();
  const x1 = T.scrolling[0].x;
  assert(x1 < x0, 'scrolls while playing');
  handlers.time({ current: 3.8, playing: false, rate: 1, at: Date.now() });
  frame();
  const x2 = T.scrolling[0].x;
  for (let i = 0; i < 10; i++) frame();
  assert.strictEqual(T.scrolling[0].x, x2, 'frozen while paused');

  // seek far ahead -> screen cleared, no burst of old danmaku
  handlers.time({ current: 100, playing: true, rate: 1, at: Date.now() });
  frame();
  assert.strictEqual(T.scrolling.length + T.pinned.length, 0, 'cleared on seek');
  console.log('danmaku renderer simulation ok');
}
console.log('unit tests ok');

// loadTracks with a fake API: logged-out response with need_login_subtitle and no tracks -> needLogin
async function fakeRun(playerData, playerCode = 0) {
  const fake = async (url) => ({
    json: async () => {
      if (url.includes('/nav')) return { code: -101, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } };
      if (url.includes('/view')) return { code: 0, data: { aid: 1, bvid: 'BV1xx', pages: [{ page: 1, cid: 42 }] } };
      if (url.includes('/player/')) return { code: playerCode, message: 'boom', data: playerData };
      throw new Error('unexpected ' + url);
    }
  });
  return S.createSubtitleSource(fake).loadTracks('BV1xx', 1);
}
(async () => {
  let r = await fakeRun({ need_login_subtitle: true, subtitle: { subtitles: [] } });
  assert.deepStrictEqual([r.tracks.length, r.needLogin], [0, true]);
  r = await fakeRun({ login_mid: 123, need_login_subtitle: false, subtitle: { subtitles: [] } });
  assert.deepStrictEqual([r.tracks.length, r.needLogin], [0, false]);
  r = await fakeRun({ login_mid: 123, subtitle: { subtitles: [{ lan: 'ai-zh', lan_doc: '中文（自动生成）', ai_type: 1, subtitle_url: '//aisubtitle.hdslb.com/x.json' }] } });
  assert.deepStrictEqual([r.tracks[0].url, r.needLogin], ['https://aisubtitle.hdslb.com/x.json', false]);
  await assert.rejects(fakeRun(null, -400));
  console.log('loadTracks fake-API tests ok');
})().catch((e) => { console.log('FAKE API TEST FAIL', e.message); process.exitCode = 1; });

if (fail) process.exitCode = 1;

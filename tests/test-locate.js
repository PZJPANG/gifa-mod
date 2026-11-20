'use strict';
// Run with GIFA's bundled Node:  $env:ELECTRON_RUN_AS_NODE='1'; & ..\GIFA.exe tests\test-locate.js
const path = require('node:path');
const assert = require('node:assert');
const L = require(path.join(__dirname, '..', 'src', 'overlay', 'locate-core.js'));

// deterministic RNG
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/* ---- synthetic "world map": smooth terrain + roads + rivers + building blocks ---- */
const W = 1024;
const world = new Float64Array(W * W);
function blobs(count, rmin, rmax, amp) {
  for (let k = 0; k < count; k++) {
    const cx = rnd() * W, cy = rnd() * W, r = rmin + rnd() * (rmax - rmin), a = (rnd() - 0.5) * amp;
    const x0 = Math.max(0, Math.floor(cx - 3 * r)), x1 = Math.min(W - 1, Math.ceil(cx + 3 * r));
    const y0 = Math.max(0, Math.floor(cy - 3 * r)), y1 = Math.min(W - 1, Math.ceil(cy + 3 * r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world[y * W + x] += a * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * r * r));
  }
}
blobs(900, 6, 40, 120);
function line(x0, y0, x1, y1, width, val) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  for (let s = 0; s <= len; s += 0.5) {
    const x = x0 + ((x1 - x0) * s) / len, y = y0 + ((y1 - y0) * s) / len;
    for (let dy = -width; dy <= width; dy++) for (let dx = -width; dx <= width; dx++) {
      const xi = Math.round(x + dx), yi = Math.round(y + dy);
      if (xi >= 0 && yi >= 0 && xi < W && yi < W) world[yi * W + xi] = val;
    }
  }
}
for (let k = 0; k < 160; k++) {
  const x = rnd() * W, y = rnd() * W, a = rnd() * Math.PI * 2, l = 30 + rnd() * 160;
  line(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, rnd() < 0.3 ? 2 : 1, rnd() < 0.5 ? 210 : 40);
}
for (let i = 0; i < world.length; i++) world[i] = Math.max(0, Math.min(255, world[i] + 110));

function sample(img, w, x, y) {
  x = Math.max(0, Math.min(w - 1.001, x)); y = Math.max(0, Math.min(w - 1.001, y));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const i = y0 * w + x0;
  return img[i] * (1 - fx) * (1 - fy) + img[i + 1] * fx * (1 - fy) + img[i + w] * (1 - fx) * fy + img[i + w + 1] * fx * fy;
}

const N = 128;
const R = 40; // minimap radius in patch pixels (same as the app: leaves room so big shifts don't wrap around)

/**
 * Crop an N×N "minimap" centred at (cx, cy) world px, `worldPerPx` world px per patch px.
 * Returns { gray, skip }: skip marks pixels the app's colour test flags as icons (saturated / pure white).
 * opts.hiddenIcons adds icons that the colour test does NOT catch (grey-ish markers).
 */
function crop(cx, cy, worldPerPx, opts = {}) {
  const g = new Float64Array(N * N);
  const skip = new Uint8Array(N * N);
  const c = (N - 1) / 2;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v = sample(world, W, cx + (x - c) * worldPerPx, cy + (y - c) * worldPerPx);
    if (opts.gain) v = v * opts.gain + (opts.bias || 0);
    if (opts.noise) v += (rnd() - 0.5) * opts.noise;
    g[y * N + x] = v;
  }
  if (opts.blur) {
    const out = new Float64Array(N * N);
    for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += g[(y + dy) * N + x + dx];
      out[y * N + x] = s / 9;
    }
    g.set(out);
  }
  const stamp = (ix, iy, flag) => {
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
      const i = (iy + y) * N + ix + x;
      g[i] = (x + y) % 4 ? 240 : 20;
      if (flag) skip[i] = 1;
    }
  };
  // player arrow in the centre: cyan in the game, so the colour test flags it
  const ang = opts.arrow || 0;
  for (let k = -14; k <= 14; k++) for (let w2 = -6; w2 <= 6; w2++) {
    const x = Math.round(c + Math.cos(ang) * k - Math.sin(ang) * w2 * (1 - (k + 14) / 28));
    const y = Math.round(c + Math.sin(ang) * k + Math.cos(ang) * w2 * (1 - (k + 14) / 28));
    if (x >= 0 && y >= 0 && x < N && y < N) { g[y * N + x] = 250; skip[y * N + x] = 1; }
  }
  for (let k = 0; k < (opts.icons || 0); k++) stamp(Math.round(rnd() * (N - 12)), Math.round(rnd() * (N - 12)), true);
  for (let k = 0; k < (opts.hiddenIcons || 0); k++) stamp(Math.round(rnd() * (N - 12)), Math.round(rnd() * (N - 12)), false);
  // outside the sampled radius there is nothing (video minimap clipped at the frame edge)
  if (opts.cover) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.hypot(x - c, y - c) > opts.cover) g[y * N + x] = 0;
  return { gray: g, skip };
}

const SCALES = [0.88, 0.94, 1, 1.06, 1.12];
const gameMinimapR = 60; // true radius of the in-game minimap, world px

/**
 * One frame. user/vid in world px. ringError: how wrong the user's red ring size is.
 * Video minimap arrives already normalised to radius R (the page does that from the calibrated ROI).
 */
function videoOf(vid, opts = {}) {
  // zoom: the uploader's map overlay shows the world zoom× bigger (or smaller) than a native minimap
  const v = crop(vid.x, vid.y, gameMinimapR / R / (opts.zoom || 1), {
    gain: 0.8, bias: 25, noise: 18, blur: true, arrow: 2.1, icons: 3, hiddenIcons: opts.hidden || 0, cover: opts.cover
  });
  v.cover = opts.cover;
  return v;
}
// what the overlay does: cut the game minimap out of the latest screen capture at the requested ring-size correction
const gameSampler = (user, ringError) => (s) => crop(user.x, user.y, (gameMinimapR * ringError * s) / R, { noise: 6, arrow: -0.7, icons: 2 });

function frame(user, vid, ringError, opts = {}) {
  const v = videoOf(vid, opts);
  const games = SCALES.map((s) => ({ scale: s, ...gameSampler(user, ringError)(s) }));
  return L.matchAll(v, games, N, R);
}

/* ---- 1. walking along the route: video slightly ahead, ring size learned across frames ---- */
let timeMs = 0, timedFrames = 0;
function session({ ring: ringError, zoom = 1 }, opts = {}) {
  const tracker = L.createTracker();
  // opts.known: second time watching this video, the locked ratio was saved
  const state = opts.known ? { scale: 1 / (ringError * zoom), locked: true, hist: [] } : {};
  let ok = 0, judged = 0, shown = 0, wrong = 0, gross = 0, firstDot = -1;
  const errs = [];
  let pos = { x: 260 + rnd() * 380, y: 260 + rnd() * 380 };
  const heading = rnd() * Math.PI * 2;
  // the video character is ahead / beside you and that offset changes smoothly (both of you walk)
  let lead = 8 + rnd() * 22;
  let side = (rnd() - 0.5) * 1.2;
  for (let f = 0; f < 28; f++) {
    pos = { x: pos.x + Math.cos(heading) * 4, y: pos.y + Math.sin(heading) * 4 };
    lead = Math.min(30, Math.max(6, lead + (rnd() - 0.5) * 3));
    side = Math.min(0.8, Math.max(-0.8, side + (rnd() - 0.5) * 0.15));
    const a = heading + side;
    const vid = { x: pos.x + Math.cos(a) * lead, y: pos.y + Math.sin(a) * lead };
    const t0 = Date.now();
    const r = L.locateFrame(videoOf(vid, { zoom, cover: f % 3 === 0 ? 0.86 * R : 0, hidden: opts.hidden }), gameSampler(pos, ringError), N, R, state);
    timeMs += Date.now() - t0;
    timedFrames++;
    // what the overlay would draw this frame (null = no dot)
    const dot = tracker.push(r, f * 250);
    if (f < 2) continue; // the tracker needs 2 agreeing frames before it shows anything
    // target in the overlay's units: image px at scale 1 (screen offset = u × ring radius / R)
    const wpp = (gameMinimapR * ringError) / R;
    const tx = (vid.x - pos.x) / wpp, ty = (vid.y - pos.y) / wpp;
    const e = Math.hypot(r.dx - tx, r.dy - ty);
    judged++;
    errs.push(e);
    if (e <= 2 && r.support >= 3) ok++;
    if (process.env.LOCATE_DEBUG === '2') console.log(`    f${f} ring ${ringError} support ${r.support} target (${tx.toFixed(1)},${ty.toFixed(1)}) got (${r.dx.toFixed(1)},${r.dy.toFixed(1)}) err ${e.toFixed(1)} psr ${r.psr.toFixed(1)} ncc ${r.ncc.toFixed(2)} scale ${r.scale.toFixed(3)} learned ${state.scale ? state.scale.toFixed(3) : '-'} ideal ${(1 / ringError).toFixed(3)} dot ${dot ? 'yes' : 'no'}`);
    if (dot) {
      shown++;
      if (firstDot < 0) firstDot = f;
      // the dot is smoothed and lags a little behind a moving target; >4px (~7% of the radius) counts as wrong
      if (Math.hypot(dot.x - tx, dot.y - ty) > 10) gross++; // >18% of the radius: a dot in the wrong place
      if (Math.hypot(dot.x - tx, dot.y - ty) > 4) {
        wrong++;
        if (process.env.LOCATE_DEBUG) console.log(`    WRONG DOT f${f} off by ${Math.hypot(dot.x - tx, dot.y - ty).toFixed(1)}px`);
      }
    }
  }
  if (process.env.LOCATE_DEBUG) console.log(`  ring ${ringError} zoom ${zoom}: trusted ${ok}/${judged}, dot shown ${shown}/${judged} (first at ${(firstDot * 0.25).toFixed(2)}s), wrong ${wrong}`);
  return { ok, judged, shown, wrong, gross, errs, firstDot };
}

function report(label, cases, opts) {
  const t = { ok: 0, judged: 0, shown: 0, wrong: 0, gross: 0 };
  const errs = [];
  const firsts = [];
  for (const c of cases) {
    const s = session(c, opts);
    for (const k of Object.keys(t)) t[k] += s[k];
    errs.push(...s.errs);
    if (s.firstDot >= 0) firsts.push(s.firstDot * 0.25);
  }
  errs.sort((a, b) => a - b);
  firsts.sort((a, b) => a - b);
  console.log(`${label}: dot shown on ${t.shown}/${t.judged} frames | off by >7% of radius: ${t.wrong}/${t.shown}, off by >18% (wrong place): ${t.gross} | first dot after ${firsts.length ? firsts[firsts.length >> 1].toFixed(1) : '-'}s (median)`);
  return t;
}

// 16 sessions, each walking through a different part of the map (some low-texture):
// ring calibration off by -13%..+15%, uploader map overlay zoomed 0.7×..1.4×
const cases = [
  { ring: 0.9 }, { ring: 0.95 }, { ring: 1 }, { ring: 1.04 }, { ring: 1.07 }, { ring: 1.1 }, { ring: 1.0, zoom: 1.4 }, { ring: 1.07, zoom: 0.7 },
  { ring: 0.92, zoom: 1.25 }, { ring: 0.97 }, { ring: 1.02, zoom: 0.8 }, { ring: 1.05 }, { ring: 1.09, zoom: 1.4 }, { ring: 0.87 }, { ring: 1.0, zoom: 0.7 }, { ring: 1.15 }
];
const a = report('first time (ratio learned live)', cases);
assert.strictEqual(a.gross, 0, 'a shown dot must never be in the wrong place');
assert(a.wrong <= Math.ceil(0.05 * a.shown), 'near-misses (>7% of the radius) should be rare');
assert(a.shown >= 0.4 * a.judged, 'the dot should be visible a good part of the time on route');
const k = report('second time (saved ratio)', cases, { known: true });
assert.strictEqual(k.gross, 0, 'saved ratio: never in the wrong place');
// visibility bar lowered from 75% to 70% when the trust rule was recalibrated on real screenshots (stricter
// uniqueness + 4 agreeing ratios); correctness bars unchanged
assert(k.wrong <= Math.ceil(0.05 * k.shown) && k.shown >= 0.7 * k.judged, 'with a saved ratio the dot should be close and visible');
const b = report('first time + 1 icon the colour test misses', cases, { hidden: 1 });
assert(b.gross <= Math.ceil(0.01 * b.shown) && b.wrong <= Math.ceil(0.08 * b.shown), 'an unflagged icon should cost only a little accuracy');
console.log(`speed: ${(timeMs / timedFrames).toFixed(1)} ms per tracking update on average (the overlay runs ~4 per second)`);

/* ---- 2. sign check, exact numbers, no degradations ---- */
{
  const games = [{ scale: 1, ...crop(500, 500, 1) }];
  const r = L.matchMinimaps(crop(512, 493, 1), games, N, R);
  assert(Math.abs(r.dx - 12) < 0.6 && Math.abs(r.dy + 7) < 0.6, `sign: got ${r.dx},${r.dy}`);
  // fused across the closely spaced fine sizes (as locateFrame does), the answer stays in scale-1 units
  const many = L.FINE.map((s) => ({ scale: s, ...crop(500, 500, s) }));
  const f = L.fuseScales(L.matchAll(crop(512, 493, 1), many, N, R), R);
  assert(f.support >= 3 && Math.abs(f.dx - 12) < 1 && Math.abs(f.dy + 7) < 1, `fused: ${f.dx},${f.dy} support ${f.support}`);
}

/* ---- 3. off route: the video shows a different place -> never lock ---- */
{
  const tracker = L.createTracker();
  let falseLocks = 0, maxSupport = 0;
  let user = { x: 200 + rnd() * 250, y: 200 + rnd() * 250 };
  let far = { x: 600 + rnd() * 250, y: 600 + rnd() * 250 };
  // the hard case: the ratio is already locked (you were on route), then you wander off
  const state = { scale: 1 / 1.04, locked: true, hist: [] };
  for (let k = 0; k < 120; k++) {
    // both keep walking (smoothly), but in unrelated places
    user = { x: user.x + (rnd() - 0.5) * 6, y: user.y + (rnd() - 0.5) * 6 };
    far = { x: far.x + (rnd() - 0.5) * 6, y: far.y + (rnd() - 0.5) * 6 };
    const r = L.locateFrame(videoOf(far), gameSampler(user, 1.04), N, R, state);
    maxSupport = Math.max(maxSupport, r.support);
    if (tracker.push(r, k * 250)) falseLocks++;
  }
  console.log(`off route: false dots ${falseLocks}/120 frames, most ring sizes ever agreeing ${maxSupport}/5 (dot needs 3 on 2 frames)`);
  assert.strictEqual(falseLocks, 0);
}

/* ---- 4. tracker: lock after 2 agreeing frames, hide 1.5 s after losing the route ---- */
{
  const t = L.createTracker();
  const good = (dx, dy) => ({ dx, dy, trusted: true });
  const bad = { dx: 0, dy: 0, trusted: false };
  assert.strictEqual(t.push(good(10, 5), 0), null);
  const d = t.push(good(10.5, 5.2), 250);
  assert.ok(d && !d.held);
  const h = t.push(bad, 500); // one bad frame: keep showing, marked as held
  assert.ok(h && h.held);
  assert.strictEqual(t.push(bad, 1100), null); // > 0.75 s without new evidence: gone
  // trust rules: high NCC but only 2 ring sizes agree, or a peak that isn't unique -> not trusted
  // calibrated on a real screenshot pair: true match 0.56 / margin 0.31 / 4 ratios; closest real negative 0.52 / 0.22 / 3
  assert.ok(L.isTrusted({ support: 4, ncc: 0.56, second: 0.25 }));
  assert.ok(!L.isTrusted({ support: 3, ncc: 0.52, second: 0.3 }));
  assert.ok(!L.isTrusted({ support: 5, ncc: 0.8, second: 0.77 }));
  assert.ok(!L.isTrusted({ support: 5, ncc: 0.45, second: 0.1 }));
}

/* ---- 5. splitRgba flags icons, keeps terrain ---- */
{
  const px = (r, g, b) => [r, g, b, 255];
  const data = Uint8ClampedArray.from([...px(90, 110, 80), ...px(34, 200, 232), ...px(250, 210, 40), ...px(245, 245, 245), ...px(160, 150, 140), ...px(40, 40, 50), ...px(0, 0, 0), ...px(120, 120, 120), ...px(255, 60, 60)]);
  const { skip } = L.splitRgba(data, 3);
  assert.deepStrictEqual(Array.from(skip), [0, 1, 1, 1, 0, 0, 0, 0, 1]);
}

/* ---- 5b. last-seen position: guide's minimap disappears, you walk there ---- */
{
  const ring = 1.04;
  const wpp = (gameMinimapR * ring) / R; // world px per scale-1 patch px
  const sampler = (p) => gameSampler(p, ring)(1);
  let ok = 0, judged = 0, arrivedAt = -1, maxErr = 0;
  for (let run = 0; run < 6; run++) {
    const L2 = L.createLastSeen();
    let me = { x: 300 + rnd() * 300, y: 300 + rnd() * 300 };
    const a = rnd() * Math.PI * 2, dist = 15 + rnd() * 15; // guide 15..30 world px away when their map disappears
    const guide = { x: me.x + Math.cos(a) * dist, y: me.y + Math.sin(a) * dist };
    L2.setAnchor(sampler(me), { x: (guide.x - me.x) / wpp, y: (guide.y - me.y) / wpp }, 0);
    // first wander sideways a bit (the marker must stay on the guide's spot), then walk to it
    for (let f = 1; f <= 40; f++) {
      if (f <= 10) me = { x: me.x + Math.cos(a + 1.6) * 2.5, y: me.y + Math.sin(a + 1.6) * 2.5 };
      else {
        const dx = guide.x - me.x, dy = guide.y - me.y, d = Math.hypot(dx, dy);
        if (d > 0) me = { x: me.x + (dx / d) * Math.min(2.5, d), y: me.y + (dy / d) * Math.min(2.5, d) };
      }
      const r = L2.track(sampler(me), N, R, f * 300);
      if (r.arrived) { if (arrivedAt < 0 || f < arrivedAt) arrivedAt = f; break; }
      if (!r.target) break;
      judged++;
      const e = Math.hypot(r.target.x - (guide.x - me.x) / wpp, r.target.y - (guide.y - me.y) / wpp);
      maxErr = Math.max(maxErr, e);
      if (process.env.LOCATE_DEBUG) console.log(`    run ${run} f${f} err ${e.toFixed(1)} held ${r.held} ncc ${(r.ncc || 0).toFixed(2)} dist ${Math.hypot(guide.x - me.x, guide.y - me.y).toFixed(1)}`);
      if (e <= 2.5) ok++;
    }
    assert(!L2.active, `run ${run}: should have arrived and cleared`);
  }
  console.log(`last-seen marker: ${ok}/${judged} frames within 2.5px (max error ${maxErr.toFixed(1)}px), arrival detected in every run`);
  assert(ok >= 0.9 * judged, 'marker should stay on the guide\'s last spot while you walk');

  // teleport / totally different place: the marker is hidden within ~2 s, never jumps to a wrong place,
  // and the memory is dropped after a minute of not matching
  const L3 = L.createLastSeen();
  L3.setAnchor(sampler({ x: 400, y: 400 }), { x: 10, y: 5 }, 0);
  let hiddenAt = -1;
  for (let f = 1; f <= 30; f++) {
    const r = L3.track(sampler({ x: 800, y: 200 }), N, R, f * 300);
    if (process.env.LOCATE_DEBUG) console.log(`    teleport f${f} held ${r.held} ncc ${(r.ncc || 0).toFixed(2)}`);
    if (r.target) assert(r.held, 'after a teleport the marker must never be re-placed from a false match');
    if (!r.target && hiddenAt < 0) hiddenAt = f;
  }
  assert(hiddenAt > 0 && hiddenAt * 300 <= 2400, 'after a teleport the marker must be hidden quickly');
  assert(L3.active, 'memory kept for a while (menus / dialogue also make the minimap unmatchable)');
  L3.track(sampler({ x: 800, y: 200 }), N, R, 70000);
  assert(!L3.active, 'memory dropped after a minute without a match');
  // ...but coming back to where you were brings the marker back
  const L4 = L.createLastSeen();
  L4.setAnchor(sampler({ x: 400, y: 400 }), { x: 10, y: 5 }, 0);
  for (let f = 1; f <= 10; f++) L4.track(sampler({ x: 800, y: 200 }), N, R, f * 300);
  const back = L4.track(sampler({ x: 400, y: 400 }), N, R, 3500);
  assert(back.target && Math.hypot(back.target.x - 10, back.target.y - 5) < 2, 'marker returns once your minimap matches again');
  console.log('last-seen: teleport hides the marker, menus/dialogue keep the memory');
}

/* ---- 6. speed (what one tracking update costs; the overlay runs ~4 per second) ---- */
{
  const sampler = gameSampler({ x: 500, y: 500 }, 1.0);
  const v = videoOf({ x: 510, y: 505 });
  const state = {};
  const t0 = Date.now();
  for (let i = 0; i < 24; i++) L.locateFrame(v, sampler, N, R, state);
  console.log(`speed: ${((Date.now() - t0) / 24).toFixed(1)} ms per update on average (incl. sampling; full re-check every 8th)`);
}
console.log('locate tests ok');


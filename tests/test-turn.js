'use strict';
// Run with GIFA's bundled Node:  $env:ELECTRON_RUN_AS_NODE='1'; & ..\GIFA.exe tests\test-turn.js
const path = require('node:path');
const assert = require('node:assert');
const { createTurnDetector, shortAngle, circMean } = require(path.join(__dirname, '..', 'src', 'turn-detect.js'));

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/** feed a heading function at ~5 Hz (what the bearing channel delivers), with noise; returns the events */
function run(heading, ms, { noise = 6, minTurn, gapAt, gapMs = 0 } = {}) {
  const d = createTurnDetector(minTurn ? { minTurn } : {});
  const events = [];
  for (let t = 0; t <= ms; t += 200) {
    if (gapAt !== undefined && t >= gapAt && t < gapAt + gapMs) continue;
    const e = d.push(heading(t) + (rnd() - 0.5) * 2 * noise, t);
    if (e) events.push({ ...e, t });
  }
  return events;
}

assert.strictEqual(shortAngle(10, 350), 20);
assert.strictEqual(shortAngle(350, 10), -20);
assert(Math.abs(circMean([{ a: 350 }, { a: 10 }]) % 360) < 1e-9 || Math.abs(circMean([{ a: 350 }, { a: 10 }]) - 360) < 1e-9);

// straight walking with noise: nothing
assert.deepStrictEqual(run(() => 40, 20000), []);

// right turn 0° -> 90° over 0.4 s at t=5 s: exactly one 'right', soon after the turn
let ev = run((t) => (t < 5000 ? 0 : t < 5400 ? ((t - 5000) / 400) * 90 : 90), 15000);
assert.strictEqual(ev.length, 1, JSON.stringify(ev));
assert.strictEqual(ev[0].dir, 'right');
assert(ev[0].t >= 5400 && ev[0].t <= 7400, `fired at ${ev[0].t}`);
assert(Math.abs(ev[0].deg - 90) < 15);

// left turn across north (20° -> 290°, i.e. -90°)
ev = run((t) => (t < 4000 ? 20 : 290), 12000);
assert.deepStrictEqual(ev.map((e) => e.dir), ['left']);

// U-turn
ev = run((t) => (t < 4000 ? 100 : 280), 12000);
assert.deepStrictEqual(ev.map((e) => e.dir), ['back']);

// small bend below the threshold: nothing (and with a lower threshold: it fires)
assert.deepStrictEqual(run((t) => (t < 4000 ? 0 : 45), 12000), []);
assert.deepStrictEqual(run((t) => (t < 4000 ? 0 : 45), 12000, { minTurn: 40 }).map((e) => e.dir), ['right']);

// slow continuous curve (25°/s for 8 s = 200° total): no alerts — it's a curve, not a turn
assert.deepStrictEqual(run((t) => (t < 2000 ? 0 : t < 10000 ? ((t - 2000) / 1000) * 25 : 200), 14000), []);

// single-frame 180° misread while walking straight: nothing
{
  const d = createTurnDetector();
  const evs = [];
  for (let t = 0; t <= 10000; t += 200) {
    const a = t === 5000 ? 180 : 0;
    const e = d.push(a, t);
    if (e) evs.push(e);
  }
  assert.deepStrictEqual(evs, []);
}

// seek / pause: heading jumps across a 1.5 s gap -> no false turn
assert.deepStrictEqual(run((t) => (t < 5000 ? 0 : 120), 14000, { gapAt: 4800, gapMs: 1500 }), []);

// two separate turns 6 s apart: both reported, each once
ev = run((t) => (t < 4000 ? 0 : t < 10000 ? 90 : 0), 18000);
assert.deepStrictEqual(ev.map((e) => e.dir), ['right', 'left']);

// zig-zag faster than the windows (turns every 1 s): no flood of alerts
ev = run((t) => (Math.floor(t / 1000) % 2 ? 70 : 0), 20000);
assert(ev.length <= 2, `zig-zag produced ${ev.length} alerts`);

console.log('turn detector tests ok');

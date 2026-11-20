'use strict';
// Run with GIFA's bundled Node:  $env:ELECTRON_RUN_AS_NODE='1'; & ..\GIFA.exe tests\test-direction.js
const path = require('node:path');
const assert = require('node:assert');
const { parseDirection, crossedDirectionCue } = require(path.join(__dirname, '..', 'src', 'direction-hints.js'));

const dir = (s) => (parseDirection(s) || {}).dir || null;

// left / right in the ways uploaders say it
for (const s of ['往左边走', '我们向左', '然后左转', '在这里左拐', '靠左走', '宝箱在左手边', '左边有个洞', '从左侧绕过去', '往左，上楼']) assert.strictEqual(dir(s), 'left', s);
for (const s of ['往右边走', '向右飞过去', '右转', '右拐上去', '靠右', '右手边那个', '右边那座桥', '往 右 走']) assert.strictEqual(dir(s), 'right', s);
// U-turn wins over left/right inside it
for (const s of ['先掉头', '我们往回走', '原路返回', '转身往左走']) assert.strictEqual(dir(s), 'back', s);

// "左右" is not a direction
for (const s of ['等十秒左右', '左右两边都有怪', '大概三十米左右', '']) assert.strictEqual(dir(s), null, s);
// lines without directions
for (const s of ['过完剧情之后', '这里有个宝箱', '我们先上去']) assert.strictEqual(dir(s), null, s);

// several directions: the first one said
assert.strictEqual(dir('先往左再往右'), 'left');
assert.strictEqual(dir('右边那个不要，往左走'), 'right');
// phrase is reported
assert.strictEqual(parseDirection('然后我们往左边走').phrase, '往左');

// timeline: fires when the line STARTS, once
const cues = [
  { from: 10, to: 12, text: '这里先上楼' },
  { from: 12.5, to: 15, text: '然后往右边走' },
  { from: 15.2, to: 17, text: '大概十米左右' }
];
assert.strictEqual(crossedDirectionCue(cues, 12.2, 12.4), null);
assert.strictEqual(crossedDirectionCue(cues, 12.4, 12.7).dir, 'right');
assert.strictEqual(crossedDirectionCue(cues, 12.7, 13.0), null); // already past the start: no repeat
assert.strictEqual(crossedDirectionCue(cues, 15.0, 15.4), null); // "左右" line
assert.strictEqual(crossedDirectionCue([], 1, 2), null);

console.log('direction hint tests ok');

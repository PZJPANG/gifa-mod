'use strict';
/**
 * Patch a GIFA app.asar with the source in this repo.
 *
 *   node tools/pack-asar.js <original app.asar> <repo root> <output app.asar>
 *
 * Every entry of the original archive is kept (node_modules, unpacked native module, …);
 * files under package.json / src / build that differ are replaced, new ones are added.
 * Only those three paths are read from the repo, so README, tests, tools and .git never
 * end up inside the package.
 *
 * Run it with GIFA's own bundled Node (no Node install needed):
 *   $env:ELECTRON_RUN_AS_NODE='1'; $env:ELECTRON_NO_ASAR='1'; $env:__COMPAT_LAYER='RunAsInvoker'
 *   & ..\GIFA.exe tools\pack-asar.js ..\resources\app.asar.bak . app.new.asar
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const INCLUDE = ['package.json', 'src', 'build'];
const [orig, dir, out] = process.argv.slice(2);
if (!orig || !dir || !out) {
  console.error('usage: node tools/pack-asar.js <original app.asar> <repo root> <output app.asar>');
  process.exit(2);
}

const buf = fs.readFileSync(orig);
const headerSize = buf.readUInt32LE(4);
const strLen = buf.readUInt32LE(12);
const header = JSON.parse(buf.toString('utf8', 16, 16 + strLen));
const origData = buf.subarray(8 + headerSize);

const BLOCK = 4 * 1024 * 1024;
function integrity(data) {
  const blocks = [];
  for (let i = 0; i < Math.max(1, data.length); i += BLOCK) {
    blocks.push(crypto.createHash('sha256').update(data.subarray(i, i + BLOCK)).digest('hex'));
  }
  return { algorithm: 'SHA256', hash: crypto.createHash('sha256').update(data).digest('hex'), blockSize: BLOCK, blocks };
}

const appended = [];
let appendOffset = origData.length;
const changes = [];

function slot(rel) {
  const parts = rel.split('/');
  let node = header;
  for (const part of parts.slice(0, -1)) {
    node.files[part] = node.files[part] || { files: {} };
    node = node.files[part];
  }
  return { parent: node, name: parts[parts.length - 1] };
}

function consider(rel) {
  const data = fs.readFileSync(path.join(dir, rel));
  const { parent, name } = slot(rel);
  const entry = parent.files[name];
  if (entry && (entry.unpacked || entry.link)) return;
  if (entry && origData.subarray(Number(entry.offset), Number(entry.offset) + entry.size).equals(data)) return;
  parent.files[name] = { size: data.length, offset: String(appendOffset), integrity: integrity(data) };
  appended.push(data);
  appendOffset += data.length;
  changes.push(`${entry ? 'M' : 'A'} ${rel} (${data.length} B)`);
}

function walk(rel) {
  const abs = path.join(dir, rel);
  const st = fs.statSync(abs);
  if (st.isFile()) return consider(rel);
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (ent.isDirectory() || ent.isFile()) walk(`${rel}/${ent.name}`);
  }
}

for (const top of INCLUDE) if (fs.existsSync(path.join(dir, top))) walk(top);

const json = Buffer.from(JSON.stringify(header), 'utf8');
const aligned = (json.length + 3) & ~3;
const headerPickle = Buffer.alloc(8 + aligned);
headerPickle.writeUInt32LE(4 + aligned, 0);
headerPickle.writeUInt32LE(json.length, 4);
json.copy(headerPickle, 8);
const sizePickle = Buffer.alloc(8);
sizePickle.writeUInt32LE(4, 0);
sizePickle.writeUInt32LE(headerPickle.length, 4);

fs.writeFileSync(out, Buffer.concat([sizePickle, headerPickle, origData, ...appended]));
console.log(changes.join('\n') || 'no changes');
console.log('wrote', out);

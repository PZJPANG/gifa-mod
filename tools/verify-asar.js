'use strict';
/**
 * Read every packaged file back through Electron's own asar layer and compare with the repo.
 *   node tools/verify-asar.js <app.asar> <repo root>      (run with ELECTRON_RUN_AS_NODE=1, asar support ON)
 */
const fs = require('node:fs');
const path = require('node:path');

const [asar, dir] = process.argv.slice(2);
let n = 0;
let bad = 0;
function walk(rel) {
  const abs = path.join(dir, rel);
  if (fs.statSync(abs).isFile()) {
    n += 1;
    if (!fs.readFileSync(path.join(asar, rel)).equals(fs.readFileSync(abs))) {
      bad += 1;
      console.log('MISMATCH', rel);
    }
    return;
  }
  for (const ent of fs.readdirSync(abs)) walk(path.join(rel, ent));
}
for (const top of ['package.json', 'src', 'build']) if (fs.existsSync(path.join(dir, top))) walk(top);
const pkg = JSON.parse(fs.readFileSync(path.join(asar, 'package.json'), 'utf8'));
console.log(`checked ${n} files, ${bad} mismatches; main=${pkg.main}`);
process.exitCode = bad ? 1 : 0;

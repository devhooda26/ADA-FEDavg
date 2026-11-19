// Syntax-checks every JavaScript file (no dependencies):  npm run lint
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.mjs';

const skip = new Set(['node_modules', '.git', 'data', '.venv']);
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(d, e.name);
    e.isDirectory() ? walk(p) : /\.(m?js)$/.test(e.name) && files.push(p);
  }
})(ROOT);
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; console.error(`✖ ${path.relative(ROOT, f)}\n${r.stderr}`); }
}
console.log(bad ? `${bad} file(s) with syntax errors` : `✔ ${files.length} JavaScript files OK`);
process.exit(bad ? 1 : 0);

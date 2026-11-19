// Runs the model benchmark (offline datasets, several methods, independent references). Takes a few minutes.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readEnv, findPython } from './lib.mjs';
const env = readEnv();
const found = env.PYTHON && fs.existsSync(env.PYTHON) ? { cmd: env.PYTHON, pre: [] } : findPython();
if (!found) { console.error('Python 3.9+ not found. Run: npm run setup'); process.exit(1); }
const r = spawnSync(found.cmd, [...found.pre, 'benchmark.py', ...process.argv.slice(2)], { cwd: path.join(ROOT, 'ml'), stdio: 'inherit' });
process.exit(r.status ?? 1);

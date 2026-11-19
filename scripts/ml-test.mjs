// Runs the Python algorithm tests with the project's interpreter (works on Windows too).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readEnv, findPython } from './lib.mjs';

const env = readEnv();
const found = env.PYTHON && fs.existsSync(env.PYTHON) ? { cmd: env.PYTHON, pre: [] } : findPython();
if (!found) { console.error('Python 3.9+ not found. Run: npm run setup'); process.exit(1); }
const r = spawnSync(found.cmd, [...found.pre, '-m', 'unittest', 'test_ml', 'test_ingest', 'test_model_quality', '-v'], { cwd: path.join(ROOT, 'ml'), stdio: 'inherit' });
process.exit(r.status ?? 1);

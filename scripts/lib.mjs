// Shared helpers for setup / doctor / dataset scripts. Node >= 20, no dependencies, works on Windows, macOS and Linux.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_FILE = path.join(ROOT, '.env');
export const NSL_DIR = path.join(ROOT, 'data', 'nsl-kdd');
export const VENV = path.join(ROOT, '.venv');
export const venvPython = () => path.join(VENV, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');

const tty = process.stdout.isTTY;
const c = (n, s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
export const ok = (m) => console.log(`${c(32, '✔')} ${m}`);
export const warn = (m) => console.log(`${c(33, '!')} ${m}`);
export const bad = (m) => console.log(`${c(31, '✖')} ${m}`);
export const info = (m) => console.log(`${c(36, '→')} ${m}`);

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, shell: false, ...opts });
  return { code: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), missing: r.error?.code === 'ENOENT' };
}

/** First working Python >= 3.9 on PATH, or null. */
export function findPython() {
  const candidates = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
  for (const [cmd, pre] of candidates) {
    const r = run(cmd, [...pre, '-c', 'import sys;print("%d.%d"%sys.version_info[:2])']);
    if (r.code === 0) {
      const [maj, min] = r.out.split('.').map(Number);
      if (maj === 3 && min >= 9) return { cmd, pre, version: r.out };
    }
  }
  return null;
}

export function readEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const env = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

/** Set KEY=value in .env (replace the line if present, else append). */
export function setEnv(key, value) {
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, () => `${key}=${value}`) : text.replace(/\s*$/, '\n') + `${key}=${value}\n`;
  fs.writeFileSync(ENV_FILE, text);
}

const BASE = 'https://raw.githubusercontent.com/jmnwong/NSL-KDD-Dataset/master';
export const NSL_FILES = [['KDDTrain+.txt', 'KDDTrain%2B.txt'], ['KDDTest+.txt', 'KDDTest%2B.txt']];

export async function downloadDataset({ force = false } = {}) {
  fs.mkdirSync(NSL_DIR, { recursive: true });
  for (const [name, remote] of NSL_FILES) {
    const dest = path.join(NSL_DIR, name);
    if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) { ok(`${name} already present`); continue; }
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        info(`Downloading ${name} (attempt ${attempt}/3)`);
        const res = await fetch(`${BASE}/${remote}`, { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const lines = text.trim().split('\n').length;
        if (lines < 10_000) throw new Error(`file looks truncated (${lines} lines)`); // KDDTest+ has 22,544, KDDTrain+ 125,973
        fs.writeFileSync(dest + '.part', text); fs.renameSync(dest + '.part', dest);
        ok(`${name}: ${lines.toLocaleString()} rows`); lastErr = null; break;
      } catch (e) { lastErr = e; }
    }
    if (lastErr) throw new Error(`Could not download ${name}: ${lastErr.message}. Download it manually into ${NSL_DIR}`);
  }
}

// Environment check:  npm run doctor
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ROOT, NSL_DIR, findPython, run, readEnv, ok, warn, bad } from './lib.mjs';

let problems = 0;
const fail = (m, fix) => { bad(m + (fix ? `\n    fix: ${fix}` : '')); problems++; };

const nodeMajor = Number(process.versions.node.split('.')[0]);
nodeMajor >= 20 ? ok(`Node ${process.versions.node}`) : fail(`Node ${process.versions.node} (need 20+)`, 'install Node 22 LTS');

fs.existsSync(path.join(ROOT, 'node_modules/express/package.json')) ? ok('npm dependencies installed') : fail('npm dependencies missing', 'npm install');

const env = readEnv();
fs.existsSync(path.join(ROOT, '.env')) ? ok('.env present') : warn('.env missing (defaults will be used; first start prints a generated admin password)  → npm run setup');
if (env.NODE_ENV === 'production' && !(env.APP_URL || '').startsWith('https://')) warn('NODE_ENV=production but APP_URL is not https');

const pyCmd = env.PYTHON && fs.existsSync(env.PYTHON) ? { cmd: env.PYTHON, pre: [] } : findPython();
if (!pyCmd) fail('Python 3.9+ not found', 'install Python, then npm run setup');
else {
  const r = run(pyCmd.cmd, [...pyCmd.pre, '-c', 'import numpy, sklearn; print(numpy.__version__, sklearn.__version__)']);
  r.code === 0 ? ok(`Python ready (numpy/scikit-learn ${r.out})`) : fail('numpy / scikit-learn not importable by the configured Python', 'npm run setup');
}

const have = (f) => fs.existsSync(path.join(NSL_DIR, f)) && fs.statSync(path.join(NSL_DIR, f)).size > 1_000_000;
have('KDDTrain+.txt') && have('KDDTest+.txt') ? ok('NSL-KDD dataset present') : fail('NSL-KDD dataset missing (experiments on the built-in dataset will not start)', 'npm run dataset');

const port = Number(env.PORT) || 4000;
await new Promise((resolve) => {
  const s = net.createServer().once('error', (e) => { e.code === 'EADDRINUSE' ? warn(`Port ${port} is in use (is the app already running?)`) : fail(`Cannot bind port ${port}: ${e.code}`); resolve(); })
    .once('listening', () => s.close(() => { ok(`Port ${port} is free`); resolve(); })).listen(port, '127.0.0.1');
});

console.log(problems ? `\n${problems} problem(s) found.\n` : '\nEverything looks good. Run: npm run dev\n');
process.exit(problems ? 1 : 0);

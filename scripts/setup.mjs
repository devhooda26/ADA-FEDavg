// One-command project setup:  npm run setup
// Creates .env, a Python virtualenv with numpy + scikit-learn, and downloads NSL-KDD. Safe to re-run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ENV_FILE, VENV, venvPython, findPython, run, setEnv, readEnv, downloadDataset, ok, warn, bad, info } from './lib.mjs';

const args = new Set(process.argv.slice(2));
let failed = false;

if (Number(process.versions.node.split('.')[0]) < 20) { bad(`Node ${process.versions.node} is too old. Install Node 20 or newer (22 recommended).`); process.exit(1); }
ok(`Node ${process.versions.node}`);

// 1. .env
if (!fs.existsSync(ENV_FILE)) {
  fs.copyFileSync(path.join(ROOT, '.env.example'), ENV_FILE);
  const password = crypto.randomBytes(12).toString('base64url');
  setEnv('ADMIN_PASSWORD', password);
  setEnv('CORS_ORIGINS', 'http://localhost:4000');
  ok('Created .env');
  console.log(`\n  Admin sign-in:  ${readEnv().ADMIN_EMAIL || 'admin@example.com'}  /  ${password}\n  (saved in .env; the account is created on first start)\n`);
} else ok('.env already exists (left untouched)');

// 2. Python
if (args.has('--skip-python')) warn('Skipping Python setup');
else {
  const py = findPython();
  if (!py) { bad('Python 3.9+ was not found. Install it from https://www.python.org/downloads/ and re-run `npm run setup`.'); failed = true; }
  else {
    ok(`Python ${py.version} (${py.cmd})`);
    if (!fs.existsSync(venvPython())) {
      info('Creating virtual environment in .venv');
      const r = run(py.cmd, [...py.pre, '-m', 'venv', VENV], { stdio: 'inherit' });
      if (r.code !== 0) { bad('Could not create .venv (on Debian/Ubuntu: sudo apt install python3-venv)'); failed = true; }
    }
    if (fs.existsSync(venvPython())) {
      info('Installing numpy and scikit-learn (first time takes a minute)');
      const r = run(venvPython(), ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', 'ml/requirements.txt'], { stdio: 'inherit' });
      if (r.code === 0) { setEnv('PYTHON', venvPython()); ok(`Python packages installed; PYTHON=${venvPython()}`); }
      else { bad('pip install failed. Check your network connection and re-run.'); failed = true; }
    }
  }
}

// 3. Dataset
if (args.has('--skip-dataset')) warn('Skipping dataset download');
else {
  try { await downloadDataset(); }
  catch (e) { bad(e.message); failed = true; }
}

console.log(failed
  ? '\nSetup finished with problems (see above). Fix them and run `npm run setup` again; completed steps are skipped.\n'
  : '\nAll set. Start the app with:  npm run dev   then open http://localhost:4000\nCheck your environment any time with:  npm run doctor\n');
process.exit(failed ? 1 : 0);

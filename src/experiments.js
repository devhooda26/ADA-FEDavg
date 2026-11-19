import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const UPLOADS = process.env.UPLOAD_DIR || path.join(ROOT, 'data/uploads');
export const MODELS = process.env.MODELS_DIR || path.join(ROOT, 'data/models');
export const modelDir = (id) => path.join(MODELS, String(Number(id)));
export const hasModel = (id) => fs.existsSync(path.join(modelDir(id), 'model.npz'));
export const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 50;
export const DATA = {
  train: path.join(ROOT, process.env.NSL_TRAIN || 'data/nsl-kdd/KDDTrain+.txt'),
  test: path.join(ROOT, process.env.NSL_TEST || 'data/nsl-kdd/KDDTest+.txt'),
};
export const datasetStatus = () => ({ train: fs.existsSync(DATA.train), test: fs.existsSync(DATA.test), setup: 'Run: npm run dataset' });

const defaultArgs = (c, db, row) => {
  const base = [path.join(ROOT, 'ml/ada_fedavg.py'), '--method', c.method, '--skew', c.skew || 'moderate', '--rounds', c.rounds, '--clients', c.clients, '--clusters', c.clusters, '--seed', c.seed,
    '--local-epochs', c.localEpochs ?? 1, '--loss-weights', c.lossWeights ?? 'none', '--cw-power', c.cwPower ?? 0.5, '--prox-mu', c.proxMu ?? 0.01, '--cluster-mode', c.clusterMode ?? 'agglom',
    '--distance', c.distance ?? 'jsd', '--blend', c.blend ?? 0, '--hetero', (c.hetero ?? ['label']).join(','), '--feature-shift', c.featureShift ?? 0.5, '--quantity-alpha', c.quantityAlpha ?? 0.5,
    ...(c.partitionSeed != null ? ['--partition-seed', c.partitionSeed] : []), ...(c.sybil ? ['--sybil'] : []),
    ...(row && !row.study_id ? ['--save-model', modelDir(row.id)] : [])]; // study runs are statistics only; standalone runs keep their model for the Detect tab
  if (!c.datasetId) return [...base, '--train', DATA.train, '--test', DATA.test].map(String);
  const d = db.prepare('SELECT * FROM datasets WHERE id=?').get(c.datasetId);
  if (!d || d.status !== 'ready') throw new Error('Dataset was deleted or is not configured');
  return [...base, '--dataset-file', path.join(UPLOADS, d.file_id + '.csv'), '--label-col', d.label_col, '--class-map', path.join(UPLOADS, d.file_id + '.map.json'),
    '--test-frac', d.test_frac, '--max-train', d.max_rows].map(String);
};

// Profile an uploaded CSV with the Python helper (never executes the file).
export function profileFile(file, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON || 'python3', [path.join(ROOT, 'ml/profile_dataset.py'), file, ...(label ? [label] : [])], { cwd: path.join(ROOT, 'ml') });
    let out = '', err = ''; const t = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err = (err + d).slice(-500)));
    child.on('error', () => { clearTimeout(t); reject(new Error('Python is not available on the server')); });
    child.on('close', () => { clearTimeout(t); try { const j = JSON.parse(out); j.error ? reject(new Error(j.error)) : resolve(j); } catch { reject(new Error('Could not read this file as CSV')); } });
  });
}

// Convert any supported upload (csv, tsv, txt, json, jsonl, xlsx, arff, parquet, gz/zip wrapper) into the normalized CSV the pipeline trains on.
// The file is only parsed by ml/ingest.py, never executed. Resolves { format, rows, columns, notes } or rejects with a user-facing message.
export function ingestFile(input, output, originalName) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON || 'python3', [path.join(ROOT, 'ml/ingest.py'), input, output, String(originalName || ''), String(MAX_UPLOAD_MB)], { cwd: path.join(ROOT, 'ml') });
    let out = ''; const t = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => { clearTimeout(t); reject(new Error('Python is not available on the server')); });
    child.on('close', () => { clearTimeout(t); try { const j = JSON.parse(out); j.error ? reject(new Error(j.error)) : resolve(j); } catch { reject(new Error('Could not read this file. Supported: CSV, TSV, TXT, JSON, JSONL, XLSX, ARFF (and .gz / .zip of these).')); } });
  });
}

const STAGE = { preparing: 'preparing', partitioned: 'preparing', training: 'training', aggregating: 'aggregating', evaluating: 'evaluating' };

export class Runner {
  constructor(db, { cmd = process.env.PYTHON || 'python3', argsFor = defaultArgs, checkDataset = true, maxMinutes = 30 } = {}) {
    Object.assign(this, { db, cmd, argsFor, checkDataset, maxMs: maxMinutes * 60_000, current: null });
    db.prepare("UPDATE experiments SET status='failed', message='Server restarted while running' WHERE status IN ('preparing','training','aggregating','evaluating')").run();
    setImmediate(() => this.tick());
  }
  set(id, f) {
    const keys = Object.keys(f);
    this.db.prepare(`UPDATE experiments SET ${keys.map((k) => k + '=?').join(',')} WHERE id=?`).run(...keys.map((k) => (typeof f[k] === 'object' && f[k] !== null ? JSON.stringify(f[k]) : f[k])), id);
  }
  tick() {
    if (this.current) return;
    const row = this.db.prepare("SELECT * FROM experiments WHERE status='queued' ORDER BY id LIMIT 1").get();
    if (row) this.run(row);
  }
  run(row) {
    const cfg = JSON.parse(row.config), live = { clients: null, history: [] };
    let result = null, err = null, stderr = '';
    this.set(row.id, { status: 'preparing', started_at: Date.now(), progress: 0 });
    let args;
    try { args = this.argsFor(cfg, this.db, row); }
    catch (e) { this.set(row.id, { status: 'failed', finished_at: Date.now(), message: e.message.slice(0, 300) }); return setImmediate(() => this.tick()); }
    const child = spawn(this.cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const job = { id: row.id, child, cancelled: false, timedOut: false };
    this.current = job;
    const timer = setTimeout(() => { job.timedOut = true; child.kill('SIGTERM'); }, this.maxMs);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.type === 'result') result = o;
        else if (o.type === 'error') err = o.message;
        else if (o.type === 'progress' && !job.cancelled) {
          if (o.clients) live.clients = o.clients;
          if (o.stage === 'training' && o.round) live.history.push({ round: o.round, val_macro_f1: o.val_macro_f1, val_accuracy: o.val_accuracy, loss: o.loss });
          this.set(row.id, { status: STAGE[o.stage] || 'training', progress: o.round && o.rounds ? o.round / o.rounds : 0, live });
        }
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const done = (code) => {
      clearTimeout(timer); this.current = null;
      if (job.cancelled) this.set(row.id, { status: 'cancelled', finished_at: Date.now(), message: 'Cancelled by user' });
      else if (result && code === 0) this.set(row.id, { status: 'completed', progress: 1, result, live, finished_at: Date.now() });
      else this.set(row.id, { status: 'failed', finished_at: Date.now(), message: job.timedOut ? 'Exceeded time limit' : (err || stderr.trim().split('\n').pop() || `Worker exited with code ${code}`).slice(0, 300) });
      this.tick();
    };
    child.on('error', (e) => done(`spawn failed: ${e.code || e.message}`));
    child.on('close', done);
  }
  shutdown() { // called on SIGTERM/SIGINT so no orphan Python worker outlives the server
    if (this.current) { this.current.cancelled = true; try { this.current.child.kill('SIGTERM'); } catch { /* already gone */ } }
  }
  cancel(id) {
    if (this.current?.id === id) { this.current.cancelled = true; this.current.child.kill('SIGTERM'); return true; }
    return this.db.prepare("UPDATE experiments SET status='cancelled', finished_at=?, message='Cancelled by user' WHERE id=? AND status='queued'").run(Date.now(), id).changes > 0;
  }
}

export const shape = (r, full = false) => {
  const cfg = JSON.parse(r.config), res = r.result ? JSON.parse(r.result) : null, live = r.live ? JSON.parse(r.live) : null;
  const o = { id: r.id, name: r.name, owner: r.owner_name, ownerId: r.user_id, config: cfg, status: r.status, progress: r.progress, message: r.message,
    createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
    studyId: r.study_id, variant: r.variant, hasModel: r.status === 'completed' && !r.study_id && hasModel(r.id),
    metrics: res ? { accuracy: res.test.accuracy, macroF1: res.test.macro_f1, weightedF1: res.test.weighted_f1, commMB: res.comm_mb, durationS: res.duration_s,
      falseAlarmRate: res.test.false_alarm_rate, detectionRate: res.test.attack_detection_rate } : null };
  if (full) Object.assign(o, { result: res, live });
  return o;
};

// Score records with a saved model (Python reads JSON on stdin; nothing in the input is executed).
export function predictRecords(id, records) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON || 'python3', [path.join(ROOT, 'ml/predict.py'), modelDir(id)], { cwd: path.join(ROOT, 'ml') });
    let out = '', err = ''; const t = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', (d) => { if (out.length < 8e6) out += d; }); child.stderr.on('data', (d) => (err = (err + d).slice(-300)));
    child.on('error', () => { clearTimeout(t); reject(new Error('Python is not available on the server')); });
    child.on('close', () => { clearTimeout(t); try { const j = JSON.parse(out); j.error ? reject(new Error(j.error)) : resolve(j); } catch { reject(new Error('The model could not score these records')); } });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(records));
  });
}

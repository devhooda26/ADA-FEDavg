import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
process.env.MODELS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-models-'));
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { Runner } = await import('../src/experiments.js');

const db = openDb(':memory:'); const h = bcrypt.hashSync('adminpassword1', 4);
for (const [e, r] of [['v@x.io', 'viewer'], ['r@x.io', 'researcher']]) db.prepare('INSERT INTO users (email,name,password_hash,role,created_at) VALUES (?,?,?,?,1)').run(e, e, h, r);
const result = JSON.stringify({ classes: ['benign', 'dos', 'probe', 'r2l', 'u2r'], test: { macro_f1: 0.5 } });
const cfg = JSON.stringify({ method: 'ada', skew: 'mild', rounds: 1, clients: 2, clusters: 2, seed: 1 });
const ins = db.prepare("INSERT INTO experiments (user_id,owner_name,name,config,status,result,created_at,finished_at,study_id) VALUES (1,'x',?,?,?,?,1,1,?)");
ins.run('with model', cfg, 'completed', result, null);        // id 1: has a saved model
ins.run('no model', cfg, 'completed', result, null);          // id 2: completed but no model on disk
ins.run('study run', cfg, 'completed', result, 1);            // id 3: study run (never listed)
const py = spawnSync(process.env.PYTHON || 'python3', ['-c', `
import numpy as np, ada_fedavg as A, sys
A.CLASSES[:] = ["benign","dos","probe","r2l","u2r"]
rng = np.random.default_rng(0); cat = [["tcp","http"],["udp","dns"]]*30; num = rng.standard_normal((60,2)).astype(np.float32)*3+5
p = A.Prep(clip=20).fit(cat, num); p.num_names=["duration","src_bytes"]; p.cat_names=["protocol_type","service"]
S = A.init_model(rng, 2+sum(len(v) for v in p.vocab)); A.save_model(sys.argv[1], S, p, A.CLASSES, {"dataset":"custom"})
`, path.join(process.env.MODELS_DIR, '1')], { cwd: path.resolve('ml'), encoding: 'utf8' });
assert.equal(py.status, 0, py.stderr);

const server = createApp(db, { corsOrigins: 'http://localhost:5173', authLimit: 1000, detectLimit: 1000, runner: new Runner(db, { cmd: process.execPath, argsFor: () => [], checkDataset: false }) }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());
const login = async (e) => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: 'adminpassword1' }) })).headers.get('set-cookie').split(';')[0];
const call = async (p, { method = 'GET', body, cookie } = {}) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { cookie }) }, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };

test('models list and schema: only completed standalone runs with a saved model', async () => {
  assert.equal((await call('/api/models')).status, 401);
  const v = await login('v@x.io'); const l = (await call('/api/models', { cookie: v })).json.models;
  assert.deepEqual(l.map((m) => m.id), [1]);
  const s = (await call('/api/models/1/schema', { cookie: v })).json;
  assert.deepEqual(s.numeric.map((f) => f.name), ['duration', 'src_bytes']); assert.deepEqual(s.categorical.map((f) => f.name), ['protocol_type', 'service']);
  assert.equal(s.benign, 'benign'); assert.equal((await call('/api/models/2/schema', { cookie: v })).status, 404); assert.equal((await call('/api/models/3/schema', { cookie: v })).status, 404);
});
test('detect: scores records, flags bad input, stores only counts', async () => {
  const v = await login('v@x.io'), recs = [{ duration: 1, src_bytes: 500, protocol_type: 'tcp', service: 'http' }, { duration: 'abc', src_bytes: 1, protocol_type: 'tcp', service: 'http' }, { duration: 2, src_bytes: 9, protocol_type: 'icmp', service: 'http' }];
  const r = await call('/api/detect', { method: 'POST', cookie: v, body: { modelId: 1, records: recs } });
  assert.equal(r.status, 200); assert.equal(r.json.results.length, 3);
  assert.ok(r.json.results[0].class); assert.ok(Math.abs(Object.values(r.json.results[0].probabilities).reduce((a, b) => a + b) - 1) < 1e-6);
  assert.match(r.json.results[1].error, /not a number/); assert.ok(r.json.results[2].warnings.some((w) => /unknown value/.test(w)));
  assert.equal(r.json.summary.scored, 2); assert.equal(r.json.summary.errors, 1);
  const cols = db.prepare('PRAGMA table_info(predictions)').all().map((c) => c.name); assert.deepEqual(cols, ['id', 'user_id', 'experiment_id', 'model_name', 'n_records', 'n_errors', 'summary', 'created_at']); // counts only, no raw input column
  const row = db.prepare('SELECT * FROM predictions ORDER BY id DESC').get(); assert.ok(!JSON.stringify(row).includes('500'));
  const hist = (await call('/api/detect/history', { cookie: v })).json.history; assert.equal(hist[0].records, 3);
  assert.equal((await call('/api/detect/history', { cookie: await login('r@x.io') })).json.history.length, 0); // history is per user
});
test('detect: validation and access control', async () => {
  const v = await login('v@x.io'), ok = { duration: 1, src_bytes: 1, protocol_type: 'tcp', service: 'http' };
  assert.equal((await call('/api/detect', { method: 'POST', body: { modelId: 1, records: [ok] } })).status, 401);
  assert.equal((await call('/api/detect', { method: 'POST', cookie: v, body: { modelId: 1, records: [] } })).status, 400);
  assert.equal((await call('/api/detect', { method: 'POST', cookie: v, body: { modelId: 1, records: Array(1001).fill(ok) } })).status, 400);
  assert.equal((await call('/api/detect', { method: 'POST', cookie: v, body: { modelId: 1, records: [{ a: { nested: 1 } }] } })).status, 400);
  assert.equal((await call('/api/detect', { method: 'POST', cookie: v, body: { modelId: 99, records: [ok] } })).status, 404);
  assert.equal((await call('/api/detect', { method: 'POST', cookie: v, body: { modelId: 2, records: [ok] } })).status, 404);
  assert.equal((await call('/api/detect', { method: 'POST', cookie: v, body: { modelId: 1, records: Array(1000).fill(ok) } })).json.summary.scored, 1000);
});

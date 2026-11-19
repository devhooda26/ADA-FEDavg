import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-up-'));
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { Runner } = await import('../src/experiments.js');

const db = openDb(':memory:'); const h = bcrypt.hashSync('adminpassword1', 4);
for (const [e, r] of [['r1@x.io', 'researcher'], ['r2@x.io', 'researcher'], ['v@x.io', 'viewer'], ['adm@x.io', 'admin']]) db.prepare('INSERT INTO users (email,name,password_hash,role,created_at) VALUES (?,?,?,?,1)').run(e, e, h, r);
const seen = [];
const runner = new Runner(db, { cmd: process.execPath, argsFor: (c, d) => { seen.push(c); return [path.resolve('test/fake_worker.js')]; }, checkDataset: false });
const server = createApp(db, { corsOrigins: 'http://localhost:5173', authLimit: 1000, runner }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());
const login = async (e) => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: 'adminpassword1' }) })).headers.get('set-cookie').split(';')[0];
const call = async (p, { method = 'GET', body, cookie, csv } = {}) => {
  const r = await fetch(base + p, { method, headers: { ...(csv !== undefined ? { 'Content-Type': 'text/csv' } : { 'Content-Type': 'application/json' }), ...(cookie && { cookie }) }, body: csv !== undefined ? csv : body && JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const mk = (n, rare = 100) => { const L = ['id,f1,f2,proto,label']; for (let i = 0; i < n; i++) L.push(`${i},${(i * 7) % 13},${i % 5 + 0.5},${['tcp', 'udp'][i % 2]},${i < rare ? 'c' : i % 2 ? 'a' : 'b'}`); return L.join('\n'); };

test('upload validation: viewer blocked, binary and tiny files rejected', async () => {
  const [v, r1] = [await login('v@x.io'), await login('r1@x.io')];
  assert.equal((await call('/api/datasets?name=x', { method: 'POST', csv: mk(400), cookie: v })).status, 403);
  assert.equal((await call('/api/datasets?name=x', { method: 'POST', csv: 'a,b\n\u0000\u0000', cookie: r1 })).status, 400);
  assert.equal((await call('/api/datasets?name=x', { method: 'POST', csv: mk(50), cookie: r1 })).status, 400);
  assert.equal((await call('/api/datasets?name=', { method: 'POST', csv: mk(400), cookie: r1 })).status, 400);
});
test('upload, profile, label mapping, privacy, experiment, delete', async () => {
  const [r1, r2, adm] = [await login('r1@x.io'), await login('r2@x.io'), await login('adm@x.io')];
  const up = await call('/api/datasets?name=My%20flows', { method: 'POST', csv: mk(400), cookie: r1 }); assert.equal(up.status, 201);
  const id = up.json.id, d = (await call('/api/datasets/' + id, { cookie: r1 })).json;
  assert.equal(d.rows, 400); assert.equal(d.status, 'uploaded');
  assert.equal(d.profile.columns.find((c) => c.name === 'id').kind, 'identifier');
  assert.ok(d.profile.labelCandidates.includes('label'));
  assert.equal((await call('/api/datasets/' + id, { cookie: r2 })).status, 404);            // other researcher can't see raw data
  assert.equal((await call('/api/datasets/' + id, { cookie: adm })).status, 200);           // admin can
  const lab = await call(`/api/datasets/${id}/labels?col=label`, { cookie: r1 });
  assert.deepEqual(lab.json.labels.map((l) => l.value).sort(), ['a', 'b', 'c']);
  assert.equal((await call(`/api/datasets/${id}/labels?col=nope`, { cookie: r1 })).status, 400);
  const cfg = (classMap) => call(`/api/datasets/${id}/config`, { method: 'PUT', cookie: r1, body: { labelCol: 'label', classMap } });
  assert.equal((await cfg({ a: 'ok', b: 'ok' })).status, 400);                                // one class only
  assert.equal((await cfg({ a: 'x', b: 'y', zzz: 'y' })).status, 400);                        // unknown label value
  assert.equal((await call('/api/experiments', { method: 'POST', cookie: r1, body: { name: 'e', method: 'ada', datasetId: id } })).status, 409); // not configured yet
  assert.equal((await cfg({ a: 'x', b: 'y', c: 'x' })).status, 200);
  assert.equal((await call('/api/experiments', { method: 'POST', cookie: r2, body: { name: 'e', method: 'ada', datasetId: id } })).status, 404); // not r2's dataset
  const ex = await call('/api/experiments', { method: 'POST', cookie: r1, body: { name: 'on mine', method: 'fedavg', datasetId: id } });
  assert.equal(ex.status, 201);
  for (let i = 0; i < 100; i++) { const e = (await call('/api/experiments/' + ex.json.id, { cookie: r1 })).json; if (e.status === 'completed') break; await new Promise((s) => setTimeout(s, 50)); }
  assert.equal(seen.at(-1).datasetId, id);
  const comp = await call('/api/experiments/compare', { cookie: r1 }); assert.equal(comp.json.runs.length, 0); // custom datasets never enter the paper comparison
  const files = fs.readdirSync(process.env.UPLOAD_DIR); assert.ok(files.every((f) => /^[0-9a-f-]{36}\.(csv|map\.json)$/.test(f)));
  assert.equal((await call('/api/datasets/' + id, { method: 'DELETE', cookie: r2 })).status, 404);
  assert.equal((await call('/api/datasets/' + id, { method: 'DELETE', cookie: r1 })).status, 200);
  assert.equal(fs.readdirSync(process.env.UPLOAD_DIR).length, 0);
});

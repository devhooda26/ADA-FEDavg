import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { Runner } from '../src/experiments.js';
import { summarize, paired } from '../src/stats.js';

test('summarize: mean, sample sd and t-based 95% CI', () => {
  const s = summarize([1, 2, 3, 4, 5]);
  assert.equal(s.mean, 3); assert.ok(Math.abs(s.sd - 1.5811) < 1e-3); assert.ok(Math.abs(s.ci[0] - 1.0368) < 1e-2 && Math.abs(s.ci[1] - 4.9632) < 1e-2);
  assert.equal(summarize([2]).ci, null); assert.equal(summarize([null, undefined]).n, 0);
  const p = paired(new Map([[1, 0.6], [2, 0.7], [3, 0.65]]), new Map([[1, 0.5], [2, 0.5], [3, 0.5]])); assert.equal(p.excludesZero, true);
  assert.equal(paired(new Map([[1, 0.5], [2, 0.4]]), new Map([[1, 0.45], [2, 0.5]])).excludesZero, false);
});

process.env.FAKE_VARY = '1';
const db = openDb(':memory:'); const h = bcrypt.hashSync('adminpassword1', 4);
for (const [e, r] of [['r@x.io', 'researcher'], ['v@x.io', 'viewer']]) db.prepare('INSERT INTO users (email,name,password_hash,role,created_at) VALUES (?,?,?,?,1)').run(e, e, h, r);
const runner = new Runner(db, { cmd: process.execPath, argsFor: (c) => [path.resolve('test/fake_worker.js'), '--seed', String(c.seed), '--method', c.method], checkDataset: false });
const server = createApp(db, { corsOrigins: 'http://localhost:5173', authLimit: 1000, runner }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());
const login = async (e) => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: 'adminpassword1' }) })).headers.get('set-cookie').split(';')[0];
const call = async (p, { method = 'GET', body, cookie } = {}) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { cookie }) }, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };

test('study: validation, permissions, statistics, standalone filter, delete', async () => {
  const [r, v] = [await login('r@x.io'), await login('v@x.io')];
  assert.equal((await call('/api/studies', { method: 'POST', cookie: v, body: { name: 's', preset: 'core' } })).status, 403);
  assert.equal((await call('/api/studies', { method: 'POST', cookie: r, body: { name: 's', preset: 'nope' } })).status, 400);
  assert.equal((await call('/api/studies', { method: 'POST', cookie: r, body: { name: 's', preset: 'core', seeds: 1 } })).status, 400);
  const pr = (await call('/api/studies/presets', { cookie: v })).json.presets; assert.ok(pr.find((p) => p.key === 'ablation').variants.length >= 15);
  const st = await call('/api/studies', { method: 'POST', cookie: r, body: { name: 'Core', preset: 'core', seeds: 3, rounds: 2 } });
  assert.equal(st.status, 201); assert.equal(st.json.runs, 21);
  let d; for (let i = 0; i < 200; i++) { d = (await call('/api/studies/' + st.json.id, { cookie: v })).json; if (d.counts.completed === 21) break; await new Promise((s) => setTimeout(s, 100)); }
  assert.equal(d.counts.completed, 21);
  const fed = d.stats.variants.find((x) => x.label === 'FedAvg'), ada = d.stats.variants.find((x) => x.label === 'ADA-FedAvg');
  assert.equal(fed.n, 3); assert.ok(Math.abs(fed.metrics.macroF1.mean - 0.52) < 1e-9);             // seeds 1,2,3 -> 0.51,0.52,0.53
  assert.ok(Math.abs(ada.metrics.macroF1.mean - 0.57) < 1e-9);
  assert.ok(Math.abs(ada.pairedVsReference.macroF1.mean - 0.05) < 1e-9); assert.equal(ada.pairedVsReference.macroF1.excludesZero, true);
  assert.equal(d.stats.reference, 'FedAvg'); assert.equal(d.stats.target, 0.513); assert.equal(fed.roundsToTarget.reached, 2); // seed 1 (0.51) never reaches the 0.513 target assert.equal(fed.curve.length, 2);
  assert.ok(Math.abs(fed.metrics.test21MacroF1.mean - 0.42) < 1e-9); assert.deepEqual(d.stats.classes, ['benign', 'dos']);
  assert.equal((await call(`/api/studies/${st.json.id}?target=2`, { cookie: v })).status, 400);
  const std = (await call('/api/experiments?scope=standalone', { cookie: r })).json; assert.equal(std.total, 0);   // study runs stay out of the standalone list
  assert.equal((await call('/api/experiments', { cookie: r })).json.total, 21);
  assert.equal((await call('/api/studies/' + st.json.id, { method: 'DELETE', cookie: v })).status, 403);
  assert.equal((await call('/api/studies/' + st.json.id, { method: 'DELETE', cookie: r })).status, 200);
  assert.equal((await call('/api/experiments', { cookie: r })).json.total, 0);
});
test('experiment accepts new knobs and rejects bad ones', async () => {
  const r = await login('r@x.io');
  assert.equal((await call('/api/experiments', { method: 'POST', cookie: r, body: { name: 'x', method: 'ada', distance: 'nope' } })).status, 400);
  assert.equal((await call('/api/experiments', { method: 'POST', cookie: r, body: { name: 'x', method: 'ada', blend: 2 } })).status, 400);
  const ok = await call('/api/experiments', { method: 'POST', cookie: r, body: { name: 'x', method: 'ifca', clients: 30, clusters: 4, hetero: ['label', 'feature'], sybil: true, lossWeights: 'global' } });
  assert.equal(ok.status, 201);
  const e = (await call('/api/experiments/' + ok.json.id, { cookie: r })).json; assert.equal(e.config.sybil, true); assert.equal(e.config.clients, 30);
});

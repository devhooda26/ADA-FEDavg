import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { Runner } from '../src/experiments.js';

const db = openDb(':memory:');
const hash = bcrypt.hashSync('adminpassword1', 4);
db.prepare("INSERT INTO users (email,name,password_hash,role,created_at) VALUES ('admin@x.io','Admin',?,'admin',1)").run(hash);
db.prepare("INSERT INTO users (email,name,password_hash,role,created_at) VALUES ('res@x.io','Res',?,'researcher',1)").run(hash);
db.prepare("INSERT INTO users (email,name,password_hash,role,created_at) VALUES ('res2@x.io','Res2',?,'researcher',1)").run(hash);
const fake = path.resolve('test/fake_worker.js');
const runner = new Runner(db, { cmd: process.execPath, argsFor: () => [fake], checkDataset: false });
const server = createApp(db, { corsOrigins: 'http://localhost:5173', authLimit: 1000, runner, requireVerify: true }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());
const call = async (p, { method = 'GET', body, cookie } = {}) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { cookie }) }, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};
const login = async (email) => (await call('/api/auth/login', { method: 'POST', body: { email, password: 'adminpassword1' } })).cookie;
const lastToken = (kind) => db.prepare('SELECT body FROM outbox ORDER BY id DESC LIMIT 1').get().body.match(/token=([\w-]+)/)[1];
const waitFor = async (id, cookie, pred) => { for (let i = 0; i < 100; i++) { const r = await call('/api/experiments/' + id, { cookie }); if (pred(r.json)) return r.json; await new Promise((s) => setTimeout(s, 50)); } throw new Error('timeout'); };

test('email verification gates login; token is single-use', async () => {
  const reg = await call('/api/auth/register', { method: 'POST', body: { email: 'new@x.io', name: 'New', password: 'longenough123' } });
  assert.equal(reg.status, 201); assert.equal(reg.json.verificationRequired, true); assert.equal(reg.cookie, '');
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'new@x.io', password: 'longenough123' } })).json.code, 'unverified');
  const t = lastToken();
  assert.equal((await call('/api/auth/verify', { method: 'POST', body: { token: t } })).status, 200);
  assert.equal((await call('/api/auth/verify', { method: 'POST', body: { token: t } })).status, 400);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'new@x.io', password: 'longenough123' } })).status, 200);
});
test('password reset: same response for unknown email, single-use, kills sessions', async () => {
  const old = await login('res@x.io');
  const a = await call('/api/auth/forgot', { method: 'POST', body: { email: 'nobody@x.io' } });
  const b = await call('/api/auth/forgot', { method: 'POST', body: { email: 'res@x.io' } });
  assert.deepEqual(a.json, b.json);
  const t = lastToken();
  assert.equal((await call('/api/auth/reset', { method: 'POST', body: { token: t, password: 'short' } })).status, 400);
  assert.equal((await call('/api/auth/reset', { method: 'POST', body: { token: t, password: 'brandnewpass1' } })).status, 200);
  assert.equal((await call('/api/auth/reset', { method: 'POST', body: { token: t, password: 'brandnewpass2' } })).status, 400);
  assert.equal((await call('/api/auth/me', { cookie: old })).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'res@x.io', password: 'brandnewpass1' } })).status, 200);
});
test('experiment lifecycle, permissions and ownership', async () => {
  const viewerReg = await call('/api/auth/register', { method: 'POST', body: { email: 'v2@x.io', name: 'V', password: 'longenough123' } });
  await call('/api/auth/verify', { method: 'POST', body: { token: lastToken() } });
  const viewer = await login2('v2@x.io', 'longenough123');
  assert.equal((await call('/api/experiments', { method: 'POST', body: { name: 'x', method: 'ada' }, cookie: viewer })).status, 403);
  assert.equal((await call('/api/experiments')).status, 401);
  const r2 = await login('res2@x.io');
  assert.equal((await call('/api/experiments', { method: 'POST', body: { name: 'x', method: 'ada', clusters: 9 }, cookie: r2 })).status, 400);
  const { json } = await call('/api/experiments', { method: 'POST', body: { name: 'run1', method: 'ada', skew: 'mild' }, cookie: r2 });
  const done = await waitFor(json.id, r2, (e) => e.status === 'completed');
  assert.equal(done.metrics.macroF1, 0.6); assert.equal(done.config.rounds, 30);
  assert.equal((await call(`/api/experiments/${json.id}`, { method: 'DELETE', cookie: await login('admin@x.io') })).status, 200);
});
test('cannot touch another researcher\'s experiment; cancel works; failure reported', async () => {
  const a = await login('admin@x.io'), r2 = await login('res2@x.io');
  process.env.FAKE_HANG = '1';
  const { json } = await call('/api/experiments', { method: 'POST', body: { name: 'hang', method: 'fedavg' }, cookie: a });
  await waitFor(json.id, a, (e) => e.status === 'training');
  const other = await call('/api/auth/login', { method: 'POST', body: { email: 'res2@x.io', password: 'adminpassword1' } });
  assert.equal((await call(`/api/experiments/${json.id}/cancel`, { method: 'POST', body: {}, cookie: other.cookie })).status, 403);
  assert.equal((await call(`/api/experiments/${json.id}/cancel`, { method: 'POST', body: {}, cookie: a })).status, 200);
  assert.equal((await waitFor(json.id, a, (e) => e.status === 'cancelled')).status, 'cancelled');
  delete process.env.FAKE_HANG; process.env.FAKE_FAIL = '1';
  const f = await call('/api/experiments', { method: 'POST', body: { name: 'fail', method: 'fedavg' }, cookie: a });
  const failed = await waitFor(f.json.id, a, (e) => e.status === 'failed');
  assert.equal(failed.message, 'boom'); delete process.env.FAKE_FAIL;
});
test('overview and compare endpoints', async () => {
  const a = await login('admin@x.io');
  const o = await call('/api/overview', { cookie: a }); assert.equal(o.status, 200); assert.ok(o.json.users >= 3);
  assert.equal((await call('/api/experiments/compare', { cookie: a })).json.source, 'generated');
  assert.equal((await call('/api/admin/outbox', { cookie: a })).status, 200);
});
async function login2(email, password) { return (await call('/api/auth/login', { method: 'POST', body: { email, password } })).cookie; }

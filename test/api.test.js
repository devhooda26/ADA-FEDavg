import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

const db = openDb(':memory:');
db.prepare("INSERT INTO users (email,name,password_hash,role,created_at) VALUES ('admin@x.io','A',?,'admin',1)").run(bcrypt.hashSync('adminpassword1', 4));
const server = createApp(db, { corsOrigins: 'http://localhost:5173', authLimit: 1000 }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const call = async (path, { method = 'GET', body, cookie } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { cookie }) }, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};

test('public summary works, private results need auth', async () => {
  assert.equal((await call('/api/paper/summary')).status, 200);
  assert.equal((await call('/api/paper/results')).status, 401);
});
test('register validates and creates viewer only', async () => {
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { email: 'a@b.co', name: 'N', password: 'short' } })).status, 400);
  const r = await call('/api/auth/register', { method: 'POST', body: { email: 'v@b.co', name: 'V', password: 'longenough123', role: 'admin' } });
  assert.equal(r.status, 201); assert.equal(r.json.user.role, 'viewer');
  assert.equal((await call('/api/paper/results', { cookie: r.cookie })).status, 200);
  assert.equal((await call('/api/admin/users', { cookie: r.cookie })).status, 403);
});
test('login, wrong password, logout invalidates session', async () => {
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'admin@x.io', password: 'nope' } })).status, 401);
  const ok = await call('/api/auth/login', { method: 'POST', body: { email: 'admin@x.io', password: 'adminpassword1' } });
  assert.equal(ok.status, 200);
  assert.equal((await call('/api/admin/audit', { cookie: ok.cookie })).status, 200);
  await call('/api/auth/logout', { method: 'POST', cookie: ok.cookie });
  assert.equal((await call('/api/auth/me', { cookie: ok.cookie })).status, 401);
});
test('account locks after 5 failures', async () => {
  for (let i = 0; i < 5; i++) await call('/api/auth/login', { method: 'POST', body: { email: 'v@b.co', password: 'wrongwrong' } });
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'v@b.co', password: 'longenough123' } })).status, 429);
});
test('admin can change roles but not own', async () => {
  const a = await call('/api/auth/login', { method: 'POST', body: { email: 'admin@x.io', password: 'adminpassword1' } });
  assert.equal((await call('/api/admin/users/1/role', { method: 'PATCH', body: { role: 'viewer' }, cookie: a.cookie })).status, 400);
  assert.equal((await call('/api/admin/users/2/role', { method: 'PATCH', body: { role: 'researcher' }, cookie: a.cookie })).status, 200);
});
test('bad origin rejected on mutation', async () => {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.com' }, body: '{}' });
  assert.equal(r.status, 403);
});

test('health endpoint reports status without auth', async () => {
  const r = await call('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.match(r.json.version, /^\d+\.\d+\.\d+/);
  assert.equal(r.json.db, true);
});
test('CSP allows inline style attributes but not inline scripts or style blocks', async () => {
  const csp = (await fetch(base + '/')).headers.get('content-security-policy') || '';
  assert.match(csp, /style-src-attr 'unsafe-inline'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /style-src 'self'[^;]*'unsafe-inline'/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/); // test env is not production
});
test('static assets and unknown API routes', async () => {
  assert.equal((await fetch(base + '/favicon.svg')).status, 200);
  assert.equal((await fetch(base + '/review.json')).status, 200);
  const r = await call('/api/does-not-exist');
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'Not found');
});

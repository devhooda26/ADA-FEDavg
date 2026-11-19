import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-fmt-'));
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { Runner } = await import('../src/experiments.js');

const db = openDb(':memory:');
db.prepare("INSERT INTO users (email,name,password_hash,role,created_at) VALUES ('r@x.io','R',?,'researcher',1)").run(bcrypt.hashSync('adminpassword1', 4));
const runner = new Runner(db, { cmd: process.execPath, argsFor: () => [path.resolve('test/fake_worker.js')], checkDataset: false });
const server = createApp(db, { corsOrigins: 'http://localhost:5173', authLimit: 1000, runner }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());
const cookie = async () => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'r@x.io', password: 'adminpassword1' }) })).headers.get('set-cookie').split(';')[0];
const upload = async (ck, name, filename, body) => {
  const r = await fetch(`${base}/api/datasets?name=${encodeURIComponent(name)}&filename=${encodeURIComponent(filename)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', cookie: ck }, body });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const records = (n) => Array.from({ length: n }, (_, i) => ({ id: i, f1: (i * 7) % 13, f2: (i % 5) + 0.5, proto: ['tcp', 'udp'][i % 2], label: i % 3 === 0 ? 'attack' : 'normal' }));

test('JSON, JSONL, TSV and gzip uploads are all accepted and profiled', async () => {
  const ck = await cookie(), recs = records(400);
  const cases = [
    ['flows.json', JSON.stringify(recs), 'JSON'],
    ['flows.jsonl', recs.map((r) => JSON.stringify(r)).join('\n'), 'JSON Lines'],
    ['flows.tsv', ['id\tf1\tf2\tproto\tlabel', ...recs.map((r) => Object.values(r).join('\t'))].join('\n'), 'TSV'],
    ['flows.json.gz', zlib.gzipSync(JSON.stringify({ data: recs })), 'JSON'],
  ];
  for (const [file, body, format] of cases) {
    const up = await upload(ck, file, file, body);
    assert.equal(up.status, 201, `${file}: ${JSON.stringify(up.json)}`);
    assert.equal(up.json.format, format, file);
    const d = await (await fetch(`${base}/api/datasets/${up.json.id}`, { headers: { cookie: ck } })).json();
    assert.equal(d.rows, 400, file);
    assert.equal(d.profile.source.format, format, file);
    assert.deepEqual(d.profile.columns.map((c) => c.name), ['id', 'f1', 'f2', 'proto', 'label'], file);
    const lab = await (await fetch(`${base}/api/datasets/${up.json.id}/labels?col=label`, { headers: { cookie: ck } })).json();
    assert.deepEqual(lab.labels.map((l) => l.value).sort(), ['attack', 'normal'], file);
  }
});

test('unsupported files are refused with a clear reason and leave nothing behind', async () => {
  const ck = await cookie();
  const pcap = await upload(ck, 'capture', 'capture.pcap', Buffer.concat([Buffer.from([0xd4, 0xc3, 0xb2, 0xa1]), Buffer.alloc(200)]));
  assert.equal(pcap.status, 400); assert.match(pcap.json.error, /packet capture/i);
  const pdf = await upload(ck, 'doc', 'doc.pdf', Buffer.from('%PDF-1.7 not data'));
  assert.equal(pdf.status, 400); assert.match(pdf.json.error, /PDF/);
  const left = fs.readdirSync(process.env.UPLOAD_DIR).filter((f) => f.endsWith('.upload'));
  assert.deepEqual(left, [], 'temporary raw uploads must be deleted');
});

test('every page URL returns the app shell; unknown pages are a real 404', async () => {
  for (const p of ['/', '/login', '/register', '/forgot', '/reset?token=x', '/verify?token=x', '/review', '/app', '/app/experiments', '/app/experiments/12', '/app/datasets/3']) {
    const r = await fetch(base + p, { headers: { Accept: 'text/html' } });
    assert.equal(r.status, 200, p);
    assert.match(await r.text(), /<div id="live"/, p);
  }
  const nf = await fetch(base + '/no-such-page', { headers: { Accept: 'text/html' } });
  assert.equal(nf.status, 404); assert.match(await nf.text(), /<div id="live"/);
  assert.equal((await fetch(base + '/missing.png', { headers: { Accept: 'text/html' } })).status, 404);
  const api = await fetch(base + '/api/nope'); assert.equal(api.status, 404); assert.equal((await api.json()).error, 'Not found');
  assert.equal((await fetch(base + '/style.css')).status, 200); // static files still win over the page fallback
});

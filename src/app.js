import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { makeMailer, issueToken, consumeToken } from './mail.js';
import { Runner, shape, datasetStatus, profileFile, ingestFile, UPLOADS, MAX_UPLOAD_MB, modelDir, hasModel, predictRecords } from './experiments.js';
import { studyStats } from './stats.js';
import path from 'node:path';

const COOKIE = 'ada_session';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Date.now();

export const ROLE_PERMS = {
  admin: ['results:read', 'users:manage', 'audit:read', 'experiments:run', 'experiments:manage_all'],
  researcher: ['results:read', 'experiments:run'],
  viewer: ['results:read'],
};
const can = (role, perm) => (ROLE_PERMS[role] || []).includes(perm);

export function createApp(db, opts = {}) {
  const isProd = (opts.nodeEnv ?? process.env.NODE_ENV) === 'production';
  const ttlMs = Number(opts.ttlHours ?? process.env.SESSION_TTL_HOURS ?? 12) * 3600_000;
  const origins = (opts.corsOrigins ?? process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const paper = JSON.parse(fs.readFileSync(new URL('../data/paper-results.json', import.meta.url), 'utf8'));
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: opts.authLimit ?? 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again later.' } });

  const mailer = opts.mailer ?? makeMailer(db);
  const runner = opts.runner ?? new Runner(db);
  const appUrl = opts.appUrl ?? process.env.APP_URL ?? 'http://localhost:4000';
  const requireVerify = (opts.requireVerify ?? process.env.REQUIRE_EMAIL_VERIFICATION) === true || (opts.requireVerify ?? process.env.REQUIRE_EMAIL_VERIFICATION) === 'true';
  const audit = (req, event, userId = null, detail = null) =>
    db.prepare('INSERT INTO audit_log (user_id,event,detail,ip,created_at) VALUES (?,?,?,?,?)').run(userId, event, detail, req.ip, now());

  const app = express();
  app.disable('x-powered-by');
  if (isProd) app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], connectSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
    styleSrc: ["'self'", 'https://fonts.googleapis.com'], fontSrc: ['https://fonts.gstatic.com'],
    styleSrcAttr: ["'unsafe-inline'"], // inline style="" attributes only (chart bars, legends); <style> blocks stay blocked
    manifestSrc: ["'self'"], workerSrc: ["'none'"],
    objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
    upgradeInsecureRequests: isProd ? [] : null } } })); // null: do not force https on http://localhost (breaks Safari)
  const smallJson = express.json({ limit: '10kb' });
  app.use((req, res, next) => (req.path === '/api/detect' ? next() : smallJson(req, res, next))); // /api/detect parses its own, larger body
  app.use(cookieParser());

  // CORS (credentialed) restricted to an allow-list, plus Origin check on mutations (CSRF defence with SameSite).
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (origin && !origins.includes(origin) && origin !== `${req.protocol}://${req.headers.host}`)
        return res.status(403).json({ error: 'Origin not allowed' });
      if (Number(req.headers['content-length'] || 0) > 0 && !req.is('application/json') && req.path !== '/api/datasets') return res.status(415).json({ error: 'JSON required' });
    }
    next();
  });

  // Session loader
  app.use((req, _res, next) => {
    const tok = req.cookies[COOKIE];
    if (tok) {
      const row = db.prepare(`SELECT u.id,u.email,u.name,u.role,u.email_verified,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(sha(tok));
      if (row && row.expires_at > now()) req.user = row;
      else if (row) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(tok));
    }
    next();
  });

  const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Authentication required' }));
  const requirePerm = (perm) => (req, res, next) => (can(req.user.role, perm) ? next() : res.status(403).json({ error: 'Forbidden' }));

  function startSession(req, res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(sha(token), userId, now() + ttlMs, now());
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: ttlMs, path: '/' });
  }

  const credSchema = z.object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(10, 'Password must be at least 10 characters').max(128),
  });
  const parse = (schema, body, res) => {
    const r = schema.safeParse(body);
    if (!r.success) { res.status(400).json({ error: 'Invalid input', details: r.error.issues.map((i) => i.message) }); return null; }
    return r.data;
  };
  const sendVerification = async (id, email) => {
    const t = issueToken(db, id, 'verify', 24 * 3600_000);
    return mailer.send(email, 'Verify your ADA-FedAvg account', `Confirm your email address:\n${appUrl}/verify?token=${t}\n\nThis link expires in 24 hours.`);
  };
  const DUMMY = bcrypt.hashSync('dummy-password-for-timing', 12);

  // ---- Health
  app.get('/api/health', (_req, res) => {
    let dbOk = true; try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }
    res.status(dbOk ? 200 : 503).json({ ok: dbOk, version: pkg.version, env: isProd ? 'production' : 'development', uptimeS: Math.round(process.uptime()), db: dbOk, dataset: datasetStatus(), email: mailer.mode });
  });

  // ---- Auth
  app.post('/api/auth/register', authLimiter, (req, res) => {
    const d = parse(credSchema.extend({ name: z.string().trim().min(1).max(80) }), req.body, res);
    if (!d) return;
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(d.email)) {
      audit(req, 'register_duplicate', null, d.email);
      return res.status(409).json({ error: 'Unable to register with those details' });
    }
    const info = db.prepare('INSERT INTO users (email,name,password_hash,role,email_verified,created_at) VALUES (?,?,?,?,0,?)')
      .run(d.email, d.name, bcrypt.hashSync(d.password, 12), 'viewer', now()); // always viewer; no self-escalation
    audit(req, 'register', info.lastInsertRowid);
    sendVerification(info.lastInsertRowid, d.email).then((delivery) => {
      if (!requireVerify) startSession(req, res, info.lastInsertRowid);
      res.status(201).json({ user: { id: info.lastInsertRowid, email: d.email, name: d.name, role: 'viewer', emailVerified: false }, verificationRequired: requireVerify, emailDelivery: delivery });
    }).catch(() => res.status(502).json({ error: 'Account created but the verification email could not be sent' }));
  });

  app.post('/api/auth/login', authLimiter, (req, res) => {
    const d = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(128) }), req.body, res);
    if (!d) return;
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(d.email);
    const fail = () => res.status(401).json({ error: 'Invalid email or password' });
    if (!u) { bcrypt.compareSync(d.password, DUMMY); audit(req, 'login_failed', null, d.email); return fail(); }
    if (u.locked_until > now()) { audit(req, 'login_locked', u.id); return res.status(429).json({ error: 'Account temporarily locked. Try again later.' }); }
    if (!bcrypt.compareSync(d.password, u.password_hash)) {
      const attempts = u.failed_attempts + 1;
      const lock = attempts >= 5 ? now() + 15 * 60_000 : 0;
      db.prepare('UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?').run(lock ? 0 : attempts, lock, u.id);
      audit(req, lock ? 'account_locked' : 'login_failed', u.id);
      return fail();
    }
    db.prepare('UPDATE users SET failed_attempts=0, locked_until=0 WHERE id=?').run(u.id);
    if (requireVerify && !u.email_verified) return res.status(403).json({ error: 'Please verify your email address first', code: 'unverified' });
    startSession(req, res, u.id);
    audit(req, 'login', u.id);
    res.json({ user: { id: u.id, email: u.email, name: u.name, role: u.role, emailVerified: !!u.email_verified } });
  });

  app.post('/api/auth/logout', (req, res) => {
    const tok = req.cookies[COOKIE];
    if (tok) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(tok));
    if (req.user) audit(req, 'logout', req.user.id);
    res.clearCookie(COOKIE, { path: '/' }).json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role, emailVerified: !!req.user.email_verified } }));

  app.post('/api/auth/change-password', requireAuth, authLimiter, (req, res) => {
    const d = parse(z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(10).max(128) }), req.body, res);
    if (!d) return;
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!bcrypt.compareSync(d.currentPassword, u.password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(d.newPassword, 12), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); // invalidate all sessions
    startSession(req, res, u.id);
    audit(req, 'password_changed', u.id);
    res.json({ ok: true });
  });

  // ---- Paper-reported results
  app.get('/api/paper/summary', (_req, res) => res.json({
    source: paper.source, paper: paper.paper, note: paper.note, config: paper.config,
    macroF1ImprovementOverFedAvgPct: paper.macroF1ImprovementOverFedAvgPct,
  }));
  app.get('/api/paper/results', requireAuth, requirePerm('results:read'), (_req, res) => res.json(paper));
  app.get('/api/paper/results/:skew', requireAuth, requirePerm('results:read'), (req, res) => {
    const skew = req.params.skew;
    if (!['mild', 'moderate', 'extreme'].includes(skew)) return res.status(404).json({ error: 'Unknown skew level' });
    res.json({ source: paper.source, skew, alpha: paper.config.skewAlpha[skew],
      rows: paper.comparison.filter((r) => r.skew === skew || r.skew === null),
      macroF1ImprovementOverFedAvgPct: paper.macroF1ImprovementOverFedAvgPct[skew] });
  });

  // ---- Admin
  app.get('/api/admin/users', requireAuth, requirePerm('users:manage'), (_req, res) =>
    res.json({ users: db.prepare('SELECT id,email,name,role,created_at FROM users ORDER BY id').all() }));

  app.patch('/api/admin/users/:id/role', requireAuth, requirePerm('users:manage'), (req, res) => {
    const d = parse(z.object({ role: z.enum(['admin', 'researcher', 'viewer']) }), req.body, res);
    if (!d) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role' });
    const r = db.prepare('UPDATE users SET role=? WHERE id=?').run(d.role, id);
    if (!r.changes) return res.status(404).json({ error: 'User not found' });
    audit(req, 'role_changed', req.user.id, `user ${id} -> ${d.role}`);
    res.json({ ok: true });
  });

  app.get('/api/admin/audit', requireAuth, requirePerm('audit:read'), (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json({ events: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset) });
  });


  // ---- Email verification, password reset, profile
  app.post('/api/auth/verify', authLimiter, (req, res) => {
    const d = parse(z.object({ token: z.string().min(10).max(200) }), req.body, res); if (!d) return;
    const id = consumeToken(db, d.token, 'verify');
    if (!id) return res.status(400).json({ error: 'This link is invalid or has expired' });
    db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(id); audit(req, 'email_verified', id);
    res.json({ ok: true });
  });
  app.post('/api/auth/resend-verification', requireAuth, authLimiter, async (req, res) => {
    if (req.user.email_verified) return res.json({ ok: true });
    res.json({ ok: true, emailDelivery: await sendVerification(req.user.id, req.user.email) });
  });
  app.post('/api/auth/forgot', authLimiter, async (req, res) => {
    const d = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.body, res); if (!d) return;
    const u = db.prepare('SELECT id,email FROM users WHERE email=?').get(d.email);
    if (u) {
      const t = issueToken(db, u.id, 'reset', 3600_000);
      audit(req, 'password_reset_requested', u.id);
      mailer.send(u.email, 'Reset your ADA-FedAvg password', `Choose a new password:\n${appUrl}/reset?token=${t}\n\nThis link expires in 1 hour. If you did not ask for this, ignore this email.`).catch((e) => console.error('mail failed', e.message));
    }
    res.json({ ok: true, emailDelivery: mailer.mode }); // identical response whether or not the account exists
  });
  app.post('/api/auth/reset', authLimiter, (req, res) => {
    const d = parse(z.object({ token: z.string().min(10).max(200), password: z.string().min(10).max(128) }), req.body, res); if (!d) return;
    const id = consumeToken(db, d.token, 'reset');
    if (!id) return res.status(400).json({ error: 'This link is invalid or has expired' });
    db.prepare('UPDATE users SET password_hash=?, failed_attempts=0, locked_until=0, email_verified=1 WHERE id=?').run(bcrypt.hashSync(d.password, 12), id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); audit(req, 'password_reset', id);
    res.json({ ok: true });
  });
  app.patch('/api/auth/profile', requireAuth, (req, res) => {
    const d = parse(z.object({ name: z.string().trim().min(1).max(80) }), req.body, res); if (!d) return;
    db.prepare('UPDATE users SET name=? WHERE id=?').run(d.name, req.user.id); audit(req, 'profile_updated', req.user.id);
    res.json({ ok: true });
  });

  // ---- Experiments (real ADA-FedAvg runs executed by the Python worker)
  const cfgSchema = z.object({
    name: z.string().trim().min(1).max(100),
    method: z.enum(['centralized', 'fedavg', 'fedprox', 'ifca', 'ada']),
    skew: z.enum(['mild', 'moderate', 'extreme']).default('moderate'),
    rounds: z.number().int().min(1).max(100).default(30),
    clients: z.number().int().min(2).max(50).default(8),
    clusters: z.number().int().min(2).max(12).default(3),
    localEpochs: z.number().int().min(1).max(5).default(1),
    lossWeights: z.enum(['none', 'local', 'global']).default('none'),
    cwPower: z.number().min(0.1).max(1).default(0.5),
    proxMu: z.number().min(0).max(10).default(0.01),
    clusterMode: z.enum(['agglom', 'random', 'singleton']).default('agglom'),
    distance: z.enum(['jsd', 'jsd-log', 'jsd-invfreq']).default('jsd'),
    blend: z.number().min(0).max(1).default(0),
    sybil: z.boolean().default(false),
    hetero: z.array(z.enum(['label', 'quantity', 'feature'])).min(1).default(['label']),
    featureShift: z.number().min(0).max(2).default(0.5),
    quantityAlpha: z.number().min(0.1).max(10).default(0.5),
    partitionSeed: z.number().int().min(0).max(1_000_000).optional(),
    seed: z.number().int().min(0).max(1_000_000).default(42),
    datasetId: z.number().int().positive().optional(),
  }).refine((c) => c.clusters <= c.clients, { message: 'clusters cannot exceed clients' });
  const enqueue = (user, cfg, studyId = null, variant = null) => {
    const { name, ...rest } = cfg; if (rest.method === 'centralized') rest.skew = null;
    return db.prepare('INSERT INTO experiments (user_id,owner_name,name,config,created_at,study_id,variant) VALUES (?,?,?,?,?,?,?)').run(user.id, user.name, name, JSON.stringify(rest), now(), studyId, variant).lastInsertRowid;
  };
  const activeCount = (uid) => db.prepare("SELECT COUNT(*) n FROM experiments WHERE user_id=? AND study_id IS NULL AND status IN ('queued','preparing','training','aggregating','evaluating')").get(uid).n;
  const guardRun = (req, res, add, builtin = true) => {
    if (builtin && runner.checkDataset && !(datasetStatus().train && datasetStatus().test)) { res.status(409).json({ error: 'NSL-KDD dataset not found on the server. Run: npm run dataset', code: 'dataset_missing' }); return false; }
    if (activeCount(req.user.id) + add > 10) { res.status(429).json({ error: 'Too many active experiments. Wait for some to finish.' }); return false; }
    return true;
  };
  const runPerm = [requireAuth, requirePerm('experiments:run')];

  app.get('/api/dataset', requireAuth, (_req, res) => res.json(datasetStatus()));
  app.post('/api/experiments', ...runPerm, (req, res) => {
    const c = parse(cfgSchema, req.body, res); if (!c) return;
    if (c.datasetId) {
      const d = db.prepare('SELECT * FROM datasets WHERE id=?').get(c.datasetId);
      if (!d || (d.user_id !== req.user.id && req.user.role !== 'admin')) return res.status(404).json({ error: 'Dataset not found' });
      if (d.status !== 'ready') return res.status(409).json({ error: 'Finish configuring the dataset first' });
      c.datasetName = d.name;
    }
    if (!guardRun(req, res, 1, !c.datasetId)) return;
    const id = enqueue(req.user, c); audit(req, 'experiment_created', req.user.id, `#${id} ${c.method}`); runner.tick();
    res.status(201).json({ id });
  });
  app.post('/api/experiments/suite', ...runPerm, (req, res) => {
    if (!guardRun(req, res, 7)) return;
    const base = { rounds: 30, clients: 8, clusters: 3, seed: 42 };
    const jobs = [{ method: 'centralized', skew: 'moderate' }, ...['mild', 'moderate', 'extreme'].flatMap((skew) => ['fedavg', 'ada'].map((method) => ({ method, skew })))];
    const ids = jobs.map((j) => enqueue(req.user, { ...base, ...j, name: `Reproduction: ${j.method}${j.method === 'centralized' ? '' : ' / ' + j.skew}` }));
    audit(req, 'experiment_suite_created', req.user.id, ids.join(',')); runner.tick();
    res.status(201).json({ ids });
  });
  app.get('/api/experiments', requireAuth, requirePerm('results:read'), (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 25, 100), offset = Math.max(Number(req.query.offset) || 0, 0);
    const w = req.query.scope === 'standalone' ? 'WHERE study_id IS NULL' : '';
    const total = db.prepare(`SELECT COUNT(*) n FROM experiments ${w}`).get().n;
    res.json({ total, experiments: db.prepare(`SELECT * FROM experiments ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(limit, offset).map((r) => shape(r)) });
  });
  app.get('/api/experiments/compare', requireAuth, requirePerm('results:read'), (_req, res) => {
    const latest = {};
    for (const r of db.prepare("SELECT * FROM experiments WHERE status='completed' ORDER BY id").all()) {
      const c = JSON.parse(r.config); if (c.datasetId || r.study_id) continue; // paper comparison is NSL-KDD only
      latest[`${c.method}|${c.skew ?? ''}`] = shape(r);
    }
    res.json({ source: 'generated', runs: Object.values(latest) });
  });
  app.get('/api/experiments/:id', requireAuth, requirePerm('results:read'), (req, res) => {
    const r = db.prepare('SELECT * FROM experiments WHERE id=?').get(Number(req.params.id));
    r ? res.json(shape(r, true)) : res.status(404).json({ error: 'Not found' });
  });
  const owned = (req, res) => {
    const r = db.prepare('SELECT * FROM experiments WHERE id=?').get(Number(req.params.id));
    if (!r) { res.status(404).json({ error: 'Not found' }); return null; }
    if (r.user_id !== req.user.id && !can(req.user.role, 'experiments:manage_all')) { res.status(403).json({ error: 'Forbidden' }); return null; }
    return r;
  };
  app.post('/api/experiments/:id/cancel', ...runPerm, (req, res) => {
    const r = owned(req, res); if (!r) return;
    if (!runner.cancel(r.id)) return res.status(409).json({ error: 'Experiment is not running or queued' });
    audit(req, 'experiment_cancelled', req.user.id, `#${r.id}`); res.json({ ok: true });
  });
  app.delete('/api/experiments/:id', ...runPerm, (req, res) => {
    const r = owned(req, res); if (!r) return;
    if (['queued', 'preparing', 'training', 'aggregating', 'evaluating'].includes(r.status)) return res.status(409).json({ error: 'Cancel the experiment first' });
    db.prepare('DELETE FROM experiments WHERE id=?').run(r.id); fs.rmSync(modelDir(r.id), { recursive: true, force: true }); audit(req, 'experiment_deleted', req.user.id, `#${r.id}`); res.json({ ok: true });
  });
  app.get('/api/overview', requireAuth, requirePerm('results:read'), (req, res) => {
    const by = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM experiments GROUP BY status').all().map((r) => [r.status, r.n]));
    const last = db.prepare("SELECT * FROM experiments WHERE status='completed' ORDER BY id DESC LIMIT 1").get();
    res.json({ experiments: { total: Object.values(by).reduce((a, b) => a + b, 0), byStatus: by }, latest: last ? shape(last) : null,
      users: can(req.user.role, 'users:manage') ? db.prepare('SELECT COUNT(*) n FROM users').get().n : null, dataset: datasetStatus(), emailMode: mailer.mode });
  });
  app.get('/api/admin/outbox', requireAuth, requirePerm('users:manage'), (_req, res) => {
    if (mailer.mode === 'smtp') return res.status(404).json({ error: 'Outbox is only used when SMTP is not configured' });
    res.json({ emails: db.prepare('SELECT id,to_email,subject,body,created_at FROM outbox ORDER BY id DESC LIMIT 50').all() });
  });
  app.delete('/api/admin/users/:id', requireAuth, requirePerm('users:manage'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id === req.user.id) return res.status(400).json({ error: 'Invalid user' });
    if (!db.prepare('DELETE FROM users WHERE id=?').run(id).changes) return res.status(404).json({ error: 'User not found' });
    audit(req, 'user_deleted', req.user.id, `user ${id}`); res.json({ ok: true });
  });

  // ---- User datasets (CSV upload -> profile -> label mapping -> experiments)
  const dsPublic = (d) => ({ id: d.id, name: d.name, owner: d.owner_name, rows: d.rows, bytes: d.bytes, status: d.status, labelCol: d.label_col, createdAt: d.created_at,
    classes: d.class_map ? [...new Set(Object.values(JSON.parse(d.class_map)))].sort() : [], testFrac: d.test_frac, maxRows: d.max_rows });
  const dsOwned = (req, res) => {
    const d = db.prepare('SELECT * FROM datasets WHERE id=?').get(Number(req.params.id));
    if (!d || (d.user_id !== req.user.id && req.user.role !== 'admin')) { res.status(404).json({ error: 'Dataset not found' }); return null; } // raw data is private to owner and admins
    return d;
  };
  const fileOf = (d) => path.join(UPLOADS, d.file_id + '.csv');
  const rm = (f) => fs.rmSync(f, { force: true });
  app.get('/api/datasets', ...runPerm, (req, res) => {
    const rows = req.user.role === 'admin' ? db.prepare('SELECT * FROM datasets ORDER BY id DESC').all() : db.prepare('SELECT * FROM datasets WHERE user_id=? ORDER BY id DESC').all(req.user.id);
    res.json({ datasets: rows.map(dsPublic), maxUploadMB: MAX_UPLOAD_MB });
  });
  app.post('/api/datasets', ...runPerm, express.raw({ type: () => true, limit: `${MAX_UPLOAD_MB}mb` }), async (req, res) => {
    const name = z.string().trim().min(1).max(100).safeParse(req.query.name);
    if (!name.success) return res.status(400).json({ error: 'A dataset name (1-100 characters) is required' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Send the data file as the request body' });
    if (db.prepare('SELECT COUNT(*) n FROM datasets WHERE user_id=?').get(req.user.id).n >= 10) return res.status(429).json({ error: 'Dataset limit reached (10). Delete one first.' });
    fs.mkdirSync(UPLOADS, { recursive: true, mode: 0o700 });
    const fileId = crypto.randomUUID(), file = path.join(UPLOADS, fileId + '.csv'), raw = path.join(UPLOADS, fileId + '.upload'); // server-generated names: no path traversal
    const original = String(req.query.filename || '').slice(0, 200); // used only as a format hint, never as a path
    fs.writeFileSync(raw, req.body, { mode: 0o600 });
    try {
      const source = await ingestFile(raw, file, original);
      const profile = await profileFile(file);
      if (profile.rows < 200) throw new Error('Too few rows: at least 200 are needed');
      profile.source = { format: source.format, notes: source.notes };
      const bytes = fs.statSync(file).size;
      const id = db.prepare('INSERT INTO datasets (user_id,owner_name,name,file_id,bytes,rows,profile,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(req.user.id, req.user.name, name.data, fileId, bytes, profile.rows, JSON.stringify(profile), now()).lastInsertRowid;
      audit(req, 'dataset_uploaded', req.user.id, `#${id} ${profile.rows} rows (${source.format})`);
      res.status(201).json({ id, format: source.format, notes: source.notes });
    } catch (e) { rm(file); res.status(400).json({ error: e.message }); } finally { rm(raw); }
  });
  app.get('/api/datasets/:id', ...runPerm, (req, res) => {
    const d = dsOwned(req, res); if (!d) return;
    res.json({ ...dsPublic(d), profile: JSON.parse(d.profile), classMap: d.class_map ? JSON.parse(d.class_map) : null });
  });
  app.get('/api/datasets/:id/labels', ...runPerm, async (req, res) => {
    const d = dsOwned(req, res); if (!d) return;
    const col = String(req.query.col || '');
    if (!JSON.parse(d.profile).columns.some((c) => c.name === col)) return res.status(400).json({ error: 'Unknown column' });
    try { res.json({ labels: (await profileFile(fileOf(d), col)).labels }); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.put('/api/datasets/:id/config', ...runPerm, async (req, res) => {
    const d = dsOwned(req, res); if (!d) return;
    const c = parse(z.object({ labelCol: z.string().min(1).max(80), classMap: z.record(z.string().max(200), z.string().trim().min(1).max(40)),
      testFrac: z.number().min(0.1).max(0.5).default(0.2), maxRows: z.number().int().min(1000).max(500000).default(200000) }), req.body, res); if (!c) return;
    if (!JSON.parse(d.profile).columns.some((x) => x.name === c.labelCol)) return res.status(400).json({ error: 'Unknown label column' });
    let labels; try { labels = (await profileFile(fileOf(d), c.labelCol)).labels; } catch (e) { return res.status(400).json({ error: e.message }); }
    const counts = {}; const known = new Map(labels.map((l) => [l.value, l.count]));
    for (const [v, cls] of Object.entries(c.classMap)) { if (!known.has(v)) return res.status(400).json({ error: `Label value not found in the file: ${v}` }); counts[cls] = (counts[cls] || 0) + known.get(v); }
    const names = Object.keys(counts);
    if (names.length < 2) return res.status(400).json({ error: 'Map labels to at least 2 classes' });
    if (names.length > 12) return res.status(400).json({ error: 'At most 12 classes are supported' });
    const small = names.find((n) => counts[n] < 50);
    if (small) return res.status(400).json({ error: `Class "${small}" has only ${counts[small]} rows (minimum 50). Merge it into another class or leave it unmapped.` });
    fs.writeFileSync(path.join(UPLOADS, d.file_id + '.map.json'), JSON.stringify(c.classMap), { mode: 0o600 });
    db.prepare("UPDATE datasets SET label_col=?, class_map=?, test_frac=?, max_rows=?, status='ready' WHERE id=?").run(c.labelCol, JSON.stringify(c.classMap), c.testFrac, c.maxRows, d.id);
    audit(req, 'dataset_configured', req.user.id, `#${d.id}`); res.json({ ok: true, classes: counts });
  });
  app.delete('/api/datasets/:id', ...runPerm, (req, res) => {
    const d = dsOwned(req, res); if (!d) return;
    const busy = db.prepare("SELECT config FROM experiments WHERE status IN ('queued','preparing','training','aggregating','evaluating')").all().some((e) => JSON.parse(e.config).datasetId === d.id);
    if (busy) return res.status(409).json({ error: 'An experiment is using this dataset. Cancel it first.' });
    rm(fileOf(d)); rm(path.join(UPLOADS, d.file_id + '.map.json')); db.prepare('DELETE FROM datasets WHERE id=?').run(d.id);
    audit(req, 'dataset_deleted', req.user.id, `#${d.id}`); res.json({ ok: true });
  });

  // ---- Studies: many seeds x variants, with mean/std, 95% CIs and paired differences
  const PRESETS = {
    core: { title: 'Core comparison', note: 'Centralized (same budget, with and without class-balanced loss), FedAvg, FedAvg with global class-balanced loss, FedProx, IFCA and ADA-FedAvg.',
      variants: () => [['Centralized', { method: 'centralized' }], ['Centralized + class-balanced loss', { method: 'centralized', lossWeights: 'global' }], ['FedAvg', { method: 'fedavg' }],
        ['FedAvg + global class-balanced loss', { method: 'fedavg', lossWeights: 'global' }], ['FedProx (mu=0.01)', { method: 'fedprox' }], ['IFCA', { method: 'ifca' }], ['ADA-FedAvg', { method: 'ada' }]] },
    ablation: { title: 'Full ablation', note: 'Is clustering the cause? Tests uniform client weights (K=N), random clusters of the same sizes, a K sweep, local class-weighted loss, other distances and bounded cluster weights.',
      variants: (b) => [['FedAvg', { method: 'fedavg' }], ['FedAvg + global class-balanced loss', { method: 'fedavg', lossWeights: 'global' }], ['FedProx (mu=0.01)', { method: 'fedprox' }], ['IFCA', { method: 'ifca' }],
        ['ADA K=3 (paper)', { method: 'ada' }], ['ADA uniform client weights (K=N)', { method: 'ada', clusterMode: 'singleton' }], ['ADA random clusters (same sizes)', { method: 'ada', clusterMode: 'random' }],
        ...[2, 4, 5, 6, 8].filter((k) => k <= b.clients).map((k) => [`ADA K=${k}`, { method: 'ada', clusters: k }]),
        ['ADA + local class-weighted loss', { method: 'ada', lossWeights: 'local' }], ['ADA inverse-frequency distance', { method: 'ada', distance: 'jsd-invfreq' }], ['ADA log-scale distance', { method: 'ada', distance: 'jsd-log' }],
        ['ADA bounded cluster weights (blend 0.5)', { method: 'ada', blend: 0.5 }], ['Centralized (matched budget)', { method: 'centralized' }], ['Centralized + class-balanced loss', { method: 'centralized', lossWeights: 'global' }]] },
    ksweep: { title: 'Cluster-count sweep', note: 'ADA-FedAvg for K = 2..N against FedAvg (K=1 is FedAvg; K=N is uniform client weighting).',
      variants: (b) => [['FedAvg', { method: 'fedavg' }], ...Array.from({ length: Math.min(b.clients, 8) - 1 }, (_, i) => [`ADA K=${i + 2}`, { method: 'ada', clusters: i + 2 }])] },
    robustness: { title: 'Robustness (Sybil client)', note: 'One client flips labels and reports a fake histogram. Compares FedAvg, ADA-FedAvg and ADA with bounded cluster weights, with and without that client.',
      variants: () => [['FedAvg', { method: 'fedavg' }], ['FedAvg + Sybil', { method: 'fedavg', sybil: true }], ['ADA', { method: 'ada' }], ['ADA + Sybil', { method: 'ada', sybil: true }],
        ['ADA blend 0.5', { method: 'ada', blend: 0.5 }], ['ADA blend 0.5 + Sybil', { method: 'ada', blend: 0.5, sybil: true }]] },
    heterogeneity: { title: 'Beyond label skew', note: 'FedAvg vs ADA-FedAvg when clients also differ in data quantity and feature distribution.',
      variants: () => [['label', ['label']], ['label+quantity', ['label', 'quantity']], ['label+feature', ['label', 'feature']], ['label+quantity+feature', ['label', 'quantity', 'feature']]]
        .flatMap(([l, h]) => [[`FedAvg [${l}]`, { method: 'fedavg', hetero: h }], [`ADA [${l}]`, { method: 'ada', hetero: h }]]) },
  };
  const presetVariants = (key, base) => PRESETS[key].variants(base).map(([label, o]) => [label, { ...base, ...o }]);
  const running = ['queued', 'preparing', 'training', 'aggregating', 'evaluating'];
  const studyCounts = (id) => Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM experiments WHERE study_id=? GROUP BY status').all(id).map((r) => [r.status, r.n]));
  const studyOwned = (req, res) => {
    const st = db.prepare('SELECT * FROM studies WHERE id=?').get(Number(req.params.id));
    if (!st) { res.status(404).json({ error: 'Study not found' }); return null; }
    return st;
  };
  app.get('/api/studies/presets', requireAuth, requirePerm('results:read'), (_req, res) => res.json({ presets: Object.entries(PRESETS).map(([key, p]) =>
    ({ key, title: p.title, note: p.note, variants: presetVariants(key, { clients: 8 }).map(([l]) => l) })), secondsPerRun: 40 }));
  app.get('/api/studies', requireAuth, requirePerm('results:read'), (_req, res) => res.json({ studies: db.prepare('SELECT * FROM studies ORDER BY id DESC LIMIT 100').all().map((s) => ({
    id: s.id, name: s.name, preset: s.preset, owner: s.owner_name, ownerId: s.user_id, seeds: s.seeds, createdAt: s.created_at, config: JSON.parse(s.config).base, counts: studyCounts(s.id) })) }));
  app.post('/api/studies', ...runPerm, (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(1).max(100), preset: z.enum(Object.keys(PRESETS)), skew: z.enum(['mild', 'moderate', 'extreme']).default('moderate'),
      seeds: z.number().int().min(2).max(20).default(5), rounds: z.number().int().min(1).max(100).default(30), clients: z.number().int().min(2).max(50).default(8), datasetId: z.number().int().positive().optional() }), req.body, res);
    if (!b) return;
    let datasetName;
    if (b.datasetId) {
      const d = db.prepare('SELECT * FROM datasets WHERE id=?').get(b.datasetId);
      if (!d || (d.user_id !== req.user.id && req.user.role !== 'admin')) return res.status(404).json({ error: 'Dataset not found' });
      if (d.status !== 'ready') return res.status(409).json({ error: 'Finish configuring the dataset first' });
      datasetName = d.name;
    } else if (runner.checkDataset && !(datasetStatus().train && datasetStatus().test)) return res.status(409).json({ error: 'NSL-KDD dataset not found on the server. Run: npm run dataset', code: 'dataset_missing' });
    const base = { skew: b.skew, rounds: b.rounds, clients: b.clients, clusters: Math.min(3, b.clients), ...(b.datasetId ? { datasetId: b.datasetId, datasetName } : {}) };
    const variants = presetVariants(b.preset, base), total = variants.length * b.seeds;
    if (total > 400) return res.status(400).json({ error: 'Too many runs (limit 400)' });
    const act = db.prepare("SELECT COUNT(*) n FROM experiments WHERE user_id=? AND study_id IS NOT NULL AND status IN ('queued','preparing','training','aggregating','evaluating')").get(req.user.id).n;
    if (act + total > 400) return res.status(429).json({ error: 'Too many queued study runs. Wait for some to finish.' });
    const jobs = [];
    for (const [label, o] of variants) for (let i = 1; i <= b.seeds; i++) {
      const c = cfgSchema.safeParse({ ...o, name: `${b.name} · ${label} · seed ${i}`, seed: i, partitionSeed: i });
      if (!c.success) return res.status(400).json({ error: `Invalid variant "${label}": ${c.error.issues[0].message}` });
      jobs.push([label, c.data]);
    }
    const sid = db.transaction(() => {
      const id = db.prepare('INSERT INTO studies (user_id,owner_name,name,preset,config,seeds,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(req.user.id, req.user.name, b.name, b.preset, JSON.stringify({ base, variants: variants.map(([l]) => l) }), b.seeds, now()).lastInsertRowid;
      for (const [label, c] of jobs) enqueue(req.user, c, id, label);
      return id;
    })();
    audit(req, 'study_created', req.user.id, `#${sid} ${b.preset} ${total} runs`); runner.tick();
    res.status(201).json({ id: sid, runs: total });
  });
  app.get('/api/studies/:id', requireAuth, requirePerm('results:read'), (req, res) => {
    const st = studyOwned(req, res); if (!st) return;
    const cfg = JSON.parse(st.config), target = req.query.target != null && req.query.target !== '' ? Number(req.query.target) : undefined;
    if (target !== undefined && !(target >= 0 && target <= 1)) return res.status(400).json({ error: 'target must be between 0 and 1' });
    const runs = db.prepare("SELECT variant, config, result FROM experiments WHERE study_id=? AND status='completed'").all(st.id).map((r) => ({ variant: r.variant, seed: JSON.parse(r.config).seed, result: JSON.parse(r.result) }));
    res.json({ id: st.id, name: st.name, preset: st.preset, owner: st.owner_name, ownerId: st.user_id, seeds: st.seeds, config: cfg.base, note: PRESETS[st.preset]?.note, counts: studyCounts(st.id),
      stats: studyStats(runs, cfg.variants, st.seeds, target), source: 'generated' });
  });
  app.post('/api/studies/:id/cancel', ...runPerm, (req, res) => {
    const st = studyOwned(req, res); if (!st) return;
    if (st.user_id !== req.user.id && !can(req.user.role, 'experiments:manage_all')) return res.status(403).json({ error: 'Forbidden' });
    let n = 0; for (const e of db.prepare(`SELECT id FROM experiments WHERE study_id=? AND status IN (${running.map(() => '?').join(',')})`).all(st.id, ...running)) n += runner.cancel(e.id) ? 1 : 0;
    audit(req, 'study_cancelled', req.user.id, `#${st.id} ${n} runs`); res.json({ ok: true, cancelled: n });
  });
  app.delete('/api/studies/:id', ...runPerm, (req, res) => {
    const st = studyOwned(req, res); if (!st) return;
    if (st.user_id !== req.user.id && !can(req.user.role, 'experiments:manage_all')) return res.status(403).json({ error: 'Forbidden' });
    if (Object.keys(studyCounts(st.id)).some((k) => running.includes(k))) return res.status(409).json({ error: 'Cancel the study first' });
    db.transaction(() => { db.prepare('DELETE FROM experiments WHERE study_id=?').run(st.id); db.prepare('DELETE FROM studies WHERE id=?').run(st.id); })();
    audit(req, 'study_deleted', req.user.id, `#${st.id}`); res.json({ ok: true });
  });

  // ---- Detect: score user-entered records with a trained model
  const detectLimiter = rateLimit({ windowMs: 15 * 60_000, limit: opts.detectLimit ?? 120, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many analyses. Try again later.' } });
  const modelRow = (id) => { const r = db.prepare("SELECT * FROM experiments WHERE id=? AND status='completed' AND study_id IS NULL").get(Number(id)); return r && hasModel(r.id) ? r : null; };
  const benignOf = (classes) => classes.find((c) => ['benign', 'normal'].includes(c.toLowerCase()));
  app.get('/api/models', requireAuth, requirePerm('results:read'), (_req, res) => {
    const list = db.prepare("SELECT * FROM experiments WHERE status='completed' AND study_id IS NULL ORDER BY id DESC LIMIT 100").all().filter((r) => hasModel(r.id)).map((r) => {
      const e = shape(r), x = JSON.parse(r.result); return { id: r.id, name: r.name, method: e.config.method, skew: e.config.skew, dataset: e.config.datasetName || 'NSL-KDD', macroF1: x.test.macro_f1, classes: x.classes, finishedAt: r.finished_at };
    });
    res.json({ models: list });
  });
  app.get('/api/models/:id/schema', requireAuth, requirePerm('results:read'), (req, res) => {
    const r = modelRow(req.params.id); if (!r) return res.status(404).json({ error: 'No saved model for this experiment' });
    const P = JSON.parse(fs.readFileSync(path.join(modelDir(r.id), 'prep.json'), 'utf8'));
    let examples = [];
    if (P.meta?.dataset === 'nsl-kdd') { try { examples = JSON.parse(fs.readFileSync(new URL('../ml/nsl_examples.json', import.meta.url), 'utf8')).examples; } catch { /* optional */ } }
    res.json({ id: r.id, name: r.name, classes: P.classes, benign: benignOf(P.classes) ?? null, dataset: P.meta?.dataset || 'custom',
      numeric: P.numeric.map((f) => ({ name: f.name, mean: f.mean })), categorical: P.categorical, examples });
  });
  app.post('/api/detect', requireAuth, requirePerm('results:read'), detectLimiter, express.json({ limit: '2mb' }), async (req, res) => {
    const b = parse(z.object({ modelId: z.number().int().positive(), records: z.array(z.record(z.string().max(80), z.union([z.string().max(200), z.number(), z.null()]))
      .refine((o) => Object.keys(o).length <= 200, 'too many fields in one record')).min(1, 'Enter at least one record').max(1000, 'At most 1000 records per analysis') }), req.body, res);
    if (!b) return;
    const r = modelRow(b.modelId); if (!r) return res.status(404).json({ error: 'No saved model for this experiment' });
    let out; try { out = await predictRecords(r.id, b.records); } catch (e) { return res.status(502).json({ error: e.message }); }
    const benign = benignOf(out.classes), by = Object.fromEntries(out.classes.map((c) => [c, 0])); let errors = 0;
    for (const x of out.results) x.error ? errors++ : by[x.class]++;
    const scored = out.results.length - errors, alerts = benign ? scored - by[benign] : null;
    const summary = { total: out.results.length, scored, errors, byClass: by, alerts, benign: benign ?? null };
    const hid = db.prepare('INSERT INTO predictions (user_id,experiment_id,model_name,n_records,n_errors,summary,created_at) VALUES (?,?,?,?,?,?,?)').run(req.user.id, r.id, r.name, out.results.length, errors, JSON.stringify(summary), now()).lastInsertRowid;
    audit(req, 'detect', req.user.id, `model #${r.id}, ${out.results.length} records`); // only counts are stored; the records themselves are never saved
    res.json({ historyId: hid, classes: out.classes, summary, results: out.results });
  });
  app.get('/api/detect/history', requireAuth, requirePerm('results:read'), (req, res) => res.json({ history: db.prepare('SELECT * FROM predictions WHERE user_id=? ORDER BY id DESC LIMIT 20').all(req.user.id)
    .map((h) => ({ id: h.id, modelId: h.experiment_id, model: h.model_name, records: h.n_records, errors: h.n_errors, summary: JSON.parse(h.summary), createdAt: h.created_at })) }));
  app.locals.runner = runner;

  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { maxAge: isProd ? '1h' : 0, etag: true }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  // Page URLs (/login, /app/experiments/12, ...) all get the app shell; the client router draws the page.
  // Known pages answer 200, anything else answers 404 (and the shell shows its "page not found" view).
  const INDEX = fileURLToPath(new URL('../public/index.html', import.meta.url));
  const PAGES = /^\/(login|register|forgot|reset|verify|review|app|dashboard)(\/.*)?$/;
  app.get('*', (req, res, next) => {
    if (path.extname(req.path) || !req.accepts('html')) return next(); // missing files and non-HTML requests get the plain 404 below
    res.set('Cache-Control', 'no-cache');
    res.status(req.path === '/' || PAGES.test(req.path) ? 200 : 404).sendFile(INDEX, { dotfiles: 'allow' });
  });
  app.use((err, _req, res, _next) => { console.error(err); res.status(err.status || 500).json({ error: err.status === 413 ? `File too large (limit ${MAX_UPLOAD_MB} MB)` : err.status === 400 ? 'Bad request' : 'Internal server error' }); });
  return app;
}

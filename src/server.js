import 'dotenv/config';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { openDb } from './db.js';
import { createApp } from './app.js';

const db = openDb();

// Seed initial admin once
if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
  db.prepare('INSERT INTO users (email,name,password_hash,role,email_verified,created_at) VALUES (?,?,?,?,1,?)')
    .run(email, 'Administrator', bcrypt.hashSync(password, 12), 'admin', Date.now());
  console.log(`\nInitial admin created: ${email}`);
  if (generated) console.log(`Generated password (shown once): ${password}\n`);
}

// Purge expired sessions hourly
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(Date.now());
  db.prepare('DELETE FROM outbox WHERE created_at < ?').run(Date.now() - 24 * 3600_000);
}, 3600_000).unref();

if (process.env.NODE_ENV === 'production') {
  if (!process.env.SMTP_URL) console.warn('WARNING: SMTP_URL is not set; verification and reset emails will not reach users.');
  if (!(process.env.APP_URL || '').startsWith('https://')) console.warn('WARNING: APP_URL should be an https:// URL in production.');
}
const port = Number(process.env.PORT) || 4000;
const host = process.env.HOST || '0.0.0.0'; // 0.0.0.0 so VS Code port-forwarding, Docker and LAN devices can reach it
const app = createApp(db);
const server = app.listen(port, host, () => {
  const shown = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`\nADA-FedAvg is running`);
  console.log(`  Local:    http://${shown}:${port}`);
  console.log(`  Health:   http://${shown}:${port}/api/health`);
  console.log(`  Mode:     ${process.env.NODE_ENV || 'development'}\n`);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\nPort ${port} is already in use. Stop the other process or set PORT in .env (e.g. PORT=4001).\n`);
  else console.error(e);
  process.exit(1);
});

// Graceful shutdown: stop accepting requests, stop the Python worker, close SQLite (flushes the WAL).
let closing = false;
function shutdown(signal) {
  if (closing) return; closing = true;
  console.log(`\n${signal} received, shutting down...`);
  app.locals.runner?.shutdown?.();
  server.close(() => { try { db.close(); } catch { /* ignore */ } process.exit(0); });
  setTimeout(() => process.exit(0), 8000).unref(); // do not hang on keep-alive connections
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));

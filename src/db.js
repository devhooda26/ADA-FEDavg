import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file = process.env.DB_PATH || './data/app.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','researcher','viewer')),
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS datasets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      owner_name TEXT NOT NULL,
      name TEXT NOT NULL,
      file_id TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      rows INTEGER NOT NULL,
      profile TEXT NOT NULL,
      label_col TEXT,
      class_map TEXT,
      test_frac REAL NOT NULL DEFAULT 0.2,
      max_rows INTEGER NOT NULL DEFAULT 200000,
      status TEXT NOT NULL DEFAULT 'uploaded',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS studies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      owner_name TEXT NOT NULL,
      name TEXT NOT NULL,
      preset TEXT NOT NULL,
      config TEXT NOT NULL,
      seeds INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS experiments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      owner_name TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      progress REAL NOT NULL DEFAULT 0,
      message TEXT,
      live TEXT,
      result TEXT,
      created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      experiment_id INTEGER NOT NULL,
      model_name TEXT NOT NULL,
      n_records INTEGER NOT NULL,
      n_errors INTEGER NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      event TEXT NOT NULL,
      detail TEXT,
      ip TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === 'email_verified'))
    db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1'); // existing accounts stay verified
  const ecols = db.prepare('PRAGMA table_info(experiments)').all().map((c) => c.name);
  if (!ecols.includes('study_id')) db.exec('ALTER TABLE experiments ADD COLUMN study_id INTEGER');
  if (!ecols.includes('variant')) db.exec('ALTER TABLE experiments ADD COLUMN variant TEXT');
  return db;
}

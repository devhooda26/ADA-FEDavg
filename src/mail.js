import crypto from 'node:crypto';

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// SMTP when SMTP_URL is set (via nodemailer). Otherwise emails go to an outbox table + server console (development only).
export function makeMailer(db, { smtpUrl = process.env.SMTP_URL, from = process.env.MAIL_FROM || 'ADA-FedAvg <no-reply@localhost>' } = {}) {
  let transport = null;
  return {
    mode: smtpUrl ? 'smtp' : 'outbox',
    async send(to, subject, body) {
      if (smtpUrl) {
        if (!transport) transport = (await import('nodemailer')).default.createTransport(smtpUrl);
        await transport.sendMail({ from, to, subject, text: body });
        return 'smtp';
      }
      db.prepare('INSERT INTO outbox (to_email,subject,body,created_at) VALUES (?,?,?,?)').run(to, subject, body, Date.now());
      console.log(`\n[outbox] To: ${to}\n[outbox] ${subject}\n${body}\n`);
      return 'outbox';
    },
  };
}

export function issueToken(db, userId, kind, ttlMs) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM tokens WHERE user_id=? AND kind=?').run(userId, kind);
  db.prepare('INSERT INTO tokens (token_hash,user_id,kind,expires_at) VALUES (?,?,?,?)').run(sha(token), userId, kind, Date.now() + ttlMs);
  return token;
}

// Returns user id and consumes the token (single use), or null.
export function consumeToken(db, token, kind) {
  const row = db.prepare('SELECT * FROM tokens WHERE token_hash=? AND kind=?').get(sha(String(token)), kind);
  if (!row) return null;
  db.prepare('DELETE FROM tokens WHERE token_hash=?').run(row.token_hash);
  return row.expires_at > Date.now() ? row.user_id : null;
}

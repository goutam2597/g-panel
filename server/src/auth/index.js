import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { verifyPassword, token } from '../lib/passwords.js';

// ---- login rate limiting (in-memory) ----
const attempts = new Map(); // ip -> {count, lockedUntil}

export function loginAllowed(ip) {
  const rec = attempts.get(ip);
  if (!rec) return true;
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) return false;
  return true;
}

export function recordLoginFailure(ip) {
  const rec = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= config.limits.loginAttempts) {
    rec.lockedUntil = Date.now() + config.limits.loginLockMinutes * 60 * 1000;
    rec.count = 0;
  }
  attempts.set(ip, rec);
}

export function recordLoginSuccess(ip) {
  attempts.delete(ip);
}

// ---- sessions ----
export function createSession(userId, ip, ua, impersonatedBy = null) {
  const t = token();
  const csrf = token(16);
  const now = Date.now();
  const expiresAt = now + config.session.ttlHours * 3600 * 1000;
  db.prepare(
    'INSERT INTO sessions (token, user_id, impersonated_by, csrf, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(t, userId, impersonatedBy, csrf, now, expiresAt, ip || null, ua ? String(ua).slice(0, 200) : null);
  return { token: t, csrf, expiresAt };
}

export function destroySession(t) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
}

export function destroyUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function getSession(t) {
  if (!t) return null;
  const row = db
    .prepare(
      `SELECT s.token, s.csrf, s.expires_at, s.impersonated_by,
              u.id AS user_id, u.username, u.email, u.role, u.suspended
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(t);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    destroySession(t);
    return null;
  }
  if (row.suspended) return null;
  return row;
}

export function authenticate(username, password) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!row) {
    // constant-ish time: still run a scrypt verify against a dummy hash
    verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    return null;
  }
  if (row.suspended) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return row;
}

// ---- audit ----
export function audit(actor, action, target = null, detail = null, ip = null) {
  db.prepare('INSERT INTO audit_log (ts, actor, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), String(actor).slice(0, 100), String(action).slice(0, 100), target ? String(target).slice(0, 200) : null, detail ? String(detail).slice(0, 1000) : null, ip);
}

// ---- fastify decorators used as preHandlers ----
export function requireAuth(request, reply, done) {
  const s = request.gpanelSession;
  if (!s) {
    reply.code(401).send({ error: 'Not authenticated' });
    return;
  }
  done();
}

export function requireAdmin(request, reply, done) {
  const s = request.gpanelSession;
  if (!s) {
    reply.code(401).send({ error: 'Not authenticated' });
    return;
  }
  if (s.role !== 'admin') {
    reply.code(403).send({ error: 'Administrator access required' });
    return;
  }
  done();
}

export function csrfCheck(request, reply, done) {
  // Only for mutating verbs. Login is exempt (no session yet — Origin check
  // plus rate limiting cover it; the SPA fetches the token from /auth/login).
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return done();
  if (request.url.split('?')[0] === '/api/v1/auth/login') return done();
  const s = request.gpanelSession;
  const header = request.headers['x-csrf-token'];
  if (!s || !header || !crypto.timingSafeEqual(Buffer.from(String(header)), Buffer.from(s.csrf))) {
    reply.code(403).send({ error: 'CSRF token missing or invalid' });
    return;
  }
  done();
}

export function originCheck(request, reply, done) {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return done();
  const origin = request.headers.origin;
  if (origin) {
    try {
      const o = new URL(origin);
      if (o.host !== request.headers.host) {
        reply.code(403).send({ error: 'Cross-origin request rejected' });
        return;
      }
    } catch {
      reply.code(403).send({ error: 'Invalid origin' });
      return;
    }
  }
  done();
}

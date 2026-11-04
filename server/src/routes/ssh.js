import { db } from '../db/index.js';
import { audit } from '../auth/index.js';
import { sys } from '../services/index.js';
import crypto from 'node:crypto';

function fingerprintKey(pub) {
  // RFC4716-style SHA256 fingerprint of the base64 body
  try {
    const parts = pub.trim().split(/\s+/);
    const b64 = parts.length > 1 ? parts[1] : pub;
    const hash = crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '');
    return `SHA256:${hash}`;
  } catch {
    return 'SHA256:unknown';
  }
}

export default async function (app) {
  app.get('/keys', { preHandler: [app.requireAuth] }, async (request) => {
    const s = request.gpanelSession;
    const userId = s.role === 'admin' && !s.impersonated_by && request.query.user ? Number(request.query.user) : s.user_id;
    const rows = db.prepare('SELECT id, name, public_key, fingerprint, added_at FROM ssh_keys WHERE user_id = ? ORDER BY added_at DESC').all(userId);
    const user = db.prepare('SELECT username, ssh_enabled FROM users WHERE id = ?').get(userId);
    return { keys: rows, ssh_enabled: Boolean(user?.ssh_enabled) };
  });

  app.post('/keys', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const s = request.gpanelSession;
    const userId = s.role === 'admin' && !s.impersonated_by && request.body?.user_id ? Number(request.body.user_id) : s.user_id;
    const name = String(request.body?.name || '').trim().slice(0, 60);
    const pub = String(request.body?.public_key || '').trim();

    if (!name) { reply.code(400).send({ error: 'Key name required' }); return; }
    const valid = /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/=]+\s*(\S.*)?$/.test(pub);
    if (!valid) { reply.code(400).send({ error: 'Invalid public key — paste an OpenSSH-format public key line' }); return; }

    const fp = fingerprintKey(pub);
    if (db.prepare('SELECT id FROM ssh_keys WHERE fingerprint = ? AND user_id = ?').get(fp, userId)) {
      reply.code(409).send({ error: 'This key is already added' });
      return;
    }
    const res = db.prepare('INSERT INTO ssh_keys (user_id, name, public_key, fingerprint, added_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, name, pub, fp, Date.now());
    await resync(userId).catch((e) => {
      db.prepare('DELETE FROM ssh_keys WHERE id = ?').run(Number(res.lastInsertRowid));
      reply.code(500).send({ error: `authorized_keys sync failed: ${e.message}` });
      return;
    });
    audit(s.username, 'ssh.key.add', name, fp, request.ip);
    return { id: Number(res.lastInsertRowid), fingerprint: fp };
  });

  app.delete('/keys/:id', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const s = request.gpanelSession;
    const userId = s.role === 'admin' && !s.impersonated_by ? (await keyOwner(request, reply)) : s.user_id;
    if (!userId) return;
    const key = db.prepare('SELECT * FROM ssh_keys WHERE id = ? AND user_id = ?').get(request.params.id, userId);
    if (!key) { reply.code(404).send({ error: 'Key not found' }); return; }
    db.prepare('DELETE FROM ssh_keys WHERE id = ?').run(key.id);
    await resync(userId).catch(() => {});
    audit(s.username, 'ssh.key.delete', key.name, null, request.ip);
    return { ok: true };
  });

  // enable/disable shell access
  app.post('/shell', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const s = request.gpanelSession;
    if (s.role !== 'admin' || s.impersonated_by) {
      reply.code(403).send({ error: 'Only administrators change shell access' });
      return;
    }
    const userId = Number(request.body?.user_id);
    const enabled = Boolean(request.body?.enabled);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) { reply.code(404).send({ error: 'User not found' }); return; }
    db.prepare('UPDATE users SET ssh_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, user.id);
    await sys.system.setShell(user.username, enabled).catch((e) => {
      reply.code(500).send({ error: e.message });
      return;
    });
    audit(s.username, 'ssh.shell', user.username, enabled ? 'enabled' : 'disabled', request.ip);
    return { ok: true };
  });
}

async function keyOwner(request, reply) {
  const key = db.prepare('SELECT user_id FROM ssh_keys WHERE id = ?').get(request.params.id);
  if (!key) { reply.code(404).send({ error: 'Key not found' }); return null; }
  return key.user_id;
}

async function resync(userId) {
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  const keys = db.prepare('SELECT public_key FROM ssh_keys WHERE user_id = ?').all(userId).map((r) => r.public_key);
  await sys.ssh.syncAuthorizedKeys(user.username, keys);
}

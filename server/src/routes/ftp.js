import { db } from '../db/index.js';
import { audit } from '../auth/index.js';
import { quotaCheckFor } from '../lib/quota.js';
import { sys } from '../services/index.js';
import { hashPassword, generatePassword } from '../lib/passwords.js';

export default async function (app) {
  app.get('/', { preHandler: [app.requireAuth] }, async (request) => {
    const s = request.gpanelSession;
    const admin = s.role === 'admin' && !s.impersonated_by;
    const rows = admin && !request.query.user
      ? db.prepare(`
          SELECT f.*, u.username AS owner FROM ftp_accounts f JOIN users u ON u.id = f.user_id ORDER BY f.username`).all()
      : db.prepare('SELECT f.*, f.user_id AS owner_id FROM ftp_accounts f WHERE f.user_id = ? ORDER BY f.username')
          .all(admin ? Number(request.query.user) : s.user_id);
    return { accounts: rows };
  });

  app.post('/', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const s = request.gpanelSession;
    const b = request.body || {};
    const userId = s.role === 'admin' && !s.impersonated_by && b.user_id ? Number(b.user_id) : s.user_id;
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!owner) { reply.code(400).send({ error: 'Owner not found' }); return; }

    const pkg = owner.package_id ? db.prepare('SELECT * FROM packages WHERE id = ?').get(owner.package_id) : null;
    const current = db.prepare('SELECT COUNT(*) c FROM ftp_accounts WHERE user_id = ?').get(owner.id).c;
    const q = quotaCheckFor(owner, pkg, 'ftp', current);
    if (!q.ok) { reply.code(403).send({ error: q.error }); return; }

    const domain = db.prepare('SELECT * FROM domains WHERE domain = ? AND user_id = ?').get(String(b.domain || ''), owner.id);
    if (!domain) { reply.code(400).send({ error: 'You do not own this domain' }); return; }

    const username = String(b.username || '').toLowerCase().trim();
    if (!new RegExp(`^${owner.username}_[a-z0-9_-]{2,32}$`).test(username)) {
      reply.code(400).send({ error: `FTP login must look like "${owner.username}_<name>" (letters, digits, dashes)` });
      return;
    }
    if (db.prepare('SELECT id FROM ftp_accounts WHERE username = ?').get(username)) {
      reply.code(409).send({ error: 'FTP login already exists' });
      return;
    }
    const directory = String(b.directory || '/').startsWith('/') ? String(b.directory) : '/' + b.directory;
    const password = b.password || generatePassword(14);

    const res = db.prepare(
      'INSERT INTO ftp_accounts (user_id, username, password, domain, directory, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(owner.id, username, hashPassword(password), domain.domain, directory, Date.now());

    await resyncFtp(owner.id, { [username]: password }).catch((e) => {
      db.prepare('DELETE FROM ftp_accounts WHERE id = ?').run(Number(res.lastInsertRowid));
      reply.code(500).send({ error: `FTP sync failed: ${e.message}` });
      return;
    });
    audit(s.username, 'ftp.account.create', username, `domain: ${domain.domain}`, request.ip);
    return { id: Number(res.lastInsertRowid), initial_password: b.password ? undefined : password };
  });

  app.delete('/:id', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const acc = await ownedFtp(request, reply);
    if (!acc) return;
    db.prepare('DELETE FROM ftp_accounts WHERE id = ?').run(acc.id);
    await resyncFtp(acc.user_id, {}).catch(() => {});
    audit(request.gpanelSession.username, 'ftp.account.delete', acc.username, null, request.ip);
    return { ok: true };
  });

  app.post('/:id/reset-password', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const acc = await ownedFtp(request, reply);
    if (!acc) return;
    const password = request.body?.password || generatePassword(14);
    db.prepare('UPDATE ftp_accounts SET password = ? WHERE id = ?').run(hashPassword(password), acc.id);
    await resyncFtp(acc.user_id, { [acc.username]: password }).catch((e) => {
      reply.code(500).send({ error: `FTP sync failed: ${e.message}` });
      return;
    });
    audit(request.gpanelSession.username, 'ftp.account.password', acc.username, null, request.ip);
    return { ok: true, new_password: request.body?.password ? undefined : password };
  });
}

async function ownedFtp(request, reply) {
  const s = request.gpanelSession;
  const acc = db.prepare('SELECT * FROM ftp_accounts WHERE id = ?').get(request.params.id);
  if (!acc) { reply.code(404).send({ error: 'FTP account not found' }); return null; }
  const admin = s.role === 'admin' && !s.impersonated_by;
  if (!admin && acc.user_id !== s.user_id) { reply.code(403).send({ error: 'Not your FTP account' }); return null; }
  return acc;
}

/** Rebuild the vsftpd virtual-user db + per-user confs for a panel user. */
async function resyncFtp(userId, plaintextFor = {}) {
  const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  const rows = db.prepare('SELECT username, domain, directory FROM ftp_accounts WHERE user_id = ?').all(userId)
    .map((r) => ({ ...r, _owner: owner.username }));
  await sys.ftp.syncUsers(rows, plaintextFor);
}

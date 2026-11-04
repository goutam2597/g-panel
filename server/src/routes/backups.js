import { db } from '../db/index.js';
import { audit } from '../auth/index.js';
import { sys } from '../services/index.js';
import { formatBytes } from '../lib/quota.js';

export default async function (app) {
  app.get('/', { preHandler: [app.requireAuth] }, async (request) => {
    const s = request.gpanelSession;
    const admin = s.role === 'admin' && !s.impersonated_by;
    const rows = admin && !request.query.user
      ? db.prepare('SELECT b.*, u.username AS owner FROM backups b JOIN users u ON u.id = b.user_id ORDER BY b.created_at DESC').all()
      : db.prepare('SELECT * FROM backups WHERE user_id = ? ORDER BY created_at DESC').all(admin ? Number(request.query.user) : s.user_id);
    return {
      backups: rows.map((r) => ({ ...r, size_human: formatBytes(r.size_bytes) })),
      retention: Number(await import('../db/index.js').then((m) => m.getSetting('backup_retention')) || 5)
    };
  });

  app.post('/create', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const s = request.gpanelSession;
    const userId = s.role === 'admin' && !s.impersonated_by && request.body?.user_id ? Number(request.body.user_id) : s.user_id;
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!owner) { reply.code(400).send({ error: 'Owner not found' }); return; }

    const databases = db.prepare('SELECT name FROM databases WHERE user_id = ?').all(owner.id).map((r) => r.name);
    const mailDomains = db.prepare(
      'SELECT DISTINCT d.domain FROM mail_domains md JOIN domains d ON d.id = md.domain_id WHERE d.user_id = ?'
    ).all(owner.id).map((r) => r.domain);

    try {
      const result = await sys.backup.create(owner.username, { databases, mailDomains });
      db.prepare('INSERT INTO backups (user_id, filename, size_bytes, includes, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(owner.id, result.filename, result.size, 'all', 'done', Date.now());
      await pruneRetention(owner.id);
      audit(s.username, 'backup.create', owner.username, result.filename, request.ip);
      return { ok: true, filename: result.filename, size: result.size };
    } catch (e) {
      reply.code(500).send({ error: `Backup failed: ${e.message}` });
      return;
    }
  });

  app.get('/:id/download', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const s = request.gpanelSession;
    const admin = s.role === 'admin' && !s.impersonated_by;
    const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(request.params.id);
    if (!row) { reply.code(404).send({ error: 'Backup not found' }); return; }
    if (!admin && row.user_id !== s.user_id) { reply.code(403).send({ error: 'Not your backup' }); return; }
    const filepath = sys.backup.filepath(
      db.prepare('SELECT username FROM users WHERE id = ?').get(row.user_id).username,
      row.filename
    );
    if (admin || row.user_id === s.user_id) {
      audit(s.username, 'backup.download', row.filename, null, request.ip);
    }
    if (require_dev()) {
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-disposition', `attachment; filename="${row.filename}"`);
      return `Simulated backup archive for ${row.filename}`;
    }
    const fs = await import('node:fs');
    if (!fs.existsSync(filepath)) { reply.code(404).send({ error: 'Backup file missing on disk' }); return; }
    reply.header('content-type', 'application/gzip');
    reply.header('content-disposition', `attachment; filename="${row.filename}"`);
    return reply.send(fs.createReadStream(filepath));
  });

  app.delete('/:id', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const s = request.gpanelSession;
    const admin = s.role === 'admin' && !s.impersonated_by;
    const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(request.params.id);
    if (!row) { reply.code(404).send({ error: 'Backup not found' }); return; }
    if (!admin && row.user_id !== s.user_id) { reply.code(403).send({ error: 'Not your backup' }); return; }
    await sys.backup.remove(
      db.prepare('SELECT username FROM users WHERE id = ?').get(row.user_id).username,
      row.filename
    ).catch(() => {});
    db.prepare('DELETE FROM backups WHERE id = ?').run(row.id);
    audit(s.username, 'backup.delete', row.filename, null, request.ip);
    return { ok: true };
  });
}

function require_dev() {
  return process.env.GPANEL_DEV === '1' || process.env.GPANEL_DEV === 'true';
}

async function pruneRetention(userId) {
  const { getSetting } = await import('../db/index.js');
  const keep = Number(getSetting('backup_retention') || 5);
  const rows = db.prepare('SELECT id FROM backups WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  for (const row of rows.slice(keep)) {
    db.prepare('DELETE FROM backups WHERE id = ?').run(row.id);
  }
}

import { db } from '../db/index.js';
import { audit } from '../auth/index.js';

export default async function (app) {
  app.get('/', { preHandler: [app.requireAuth] }, async () => {
    const rows = db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM users u WHERE u.package_id = p.id) AS user_count
      FROM packages p ORDER BY p.name
    `).all();
    return { packages: rows };
  });

  app.post('/', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const b = request.body || {};
    if (!b.name || !/^[A-Za-z0-9 _-]{2,40}$/.test(b.name)) {
      reply.code(400).send({ error: 'Package name must be 2-40 characters' });
      return;
    }
    const exists = db.prepare('SELECT id FROM packages WHERE name = ?').get(b.name);
    if (exists) { reply.code(409).send({ error: 'A package with this name exists' }); return; }

    const res = db.prepare(`
      INSERT INTO packages (name, max_domains, max_disk_mb, max_mailboxes, max_databases, max_ftp, max_cron, max_bandwidth_gb, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.name.trim(),
      intOr(b.max_domains, 1), intOr(b.max_disk_mb, 1024), intOr(b.max_mailboxes, 5),
      intOr(b.max_databases, 2), intOr(b.max_ftp, 2), intOr(b.max_cron, 2), intOr(b.max_bandwidth_gb, 0),
      Date.now()
    );
    audit(request.gpanelSession.username, 'package.create', b.name, null, request.ip);
    return { id: Number(res.lastInsertRowid) };
  });

  app.put('/:id', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(request.params.id);
    if (!pkg) { reply.code(404).send({ error: 'Package not found' }); return; }
    const b = request.body || {};
    db.prepare(`
      UPDATE packages SET name = ?, max_domains = ?, max_disk_mb = ?, max_mailboxes = ?,
        max_databases = ?, max_ftp = ?, max_cron = ?, max_bandwidth_gb = ? WHERE id = ?
    `).run(
      (b.name || pkg.name).trim(),
      intOr(b.max_domains, pkg.max_domains), intOr(b.max_disk_mb, pkg.max_disk_mb),
      intOr(b.max_mailboxes, pkg.max_mailboxes), intOr(b.max_databases, pkg.max_databases),
      intOr(b.max_ftp, pkg.max_ftp), intOr(b.max_cron, pkg.max_cron),
      intOr(b.max_bandwidth_gb, pkg.max_bandwidth_gb),
      pkg.id
    );
    audit(request.gpanelSession.username, 'package.update', pkg.name, null, request.ip);
    return { ok: true };
  });

  app.delete('/:id', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(request.params.id);
    if (!pkg) { reply.code(404).send({ error: 'Package not found' }); return; }
    const inUse = db.prepare('SELECT COUNT(*) c FROM users WHERE package_id = ?').get(pkg.id).c;
    if (inUse > 0) { reply.code(409).send({ error: `${inUse} user(s) still assigned to this package` }); return; }
    db.prepare('DELETE FROM packages WHERE id = ?').run(pkg.id);
    audit(request.gpanelSession.username, 'package.delete', pkg.name, null, request.ip);
    return { ok: true };
  });
}

function intOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

import { db } from '../db/index.js';
import { audit, createSession, destroyUserSessions, destroySession } from '../auth/index.js';
import { validateUsername, validateEmail } from '../lib/validate.js';
import { hashPassword, generatePassword } from '../lib/passwords.js';
import { provisionUserEnvironment, deprovisionUserEnvironment } from '../services/sites.js';
import { sys } from '../services/index.js';
import { quotaSummary } from '../lib/quota.js';
import { config } from '../config.js';

export default async function (app) {
  // list (admin: all, user: self)
  app.get('/', { preHandler: [app.requireAuth] }, async (request) => {
    const s = request.gpanelSession;
    if (s.role !== 'admin' || s.impersonated_by) {
      const me = db.prepare('SELECT id, username, email, role, package_id, ssh_enabled, suspended, created_at FROM users WHERE id = ?').get(s.user_id);
      return { users: [me] };
    }
    const rows = db.prepare(`
      SELECT u.id, u.username, u.email, u.role, u.package_id, u.ssh_enabled, u.suspended, u.created_at,
             p.name AS package_name, p.max_domains, p.max_disk_mb,
             (SELECT COUNT(*) FROM domains d WHERE d.user_id = u.id) AS domain_count
      FROM users u LEFT JOIN packages p ON p.id = u.package_id
      ORDER BY u.created_at DESC
    `).all();
    return { users: rows };
  });

  // create (admin)
  app.post('/', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const b = request.body || {};
    const username = String(b.username || '').toLowerCase().trim();
    const err = validateUsername(username) || validateEmail(b.email);
    if (err) { reply.code(400).send({ error: err }); return; }
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      reply.code(409).send({ error: 'Username already exists' });
      return;
    }
    const pkg = b.package_id ? db.prepare('SELECT * FROM packages WHERE id = ?').get(b.package_id) : null;
    if (b.package_id && !pkg) { reply.code(400).send({ error: 'Unknown package' }); return; }

    const password = b.password || generatePassword(14);
    const res = db.prepare(
      'INSERT INTO users (username, email, password_hash, role, package_id, ssh_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(username, b.email.trim(), hashPassword(password), 'user', pkg?.id || null, b.ssh_enabled === false ? 0 : 1, Date.now());

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(res.lastInsertRowid));
    try {
      await provisionUserEnvironment(user, 8);
    } catch (e) {
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      reply.code(500).send({ error: `Provisioning failed: ${e.message}` });
      return;
    }
    audit(request.gpanelSession.username, 'user.create', username, `package: ${pkg?.name || 'none'}`, request.ip);
    return { id: user.id, initial_password: b.password ? undefined : password };
  });

  // per-user quota usage (admin or self)
  app.get('/:id/usage', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const target = await targetUser(request, reply);
    if (!target) return;
    return usageFor(target);
  });

  // update (admin)
  app.put('/:id', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(request.params.id);
    if (!user) { reply.code(404).send({ error: 'User not found' }); return; }
    const b = request.body || {};

    if (b.email !== undefined) {
      const err = validateEmail(b.email);
      if (err) { reply.code(400).send({ error: err }); return; }
    }
    if (b.package_id !== undefined) {
      if (b.package_id === null || b.package_id === '') {
        db.prepare('UPDATE users SET package_id = NULL WHERE id = ?').run(user.id);
      } else {
        const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(b.package_id);
        if (!pkg) { reply.code(400).send({ error: 'Unknown package' }); return; }
        db.prepare('UPDATE users SET package_id = ? WHERE id = ?').run(pkg.id, user.id);
      }
    }
    if (b.email !== undefined) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(b.email.trim(), user.id);
    if (b.ssh_enabled !== undefined) {
      db.prepare('UPDATE users SET ssh_enabled = ? WHERE id = ?').run(b.ssh_enabled ? 1 : 0, user.id);
      await sys.system.setShell(user.username, Boolean(b.ssh_enabled));
    }
    if (b.suspended !== undefined) {
      db.prepare('UPDATE users SET suspended = ? WHERE id = ?').run(b.suspended ? 1 : 0, user.id);
      if (b.suspended) destroyUserSessions(user.id);
    }
    if (b.password) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), user.id);
    }
    audit(request.gpanelSession.username, 'user.update', user.username, Object.keys(b).join(','), request.ip);
    return { ok: true };
  });

  // delete (admin)
  app.delete('/:id', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(request.params.id);
    if (!user) { reply.code(404).send({ error: 'User not found' }); return; }
    if (user.role === 'admin') { reply.code(400).send({ error: 'Cannot delete an administrator here' }); return; }

    // cascade in panel db via FK; remove system artifacts explicitly
    const mailDomains = db.prepare(
      'SELECT d.domain FROM mail_domains md JOIN domains d ON d.id = md.domain_id WHERE d.user_id = ?'
    ).all(user.id);
    const versions = await sys.php.versions();

    for (const { domain } of mailDomains) await sys.mail.deprovisionDomain(domain).catch(() => {});
    const domains = db.prepare('SELECT domain FROM domains WHERE user_id = ?').all(user.id);
    for (const { domain } of domains) await sys.dns.removeZone(domain).catch(() => {});
    await sys.php.removePool(user.username, versions).catch(() => {});
    await deprovisionUserEnvironment(user).catch(() => {});

    destroyUserSessions(user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    audit(request.gpanelSession.username, 'user.delete', user.username, null, request.ip);
    return { ok: true };
  });

  // impersonate (admin) — swap session to act as the user
  app.post('/:id/impersonate', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(request.params.id);
    if (!user) { reply.code(404).send({ error: 'User not found' }); return; }
    if (user.role === 'admin') { reply.code(400).send({ error: 'Cannot impersonate an administrator' }); return; }
    destroySession(request.gpanelSession.token);
    const session = createSession(user.id, request.ip, request.headers['user-agent'], request.gpanelSession.user_id);
    reply.setCookie('gpanel_session', session.token, {
      httpOnly: true, sameSite: 'lax', secure: config.session.secureCookie, path: '/', maxAge: 12 * 3600
    });
    audit(request.gpanelSession.username, 'user.impersonate', user.username, null, request.ip);
    return { ok: true, csrf: session.csrf };
  });

  app.post('/stop-impersonating', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const s = request.gpanelSession;
    if (!s.impersonated_by) { reply.code(400).send({ error: 'Not impersonating' }); return; }
    destroySession(s.token);
    const session = createSession(s.impersonated_by, request.ip, request.headers['user-agent']);
    reply.setCookie('gpanel_session', session.token, {
      httpOnly: true, sameSite: 'lax', secure: config.session.secureCookie, path: '/', maxAge: 24 * 3600
    });
    audit(db.prepare('SELECT username FROM users WHERE id = ?').get(s.impersonated_by)?.username || 'admin', 'user.unimpersonate', s.username, null, request.ip);
    return { ok: true, csrf: session.csrf };
  });
}

async function targetUser(request, reply) {
  const s = request.gpanelSession;
  const id = s.role === 'admin' && !s.impersonated_by ? Number(request.params.id) : s.user_id;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) { reply.code(404).send({ error: 'User not found' }); return null; }
  return user;
}

export async function usageFor(user) {
  const pkg = user.package_id ? db.prepare('SELECT * FROM packages WHERE id = ?').get(user.package_id) : null;
  const domains = db.prepare('SELECT COUNT(*) c FROM domains WHERE user_id = ?').get(user.id).c;
  const mailboxes = db.prepare(
    'SELECT COUNT(*) c FROM mail_accounts ma JOIN mail_domains md ON md.id = ma.mail_domain_id JOIN domains d ON d.id = md.domain_id WHERE d.user_id = ?'
  ).get(user.id).c;
  const databases = db.prepare('SELECT COUNT(*) c FROM databases WHERE user_id = ?').get(user.id).c;
  const ftp = db.prepare('SELECT COUNT(*) c FROM ftp_accounts WHERE user_id = ?').get(user.id).c;
  const cron = db.prepare('SELECT COUNT(*) c FROM cron_jobs WHERE user_id = ?').get(user.id).c;
  const diskBytes = await sys.system.diskUsageHome(user.username);
  const diskMb = Math.round(diskBytes / 1024 / 1024);
  return {
    user: { id: user.id, username: user.username },
    package: pkg ? { id: pkg.id, name: pkg.name } : null,
    items: quotaSummary(pkg, { domains, disk_mb: diskMb, mailboxes, databases, ftp, cron, bandwidth_gb: 0 }),
    raw: { domains, mailboxes, databases, ftp, cron, disk_mb: diskMb }
  };
}

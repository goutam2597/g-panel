import { db, getSetting } from '../db/index.js';
import { audit } from '../auth/index.js';
import { validateMailboxLocalPart } from '../lib/validate.js';
import { quotaCheckFor } from '../lib/quota.js';
import { sys } from '../services/index.js';
import { mailPasswordHash, generatePassword } from '../lib/passwords.js';
import { bumpAndWriteZone } from '../services/sites.js';

export default async function (app) {
  // list mail domains (scoped)
  app.get('/', { preHandler: [app.requireAuth] }, async (request) => {
    const s = request.gpanelSession;
    const admin = s.role === 'admin' && !s.impersonated_by;
    const rows = admin && !request.query.user
      ? db.prepare(`
          SELECT md.*, d.domain, u.username AS owner,
                 (SELECT COUNT(*) FROM mail_accounts ma WHERE ma.mail_domain_id = md.id) AS account_count
          FROM mail_domains md JOIN domains d ON d.id = md.domain_id JOIN users u ON u.id = d.user_id
          ORDER BY d.domain`).all()
      : db.prepare(`
          SELECT md.*, d.domain,
                 (SELECT COUNT(*) FROM mail_accounts ma WHERE ma.mail_domain_id = md.id) AS account_count
          FROM mail_domains md JOIN domains d ON d.id = md.domain_id
          WHERE d.user_id = ? ORDER BY d.domain`).all(admin ? Number(request.query.user) : s.user_id);
    return { mailDomains: rows };
  });

  // enable mail for a domain (generates DKIM, inserts system DNS records)
  app.post('/domains', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const s = request.gpanelSession;
    const d = db.prepare('SELECT * FROM domains WHERE id = ?').get(request.body?.domain_id);
    if (!d) { reply.code(404).send({ error: 'Domain not found' }); return; }
    const admin = s.role === 'admin' && !s.impersonated_by;
    if (!admin && d.user_id !== s.user_id) { reply.code(403).send({ error: 'Not your domain' }); return; }
    if (db.prepare('SELECT id FROM mail_domains WHERE domain_id = ?').get(d.id)) {
      reply.code(409).send({ error: 'Mail is already enabled for this domain' });
      return;
    }

    const res = db.prepare('INSERT INTO mail_domains (domain_id, created_at) VALUES (?, ?)').run(d.id, Date.now());
    const mailDomainId = Number(res.lastInsertRowid);
    try {
      const { publicKey } = await sys.mail.provisionDomain(d.domain, 'gpanel');
      if (publicKey) {
        db.prepare('UPDATE mail_domains SET dkim_public = ? WHERE id = ?').run(publicKey, mailDomainId);
      }
      // system DNS records
      const zone = db.prepare('SELECT * FROM dns_zones WHERE domain_id = ?').get(d.id);
      if (zone) {
        const serverIp = getSetting('server_ip');
        const hostname = getSetting('hostname');
        const ins = db.prepare('INSERT INTO dns_records (zone_id, name, type, value, ttl, prio, system) VALUES (?, ?, ?, ?, ?, ?, 1)');
        if (!recordExists(zone.id, 'MX')) ins.run(zone.id, '@', 'MX', `mail.${hostname || d.domain}`, 3600, 10);
        ins.run(zone.id, 'mail', 'A', serverIp, 3600, null);
        ins.run(zone.id, '@', 'TXT', `v=spf1 mx a ip4:${serverIp} ~all`, 3600, null);
        ins.run(zone.id, '_dmarc', 'TXT', `v=DMARC1; p=quarantine; rua=mailto:postmaster@${d.domain}; adkim=s; aspf=s`, 3600, null);
        if (publicKey) ins.run(zone.id, 'gpanel._domainkey', 'TXT', publicKey, 3600, null);
        await bumpAndWriteZone(d.id);
      }
    } catch (e) {
      db.prepare('DELETE FROM mail_domains WHERE id = ?').run(mailDomainId);
      reply.code(500).send({ error: `Mail provisioning failed: ${e.message}` });
      return;
    }
    audit(s.username, 'mail.domain.enable', d.domain, null, request.ip);
    return { id: mailDomainId };
  });

  // disable mail for a domain
  app.delete('/domains/:id', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const md = await ownedMailDomain(request, reply);
    if (!md) return;
    const count = db.prepare('SELECT COUNT(*) c FROM mail_accounts WHERE mail_domain_id = ?').get(md.id).c;
    if (count > 0 && request.query.force !== '1') {
      reply.code(409).send({ error: `Domain has ${count} mailbox(es). Delete them first.` });
      return;
    }
    for (const a of db.prepare('SELECT address FROM mail_accounts WHERE mail_domain_id = ?').all(md.id)) {
      const [local, dom] = a.address.split('@');
      await sys.mail.deprovisionUser(dom, local).catch(() => {});
    }
    await sys.mail.deprovisionDomain(md.domain).catch(() => {});
    db.prepare('DELETE FROM mail_domains WHERE id = ?').run(md.id);
    audit(request.gpanelSession.username, 'mail.domain.disable', md.domain, null, request.ip);
    return { ok: true };
  });

  // mailboxes of a mail domain
  app.get('/domains/:id/accounts', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const md = await ownedMailDomain(request, reply);
    if (!md) return;
    const rows = db.prepare('SELECT id, address, quota_mb, created_at FROM mail_accounts WHERE mail_domain_id = ? ORDER BY address').all(md.id);
    const usage = [];
    for (const r of rows) {
      const [local, dom] = r.address.split('@');
      usage.push(await sys.mail.mailboxUsage(dom, local).catch(() => 0));
    }
    return {
      domain: { id: md.id, domain: md.domain, dkim_selector: md.dkim_selector, dkim_public: md.dkim_public },
      accounts: rows.map((r, i) => ({ ...r, used_bytes: usage[i] }))
    };
  });

  app.post('/domains/:id/accounts', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const md = await ownedMailDomain(request, reply);
    if (!md) return;
    const s = request.gpanelSession;
    const local = String(request.body?.local || '').toLowerCase().trim();
    const err = validateMailboxLocalPart(local);
    if (err) { reply.code(400).send({ error: err }); return; }
    const address = `${local}@${md.domain}`;

    // quota: package mailboxes limit for the owner
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(
      db.prepare('SELECT user_id FROM domains WHERE domain = ?').get(md.domain).user_id
    );
    const pkg = owner?.package_id ? db.prepare('SELECT * FROM packages WHERE id = ?').get(owner.package_id) : null;
    const current = db.prepare(
      `SELECT COUNT(*) c FROM mail_accounts ma JOIN mail_domains md2 ON md2.id = ma.mail_domain_id JOIN domains d ON d.id = md2.domain_id WHERE d.user_id = ?`
    ).get(owner.id).c;
    const q = quotaCheckFor(owner, pkg, 'mailboxes', current);
    if (!q.ok) { reply.code(403).send({ error: q.error }); return; }

    if (db.prepare('SELECT id FROM mail_accounts WHERE address = ?').get(address)) {
      reply.code(409).send({ error: 'Mailbox already exists' });
      return;
    }
    const password = request.body?.password || generatePassword(14);
    db.prepare('INSERT INTO mail_accounts (mail_domain_id, address, password, quota_mb, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(md.id, address, mailPasswordHash(password), Number(request.body?.quota_mb) || 1024, Date.now());
    await sys.mail.provisionUser(md.domain, local).catch(() => {});
    audit(s.username, 'mail.account.create', address, null, request.ip);
    return { address, initial_password: request.body?.password ? undefined : password };
  });

  app.put('/domains/:id/accounts/:accountId', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const md = await ownedMailDomain(request, reply);
    if (!md) return;
    const acc = db.prepare('SELECT * FROM mail_accounts WHERE id = ? AND mail_domain_id = ?').get(request.params.accountId, md.id);
    if (!acc) { reply.code(404).send({ error: 'Mailbox not found' }); return; }
    const b = request.body || {};
    if (b.quota_mb !== undefined) {
      db.prepare('UPDATE mail_accounts SET quota_mb = ? WHERE id = ?').run(Number(b.quota_mb) || 1024, acc.id);
    }
    let new_password;
    if (b.password) {
      db.prepare('UPDATE mail_accounts SET password = ? WHERE id = ?').run(mailPasswordHash(b.password), acc.id);
    } else if (b.reset_password) {
      new_password = generatePassword(14);
      db.prepare('UPDATE mail_accounts SET password = ? WHERE id = ?').run(mailPasswordHash(new_password), acc.id);
    }
    audit(request.gpanelSession.username, 'mail.account.update', acc.address, Object.keys(b).join(','), request.ip);
    return { ok: true, new_password };
  });

  app.delete('/domains/:id/accounts/:accountId', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const md = await ownedMailDomain(request, reply);
    if (!md) return;
    const acc = db.prepare('SELECT * FROM mail_accounts WHERE id = ? AND mail_domain_id = ?').get(request.params.accountId, md.id);
    if (!acc) { reply.code(404).send({ error: 'Mailbox not found' }); return; }
    const [local, dom] = acc.address.split('@');
    db.prepare('DELETE FROM mail_accounts WHERE id = ?').run(acc.id);
    await sys.mail.deprovisionUser(dom, local).catch(() => {});
    audit(request.gpanelSession.username, 'mail.account.delete', acc.address, null, request.ip);
    return { ok: true };
  });

  // reset a mailbox password (auto-generates when none provided)
  app.post('/domains/:id/accounts/:accountId/reset-password', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const md = await ownedMailDomain(request, reply);
    if (!md) return;
    const acc = db.prepare('SELECT * FROM mail_accounts WHERE id = ? AND mail_domain_id = ?').get(request.params.accountId, md.id);
    if (!acc) { reply.code(404).send({ error: 'Mailbox not found' }); return; }
    const new_password = request.body?.password || generatePassword(14);
    db.prepare('UPDATE mail_accounts SET password = ? WHERE id = ?').run(mailPasswordHash(new_password), acc.id);
    audit(request.gpanelSession.username, 'mail.account.password', acc.address, null, request.ip);
    return { ok: true, new_password: request.body?.password ? undefined : new_password };
  });
}

function recordExists(zoneId, type) {
  return db.prepare('SELECT id FROM dns_records WHERE zone_id = ? AND type = ?').get(zoneId, type);
}

async function ownedMailDomain(request, reply) {
  const s = request.gpanelSession;
  const md = db.prepare(
    'SELECT md.*, d.domain, d.user_id AS owner_id FROM mail_domains md JOIN domains d ON d.id = md.domain_id WHERE md.id = ?'
  ).get(request.params.id);
  if (!md) { reply.code(404).send({ error: 'Mail domain not found' }); return null; }
  const admin = s.role === 'admin' && !s.impersonated_by;
  if (!admin && md.owner_id !== s.user_id) { reply.code(403).send({ error: 'Not your mail domain' }); return null; }
  return md;
}

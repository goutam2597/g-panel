import { db } from '../db/index.js';
import { audit } from '../auth/index.js';
import { sys } from '../services/index.js';

export default async function (app) {
  // certificates overview
  app.get('/', { preHandler: [app.requireAuth] }, async (request) => {
    const s = request.gpanelSession;
    const admin = s.role === 'admin' && !s.impersonated_by;
    const rows = admin && !request.query.user
      ? db.prepare('SELECT d.*, u.username AS owner FROM domains d JOIN users u ON u.id = d.user_id ORDER BY d.domain').all()
      : db.prepare('SELECT * FROM domains WHERE user_id = ? ORDER BY domain').all(admin ? Number(request.query.user) : s.user_id);

    const out = [];
    for (const d of rows) {
      const info = await sys.ssl.certInfo(d.domain).catch(() => null);
      const sslState = info ? (info.kind === 'letsencrypt' ? 'letsencrypt' : 'selfsigned') : 'none';
      if (sslState !== d.ssl_state || (info && info.expiry !== d.ssl_expiry)) {
        db.prepare('UPDATE domains SET ssl_state = ?, ssl_expiry = ? WHERE id = ?').run(sslState, info?.expiry || null, d.id);
        d.ssl_state = sslState;
        d.ssl_expiry = info?.expiry || null;
      }
      out.push({
        id: d.id,
        domain: d.domain,
        ssl_state: sslState,
        ssl_expiry: info?.expiry || null,
        issuer: info?.issuer || null,
        days_left: info?.expiry ? Math.round((info.expiry - Date.now()) / 86400000) : null,
        force_https: Boolean(d.force_https)
      });
    }
    return { certificates: out };
  });

  // issue Let's Encrypt certificate
  app.post('/:id/issue', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply);
    if (!d) return;
    const s = request.gpanelSession;
    try {
      const info = await sys.ssl.issue(d.domain, s.email);
      const kind = info?.kind || 'letsencrypt';
      db.prepare('UPDATE domains SET ssl_state = ?, ssl_expiry = ? WHERE id = ?').run(kind, info?.expiry || null, d.id);
      // rewrite vhost with cert
      const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(d.user_id);
      await sys.nginx.writeVhost({
        domain: d.domain, user: owner.username, type: d.type, docroot: d.docroot,
        phpVersion: d.php_version, forceHttps: Boolean(d.force_https), proxyTarget: d.proxy_target,
        hasCert: true
      });
      audit(s.username, 'ssl.issue', d.domain, kind, request.ip);
      return { ok: true, cert: info };
    } catch (e) {
      reply.code(502).send({ error: e.message });
      return;
    }
  });

  // self-signed fallback
  app.post('/:id/selfsigned', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply);
    if (!d) return;
    try {
      const info = await sys.ssl.issueSelfSigned(d.domain);
      db.prepare("UPDATE domains SET ssl_state = 'selfsigned', ssl_expiry = ? WHERE id = ?").run(info.expiry, d.id);
      const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(d.user_id);
      await sys.nginx.writeVhost({
        domain: d.domain, user: owner.username, type: d.type, docroot: d.docroot,
        phpVersion: d.php_version, forceHttps: Boolean(d.force_https), proxyTarget: d.proxy_target,
        hasCert: true
      });
      audit(request.gpanelSession.username, 'ssl.selfsigned', d.domain, null, request.ip);
      return { ok: true, cert: info };
    } catch (e) {
      reply.code(502).send({ error: e.message });
      return;
    }
  });

  // toggle force-https
  app.post('/:id/force-https', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply);
    if (!d) return;
    const on = Boolean(request.body?.enabled);
    const info = await sys.ssl.certInfo(d.domain);
    if (on && !info) { reply.code(400).send({ error: 'Issue a certificate first' }); return; }
    db.prepare('UPDATE domains SET force_https = ? WHERE id = ?').run(on ? 1 : 0, d.id);
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(d.user_id);
    await sys.nginx.writeVhost({
      domain: d.domain, user: owner.username, type: d.type, docroot: d.docroot,
      phpVersion: d.php_version, forceHttps: on, proxyTarget: d.proxy_target, hasCert: Boolean(info)
    });
    audit(request.gpanelSession.username, 'ssl.force_https', d.domain, on ? 'on' : 'off', request.ip);
    return { ok: true };
  });
}

async function ownedDomain(request, reply) {
  const s = request.gpanelSession;
  const d = db.prepare('SELECT * FROM domains WHERE id = ?').get(request.params.id);
  if (!d) { reply.code(404).send({ error: 'Domain not found' }); return null; }
  const admin = s.role === 'admin' && !s.impersonated_by;
  if (!admin && d.user_id !== s.user_id) { reply.code(403).send({ error: 'Not your domain' }); return null; }
  return d;
}

import { db, getSetting } from '../db/index.js';
import { config } from '../config.js';
import { audit } from '../auth/index.js';
import { validateDomain } from '../lib/validate.js';
import { quotaCheckFor } from '../lib/quota.js';
import { sys } from '../services/index.js';
import { provisionDomain, createDnsZoneForDomain, allocateLocalPort, startLocalSite, stopLocalSite } from '../services/sites.js';
import { config as appConfig } from '../config.js';

export default async function (app) {
  app.get('/', { preHandler: [app.requireAuth] }, async (request) => {
    const s = request.gpanelSession;
    let rows;
    if (s.role === 'admin' && !s.impersonated_by) {
      if (request.query.user) {
        rows = db.prepare('SELECT d.*, u.username AS owner FROM domains d JOIN users u ON u.id = d.user_id WHERE d.user_id = ? ORDER BY d.domain').all(Number(request.query.user));
      } else {
        rows = db.prepare('SELECT d.*, u.username AS owner FROM domains d JOIN users u ON u.id = d.user_id ORDER BY d.domain').all();
      }
    } else {
      rows = db.prepare('SELECT d.*, u.username AS owner FROM domains d JOIN users u ON u.id = d.user_id WHERE d.user_id = ? ORDER BY d.domain').all(s.user_id);
    }

    const phpVersions = await sys.php.versions();
    const withExtras = [];
    for (const d of rows) {
      const zone = db.prepare('SELECT id FROM dns_zones WHERE domain_id = ?').get(d.id);
      const mail = db.prepare('SELECT id FROM mail_domains WHERE domain_id = ?').get(d.id);
      const ftpCount = db.prepare('SELECT COUNT(*) c FROM ftp_accounts WHERE user_id = ? AND domain = ?').get(d.user_id, d.domain).c;
      withExtras.push({
        ...d,
        dns_zone: Boolean(zone),
        mail_enabled: Boolean(mail),
        ftp_count: ftpCount,
        ssl_expiry_human: d.ssl_expiry ? new Date(d.ssl_expiry).toISOString().slice(0, 10) : null
      });
    }
    return { domains: withExtras, phpVersions, serverIp: getSetting('server_ip') };
  });

  app.post('/', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const s = request.gpanelSession;
    const b = request.body || {};
    const domain = String(b.domain || '').toLowerCase().trim();
    const domErr = validateDomain(domain);
    if (domErr) { reply.code(400).send({ error: domErr }); return; }

    // ownership scope: admin may create for any user; user only for self
    const userId = s.role === 'admin' && !s.impersonated_by && b.user_id ? Number(b.user_id) : s.user_id;
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!owner) { reply.code(400).send({ error: 'Owner not found' }); return; }

    if (db.prepare('SELECT id FROM domains WHERE domain = ?').get(domain)) {
      reply.code(409).send({ error: 'Domain already exists on this server' });
      return;
    }
    const pkg = owner.package_id ? db.prepare('SELECT * FROM packages WHERE id = ?').get(owner.package_id) : null;
    const current = db.prepare('SELECT COUNT(*) c FROM domains WHERE user_id = ?').get(owner.id).c;
    const q = quotaCheckFor(owner, pkg, 'domains', current);
    if (!q.ok) { reply.code(403).send({ error: q.error }); return; }

    const type = ['php', 'static', 'proxy', 'parked'].includes(b.type) ? b.type : 'php';
    const phpVersions = await sys.php.versions();
    const phpVersion = phpVersions.includes(b.php_version) ? b.php_version : phpVersions[0] || '8.3';
    if (type === 'proxy' && !/^https?:\/\/.+/.test(String(b.proxy_target || ''))) {
      reply.code(400).send({ error: 'Proxy target must be a URL like http://127.0.0.1:3000' });
      return;
    }

    const localPort = allocateLocalPort();
    const res = db.prepare(
      'INSERT INTO domains (user_id, domain, type, docroot, php_version, proxy_target, force_https, dns_enabled, local_port, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      owner.id, domain, type,
      config.webPublic(owner.username, domain),
      phpVersion, b.proxy_target || null, b.force_https === false ? 0 : 1, b.dns_enabled === false ? 0 : 1, localPort, Date.now()
    );
    const domainId = Number(res.lastInsertRowid);
    const row = db.prepare('SELECT * FROM domains WHERE id = ?').get(domainId);

    try {
      await provisionDomain({
        user: owner, domain, type, phpVersion,
        forceHttps: b.force_https !== false, dnsEnabled: b.dns_enabled !== false,
        proxyTarget: b.proxy_target, localPort
      });
      await startLocalSite(row);
      if (b.dns_enabled !== false) {
        await createDnsZoneForDomain(domainId, domain, getSetting('server_ip'), getSetting('hostname'), getSetting('panel_email'));
      }
    } catch (e) {
      db.prepare('DELETE FROM domains WHERE id = ?').run(domainId);
      reply.code(500).send({ error: `Provisioning failed: ${e.message}` });
      return;
    }

    let tunnel = { url: null, status: 'none' };
    if (b.tunnel !== false) {
      const tryTunnel = async () => {
        const st = await sys.cloudflare.siteTunnelStart(domainId, `http://127.0.0.1:${localPort}`);
        tunnel = { url: st.url, status: st.status };
        db.prepare('UPDATE domains SET tunnel_url = ?, tunnel_status = ? WHERE id = ?').run(st.url, st.status, domainId);
      };
      try {
        await tryTunnel();
      } catch (e) {
        // one-click behavior: if cloudflared is missing, install it now and retry
        if (/not installed/i.test(String(e.message))) {
          try {
            await sys.cloudflare.install();
            await tryTunnel();
          } catch (e2) {
            db.prepare("UPDATE domains SET tunnel_status = 'error' WHERE id = ?").run(domainId);
            tunnel = { url: null, status: 'error', error: e2.message };
          }
        } else {
          db.prepare("UPDATE domains SET tunnel_status = 'error' WHERE id = ?").run(domainId);
          tunnel = { url: null, status: 'error', error: e.message };
        }
      }
    }
    audit(s.username, 'domain.create', domain, `owner: ${owner.username}`, request.ip);
    return { id: domainId, local_port: localPort, local_url: `http://127.0.0.1:${localPort}`, tunnel };
  });

  app.get('/:id', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply);
    if (!d) return;
    return { domain: d };
  });

  app.put('/:id', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply);
    if (!d) return;
    const s = request.gpanelSession;
    const b = request.body || {};
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(d.user_id);
    const phpVersions = await sys.php.versions();

    if (b.type !== undefined && ['php', 'static', 'proxy', 'parked'].includes(b.type)) d.type = b.type;
    if (b.php_version !== undefined && phpVersions.includes(b.php_version)) d.php_version = b.php_version;
    if (b.force_https !== undefined) d.force_https = b.force_https ? 1 : 0;
    if (b.proxy_target !== undefined) d.proxy_target = b.proxy_target;
    if (b.active !== undefined) d.active = b.active ? 1 : 0;

    if (d.type === 'proxy' && !/^https?:\/\/.+/.test(String(d.proxy_target || ''))) {
      reply.code(400).send({ error: 'Proxy target must be a URL like http://127.0.0.1:3000' });
      return;
    }
    if (d.type === 'php' && !phpVersions.includes(d.php_version)) {
      d.php_version = phpVersions[0] || d.php_version;
    }

    db.prepare('UPDATE domains SET type = ?, php_version = ?, force_https = ?, proxy_target = ?, active = ? WHERE id = ?')
      .run(d.type, d.php_version, d.force_https, d.proxy_target, d.active, d.id);

    // ensure pool exists for this version, rewrite vhost
    if (d.type === 'php') {
      await sys.php.writePool(owner.username, d.php_version, config.domainsDir(owner.username));
    }
    const cert = await sys.ssl.certInfo(d.domain);
    await sys.nginx.writeVhost({
      domain: d.domain, user: owner.username, type: d.type, docroot: d.docroot,
      phpVersion: d.php_version, forceHttps: Boolean(d.force_https), proxyTarget: d.proxy_target,
      hasCert: Boolean(cert)
    });
    audit(s.username, 'domain.update', d.domain, Object.keys(b).join(','), request.ip);
    return { ok: true };
  });

  app.delete('/:id', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply);
    if (!d) return;
    const s = request.gpanelSession;

    const mailDomain = db.prepare('SELECT * FROM mail_domains WHERE domain_id = ?').get(d.id);
    if (mailDomain) {
      const accounts = db.prepare('SELECT address FROM mail_accounts WHERE mail_domain_id = ?').all(mailDomain.id);
      if (accounts.length && request.query.force !== '1') {
        reply.code(409).send({ error: `Domain has ${accounts.length} mailbox(es). Delete them first or confirm force deletion.` });
        return;
      }
      for (const a of accounts) {
        const [local, dom] = a.address.split('@');
        await sys.mail.deprovisionUser(dom, local).catch(() => {});
      }
      await sys.mail.deprovisionDomain(d.domain).catch(() => {});
    }

    await stopLocalSite(d.id);
    await sys.cloudflare.siteTunnelStop(d.id).catch(() => {});
    await sys.dns.removeZone(d.domain).catch(() => {});
    await sys.nginx.removeVhost(d.domain).catch(() => {});
    db.prepare('DELETE FROM domains WHERE id = ?').run(d.id);
    audit(s.username, 'domain.delete', d.domain, null, request.ip);
    return { ok: true };
  });

  // site logs
  app.get('/:id/logs/:kind', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply);
    if (!d) return;
    const kind = ['access', 'error'].includes(request.params.kind) ? request.params.kind : 'access';
    const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(d.user_id);
    const text = await sys.nginx.readLog(d.domain, kind, 300);
    void owner;
    return { text, domain: d.domain, kind };
  });

  // Local development: start/stop this site's local server or tunnel, read its logs
  app.post('/:id/local/start', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply); if (!d) return;
    if (!d.local_port) { reply.code(409).send({ error: 'This site has no local port assigned — delete and recreate it' }); return; }
    await startLocalSite(d);
    return { ok: true, local_url: `http://127.0.0.1:${d.local_port}` };
  });

  app.post('/:id/local/stop', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply); if (!d) return;
    await stopLocalSite(d.id);
    return { ok: true };
  });

  app.post('/:id/tunnel/start', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply); if (!d) return;
    if (!d.local_port) { reply.code(409).send({ error: 'This site has no local port — delete and recreate it' }); return; }
    try {
      await startLocalSite(d);
      const st = await sys.cloudflare.siteTunnelStart(d.id, `http://127.0.0.1:${d.local_port}`);
      db.prepare('UPDATE domains SET tunnel_url = ?, tunnel_status = ? WHERE id = ?').run(st.url, st.status, d.id);
      return { ...st };
    } catch (e) { reply.code(502).send({ error: e.message }); }
  });

  app.post('/:id/tunnel/stop', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply); if (!d) return;
    const st = await sys.cloudflare.siteTunnelStop(d.id);
    db.prepare('UPDATE domains SET tunnel_url = NULL, tunnel_status = ? WHERE id = ?').run(st.status, d.id);
    return { ...st };
  });

  app.get('/:id/tunnel', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply); if (!d) return;
    const st = await sys.cloudflare.siteTunnelStatus(d.id);
    return { ...st, logs: sys.cloudflare.siteTunnelLogs(d.id), stored_url: d.tunnel_url, stored_status: d.tunnel_status };
  });

  // domain connection: third-party delegation check (registrar nameservers etc.)
  app.get('/:id/connection', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply);
    if (!d) return;
    const check = await sys.dnsthirdparty.check(d.domain).catch((e) => ({ error: e.message }));
    const tunnel = await sys.cloudflare.siteTunnelStatus(d.id);
    return {
      domain: d.domain,
      dns_hosted: Boolean(db.prepare('SELECT id FROM dns_zones WHERE domain_id = ?').get(d.id)),
      local: {
        port: d.local_port || null,
        url: d.local_port ? `http://127.0.0.1:${d.local_port}` : null,
        docroot: d.docroot
      },
      tunnel: tunnel.url || d.tunnel_url || null,
      tunnel_status: tunnel.running ? tunnel.status : (d.tunnel_status || 'none'),
      tunnel_target: tunnel.target || (d.local_port ? `http://127.0.0.1:${d.local_port}` : null),
      ...check
    };
  });

  // traffic estimate (current month, from access logs)
  app.get('/:id/traffic', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply);
    if (!d) return;
    const bytes = await sys.nginx.trafficMonth(d.domain);
    return { bytes };
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

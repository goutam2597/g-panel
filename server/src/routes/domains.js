import { db, getSetting } from '../db/index.js';
import { config } from '../config.js';
import { audit } from '../auth/index.js';
import { validateDomain } from '../lib/validate.js';
import { quotaCheckFor } from '../lib/quota.js';
import { sys } from '../services/index.js';
import { provisionDomain, createDnsZoneForDomain, allocateLocalPort, startLocalSite, stopLocalSite, docrootFor, deprovisionLocalSite } from '../services/sites.js';
import { uniqueLocalName } from '../lib/hosts.js';
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
    const local = config.mode === 'local';

    // Local mode accepts a plain site name ("cloudmarket") and generates
    // <name>.test automatically. Server mode requires a full domain.
    let domain = String(b.domain || '').toLowerCase().trim();
    let siteName = String(b.name || '').toLowerCase().trim();
    if (local && !domain) {
      if (!/^[a-z][a-z0-9-]{1,40}$/.test(siteName)) {
        reply.code(400).send({ error: 'Site name must be 2-41 chars: letters, digits, dashes (e.g. cloudmarket)' });
        return;
      }
      domain = uniqueLocalName(siteName, db.prepare('SELECT domain FROM domains').all().map((r) => r.domain));
    }
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

    const appType = ['static', 'php', 'laravel', 'proxy', 'parked'].includes(b.app_type) ? b.app_type
      : (['php', 'static', 'proxy', 'parked'].includes(b.type) ? b.type : 'php');
    const type = appType;
    const phpVersions = await sys.php.versions();
    const phpVersion = phpVersions.includes(b.php_version) ? b.php_version : phpVersions[0] || '8.3';
    if (type === 'proxy' && !/^https?:\/\/.+/.test(String(b.proxy_target || ''))) {
      reply.code(400).send({ error: 'Proxy target must be a URL like http://127.0.0.1:3000' });
      return;
    }

    const localPort = config.mode === 'local' ? allocateLocalPort() : null;
    const docroot = docrootFor({ user: owner, domain, type, appType, siteName: siteName || domain.replace(/\.[a-z]+$/i, '') });
    siteName = siteName || domain.replace(/\.[a-z]+$/i, '');
    const res = db.prepare(
      'INSERT INTO domains (user_id, domain, type, docroot, php_version, proxy_target, force_https, dns_enabled, local_port, app_type, site_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      owner.id, domain, type, docroot,
      phpVersion, b.proxy_target || null, b.force_https === false ? 0 : 1, b.dns_enabled === false ? 0 : 1, localPort, appType, siteName, Date.now()
    );
    const domainId = Number(res.lastInsertRowid);
    const row = db.prepare('SELECT * FROM domains WHERE id = ?').get(domainId);

    // Optional database: created + granted in one step, credentials returned.
    // Host defaults to the panel MySQL (:3307 panel-owned / config override).
    let database = null;
    if (b.create_db) {
      try {
        const { generatePassword } = await import('../lib/passwords.js');
        const { assigned } = await import('../lib/ports.js');
        const dbName = `${siteName.replace(/-/g, '_')}_db`.slice(0, 64);
        const dbUserName = `${siteName.replace(/-/g, '_')}_user`.slice(0, 64);
        const dbPass = generatePassword(18);
        const dbPort = config.mode === 'local'
          ? assigned('mysql', 3307)
          : 3306;
        await sys.db.createDatabase(dbName);
        await sys.db.createDbUser(dbUserName, dbPass);
        await sys.db.grant(dbUserName, dbName);
        const dres = db.prepare('INSERT INTO databases (user_id, name, engine, created_at) VALUES (?, ?, ?, ?)').run(owner.id, dbName, 'mysql', Date.now());
        const ures = db.prepare('INSERT INTO db_users (user_id, name, password, engine, created_at) VALUES (?, ?, ?, ?, ?)').run(owner.id, dbUserName, dbPass, 'mysql', Date.now());
        db.prepare('INSERT INTO db_grants (db_user_id, database_id) VALUES (?, ?)').run(Number(ures.lastInsertRowid), Number(dres.lastInsertRowid));
        db.prepare('UPDATE domains SET db_name = ?, db_user = ? WHERE id = ?').run(dbName, dbUserName, domainId);
        database = { name: dbName, user: dbUserName, password: dbPass, host: config.mode === 'local' ? '127.0.0.1' : 'localhost', port: dbPort };
      } catch (e) {
        database = { error: `Database provisioning failed: ${e.message}` };
      }
    }

    try {
      await provisionDomain({
        user: owner, domain, type, phpVersion, appType, siteName,
        forceHttps: b.force_https !== false, dnsEnabled: b.dns_enabled !== false,
        proxyTarget: b.proxy_target, localPort
      });
      await startLocalSite(row);
      if (b.dns_enabled !== false && config.mode === 'server') {
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
    return {
      id: domainId, local_port: localPort,
      local_url: local
        ? (localPort === config.webPort ? `http://${domain}` : `http://${domain}:${localPort}`)
        : `http://127.0.0.1:${localPort}`,
      domain, tunnel, database
    };
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
    // local mode: clean the site directory + hosts entries
    if (config.mode === 'local') {
      await deprovisionLocalSite(d.domain, d.docroot).catch(() => {});
    }
    db.prepare('DELETE FROM site_domains WHERE domain_id = ?').run(d.id);
    db.prepare('DELETE FROM domains WHERE id = ?').run(d.id);
    audit(s.username, 'domain.delete', d.domain, null, request.ip);
    return { ok: true };
  });

  // ---- custom domains per site (local + live + tunnel domains) ----
  app.get('/:id/domains', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply);
    if (!d) return;
    return {
      primary: d.domain,
      domains: db.prepare('SELECT id, domain, kind, created_at FROM site_domains WHERE domain_id = ? ORDER BY created_at').all(d.id)
    };
  });

  app.post('/:id/domains', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply);
    if (!d) return;
    const domain = String(request.body?.domain || '').toLowerCase().trim();
    const domErr = validateDomain(domain);
    if (domErr) { reply.code(400).send({ error: domErr }); return; }
    if (domain === d.domain || db.prepare('SELECT id FROM site_domains WHERE domain = ?').get(domain)) {
      reply.code(409).send({ error: 'Domain already connected to a site' });
      return;
    }
    const kind = ['custom', 'tunnel'].includes(request.body?.kind) ? request.body.kind : 'custom';
    db.prepare('INSERT INTO site_domains (domain_id, domain, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(d.id, domain, kind, Date.now());
    // local .test domains get hosts entries; everything joins the vhost
    if (config.mode === 'local') {
      const { ensureHostsEntries } = await import('../lib/hosts.js');
      await ensureHostsEntries([domain]);
    }
    await regenerateVhost(d);
    audit(request.gpanelSession.username, 'domain.connect', domain, `site: ${d.domain}`, request.ip);
    return { ok: true };
  });

  app.delete('/:id/domains/:domainId', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply);
    if (!d) return;
    const row = db.prepare('SELECT * FROM site_domains WHERE id = ? AND domain_id = ?').get(request.params.domainId, d.id);
    if (!row) { reply.code(404).send({ error: 'Domain not found' }); return; }
    db.prepare('DELETE FROM site_domains WHERE id = ?').run(row.id);
    if (config.mode === 'local') await removeHostsEntries([row.domain]).catch(() => {});
    await regenerateVhost(d);
    audit(request.gpanelSession.username, 'domain.disconnect', row.domain, null, request.ip);
    return { ok: true };
  });

  // ---- database credentials for the site's assigned database ----
  app.get('/:id/db-creds', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply);
    if (!d) return;
    if (!d.db_name) { reply.code(404).send({ error: 'This site has no assigned database — create one from the Databases page' }); return; }
    const u = db.prepare('SELECT name, password FROM db_users WHERE name = ?').get(d.db_user);
    const { assigned } = await import('../lib/ports.js');
    return {
      database: d.db_name,
      user: d.db_user,
      password: u?.password || null,
      host: '127.0.0.1',
      port: config.mode === 'local' ? assigned('mysql', 3307) : 3306
    };
  });

  // ---- Laravel support ----
  app.post('/:id/laravel/setup', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply);
    if (!d) return;
    const s = request.gpanelSession;
    const { runLaravelSetup } = await import('../lib/laravel.js');
    try {
      const result = await runLaravelSetup(d.docroot);
      audit(s.username, 'laravel.setup', d.domain, JSON.stringify(result).slice(0, 200), request.ip);
      return { ok: true, ...result };
    } catch (e) {
      reply.code(502).send({ error: e.message });
      return;
    }
  });

  app.post('/:id/artisan', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDomain(request, reply);
    if (!d) return;
    const command = String(request.body?.command || '').trim();
    if (!/^[a-z0-9:_-]+(\s+--?[a-z0-9-=]+)*$/i.test(command)) {
      reply.code(400).send({ error: 'Invalid artisan command' });
      return;
    }
    const { runArtisan } = await import('../lib/laravel.js');
    try {
      const result = await runArtisan(d.docroot.replace(/\/public$/, ''), command);
      audit(request.gpanelSession.username, 'laravel.artisan', d.domain, command, request.ip);
      return { ok: true, output: result.output?.slice(-4000) };
    } catch (e) {
      reply.code(502).send({ error: e.message });
      return;
    }
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

/**
 * Rebuild the vhost for a site with its primary + custom domains.
 */
async function regenerateVhost(d) {
  const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(d.user_id);
  const cert = await sys.ssl.certInfo(d.domain).catch(() => null);
  const extras = db.prepare('SELECT domain FROM site_domains WHERE domain_id = ?').all(d.id).map((r) => r.domain);
  await sys.nginx.writeVhost({
    domain: d.domain, user: owner.username, type: d.type, docroot: d.docroot,
    phpVersion: d.php_version, forceHttps: Boolean(d.force_https), proxyTarget: d.proxy_target,
    hasCert: Boolean(cert), listenPort: d.local_port || undefined,
    serverNames: [d.domain, ...extras]
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

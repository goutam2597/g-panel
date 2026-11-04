import { db } from '../db/index.js';
import { config } from '../config.js';
import { audit } from '../auth/index.js';
import { validateDomain } from '../lib/validate.js';
import { sys } from '../services/index.js';
import { provisionDomain } from '../services/sites.js';

// cPanel-style Node.js application manager.
// Apps run as systemd services on loopback ports; nginx proxies their domain.

const PORT_RANGE = { min: 31000, max: 35999 };

async function allocatePort() {
  const used = new Set(db.prepare('SELECT port FROM node_apps').all().map((r) => r.port));
  for (let i = 0; i < 200; i++) {
    const p = PORT_RANGE.min + Math.floor(Math.random() * (PORT_RANGE.max - PORT_RANGE.min));
    if (!used.has(p)) return p;
  }
  throw new Error('No free ports in the app range');
}

export default async function (app) {
  app.get('/', { preHandler: [app.requireAuth] }, async (request) => {
    const s = request.gpanelSession;
    const admin = s.role === 'admin' && !s.impersonated_by;
    const scope = admin && !request.query.user ? null : (admin ? Number(request.query.user) : s.user_id);

    const rows = scope === null
      ? db.prepare('SELECT na.*, u.username AS owner FROM node_apps na JOIN users u ON u.id = na.user_id ORDER BY na.created_at DESC').all()
      : db.prepare('SELECT * FROM node_apps WHERE user_id = ? ORDER BY created_at DESC').all(scope);

    const out = [];
    for (const r of rows) {
      const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(r.user_id);
      const status = await sys.nodeapps.status(owner.username, r.name).catch(() => 'unknown');
      if (status !== r.status) db.prepare('UPDATE node_apps SET status = ? WHERE id = ?').run(status, r.id);
      out.push({ ...r, status, owner_username: owner.username, app_dir: sys.nodeapps.appDir(owner.username, r.name) });
    }
    const versions = await sys.nodeapps.nodeVersions().catch(() => []);
    return { apps: out, nodeVersions: versions.map((v) => v.version) };
  });

  app.post('/', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const s = request.gpanelSession;
    const b = request.body || {};
    const userId = s.role === 'admin' && !s.impersonated_by && b.user_id ? Number(b.user_id) : s.user_id;
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!owner) { reply.code(400).send({ error: 'Owner not found' }); return; }

    const name = String(b.name || '').toLowerCase().trim();
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) {
      reply.code(400).send({ error: 'App name: 2-31 chars, lowercase letters, digits, dashes' });
      return;
    }
    if (db.prepare('SELECT id FROM node_apps WHERE user_id = ? AND name = ?').get(owner.id, name)) {
      reply.code(409).send({ error: 'You already have an app with this name' });
      return;
    }

    const domain = String(b.domain || '').toLowerCase().trim();
    const domErr = validateDomain(domain);
    if (domErr) { reply.code(400).send({ error: domErr }); return; }

    const startupFile = String(b.startup_file || 'app.js').trim();
    if (!/^[a-zA-Z0-9._/-]{1,100}$/.test(startupFile) || startupFile.startsWith('/')) {
      reply.code(400).send({ error: 'Startup file must be a relative path like app.js or src/index.js' });
      return;
    }

    const port = await allocatePort();
    const existingDomain = db.prepare('SELECT * FROM domains WHERE domain = ?').get(domain);

    if (existingDomain && existingDomain.user_id !== owner.id) {
      reply.code(403).send({ error: 'That domain belongs to another user' });
      return;
    }

    // create or repoint the domain as a proxy vhost to the app port
    let domainId;
    try {
      if (!existingDomain) {
        const res = db.prepare(
          "INSERT INTO domains (user_id, domain, type, docroot, php_version, proxy_target, force_https, dns_enabled, created_at) VALUES (?, ?, 'proxy', ?, '8.3', ?, 0, 0, ?)"
        ).run(owner.id, domain, config.webPublic(owner.username, domain), `http://127.0.0.1:${port}`, Date.now());
        domainId = Number(res.lastInsertRowid);
        await provisionDomain({ user: owner, domain, type: 'proxy', phpVersion: '8.3', forceHttps: false, proxyTarget: `http://127.0.0.1:${port}` });
      } else {
        domainId = existingDomain.id;
        db.prepare("UPDATE domains SET type = 'proxy', proxy_target = ? WHERE id = ?").run(`http://127.0.0.1:${port}`, domainId);
        await sys.nginx.writeVhost({
          domain, user: owner.username, type: 'proxy',
          docroot: existingDomain.docroot, phpVersion: existingDomain.php_version,
          forceHttps: Boolean(existingDomain.force_https), proxyTarget: `http://127.0.0.1:${port}`,
          hasCert: existingDomain.ssl_state !== 'none'
        });
      }
      await sys.nodeapps.create({
        username: owner.username, appName: name, port,
        startupFile, nodeVersion: String(b.node_version || '22')
      });
    } catch (e) {
      reply.code(500).send({ error: `App provisioning failed: ${e.message}` });
      return;
    }

    const res = db.prepare(
      "INSERT INTO node_apps (user_id, name, domain, port, startup_file, node_version, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)"
    ).run(owner.id, name, domain, port, startupFile, String(b.node_version || '22'), Date.now());

    audit(s.username, 'app.create', `${owner.username}/${name}`, `domain: ${domain} port: ${port}`, request.ip);
    return { id: Number(res.lastInsertRowid), port, domain_id: domainId, sample_env: `PORT=${port}` };
  });

  app.post('/:id/:action', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const actions = ['start', 'stop', 'restart', 'npm-install'];
    const { id, action } = request.params;
    if (!actions.includes(action)) { reply.code(400).send({ error: 'Unknown action' }); return; }
    const row = await ownedApp(request, reply);
    if (!row) return;
    const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(row.user_id);
    try {
      let extra;
      if (action === 'start') await sys.nodeapps.start(owner.username, row.name);
      else if (action === 'stop') await sys.nodeapps.stop(owner.username, row.name);
      else if (action === 'restart') await sys.nodeapps.restart(owner.username, row.name);
      else if (action === 'npm-install') extra = await sys.nodeapps.npmInstall(owner.username, row.name);
      const status = await sys.nodeapps.status(owner.username, row.name).catch(() => 'unknown');
      db.prepare('UPDATE node_apps SET status = ? WHERE id = ?').run(status, row.id);
      audit(s.username, `app.${action.replace('-', '.')}`, `${owner.username}/${row.name}`, null, request.ip);
      return { ok: true, status, ...(extra ? { output: extra.output } : {}) };
    } catch (e) {
      reply.code(502).send({ error: e.message });
      return;
    }
  });

  app.get('/:id/logs', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const row = await ownedApp(request, reply);
    if (!row) return;
    const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(row.user_id);
    const text = await sys.nodeapps.logs(owner.username, row.name, 300).catch(() => '');
    return { text };
  });

  app.delete('/:id', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const row = await ownedApp(request, reply);
    if (!row) return;
    const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(row.user_id);
    await sys.nodeapps.remove(owner.username, row.name).catch(() => {});
    // leave the domain in place but switch it to a parked site so it isn't proxying a dead port
    const d = db.prepare('SELECT * FROM domains WHERE domain = ?').get(row.domain);
    if (d && d.type === 'proxy') {
      db.prepare("UPDATE domains SET type = 'static', proxy_target = NULL WHERE id = ?").run(d.id);
      await sys.nginx.writeVhost({
        domain: d.domain, user: owner.username, type: 'static', docroot: d.docroot,
        phpVersion: d.php_version, forceHttps: Boolean(d.force_https), proxyTarget: null,
        hasCert: d.ssl_state !== 'none'
      }).catch(() => {});
    }
    db.prepare('DELETE FROM node_apps WHERE id = ?').run(row.id);
    audit(request.gpanelSession.username, 'app.delete', `${owner.username}/${row.name}`, null, request.ip);
    return { ok: true };
  });
}

async function ownedApp(request, reply) {
  const s = request.gpanelSession;
  const row = db.prepare('SELECT * FROM node_apps WHERE id = ?').get(request.params.id);
  if (!row) { reply.code(404).send({ error: 'App not found' }); return null; }
  const admin = s.role === 'admin' && !s.impersonated_by;
  if (!admin && row.user_id !== s.user_id) { reply.code(403).send({ error: 'Not your app' }); return null; }
  return row;
}

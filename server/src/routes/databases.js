import { db, getSetting } from '../db/index.js';
import { audit } from '../auth/index.js';
import { validateDbName } from '../lib/validate.js';
import { quotaCheckFor } from '../lib/quota.js';
import { sys } from '../services/index.js';
import { generatePassword, token as randomToken } from '../lib/passwords.js';
import { config } from '../config.js';

const ENGINES = ['mysql', 'postgres'];

function driver(engine) {
  if (engine === 'postgres') return sys.pg;
  return sys.db;
}

export default async function (app) {
  app.get('/', { preHandler: [app.requireAuth] }, async (request) => {
    const s = request.gpanelSession;
    const admin = s.role === 'admin' && !s.impersonated_by;
    const scope = admin && !request.query.user ? null : (admin ? Number(request.query.user) : s.user_id);

    const where = scope === null ? '' : 'WHERE user_id = ?';
    const params = scope === null ? [] : [scope];

    const dbs = db.prepare(`SELECT * FROM databases ${where} ORDER BY name`).all(...params);
    const users = db.prepare(`SELECT id, name, user_id, engine, created_at FROM db_users ${where} ORDER BY name`).all(...params);
    const grants = db.prepare('SELECT * FROM db_grants').all();
    const mysqlSizes = await sys.db.listSizes().catch(() => ({}));
    const pgSizes = await sys.pg.listSizes().catch(() => ({}));

    const grantsByUser = {};
    const grantsByDatabase = {};
    for (const g of grants) {
      (grantsByUser[g.db_user_id] ||= []).push(g.database_id);
      (grantsByDatabase[g.database_id] ||= []).push(g.db_user_id);
    }

    return {
      databases: dbs.map((d) => ({
        ...d,
        size_mb: (d.engine === 'postgres' ? pgSizes[d.name] : mysqlSizes[d.name]) ?? null,
        granted_to: (grantsByDatabase[d.id] || []).map((uid) => {
          const u = users.find((x) => x.id === uid);
          return u ? { id: u.id, name: u.name } : null;
        }).filter(Boolean)
      })),
      dbUsers: users.map((u) => ({ ...u, databases: grantsByUser[u.id] || [] })),
      serverVersion: {
        mysql: await sys.db.serverVersion().catch(() => null),
        postgres: await sys.pg.serverVersion().catch(() => null)
      },
      pma_url: getSetting('pma_url') || ''
    };
  });

  // ---- databases ----
  app.post('/databases', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const s = request.gpanelSession;
    const engine = ENGINES.includes(request.body?.engine) ? request.body.engine : 'mysql';
    const userId = s.role === 'admin' && !s.impersonated_by && request.body?.user_id ? Number(request.body.user_id) : s.user_id;
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!owner) { reply.code(400).send({ error: 'Owner not found' }); return; }

    const pkg = owner.package_id ? db.prepare('SELECT * FROM packages WHERE id = ?').get(owner.package_id) : null;
    const current = db.prepare('SELECT COUNT(*) c FROM databases WHERE user_id = ?').get(owner.id).c;
    const q = quotaCheckFor(owner, pkg, 'databases', current);
    if (!q.ok) { reply.code(403).send({ error: q.error }); return; }

    const err = validateDbName(String(request.body?.name || ''), owner.username);
    if (err) { reply.code(400).send({ error: err }); return; }
    const name = `${owner.username}_${String(request.body.name).toLowerCase()}`;
    if (db.prepare('SELECT id FROM databases WHERE name = ?').get(name)) {
      reply.code(409).send({ error: 'Database already exists' });
      return;
    }
    try {
      await driver(engine).createDatabase(name);
    } catch (e) {
      reply.code(500).send({ error: e.message });
      return;
    }
    const res = db.prepare('INSERT INTO databases (user_id, name, engine, created_at) VALUES (?, ?, ?, ?)')
      .run(owner.id, name, engine, Date.now());
    const databaseId = Number(res.lastInsertRowid);

    // optional: grant a database user immediately so the new database shows
    // up in phpMyAdmin the moment the user signs in with that user (cPanel
    // does this as a second step; we fold it into creation)
    let grantWarning = null;
    const grantTo = request.body?.grant_to ? Number(request.body.grant_to) : null;
    if (grantTo) {
      const du = db.prepare('SELECT * FROM db_users WHERE id = ? AND user_id = ? AND engine = ?').get(grantTo, owner.id, engine);
      if (du) {
        try {
          await driver(engine).grant(du.name, name);
          db.prepare('INSERT INTO db_grants (db_user_id, database_id) VALUES (?, ?)').run(du.id, databaseId);
        } catch (e) {
          grantWarning = `Database created, but granting ${du.name} failed: ${e.message}`;
        }
      }
    }

    audit(s.username, 'db.create', name, `engine: ${engine}${grantTo ? ', granted' : ''}`, request.ip);
    return { id: databaseId, name, engine, warning: grantWarning };
  });

  app.delete('/databases/:id', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const d = await ownedDb(request, reply);
    if (!d) return;
    try {
      if (d.engine === 'postgres') {
        const grants = db.prepare(
          'SELECT u.name FROM db_grants g JOIN db_users u ON u.id = g.db_user_id WHERE g.database_id = ?'
        ).all(d.id);
        for (const g of grants) await sys.pg.revokeAll(g.name, d.name).catch(() => {});
      }
      await driver(d.engine).dropDatabase(d.name);
    } catch (e) {
      reply.code(500).send({ error: e.message });
      return;
    }
    db.prepare('DELETE FROM databases WHERE id = ?').run(d.id);
    audit(request.gpanelSession.username, 'db.delete', d.name, null, request.ip);
    return { ok: true };
  });

  // ---- database users ----
  app.post('/users', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const s = request.gpanelSession;
    const engine = ENGINES.includes(request.body?.engine) ? request.body.engine : 'mysql';
    const userId = s.role === 'admin' && !s.impersonated_by && request.body?.user_id ? Number(request.body.user_id) : s.user_id;
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!owner) { reply.code(400).send({ error: 'Owner not found' }); return; }

    const err = validateDbName(String(request.body?.name || ''), owner.username);
    if (err) { reply.code(400).send({ error: err }); return; }
    const name = `${owner.username}_${String(request.body.name).toLowerCase()}`;
    if (db.prepare('SELECT id FROM db_users WHERE name = ? AND engine = ?').get(name, engine)) {
      reply.code(409).send({ error: 'Database user already exists' });
      return;
    }
    const password = request.body?.password || generatePassword(16);
    try {
      await driver(engine).createDbUser(name, password);
    } catch (e) {
      reply.code(500).send({ error: e.message });
      return;
    }
    const res = db.prepare('INSERT INTO db_users (user_id, name, password, engine, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(owner.id, name, password, engine, Date.now());
    audit(s.username, 'db.user.create', name, `engine: ${engine}`, request.ip);
    return { id: Number(res.lastInsertRowid), name, engine, initial_password: request.body?.password ? undefined : password };
  });

  app.post('/users/:id/grants', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const u = await ownedDbUser(request, reply);
    if (!u) return;
    const database = db.prepare('SELECT * FROM databases WHERE id = ? AND user_id = ?').get(request.body?.database_id, u.user_id);
    if (!database) { reply.code(400).send({ error: 'Database not found or not yours' }); return; }
    if (database.engine !== u.engine) {
      reply.code(400).send({ error: `Engine mismatch: this is a ${database.engine} database, the user is a ${u.engine} user` });
      return;
    }
    const existing = db.prepare('SELECT 1 FROM db_grants WHERE db_user_id = ? AND database_id = ?').get(u.id, database.id);
    if (existing) { reply.code(409).send({ error: 'Grant already exists' }); return; }
    try {
      await driver(u.engine).grant(u.name, database.name);
    } catch (e) {
      reply.code(500).send({ error: e.message });
      return;
    }
    db.prepare('INSERT INTO db_grants (db_user_id, database_id) VALUES (?, ?)').run(u.id, database.id);
    audit(request.gpanelSession.username, 'db.grant', `${u.name} -> ${database.name}`, null, request.ip);
    return { ok: true };
  });

  app.delete('/users/:id/grants/:databaseId', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const u = await ownedDbUser(request, reply);
    if (!u) return;
    const database = db.prepare('SELECT * FROM databases WHERE id = ? AND user_id = ?').get(request.params.databaseId, u.user_id);
    if (!database) { reply.code(400).send({ error: 'Database not found' }); return; }
    if (u.engine === 'postgres') {
      await sys.pg.revokeAll(u.name, database.name).catch(() => {});
    } else {
      await sys.db.revokeAll(u.name).catch(() => {});
      const remaining = db.prepare(
        `SELECT d.name FROM db_grants g JOIN databases d ON d.id = g.database_id WHERE g.db_user_id = ? AND g.database_id != ? AND d.engine = 'mysql'`
      ).all(u.id, database.id);
      for (const r of remaining) await sys.db.grant(u.name, r.name).catch(() => {});
    }
    db.prepare('DELETE FROM db_grants WHERE db_user_id = ? AND database_id = ?').run(u.id, database.id);
    audit(request.gpanelSession.username, 'db.revoke', `${u.name} -X ${database.name}`, null, request.ip);
    return { ok: true };
  });

  app.delete('/users/:id', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const u = await ownedDbUser(request, reply);
    if (!u) return;
    await driver(u.engine).dropDbUser(u.name).catch(() => {});
    db.prepare('DELETE FROM db_users WHERE id = ?').run(u.id);
    audit(request.gpanelSession.username, 'db.user.delete', u.name, null, request.ip);
    return { ok: true };
  });

  app.post('/users/:id/reset-password', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const u = await ownedDbUser(request, reply);
    if (!u) return;
    const password = request.body?.password || generatePassword(16);
    try {
      await driver(u.engine).setDbUserPassword(u.name, password);
    } catch (e) {
      reply.code(500).send({ error: e.message });
      return;
    }
    db.prepare('UPDATE db_users SET password = ? WHERE id = ?').run(password, u.id);
    audit(request.gpanelSession.username, 'db.user.password', u.name, null, request.ip);
    return { ok: true, new_password: request.body?.password ? undefined : password };
  });

  // ---- phpMyAdmin single sign-on (cPanel-style one-click login) ----
  // Issues a one-time token consumed by gpanel-signon.php on the phpMyAdmin
  // host (prod) or by the built-in simulated phpMyAdmin (dev).
  app.post('/pma-login', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const s = request.gpanelSession;
    const dbUser = db.prepare("SELECT * FROM db_users WHERE id = ? AND engine = 'mysql'").get(Number(request.body?.db_user_id));
    if (!dbUser) { reply.code(400).send({ error: 'Choose one of your MySQL database users to sign in with' }); return; }
    const admin = s.role === 'admin' && !s.impersonated_by;
    if (!admin && dbUser.user_id !== s.user_id) { reply.code(403).send({ error: 'Not your database user' }); return; }

    // housekeeping: drop expired tokens
    db.prepare('DELETE FROM pma_tokens WHERE expires < ?').run(Date.now());

    const token = randomToken(32); // 64 hex chars
    db.prepare(
      'INSERT INTO pma_tokens (token, mysql_user, mysql_pass, panel_user, created, expires) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(token, dbUser.name, dbUser.password, s.username, Date.now(), Date.now() + 90 * 1000);

    audit(s.username, 'db.pma.login', dbUser.name, null, request.ip);

    // Windows (and dev): the panel stages and serves its own phpMyAdmin
    // (original package) with the machine's PHP — one-click SSO, no setup.
    if (config.dev || config.isWin) {
      const { startDevPma } = await import('../devpma.js');
      const pma = await startDevPma();
      if (!pma.url) {
        return { phpMissing: true, reason: pma.error };
      }
      return { url: `${pma.url}/gpanel-signon.php?t=${token}`, simulated: false };
    }
    const pmaUrl = getSetting('pma_url');
    if (!pmaUrl) {
      reply.code(400).send({ error: 'phpMyAdmin is not configured — set its signon URL in Settings (see docs/INSTALL.md)' });
      return;
    }
    return { url: `${pmaUrl.replace(/\/$/, '')}${pmaUrl.includes('?') ? '&' : '?'}t=${token}`, simulated: false };
  });

  // which MySQL users can the caller sign in with (for the chooser modal)
  app.get('/pma-users', { preHandler: [app.requireAuth] }, async (request) => {
    const s = request.gpanelSession;
    const userId = s.role === 'admin' && !s.impersonated_by && request.query.user ? Number(request.query.user) : s.user_id;
    const users = db.prepare("SELECT id, name, created_at FROM db_users WHERE user_id = ? AND engine = 'mysql' ORDER BY name").all(userId);
    return {
      users,
      pma_url: getSetting('pma_url') || '',
      dev: config.dev
    };
  });
}

async function ownedDb(request, reply) {
  const s = request.gpanelSession;
  const d = db.prepare('SELECT * FROM databases WHERE id = ?').get(request.params.id);
  if (!d) { reply.code(404).send({ error: 'Database not found' }); return null; }
  const admin = s.role === 'admin' && !s.impersonated_by;
  if (!admin && d.user_id !== s.user_id) { reply.code(403).send({ error: 'Not your database' }); return null; }
  return d;
}

async function ownedDbUser(request, reply) {
  const s = request.gpanelSession;
  const u = db.prepare('SELECT * FROM db_users WHERE id = ?').get(request.params.id);
  if (!u) { reply.code(404).send({ error: 'Database user not found' }); return null; }
  const admin = s.role === 'admin' && !s.impersonated_by;
  if (!admin && u.user_id !== s.user_id) { reply.code(403).send({ error: 'Not your database user' }); return null; }
  return u;
}

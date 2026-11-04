import { db } from '../db/index.js';
import { audit } from '../auth/index.js';
import { validateCron, describeCron } from '../lib/cronexpr.js';
import { quotaCheckFor } from '../lib/quota.js';
import { sys } from '../services/index.js';

export default async function (app) {
  app.get('/', { preHandler: [app.requireAuth] }, async (request) => {
    const s = request.gpanelSession;
    const admin = s.role === 'admin' && !s.impersonated_by;
    const scope = admin && !request.query.user ? null : (admin ? Number(request.query.user) : s.user_id);
    const owner = scope === null ? null : db.prepare('SELECT username FROM users WHERE id = ?').get(scope);

    const jobs = scope === null
      ? db.prepare('SELECT cj.*, u.username AS owner FROM cron_jobs cj JOIN users u ON u.id = cj.user_id ORDER BY cj.created_at').all()
      : db.prepare('SELECT * FROM cron_jobs WHERE user_id = ? ORDER BY created_at').all(scope);

    // live crontab lines (to show co-existing foreign entries)
    const crontab = owner ? await sys.cron.list(owner.username).catch(() => '') : '';
    return {
      jobs: jobs.map((j) => ({ ...j, description: describeCron(j.schedule) })),
      crontab,
      foreignLines: owner
        ? crontab.split('\n').filter((l) => l.trim() && !l.includes('gpanel-job:'))
        : []
    };
  });

  app.post('/', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const s = request.gpanelSession;
    const userId = s.role === 'admin' && !s.impersonated_by && request.body?.user_id ? Number(request.body.user_id) : s.user_id;
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!owner) { reply.code(400).send({ error: 'Owner not found' }); return; }

    const pkg = owner.package_id ? db.prepare('SELECT * FROM packages WHERE id = ?').get(owner.package_id) : null;
    const current = db.prepare('SELECT COUNT(*) c FROM cron_jobs WHERE user_id = ?').get(owner.id).c;
    const q = quotaCheckFor(owner, pkg, 'cron', current);
    if (!q.ok) { reply.code(403).send({ error: q.error }); return; }

    const schedule = String(request.body?.schedule || '').trim();
    const v = validateCron(schedule);
    if (v.error) { reply.code(400).send({ error: `Invalid schedule: ${v.error}` }); return; }
    const command = String(request.body?.command || '').trim();
    if (!command || command.length > 1000) { reply.code(400).send({ error: 'Command required (max 1000 chars)' }); return; }

    const res = db.prepare('INSERT INTO cron_jobs (user_id, schedule, command, comment, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(owner.id, schedule, command, String(request.body?.comment || '').slice(0, 200) || null, Date.now());
    await applyCrontab(owner.id).catch((e) => {
      db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(Number(res.lastInsertRowid));
      reply.code(500).send({ error: `crontab write failed: ${e.message}` });
      return;
    });
    audit(s.username, 'cron.create', owner.username, `${schedule} ${command.slice(0, 80)}`, request.ip);
    return { id: Number(res.lastInsertRowid) };
  });

  app.put('/:id', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const job = await ownedJob(request, reply);
    if (!job) return;
    const b = request.body || {};
    if (b.schedule !== undefined) {
      const v = validateCron(String(b.schedule));
      if (v.error) { reply.code(400).send({ error: `Invalid schedule: ${v.error}` }); return; }
      job.schedule = String(b.schedule).trim();
    }
    if (b.command !== undefined && String(b.command).trim()) job.command = String(b.command).trim();
    if (b.comment !== undefined) job.comment = String(b.comment || '').slice(0, 200) || null;
    if (b.enabled !== undefined) job.enabled = b.enabled ? 1 : 0;
    db.prepare('UPDATE cron_jobs SET schedule = ?, command = ?, comment = ?, enabled = ? WHERE id = ?')
      .run(job.schedule, job.command, job.comment, job.enabled, job.id);
    await applyCrontab(job.user_id);
    audit(request.gpanelSession.username, 'cron.update', job.id, null, request.ip);
    return { ok: true };
  });

  app.delete('/:id', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const job = await ownedJob(request, reply);
    if (!job) return;
    db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(job.id);
    await applyCrontab(job.user_id);
    audit(request.gpanelSession.username, 'cron.delete', String(job.id), null, request.ip);
    return { ok: true };
  });

  // validate-only endpoint for the schedule builder UI
  app.post('/validate', { preHandler: [app.requireAuth] }, async (request) => {
    const v = validateCron(String(request.body?.schedule || ''));
    return { valid: !v.error, error: v.error || null, description: describeCron(String(request.body?.schedule || '')) };
  });
}

async function ownedJob(request, reply) {
  const s = request.gpanelSession;
  const job = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(request.params.id);
  if (!job) { reply.code(404).send({ error: 'Cron job not found' }); return null; }
  const admin = s.role === 'admin' && !s.impersonated_by;
  if (!admin && job.user_id !== s.user_id) { reply.code(403).send({ error: 'Not your cron job' }); return null; }
  return job;
}

async function applyCrontab(userId) {
  const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  const jobs = db.prepare('SELECT id, schedule, command, comment, enabled FROM cron_jobs WHERE user_id = ? AND enabled = 1').all(userId);
  await sys.cron.apply(owner.username, jobs);
}

import { sys } from '../services/index.js';
import { db } from '../db/index.js';
import { quotaSummary } from '../lib/quota.js';

export default async function (app) {
  app.get('/summary', { preHandler: [app.requireAuth] }, async (request) => {
    const s = request.gpanelSession;
    const adminView = s.role === 'admin' && !s.impersonated_by;

    const [info, stats, services] = await Promise.all([
      sys.system.info(),
      sys.system.stats(),
      sys.system.services()
    ]);

    // scope data by role
    let userWhere = '';
    const params = [];
    if (!adminView) {
      userWhere = 'WHERE user_id = ?';
      params.push(s.user_id);
    }
    const domainCount = db.prepare(`SELECT COUNT(*) c FROM domains ${userWhere}`).get(...params).c;
    const mailboxCount = db.prepare(
      `SELECT COUNT(*) c FROM mail_accounts ma JOIN mail_domains md ON md.id = ma.mail_domain_id
       JOIN domains d ON d.id = md.domain_id ${userWhere.replace('user_id', 'd.user_id')}`
    ).get(...params).c;
    const dbCount = db.prepare(`SELECT COUNT(*) c FROM databases ${userWhere}`).get(...params).c;
    const backupCount = db.prepare(`SELECT COUNT(*) c FROM backups ${userWhere}`).get(...params).c;
    const userCount = adminView ? db.prepare("SELECT COUNT(*) c FROM users WHERE role='user'").get().c : null;

    // disk usage across scoped domains
    let diskUsed = 0;
    const domains = db.prepare(`SELECT user_id, domain FROM domains ${userWhere}`).all(...params);
    for (const d of domains.slice(0, 50)) {
      const u = db.prepare('SELECT username FROM users WHERE id = ?').get(d.user_id);
      if (u) diskUsed += await sys.files.diskUsage(`/home/${u.username}/domains/${d.domain}`);
    }

    // recent audit (admin sees global, user sees their own actions)
    const auditRows = adminView
      ? db.prepare('SELECT ts, actor, action, target FROM audit_log ORDER BY ts DESC LIMIT 8').all()
      : db.prepare('SELECT ts, actor, action, target FROM audit_log WHERE actor = ? ORDER BY ts DESC LIMIT 8').all(s.username);

    return {
      info, stats, services,
      counts: { domains: domainCount, mailboxes: mailboxCount, databases: dbCount, backups: backupCount, users: userCount },
      diskUsed,
      audit: auditRows,
      history: await (sys.system.history ? sys.system.history(24) : [])
    };
  });

  app.get('/quotas', { preHandler: [app.requireAuth] }, async (request) => {
    const s = request.gpanelSession;
    const userId = s.role === 'admin' && !s.impersonated_by ? (Number(request.query.user) || s.user_id) : s.user_id;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const pkg = user?.package_id ? db.prepare('SELECT * FROM packages WHERE id = ?').get(user.package_id) : null;

    const domains = db.prepare('SELECT COUNT(*) c FROM domains WHERE user_id = ?').get(userId).c;
    const mailboxes = db.prepare(
      'SELECT COUNT(*) c FROM mail_accounts ma JOIN mail_domains md ON md.id = ma.mail_domain_id JOIN domains d ON d.id = md.domain_id WHERE d.user_id = ?'
    ).get(userId).c;
    const databases = db.prepare('SELECT COUNT(*) c FROM databases WHERE user_id = ?').get(userId).c;
    const ftp = db.prepare('SELECT COUNT(*) c FROM ftp_accounts WHERE user_id = ?').get(userId).c;
    const cron = db.prepare('SELECT COUNT(*) c FROM cron_jobs WHERE user_id = ?').get(userId).c;

    const diskBytes = await sys.system.diskUsageHome(db.prepare('SELECT username FROM users WHERE id = ?').get(userId).username);
    const diskMb = Math.round(diskBytes / 1024 / 1024);

    return {
      package: pkg ? { id: pkg.id, name: pkg.name } : null,
      items: quotaSummary(pkg, {
        domains,
        disk_mb: diskMb,
        mailboxes,
        databases,
        ftp,
        cron,
        bandwidth_gb: 0
      }),
      raw: { domains, mailboxes, databases, ftp, cron, disk_mb: diskMb }
    };
  });
}

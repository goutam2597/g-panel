import { db } from '../db/index.js';

export default async function (app) {
  app.get('/', { preHandler: [app.requireAdmin] }, async (request) => {
    const limit = Math.min(500, Number(request.query.limit) || 100);
    const q = String(request.query.q || '').trim();
    let rows;
    if (q) {
      rows = db.prepare(
        `SELECT * FROM audit_log WHERE actor LIKE ? OR action LIKE ? OR target LIKE ? OR detail LIKE ?
         ORDER BY ts DESC LIMIT ?`
      ).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, limit);
    } else {
      rows = db.prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?').all(limit);
    }
    return { entries: rows };
  });
}

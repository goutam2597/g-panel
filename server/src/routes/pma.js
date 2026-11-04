import { db } from '../db/index.js';

/**
 * Token exchange endpoint for the phpMyAdmin signon bridge (gpanel-signon.php).
 * No session auth: the 64-hex one-time token IS the credential. It is burned
 * on first use and expires in 90 seconds — same capability model as the
 * sqlite-reading bridge, but works with any PHP build (no pdo_sqlite needed).
 */
export default async function (app) {
  app.get('/token', async (request, reply) => {
    const token = String(request.query.t || '');
    if (!/^[a-f0-9]{64}$/.test(token)) {
      reply.code(400).send({ error: 'Invalid token' });
      return;
    }
    const row = db.prepare('SELECT mysql_user, mysql_pass, expires FROM pma_tokens WHERE token = ?').get(token);
    db.prepare('DELETE FROM pma_tokens WHERE token = ?').run(token); // one-time use
    if (!row || row.expires < Date.now()) {
      reply.code(403).send({ error: 'Token expired or already used' });
      return;
    }
    return { mysql_user: row.mysql_user, mysql_pass: row.mysql_pass };
  });
}

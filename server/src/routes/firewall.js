import { audit } from '../auth/index.js';
import { sys } from '../services/index.js';
import { validatePort } from '../lib/validate.js';

export default async function (app) {
  app.get('/', { preHandler: [app.requireAdmin] }, async () => {
    const [status, f2b] = await Promise.all([
      sys.firewall.status().catch(() => ({ enabled: false, rules: [] })),
      sys.firewall.fail2ban().catch(() => ({ active: false, jails: [] }))
    ]);
    return { ...status, fail2ban: f2b };
  });

  app.post('/rules', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const b = request.body || {};
    const err = validatePort(b.port);
    if (err) { reply.code(400).send({ error: err }); return; }
    const action = b.action === 'deny' ? 'deny' : 'allow';
    const proto = ['tcp', 'udp', ''].includes(b.proto) ? b.proto : 'tcp';
    try {
      if (action === 'allow') await sys.firewall.allow(b.port, proto, b.from || 'anywhere');
      else await sys.firewall.deny(b.port, proto);
    } catch (e) {
      reply.code(502).send({ error: e.message });
      return;
    }
    audit(request.gpanelSession.username, `firewall.${action}`, String(b.port), proto, request.ip);
    return { ok: true };
  });

  app.delete('/rules/:index', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    try {
      await sys.firewall.deleteByIndex(Number(request.params.index));
    } catch (e) {
      reply.code(502).send({ error: e.message });
      return;
    }
    audit(request.gpanelSession.username, 'firewall.delete', request.params.index, null, request.ip);
    return { ok: true };
  });

  app.post('/toggle', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    try {
      await sys.firewall.setEnabled(Boolean(request.body?.enabled));
    } catch (e) {
      reply.code(502).send({ error: e.message });
      return;
    }
    audit(request.gpanelSession.username, 'firewall.toggle', null, request.body?.enabled ? 'on' : 'off', request.ip);
    return { ok: true };
  });

  app.post('/services/:name/:action', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const allowed = ['nginx', 'bind9', 'postfix', 'dovecot', 'opendkim', 'mariadb', 'vsftpd', 'fail2ban', 'php8.3-fpm', 'php8.2-fpm'];
    const { name, action } = request.params;
    if (!allowed.includes(name) || !['restart', 'reload', 'start', 'stop'].includes(action)) {
      reply.code(400).send({ error: 'Unsupported service action' });
      return;
    }
    try {
      await sys.system[action](name);
    } catch (e) {
      reply.code(502).send({ error: e.message });
      return;
    }
    audit(request.gpanelSession.username, `service.${action}`, name, null, request.ip);
    return { ok: true };
  });
}

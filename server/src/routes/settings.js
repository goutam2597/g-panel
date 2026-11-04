import { allSettings, setSetting } from '../db/index.js';
import { audit } from '../auth/index.js';
import { validateDomain, validateEmail } from '../lib/validate.js';
import { sys } from '../services/index.js';

const EDITABLE = ['hostname', 'server_ip', 'ns1', 'ns2', 'panel_email', 'backup_retention', 'webmail_url', 'pma_url'];

export default async function (app) {
  app.get('/', { preHandler: [app.requireAuth] }, async () => {
    const s = allSettings();
    const publicSettings = {
      hostname: s.hostname,
      server_ip: s.server_ip,
      ns1: s.ns1,
      ns2: s.ns2,
      webmail_url: s.webmail_url,
      pma_url: s.pma_url
    };
    return { settings: publicSettings };
  });

  app.put('/', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const b = request.body || {};
    if (b.hostname !== undefined) {
      const err = validateDomain(String(b.hostname));
      if (err) { reply.code(400).send({ error: `hostname: ${err}` }); return; }
      setSetting('hostname', String(b.hostname).toLowerCase());
    }
    if (b.server_ip !== undefined) {
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(String(b.server_ip))) {
        reply.code(400).send({ error: 'server_ip must be an IPv4 address' });
        return;
      }
      setSetting('server_ip', String(b.server_ip));
    }
    for (const key of ['ns1', 'ns2']) {
      if (b[key] !== undefined) {
        const err = validateDomain(String(b[key]));
        if (err) { reply.code(400).send({ error: `${key}: ${err}` }); return; }
        setSetting(key, String(b[key]).toLowerCase());
      }
    }
    if (b.panel_email !== undefined) {
      const err = validateEmail(String(b.panel_email));
      if (err) { reply.code(400).send({ error: `panel_email: ${err}` }); return; }
      setSetting('panel_email', String(b.panel_email));
    }
    if (b.backup_retention !== undefined) {
      const n = Number(b.backup_retention);
      if (!Number.isInteger(n) || n < 1 || n > 100) { reply.code(400).send({ error: 'backup_retention must be 1-100' }); return; }
      setSetting('backup_retention', n);
    }
    if (b.webmail_url !== undefined) setSetting('webmail_url', String(b.webmail_url || ''));
    if (b.pma_url !== undefined) setSetting('pma_url', String(b.pma_url || ''));

    audit(request.gpanelSession.username, 'settings.update', null, Object.keys(b).join(','), request.ip);
    return { ok: true };
  });

  app.get('/server', { preHandler: [app.requireAdmin] }, async () => {
    const [info, services] = await Promise.all([sys.system.info(), sys.system.services()]);
    return {
      info,
      services,
      updates: await sys.system.updatesCount().catch(() => null),
      storage: await sys.system.storageInfo().catch(() => null)
    };
  });
}

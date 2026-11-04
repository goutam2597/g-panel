import { getSetting, setSetting } from '../db/index.js';
import { audit } from '../auth/index.js';
import { sys } from '../services/index.js';
import { config } from '../config.js';

export default async function (app) {
  app.get('/status', { preHandler: [app.requireAuth] }, async () => {
    const status = await sys.cloudflare.status();
    return { ...status, cf_token_set: Boolean(getSetting('cf_api_token')) };
  });

  app.post('/install', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    try {
      const status = await sys.cloudflare.install();
      audit(request.gpanelSession.username, 'cloudflare.install', null, null, request.ip);
      return status;
    } catch (e) {
      reply.code(502).send({ error: e.message });
      return;
    }
  });

  app.post('/quick/start', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    try {
      const target = request.body?.target || `http://127.0.0.1:${config.webPort}`;
      const status = await sys.cloudflare.quickStart(target);
      audit(request.gpanelSession.username, 'cloudflare.quick.start', status.url, target, request.ip);
      return status;
    } catch (e) {
      reply.code(502).send({ error: e.message });
      return;
    }
  });

  app.post('/named/start', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    try {
      const status = await sys.cloudflare.namedStart(request.body?.token);
      audit(request.gpanelSession.username, 'cloudflare.named.start', null, null, request.ip);
      return status;
    } catch (e) {
      reply.code(502).send({ error: e.message });
      return;
    }
  });

  app.post('/stop', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const status = await sys.cloudflare.stop();
    audit(request.gpanelSession.username, 'cloudflare.stop', null, null, request.ip);
    return status;
  });

  app.get('/logs', { preHandler: [app.requireAuth] }, async () => ({ text: sys.cloudflare.logs() }));

  // ---- Cloudflare API token (enables the DNS record manager) ----
  app.post('/token', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const token = String(request.body?.token || '').trim();
    setSetting('cf_api_token', token);
    try {
      const verify = await sys.cloudflare.cfVerifyToken();
      audit(request.gpanelSession.username, 'cloudflare.token', null, `${verify.zones} zones`, request.ip);
      return { ok: true, ...verify };
    } catch (e) {
      setSetting('cf_api_token', '');
      reply.code(400).send({ error: e.message });
      return;
    }
  });

  app.post('/token/clear', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    setSetting('cf_api_token', '');
    audit(request.gpanelSession.username, 'cloudflare.token.clear', null, null, request.ip);
    return { ok: true };
  });

  // ---- DNS records via Cloudflare API ----
  app.get('/dns/zones', { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      return { zones: await sys.cloudflare.cfZones() };
    } catch (e) {
      reply.code(400).send({ error: e.message });
      return;
    }
  });

  app.get('/dns/zones/:zoneId/records', { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      return { records: await sys.cloudflare.cfRecords(request.params.zoneId) };
    } catch (e) {
      reply.code(400).send({ error: e.message });
      return;
    }
  });

  app.post('/dns/zones/:zoneId/records', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const s = request.gpanelSession;
    const admin = s.role === 'admin' && !s.impersonated_by;
    if (!admin) { reply.code(403).send({ error: 'Administrator access required for DNS changes' }); return; }
    try {
      await sys.cloudflare.cfCreateRecord(request.params.zoneId, request.body || {});
      audit(s.username, 'cloudflare.dns.create', request.body?.name, `${request.body?.type} ${request.body?.content}`, request.ip);
      return { ok: true };
    } catch (e) {
      reply.code(400).send({ error: e.message });
      return;
    }
  });

  app.put('/dns/zones/:zoneId/records/:recordId', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const s = request.gpanelSession;
    const admin = s.role === 'admin' && !s.impersonated_by;
    if (!admin) { reply.code(403).send({ error: 'Administrator access required for DNS changes' }); return; }
    try {
      await sys.cloudflare.cfUpdateRecord(request.params.zoneId, request.params.recordId, request.body || {});
      audit(s.username, 'cloudflare.dns.update', request.body?.name, null, request.ip);
      return { ok: true };
    } catch (e) {
      reply.code(400).send({ error: e.message });
      return;
    }
  });

  app.delete('/dns/zones/:zoneId/records/:recordId', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    try {
      await sys.cloudflare.cfDeleteRecord(request.params.zoneId, request.params.recordId);
      audit(request.gpanelSession.username, 'cloudflare.dns.delete', request.params.recordId, null, request.ip);
      return { ok: true };
    } catch (e) {
      reply.code(400).send({ error: e.message });
      return;
    }
  });
}

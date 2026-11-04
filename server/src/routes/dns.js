import { db, getSetting } from '../db/index.js';
import { audit } from '../auth/index.js';
import { validateDnsRecord, DNS_TYPES } from '../lib/validate.js';
import { sys } from '../services/index.js';
import { bumpAndWriteZone, writeZoneFromDb, createDnsZoneForDomain } from '../services/sites.js';

export default async function (app) {
  // zones visible to the caller
  app.get('/zones', { preHandler: [app.requireAuth] }, async (request) => {
    const s = request.gpanelSession;
    const admin = s.role === 'admin' && !s.impersonated_by;
    const sql = admin && !request.query.user
      ? `SELECT z.id, z.serial, d.id AS domain_id, d.domain, d.user_id, u.username AS owner,
                (SELECT COUNT(*) FROM dns_records r WHERE r.zone_id = z.id) AS record_count
         FROM dns_zones z JOIN domains d ON d.id = z.domain_id JOIN users u ON u.id = d.user_id
         ORDER BY d.domain`
      : `SELECT z.id, z.serial, d.id AS domain_id, d.domain, d.user_id,
                (SELECT COUNT(*) FROM dns_records r WHERE r.zone_id = z.id) AS record_count
         FROM dns_zones z JOIN domains d ON d.id = z.domain_id
         WHERE d.user_id = ? ORDER BY d.domain`;
    const params = admin && !request.query.user ? [] : [admin ? Number(request.query.user) : s.user_id];
    return { zones: db.prepare(sql).all(...params) };
  });

  app.get('/zones/:domainId/records', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const zone = await ownedZone(request, reply);
    if (!zone) return;
    const records = db.prepare("SELECT * FROM dns_records WHERE zone_id = ? ORDER BY CASE type WHEN 'SOA' THEN 0 ELSE 1 END, type, name").all(zone.id);
    return {
      zone: { id: zone.id, domain: zone.domain, serial: zone.serial, domain_id: zone.domain_id },
      records
    };
  });

  app.get('/zones/:domainId/zonefile', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const zone = await ownedZone(request, reply);
    if (!zone) return;
    let text = await sys.dns.readZone(zone.domain);
    if (!text) {
      // self-heal: zone file missing on disk — regenerate from the database
      await writeZoneFromDb(zone.domain_id);
      text = await sys.dns.readZone(zone.domain);
    }
    return { domain: zone.domain, text };
  });

  app.post('/zones/:domainId/records', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const zone = await ownedZone(request, reply);
    if (!zone) return;
    const b = request.body || {};
    const v = validateDnsRecord(b);
    if (v.error) { reply.code(400).send({ error: v.error }); return; }

    if (b.type === 'CNAME' && b.name !== '@') {
      const clash = db.prepare("SELECT id FROM dns_records WHERE zone_id = ? AND name = ? AND type != 'CNAME'").get(zone.id, v.name);
      if (clash) { reply.code(409).send({ error: 'A record with this name already exists (CNAME cannot coexist with other records)' }); return; }
    }
    db.prepare('INSERT INTO dns_records (zone_id, name, type, value, ttl, prio, system) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .run(zone.id, v.name, b.type, v.value, v.ttl, b.type === 'MX' || b.type === 'SRV' ? Number(b.prio) || 0 : null);
    await bumpAndWriteZone(zone.domain_id);
    audit(request.gpanelSession.username, 'dns.record.create', `${zone.domain} ${v.name} ${b.type}`, v.value, request.ip);
    return { ok: true };
  });

  app.put('/zones/:domainId/records/:recId', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const zone = await ownedZone(request, reply);
    if (!zone) return;
    const rec = db.prepare('SELECT * FROM dns_records WHERE id = ? AND zone_id = ?').get(request.params.recId, zone.id);
    if (!rec) { reply.code(404).send({ error: 'Record not found' }); return; }
    if (rec.system) { reply.code(403).send({ error: 'System records (SPF/DKIM/DMARC/mail defaults) are managed by the panel' }); return; }
    const b = request.body || {};
    const v = validateDnsRecord({ type: b.type || rec.type, name: b.name ?? rec.name, value: b.value ?? rec.value, ttl: b.ttl ?? rec.ttl, prio: b.prio ?? rec.prio });
    if (v.error) { reply.code(400).send({ error: v.error }); return; }
    db.prepare('UPDATE dns_records SET name = ?, value = ?, ttl = ?, prio = ? WHERE id = ?')
      .run(v.name, v.value, v.ttl, b.type === 'MX' || rec.type === 'MX' || b.type === 'SRV' || rec.type === 'SRV' ? Number(b.prio ?? rec.prio) || 0 : rec.prio, rec.id);
    await bumpAndWriteZone(zone.domain_id);
    audit(request.gpanelSession.username, 'dns.record.update', `${zone.domain} ${v.name} ${b.type || rec.type}`, v.value, request.ip);
    return { ok: true };
  });

  app.delete('/zones/:domainId/records/:recId', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const zone = await ownedZone(request, reply);
    if (!zone) return;
    const rec = db.prepare('SELECT * FROM dns_records WHERE id = ? AND zone_id = ?').get(request.params.recId, zone.id);
    if (!rec) { reply.code(404).send({ error: 'Record not found' }); return; }
    if (rec.system) { reply.code(403).send({ error: 'System records are managed by the panel (delete the mail domain or edit settings instead)' }); return; }
    db.prepare('DELETE FROM dns_records WHERE id = ?').run(rec.id);
    await bumpAndWriteZone(zone.domain_id);
    audit(request.gpanelSession.username, 'dns.record.delete', `${zone.domain} ${rec.name} ${rec.type}`, rec.value, request.ip);
    return { ok: true };
  });

  // manual zone push (after out-of-band edits)
  app.post('/zones/:domainId/push', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const zone = await ownedZone(request, reply);
    if (!zone) return;
    await writeZoneFromDb(zone.domain_id);
    await bumpAndWriteZone(zone.domain_id);
    audit(request.gpanelSession.username, 'dns.zone.push', zone.domain, null, request.ip);
    return { ok: true };
  });

  // zone file rewrite for a domain without a zone yet (enable DNS)
  app.post('/domains/:domainId/enable', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const s = request.gpanelSession;
    const d = db.prepare('SELECT * FROM domains WHERE id = ?').get(request.params.domainId);
    if (!d) { reply.code(404).send({ error: 'Domain not found' }); return; }
    const admin = s.role === 'admin' && !s.impersonated_by;
    if (!admin && d.user_id !== s.user_id) { reply.code(403).send({ error: 'Not your domain' }); return; }
    const existing = db.prepare('SELECT id FROM dns_zones WHERE domain_id = ?').get(d.id);
    if (existing) { reply.code(409).send({ error: 'Zone already exists' }); return; }
    await createDnsZoneForDomain(d.id, d.domain, getSetting('server_ip'), getSetting('hostname'), getSetting('panel_email'));
    db.prepare('UPDATE domains SET dns_enabled = 1 WHERE id = ?').run(d.id);
    audit(s.username, 'dns.zone.enable', d.domain, null, request.ip);
    return { ok: true };
  });
}

async function ownedZone(request, reply) {
  const s = request.gpanelSession;
  const zone = db.prepare(
    'SELECT z.*, d.domain, d.user_id AS owner_id FROM dns_zones z JOIN domains d ON d.id = z.domain_id WHERE z.domain_id = ?'
  ).get(request.params.domainId);
  if (!zone) { reply.code(404).send({ error: 'DNS zone not found' }); return null; }
  const admin = s.role === 'admin' && !s.impersonated_by;
  if (!admin && zone.owner_id !== s.user_id) { reply.code(403).send({ error: 'Not your zone' }); return null; }
  return zone;
}

export { DNS_TYPES };

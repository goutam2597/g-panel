import fs from 'node:fs';
import { db, getSetting } from '../db/index.js';
import { config } from '../config.js';
import { sys } from './index.js';
import { buildZoneFile, bumpSerial } from '../lib/zonefile.js';
import { ensurePublicHtml, startSiteServer } from './site-server.js';

export function allocateLocalPort() {
  const used = new Set();
  try {
    for (const r of db.prepare('SELECT local_port FROM domains WHERE local_port IS NOT NULL').all()) {
      if (r.local_port) used.add(Number(r.local_port));
    }
  } catch {}
  for (let p = 10000; p < 11000; p++) if (!used.has(p)) return p;
  return 10000;
}

export async function startLocalSite(domainRow) {
  ensurePublicHtml(domainRow.domain, domainRow.docroot);
  const result = await startSiteServer(domainRow.id, domainRow.docroot, domainRow.local_port);
  return result;
}

export async function stopLocalSite(domainId) {
  const { stopSiteServer } = await import('./site-server.js');
  stopSiteServer(domainId);
}

/**
 * Boot-time restore: every domain gets its local server back, and domains
 * that had a tunnel get a fresh one — quick-tunnel hostnames change on each
 * start, so tunnel_url is refreshed in the DB as they come up.
 */
export async function restoreLocalSites() {
  let restored = 0;
  let reconnected = 0;
  const rows = db.prepare('SELECT * FROM domains').all();
  for (const d of rows) {
    if (!d.local_port || !d.docroot) continue;
    try {
      ensurePublicHtml(d.domain, d.docroot);
      await startSiteServer(d.id, d.docroot, d.local_port);
      restored++;
    } catch { /* port race — skip */ }
    if (d.tunnel_url) {
      try {
        const st = await sys.cloudflare.siteTunnelStart(d.id, `http://127.0.0.1:${d.local_port}`);
        if (st.url) {
          db.prepare('UPDATE domains SET tunnel_url = ?, tunnel_status = ? WHERE id = ?').run(st.url, st.status, d.id);
          reconnected++;
        }
      } catch { /* cloudflared missing or offline — sites stay local-only */ }
    }
  }
  return { restored, reconnected };
}

/**
 * Site provisioning orchestration: keeps service drivers dumb and centralizes
 * the create/delete flows so every path (API, future CLI) behaves identically.
 */

export async function ensureLinuxUser(user) {
  const exists = await sys.system.userExists(user.username);
  if (!exists) {
    await sys.system.provisionUser(user.username);
    await sys.system.setShell(user.username, Boolean(user.ssh_enabled));
  }
}

export async function provisionUserEnvironment(user, maxChildren = 8) {
  await ensureLinuxUser(user);
  const versions = await sys.php.versions();
  const docrootBase = config.domainsDir(user.username);
  for (const v of versions) {
    await sys.php.writePool(user.username, v, docrootBase, maxChildren);
  }
}

export async function deprovisionUserEnvironment(user) {
  const versions = await sys.php.versions();
  await sys.php.removePool(user.username, versions);
  await sys.system.deprovisionUser(user.username);
}

/**
 * Create a website: vhost + docroot + PHP pool entry.
 * DNS zone is created by the caller via createDnsZoneForDomain() after the
 * domain row exists — keeps this function idempotent on vhost-only edits.
 */
export async function provisionDomain({ user, domain, type, phpVersion, forceHttps, proxyTarget, localPort }) {
  await ensureLinuxUser(user);

  if (type === 'php') {
    const versions = await sys.php.versions();
    const target = versions.includes(phpVersion) ? phpVersion : versions[0];
    if (target) await sys.php.writePool(user.username, target, config.domainsDir(user.username));
  }

  const docroot = config.webPublic(user.username, domain);
  ensurePublicHtml(domain, docroot);
  try {
    await sys.nginx.writeVhost({
      domain, user: user.username, type,
      docroot,
      phpVersion, forceHttps: Boolean(forceHttps), proxyTarget: proxyTarget || null,
      hasCert: false,
      listenPort: localPort || undefined
    });
  } catch (e) {
    // nginx-for-Windows may be absent locally — the per-domain static server
    // (started by the caller) still serves public_html on the local port.
    console.warn(`[gpanel] nginx vhost skipped for ${domain}: ${e.message}`);
  }

  await ensurePublicHtmlLink(user.username, domain);
  return true;
}

/**
 * cPanel convention: the user's home contains a `public_html` entry that
 * points at their main domain's document root. Created as a junction on
 * Windows (no admin rights needed) or a symlink on Linux.
 */
export async function ensurePublicHtmlLink(username, domain) {
  const link = config.publicHtmlLink(username);
  const target = config.webPublic(username, domain);
  fs.mkdirSync(target, { recursive: true });
  try {
    fs.lstatSync(link);
    return; // already present (points at the main domain)
  } catch { /* does not exist — create below */ }
  try {
    fs.symlinkSync(target, link, 'junction');
  } catch {
    try { fs.symlinkSync(target, link); } catch { /* best effort */ }
  }
}

export async function createDnsZoneForDomain(domainId, domain, serverIp, hostname, panelEmail) {
  const now = Date.now();
  const res = db.prepare('INSERT INTO dns_zones (domain_id, serial, created_at) VALUES (?, ?, ?)').run(domainId, bumpSerial(0), now);
  const zoneId = Number(res.lastInsertRowid);
  const ins = db.prepare('INSERT INTO dns_records (zone_id, name, type, value, ttl, prio, system) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run(zoneId, '@', 'A', serverIp, 3600, null, 1);
  ins.run(zoneId, 'www', 'A', serverIp, 3600, null, 1);
  ins.run(zoneId, '@', 'MX', `mail.${hostname || domain}`, 3600, 10, 1);
  ins.run(zoneId, 'mail', 'A', serverIp, 3600, null, 1);
  ins.run(zoneId, '@', 'TXT', `v=spf1 mx a ip4:${serverIp} ~all`, 3600, null, 1);
  await writeZoneFromDb(domainId);
  return zoneId;
}

/** Regenerate + push the BIND zone file from dns_records (real or sim driver). */
export async function writeZoneFromDb(domainId) {
  const zone = db.prepare('SELECT * FROM dns_zones WHERE domain_id = ?').get(domainId);
  if (!zone) return;
  const domainRow = db.prepare('SELECT domain FROM domains WHERE id = ?').get(domainId);
  const records = db.prepare('SELECT * FROM dns_records WHERE zone_id = ? ORDER BY type, name').all(zone.id);
  const text = buildZoneFile({
    domain: domainRow.domain,
    records,
    serial: zone.serial || bumpSerial(0),
    primaryNs: getSetting('ns1'),
    secondaryNs: getSetting('ns2'),
    adminEmail: getSetting('panel_email')
  });
  await sys.dns.writeZone(domainRow.domain, text);
}

export async function bumpAndWriteZone(domainId) {
  const zone = db.prepare('SELECT * FROM dns_zones WHERE domain_id = ?').get(domainId);
  if (!zone) return;
  const serial = bumpSerial(zone.serial);
  db.prepare('UPDATE dns_zones SET serial = ? WHERE id = ?').run(serial, zone.id);
  await writeZoneFromDb(domainId);
}

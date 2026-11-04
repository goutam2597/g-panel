import fs from 'node:fs';
import { db, getSetting } from '../db/index.js';
import { config } from '../config.js';
import { sys } from './index.js';
import { buildZoneFile, bumpSerial } from '../lib/zonefile.js';

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
export async function provisionDomain({ user, domain, type, phpVersion, forceHttps, proxyTarget }) {
  await ensureLinuxUser(user);

  if (type === 'php') {
    const versions = await sys.php.versions();
    const target = versions.includes(phpVersion) ? phpVersion : versions[0];
    if (target) await sys.php.writePool(user.username, target, config.domainsDir(user.username));
  }

  await sys.nginx.writeVhost({
    domain, user: user.username, type,
    docroot: config.webPublic(user.username, domain),
    phpVersion, forceHttps: Boolean(forceHttps), proxyTarget: proxyTarget || null,
    hasCert: false
  });

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

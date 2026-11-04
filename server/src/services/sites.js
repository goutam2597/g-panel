import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { db, getSetting } from '../db/index.js';
import { config } from '../config.js';
import { sys } from './index.js';
import { buildZoneFile, bumpSerial } from '../lib/zonefile.js';
import { ensureHostsEntries, removeHostsEntries, flushDns } from '../lib/hosts.js';
import { ensurePublicHtml, startSiteServer, startPhpServer, stopPhpServer, phpServerLogs } from './site-server.js';

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

  // PHP / Laravel sites: the dedicated port runs a real PHP server
  // (`php -S` with a generated router — plain PHP and Laravel both work,
  // pretty URLs included). Static sites keep the lightweight Node server.
  const appType = domainRow.type === 'laravel' ? 'laravel' : domainRow.type;
  if (appType === 'php' || appType === 'laravel') {
    try {
      const { findPhpCandidates } = await import('../lib/localstack.js');
      const candidates = await findPhpCandidates();
      if (candidates.length) {
        // prefer a build matching the site's configured PHP version
        let phpBin = candidates[0];
        if (domainRow.php_version) {
          const wanted = `PHP ${domainRow.php_version}`;
          const checks = candidates.map((cand) => {
            
            return new Promise((resolve) => {
              execFile(cand === 'php' ? 'php' : String(cand), ['-v'], { windowsHide: true }, (err, stdout) => {
                resolve(!err && String(stdout || '').includes(wanted) ? cand : null);
              });
            });
          });
          const matches = (await Promise.all(checks)).filter(Boolean);
          if (matches.length) {
            phpBin = matches[0];
          } else {
            phpBin = candidates[candidates.length - 1]; // newest build
          }
        }
        const r = await startPhpServer(domainRow.id, domainRow.docroot, domainRow.local_port, { phpBin });
        if (r.ok) return r;
      }
    } catch (e) {
      console.warn(`[gpanel] PHP server for ${domainRow.domain}: ${String(e.message || e).slice(0, 120)} — falling back to static`);
    }
  }
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
      await startLocalSite(d);
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
 * Site provisioning. In local mode the docroot follows the standalone
 * public_html layout (public_html/<site>, Laravel → public_html/<site>/public)
 * and the domain is registered in the hosts file. In server mode the per-user
 * cPanel layout applies.
 */
export function docrootFor({ user, domain: domainName, type, siteName, appType }) {
  if (config.mode === 'local') {
    const site = siteName || domainName.replace(/\.[a-z]+$/i, '');
    const app = appType || type;
    if (app === 'laravel') return `${config.siteDir(site)}/public`;
    return config.siteDir(site);
  }
  return config.webPublic(user.username, domainName);
}

export async function provisionDomain({ user, domain, type, phpVersion, forceHttps, proxyTarget, localPort }) {
  await ensureLinuxUser(user);

  const appType = type === 'laravel' ? 'laravel' : type;
  const docroot = docrootFor({ user, domain, type: appType, appType });
  fs.mkdirSync(docroot, { recursive: true });
  fs.mkdirSync(path.join(path.dirname(docroot), 'logs'), { recursive: true });

  if (appType === 'php' || appType === 'laravel') {
    const versions = await sys.php.versions();
    const target = versions.includes(phpVersion) ? phpVersion : versions[0];
    if (target) await sys.php.writePool(user.username, target, config.domainsDir(user.username));
  }

  // local mode: register <name>.test in the hosts file so the domain resolves
  if (config.mode === 'local') {
    const r = await ensureHostsEntries([domain, `www.${domain}`]);
    if (r.elevatedError) console.warn(`[gpanel] hosts: ${r.elevatedError.split('\n')[0]}`);
    await flushDns().catch(() => {});
  }

  try {
    await sys.nginx.writeVhost({
      domain, user: user.username, type: appType,
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

  if (config.mode !== 'local') {
    await ensurePublicHtmlLink(user.username, domain);
  }
  return true;
}

/** Remove hosts entries + sites tree for a deleted local site. */
export async function deprovisionLocalSite(domainName, docroot) {
  const r = removeHostsEntries([domainName, `www.${domainName}`]);
  if (r.elevatedError) console.warn(`[gpanel] hosts: ${r.elevatedError.split('\n')[0]}`);
  await flushDns().catch(() => {});
  try {
    fs.rmSync(docroot, { recursive: true, force: true });
  } catch {}
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

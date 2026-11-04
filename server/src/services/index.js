import { DEV, IS_WIN } from '../config.js';

/**
 * Driver registry.
 *  - GPANEL_DEV=1           → in-memory simulator (+ real local MySQL when found)
 *  - Windows (no GPANEL_DEV)→ the real Windows driver set: panel-managed nginx,
 *                             php-cgi, Task Scheduler cron, managed Node apps,
 *                             netsh firewall, bsdtar backups — no mocks.
 *  - Linux (no GPANEL_DEV)  → the real Linux stack drivers (systemd stack).
 */
let drivers;
if (DEV) {
  const sim = (await import('./sim/index.js')).default;
  drivers = sim;
  // Cloudflare tunnel + DNS are real even in dev — they are cross-platform
  // and independent of the hosted services.
  drivers.cloudflare = (await import('./real/cloudflare.js')).default;

  // Real file driver in dev too — the file manager must touch the disk like
  // production (the sim's in-memory VFS is why Files looked like a dummy and
  // showed "No such directory: /" on Windows).
  drivers.files = (await import('./real/files.js')).default;
  if (IS_WIN) {
    try {
      const winNginx = (await import('./win/nginx.js')).default;
      drivers.nginx = winNginx;
    } catch { /* fallback static server still serves sites */ }
    try {
      const winSystem = (await import('./win/system.js')).default;
      drivers.system = winSystem;
    } catch {}
  }

  // Dev databases: the panel owns its own MySQL on a private port (:3307) —
  // never Laragon's :3306. Simulator stays until the panel MySQL is up.
  try {
    const { ensurePanelMySQL, panelDbConfig, MYSQL_PORT } = await import('./win/mysql.js');
    const { configureDb } = await import('./real/db.js');
    await ensurePanelMySQL();
    configureDb(panelDbConfig());
    const realDb = (await import('./real/db.js')).default;
    const version = await realDb.serverVersion();
    if (version) {
      drivers.db = realDb;
      console.log(`[gpanel dev] panel MySQL ${version} on :${MYSQL_PORT} (own server, not Laragon)`);
    }
  } catch (e) {
    console.log(`[gpanel dev] panel MySQL not started (${e.message?.slice(0, 160)}) — database driver stays simulated`);
  }
} else if (IS_WIN) {
  const [
    system, nginx, php, dns, mail, ftp, db, pg, nodeapps, dnsthirdparty,
    ssl, cron, files, ssh, firewall, backup
  ] = await Promise.all([
    import('./win/system.js'),
    import('./win/nginx.js'),
    import('./win/php.js'),
    import('./win/dns.js'),
    import('./win/mail.js'),
    import('./win/ftp.js'),
    import('./real/db.js'),     // cross-platform (TCP root via detected client)
    import('./real/pg.js'),
    import('./win/nodeapps.js'),
    import('./real/dnsthirdparty.js'),
    import('./win/ssl.js'),
    import('./win/cron.js'),
    import('./real/files.js'),  // cross-platform
    import('./win/ssh.js'),
    import('./win/firewall.js'),
    import('./win/backup.js')
  ]);
  drivers = {
    system: system.default,
    nginx: nginx.default,
    php: php.default,
    dns: dns.default,
    mail: mail.default,
    ftp: ftp.default,
    db: db.default,
    pg: pg.default,
    nodeapps: nodeapps.default,
    dnsthirdparty: dnsthirdparty.default,
    ssl: ssl.default,
    cron: cron.default,
    files: files.default,
    ssh: ssh.default,
    firewall: firewall.default,
    backup: backup.default,
    cloudflare: (await import('./real/cloudflare.js')).default
  };

  // Panel-owned MySQL (:3307) — started automatically so databases are real
  // from the first boot, without borrowing Laragon's :3306 data server.
  try {
    const { ensurePanelMySQL, panelDbConfig, MYSQL_PORT } = await import('./win/mysql.js');
    const { configureDb } = await import('./real/db.js');
    await ensurePanelMySQL();
    configureDb(panelDbConfig());
    const v = await drivers.db.serverVersion();
    if (v) console.log(`[gpanel] panel MySQL ${v} on :${MYSQL_PORT}`);
  } catch (e) {
    console.log(`[gpanel] panel MySQL not started (${e.message?.slice(0, 160)})`);
  }
} else {
  const [system, nginx, php, dns, mail, ftp, db, pg, nodeapps, dnsthirdparty, ssl, cron, files, ssh, firewall, backup, cloudflare] = await Promise.all([
    import('./real/system.js'),
    import('./real/nginx.js'),
    import('./real/php.js'),
    import('./real/dns.js'),
    import('./real/mail.js'),
    import('./real/ftp.js'),
    import('./real/db.js'),
    import('./real/pg.js'),
    import('./real/nodeapps.js'),
    import('./real/dnsthirdparty.js'),
    import('./real/ssl.js'),
    import('./real/cron.js'),
    import('./real/files.js'),
    import('./real/ssh.js'),
    import('./real/firewall.js'),
    import('./real/backup.js'),
    import('./real/cloudflare.js')
  ]);
  drivers = {
    system: system.default,
    nginx: nginx.default,
    php: php.default,
    dns: dns.default,
    mail: mail.default,
    ftp: ftp.default,
    db: db.default,
    pg: pg.default,
    nodeapps: nodeapps.default,
    dnsthirdparty: dnsthirdparty.default,
    ssl: ssl.default,
    cron: cron.default,
    files: files.default,
    ssh: ssh.default,
    firewall: firewall.default,
    backup: backup.default,
    cloudflare: cloudflare.default
  };
}

export const sys = drivers;

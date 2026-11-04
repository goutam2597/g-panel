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

  // Dev upgrade: if this machine has a real local MySQL (Laragon/XAMPP/PATH),
  // use the REAL database driver so panel-created users/databases genuinely
  // exist — and the original phpMyAdmin SSO works end-to-end against them.
  try {
    const { findMysqlClient } = await import('../lib/localstack.js');
    const { configureDb } = await import('./real/db.js');
    const client = await findMysqlClient();
    if (client) {
      configureDb({
        bin: client.bin,
        dumpBin: client.dumpBin,
        baseArgs: ['-h', process.env.GPANEL_MYSQL_HOST || '127.0.0.1', '-P', process.env.GPANEL_MYSQL_PORT || '3306', '-uroot']
      });
      const realDb = (await import('./real/db.js')).default;
      const version = await realDb.serverVersion();
      if (version) {
        drivers.db = realDb;
        console.log(`[gpanel dev] using real local MySQL ${version} (${client.bin})`);
      }
    }
  } catch (e) {
    console.log(`[gpanel dev] local MySQL not used (${e.message?.slice(0, 120)}) — database driver stays simulated`);
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

  // real local MySQL (Laragon/XAMPP/MySQL installer) — the database driver
  // is genuinely functional on Windows from the first boot.
  try {
    const { findMysqlClient } = await import('../lib/localstack.js');
    const { configureDb } = await import('./real/db.js');
    const client = await findMysqlClient();
    if (client) {
      configureDb({ bin: client.bin, dumpBin: client.dumpBin, baseArgs: ['-h', '127.0.0.1', '-P', '3306', '-uroot'] });
      const v = await drivers.db.serverVersion();
      if (v) console.log(`[gpanel] local MySQL ${v} detected (${client.bin})`);
    }
  } catch { /* user can set GPANEL_MYSQL_HOST later */ }
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

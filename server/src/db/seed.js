import crypto from 'node:crypto';
import { db, getSetting, setSetting } from './index.js';
import { hashPassword, mailPasswordHash, generatePassword } from '../lib/passwords.js';
import { DEV, config } from '../config.js';
import { sys } from '../services/index.js';

export async function seed() {
  const now = Date.now();

  // default package
  let pkg = db.prepare('SELECT * FROM packages WHERE name = ?').get('Standard');
  if (!pkg) {
    db.prepare(
      `INSERT INTO packages (name, max_domains, max_disk_mb, max_mailboxes, max_databases, max_ftp, max_cron, max_bandwidth_gb, created_at)
       VALUES ('Standard', 5, 10240, 10, 5, 5, 5, 100, ?)`
    ).run(now);
    pkg = db.prepare('SELECT * FROM packages WHERE name = ?').get('Standard');
  }

  // settings defaults
  const defaults = {
    hostname: 'server1.example.com',
    server_ip: '203.0.113.10',
    ns1: 'ns1.example.com',
    ns2: 'ns2.example.com',
    panel_email: 'admin@example.com',
    backup_retention: 5,
    webmail_url: '',
    pma_url: ''
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (!getSetting(k)) setSetting(k, v);
  }

  // admin user
  const adminExists = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!adminExists) {
    const initialPassword = process.env.GPANEL_ADMIN_PASSWORD || (DEV ? 'gpanel-admin' : generatePassword(20));
    db.prepare(
      `INSERT INTO users (username, email, password_hash, role, package_id, created_at) VALUES ('admin', ?, ?, 'admin', NULL, ?)`
    ).run(getSetting('panel_email'), hashPassword(initialPassword), now);
    if (!DEV) {
      // The installer surfaces this once; it is overwritten on first login change.
      console.log(`[gpanel] initial admin password: ${initialPassword}`);
      setSetting('initial_admin_password', initialPassword);
    }
  }

  // demo data in dev mode so the UI is alive on first login
  if (DEV) await seedDevDemo(now, pkg.id);
}

async function seedDevDemo(now, standardPkgId) {
  // dev-only convenience URLs so integration links are visible in the demo
  setSetting('pma_url', 'https://pma.server1.example.com');
  setSetting('webmail_url', 'https://webmail.server1.example.com');

  const has = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (has > 1) return;

  const insertUser = db.prepare(
    'INSERT INTO users (username, email, password_hash, role, package_id, ssh_enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
  );
  const res = insertUser.run('johndoe', 'john@doe-labs.com', hashPassword('johndoe123'), 'user', standardPkgId, now);
  const userId = Number(res.lastInsertRowid);

  const insDomain = db.prepare(
    'INSERT INTO domains (user_id, domain, type, docroot, php_version, force_https, ssl_state, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
  );
  const d1 = insDomain.run(userId, 'doe-labs.com', 'php', config.webPublic('johndoe', 'doe-labs.com'), '8.3', 'letsencrypt', now);
  const d2 = insDomain.run(userId, 'shop-doe.com', 'php', config.webPublic('johndoe', 'shop-doe.com'), '8.2', 'none', now);

  for (const domainId of [Number(d1.lastInsertRowid), Number(d2.lastInsertRowid)]) {
    const zoneRes = db.prepare('INSERT INTO dns_zones (domain_id, serial, created_at) VALUES (?, ?, ?)').run(domainId, 2026010100, now);
    const zoneId = Number(zoneRes.lastInsertRowid);
    const insRec = db.prepare('INSERT INTO dns_records (zone_id, name, type, value, ttl, prio, system) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insRec.run(zoneId, '@', 'A', '203.0.113.10', 3600, null, 0);
    insRec.run(zoneId, 'www', 'A', '203.0.113.10', 3600, null, 0);
    insRec.run(zoneId, '@', 'MX', 'mail.doe-labs.com', 3600, 10, 1);
    insRec.run(zoneId, '@', 'TXT', 'v=spf1 mx a ip4:203.0.113.10 ~all', 3600, null, 1);
  }

  const md = db.prepare('INSERT INTO mail_domains (domain_id, created_at) VALUES (?, ?)').run(Number(d1.lastInsertRowid), now);
  db.prepare('INSERT INTO mail_accounts (mail_domain_id, address, password, quota_mb, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(Number(md.lastInsertRowid), 'john@doe-labs.com', mailPasswordHash('MailPass123!'), 1024, now);

  db.prepare('INSERT INTO ftp_accounts (user_id, username, password, domain, directory, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, 'johndoe_deploy', hashPassword('FtpPass123!'), 'doe-labs.com', '/', now);

  const dbRes = db.prepare('INSERT INTO databases (user_id, name, created_at) VALUES (?, ?, ?)').run(userId, 'johndoe_wordpress', now);
  const dbu = db.prepare('INSERT INTO db_users (user_id, name, password, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, 'johndoe_wp', 'DbPass123!', now);
  db.prepare('INSERT INTO db_grants (db_user_id, database_id) VALUES (?, ?)').run(Number(dbu.lastInsertRowid), Number(dbRes.lastInsertRowid));

  // dev with a real local MySQL (Laragon): make the demo data real so sizes,
  // phpMyAdmin and deletion all behave exactly like on the server
  try {
    await sys.db.createDatabase('johndoe_wordpress');
    await sys.db.createDbUser('johndoe_wp', 'DbPass123!');
    await sys.db.grant('johndoe_wp', 'johndoe_wordpress');
  } catch { /* sim driver or no local MySQL — demo rows only */ }

  db.prepare('INSERT INTO cron_jobs (user_id, schedule, command, comment, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, '0 3 * * *', '/usr/local/bin/backup-site.sh', 'Nightly site backup', now);

  db.prepare('INSERT INTO ssh_keys (user_id, name, public_key, fingerprint, added_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, 'workstation', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB4xXcgYVptLkGZmUlDkYCGvB0VfNqOZ0eZmZqM3JqVz john@workstation', 'SHA256:xX9kP2VzQ', now);

  db.prepare('INSERT INTO backups (user_id, filename, size_bytes, includes, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, 'johndoe-2026-01-15.tar.gz', 245684223, 'all', 'done', now - 86400000 * 3);
}

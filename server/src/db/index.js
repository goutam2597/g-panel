import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const dbPath = path.join(config.dataDir, 'panel.db');
export const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// The database holds mail + database-user secrets: keep it group-readable by
// www-data only (phpMyAdmin signon bridge reads it), never world-readable.
if (!config.dev) {
  try {
    fs.chmodSync(dbPath, 0o640);
    fs.chownSync(dbPath, 0, 33); // root:www-data
  } catch { /* best-effort; installer also enforces */ }
}

export function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    max_domains INTEGER NOT NULL DEFAULT 1,
    max_disk_mb INTEGER NOT NULL DEFAULT 1024,
    max_mailboxes INTEGER NOT NULL DEFAULT 5,
    max_databases INTEGER NOT NULL DEFAULT 2,
    max_ftp INTEGER NOT NULL DEFAULT 2,
    max_cron INTEGER NOT NULL DEFAULT 2,
    max_bandwidth_gb INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    package_id INTEGER REFERENCES packages(id),
    ssh_enabled INTEGER NOT NULL DEFAULT 1,
    suspended INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    impersonated_by INTEGER,
    csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT,
    ua TEXT
  );
  CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 'php',
    docroot TEXT NOT NULL,
    php_version TEXT NOT NULL DEFAULT '8.3',
    proxy_target TEXT,
    force_https INTEGER NOT NULL DEFAULT 1,
    dns_enabled INTEGER NOT NULL DEFAULT 1,
    ssl_state TEXT NOT NULL DEFAULT 'none',
    ssl_expiry INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dns_zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id INTEGER NOT NULL UNIQUE REFERENCES domains(id) ON DELETE CASCADE,
    serial INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dns_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zone_id INTEGER NOT NULL REFERENCES dns_zones(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    value TEXT NOT NULL,
    ttl INTEGER NOT NULL DEFAULT 3600,
    prio INTEGER,
    system INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS mail_domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id INTEGER NOT NULL UNIQUE REFERENCES domains(id) ON DELETE CASCADE,
    dkim_selector TEXT NOT NULL DEFAULT 'gpanel',
    dkim_private TEXT,
    dkim_public TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mail_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mail_domain_id INTEGER NOT NULL REFERENCES mail_domains(id) ON DELETE CASCADE,
    address TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    quota_mb INTEGER NOT NULL DEFAULT 1024,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ftp_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    domain TEXT NOT NULL,
    directory TEXT NOT NULL DEFAULT '/',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS databases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL UNIQUE,
    engine TEXT NOT NULL DEFAULT 'mysql',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS db_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    engine TEXT NOT NULL DEFAULT 'mysql',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS node_apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    domain TEXT NOT NULL,
    port INTEGER NOT NULL UNIQUE,
    startup_file TEXT NOT NULL DEFAULT 'app.js',
    node_version TEXT NOT NULL DEFAULT '22',
    status TEXT NOT NULL DEFAULT 'stopped',
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, name)
  );
  CREATE TABLE IF NOT EXISTS pma_tokens (
    token TEXT PRIMARY KEY,
    mysql_user TEXT NOT NULL,
    mysql_pass TEXT NOT NULL,
    panel_user TEXT NOT NULL,
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS site_domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    domain TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'custom',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS db_grants (
    db_user_id INTEGER NOT NULL REFERENCES db_users(id) ON DELETE CASCADE,
    database_id INTEGER NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
    PRIMARY KEY (db_user_id, database_id)
  );
  CREATE TABLE IF NOT EXISTS cron_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    schedule TEXT NOT NULL,
    command TEXT NOT NULL,
    comment TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ssh_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    public_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    added_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    includes TEXT NOT NULL DEFAULT 'all',
    status TEXT NOT NULL DEFAULT 'done',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stats_samples (
    ts INTEGER PRIMARY KEY,
    cpu REAL, mem_used REAL, mem_total REAL,
    disk_used REAL, disk_total REAL,
    net_rx REAL, net_tx REAL, load1 REAL
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    ip TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_dns_records_zone ON dns_records(zone_id);
  CREATE INDEX IF NOT EXISTS idx_domains_user ON domains(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
  `);

  // lightweight column migrations for databases created before v1.1
  addColumnIfMissing('databases', 'engine', "TEXT NOT NULL DEFAULT 'mysql'");
  addColumnIfMissing('db_users', 'engine', "TEXT NOT NULL DEFAULT 'mysql'");
  // local/dev per-domain serving: dedicated loopback port + Cloudflare tunnel
  addColumnIfMissing('domains', 'local_port', 'INTEGER');
  addColumnIfMissing('domains', 'tunnel_url', 'TEXT');
  addColumnIfMissing('domains', 'tunnel_status', "TEXT NOT NULL DEFAULT 'none'");
  addColumnIfMissing('domains', 'app_type', "TEXT NOT NULL DEFAULT 'php'");
  addColumnIfMissing('domains', 'site_name', 'TEXT');
  addColumnIfMissing('domains', 'db_name', 'TEXT');
  addColumnIfMissing('domains', 'db_user', 'TEXT');
}

function addColumnIfMissing(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function allSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

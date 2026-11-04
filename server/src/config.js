import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const DEV = process.env.GPANEL_DEV === '1' || process.env.GPANEL_DEV === 'true';
export const IS_WIN = process.platform === 'win32';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

// Where the panel keeps everything it owns. On a Windows install this is a
// real, writable directory (never /var/lib) — the site tree, nginx/php stack,
// cloudflared and the SQLite database all live under it.
export const ROOT_DIR = DEV
  ? repoRoot
  : IS_WIN
    ? (process.env.GPANEL_HOME || 'C:/gpanel')
    : null;

const DATA_DIR = DEV
  ? path.join(ROOT_DIR, '.devdata')
  : IS_WIN
    ? path.join(ROOT_DIR, 'data')
    : '/var/lib/gpanel';

export const config = {
  dev: DEV,
  isWin: IS_WIN,
  version: '1.2.0',
  port: parseInt(process.env.GPANEL_PORT || '2083', 10),
  webPort: parseInt(process.env.GPANEL_WEB_PORT || '80', 10),
  host: process.env.GPANEL_HOST || '0.0.0.0',

  // Hosting mode:
  //  - 'local'  → standalone local server (Windows desktop/server, Linux desktop):
  //               flat public_html/<site>/ tree, <name>.test local domains via the
  //               hosts file, single admin, Cloudflare Tunnel for public domains.
  //  - 'server' → multi-tenant hosting provider mode (Linux VPS): per-user homes,
  //               BIND DNS, mail/FTP, package quotas — the cPanel-provider flow.
  mode: process.env.GPANEL_MODE || (IS_WIN ? 'local' : 'server'),

  // Panel data (SQLite db, sites tree, stack binaries)
  dataDir: DATA_DIR,
  etcDir: DEV ? path.join(ROOT_DIR, '.devdata', 'etc') : IS_WIN ? path.join(ROOT_DIR, 'data', 'etc') : '/etc/gpanel',

  // Panel-owned service stack (nginx-for-Windows, php, cloudflared on Windows)
  stackDir: IS_WIN ? path.join(ROOT_DIR, 'stack') : null,

  // Local-mode site storage: <dataDir>/public_html/<site> (the cPanel-style
  // public_html root for the whole server, as the spec requires)
  publicHtmlDir: path.join(DATA_DIR, 'public_html').replace(/\\/g, '/'),
  siteDir: (site) => `${config.publicHtmlDir}/${site}`,
  siteDocroot: (site, appType = 'php') => appType === 'laravel'
    ? `${config.siteDir(site)}/public`
    : `${config.siteDir(site)}`,

  // Isolation model: on Linux every panel user is a real unix user. On
  // Windows the sites tree is panel-owned under dataDir/home.
  homeDir: (user) => IS_WIN
    ? path.join(config.dataDir, 'home', String(user)).replace(/\\/g, '/')
    : `/home/${user}`,
  domainsDir: (user) => `${config.homeDir(user)}/domains`,
  webPublic: (user, domain) => `${config.domainsDir(user)}/${domain}/public_html`,
  // cPanel-style: the user's home carries a public_html entry pointing at
  // their main domain's document root (junction on Windows, symlink on Linux)
  publicHtmlLink: (user) => `${config.homeDir(user)}/public_html`,

  // System paths used by the real Linux drivers on the VPS
  paths: {
    panelDb: DEV ? null : IS_WIN ? path.join(DATA_DIR, 'panel.db') : '/var/lib/gpanel/panel.db',
    nginxAvailable: '/etc/nginx/sites-available/gpanel',
    nginxEnabled: '/etc/nginx/sites-enabled',
    nginxMimeConf: '/etc/nginx/snippets/gpanel-extras.conf',
    bindZones: '/etc/bind/zones',
    bindZoneConf: '/etc/bind/named.conf.local',
    phpPools: (version) => `/etc/php/${version}/fpm/pool.d`,
    vsftpdUsers: '/etc/vsftpd/gpanel.users',
    vsftpdUserDb: '/etc/vsftpd/gpanel.users.db',
    vsftpdUserConf: '/etc/vsftpd/gpanel.d',
    opendkimKeys: '/etc/opendkim/keys',
    backupsDir: '/home/gpanel-backups',
    vmailDir: '/home/vmail',
    letsencryptLive: (domain) => `/etc/letsencrypt/live/${domain}/cert.pem`,
    webRoot: (user, domain) => `${config.domainsDir(user)}/${domain}`,
    webPublic: (user, domain) => `${config.domainsDir(user)}/${domain}/public_html`,
    userLogs: (user) => `${config.homeDir(user)}/logs`,
    authorizedKeys: (user) => `${config.homeDir(user)}/.ssh/authorized_keys`,
    panelRootKey: '/root/.ssh/gpanel_panel_ed25519'
  },

  session: {
    cookieName: 'gpanel_session',
    ttlHours: parseInt(process.env.GPANEL_SESSION_HOURS || '24', 10),
    secureCookie: !DEV // on the VPS the panel serves https via its own TLS terminator
  },

  // Optional native TLS: set GPANEL_TLS_CERT / GPANEL_TLS_KEY to serve https
  // directly from the panel (the installer wires a self-signed or LE cert).
  tls: process.env.GPANEL_TLS_CERT && process.env.GPANEL_TLS_KEY
    ? {
        cert: fs.readFileSync(process.env.GPANEL_TLS_CERT),
        key: fs.readFileSync(process.env.GPANEL_TLS_KEY)
      }
    : null,

  limits: {
    maxUploadMb: parseInt(process.env.GPANEL_MAX_UPLOAD_MB || '512', 10),
    loginAttempts: 5,
    loginLockMinutes: 10
  }
};

if (DEV) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.etcDir, { recursive: true });
} else if (IS_WIN) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.etcDir, { recursive: true });
  fs.mkdirSync(config.stackDir, { recursive: true });
}

export const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpanel-'));

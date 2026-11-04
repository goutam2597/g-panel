// Dev-mode simulator: implements the exact same driver interface as the real
// services but entirely in-memory, so the panel runs end-to-end on a
// workstation (GPANEL_DEV=1). Data structures mimic what the real drivers
// would leave on disk.

import { buildVhost, buildPhpPool } from '../../lib/vhost-template.js';
import { generatePassword } from '../../lib/passwords.js';
import { config } from '../../config.js';

// ---------------- virtual filesystem ----------------
class VNode {
  constructor(type, { content = '', mode = '644', mtime = Date.now() } = {}) {
    this.type = type; // 'dir' | 'file'
    this.content = content;
    this.mode = mode;
    this.mtime = mtime;
    this.children = type === 'dir' ? new Map() : null;
  }
  size() { return this.type === 'file' ? Buffer.byteLength(this.content) : 0; }
}

const vroot = new VNode('dir', { mode: '755' });

function normalize(p) {
  const parts = [];
  for (const seg of String(p).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return '/' + parts.join('/');
}

function getNode(p) {
  let node = vroot;
  for (const seg of normalize(p).split('/').slice(1)) {
    if (!node || node.type !== 'dir') return null;
    node = node.children.get(seg);
  }
  return node;
}

function getDir(p, { create = false } = {}) {
  let node = vroot;
  for (const seg of normalize(p).split('/').slice(1)) {
    let next = node.children.get(seg);
    if (!next && create) {
      next = new VNode('dir', { mode: '755' });
      node.children.set(seg, next);
    }
    if (!next) return null;
    node = next;
  }
  return node;
}

function putFile(p, content, mode = '644') {
  const dir = getDir(normalize(p).split('/').slice(0, -1).join('/') || '/', { create: true });
  const name = normalize(p).split('/').pop();
  dir.children.set(name, new VNode('file', { content, mode, mtime: Date.now() }));
}

function seedWebsite(user, domain, kind = 'php') {
  const base = `${config.domainsDir(user)}/${domain}`;
  putFile(`${base}/public_html/index.html`, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Welcome to ${domain}</title>
  <style>
    body { font-family: Georgia, serif; max-width: 44rem; margin: 4rem auto; padding: 0 1.5rem; color: #1a1c20; line-height: 1.6; }
    h1 { font-size: 2rem; margin-bottom: .5rem; }
    .badge { display: inline-block; background: #0E6B5A; color: #fff; font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; padding: .3rem .7rem; border-radius: 3px; }
  </style>
</head>
<body>
  <span class="badge">Deployed via G-Panel</span>
  <h1>${domain}</h1>
  <p>This site is being served by nginx and managed by G-Panel. Upload your files to <code>public_html</code> via the file manager, FTP or SSH.</p>
</body>
</html>
`);
  if (kind === 'php') {
    putFile(`${base}/public_html/info.php`, `<?php\nphpinfo();\n`);
    putFile(`${base}/public_html/wp-config-sample.php`, `<?php\n// Sample WordPress config\n define('DB_NAME', 'database_name_here');\n`);
  }
  getDir(`${base}/logs`, { create: true });
  getDir(`${base}/ssl`, { create: true });
  putFile(`${base}/logs/${domain}-access.log`, sampleAccessLog(domain, 40));
  putFile(`${base}/logs/${domain}-error.log`, `2026/01/12 03:11:04 [error] 812#812: *3 open() "${base}/public_html/favicon.ico" failed (2: No such file or directory), client: 198.51.100.7, request: "GET /favicon.ico HTTP/1.1"\n`);
}

function sampleAccessLog(domain, n) {
  const ips = ['198.51.100.7', '203.0.113.44', '192.0.2.88', '198.51.100.201'];
  const paths = ['/', '/about', '/pricing', '/wp-login.php', '/assets/style.css', '/favicon.ico', '/api/v1/status'];
  const agents = ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/128.0', 'curl/8.5.0'];
  const lines = [];
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const t = new Date(now - i * 640000);
    const day = t.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const time = t.toLocaleTimeString('en-GB', { hour12: false });
    const ip = ips[i % ips.length];
    const path = paths[i % paths.length];
    const status = path === '/favicon.ico' ? 404 : 200;
    const bytes = 300 + ((i * 977) % 24000);
    lines.push(`${ip} - - [${day}/${t.getFullYear()}:${time} +0000] "GET ${path} HTTP/1.1" ${status} ${bytes} "-" "${agents[i % agents.length]}"`);
  }
  return lines.join('\n') + '\n';
}

// ---------------- state ----------------
const state = {
  zones: new Map(),        // domain -> {serial, text}
  dkim: new Map(),         // domain -> {private, public}
  ftpUsers: new Map(),     // username -> plaintext password (simulating the pam db)
  mariadbSizes: new Map(), // dbname -> MB
  pgSizes: new Map(),      // pg dbname -> MB
  nodeApps: new Map(),     // "user/app" -> {status, logs}
  certs: new Map(),        // domain -> {kind, issuer, expiry}
  ufw: { enabled: true, rules: [
    { index: 1, port: '22/tcp', action: 'ALLOW', from: 'Anywhere' },
    { index: 2, port: '80/tcp', action: 'ALLOW', from: 'Anywhere' },
    { index: 3, port: '443/tcp', action: 'ALLOW', from: 'Anywhere' },
    { index: 4, port: '53', action: 'ALLOW', from: 'Anywhere' },
    { index: 5, port: '2083/tcp', action: 'ALLOW', from: 'Anywhere' },
    { index: 6, port: '21/tcp', action: 'ALLOW', from: 'Anywhere' },
    { index: 7, port: '49152:49520/tcp', action: 'ALLOW', from: 'Anywhere' }
  ] },
  crontabs: new Map(),     // user -> text
  authKeys: new Map(),     // user -> [keys]
  panelKeys: new Set(),
  statsHistory: [],
  vhosts: new Map(),
  pools: new Map()
};

function seedStats() {
  const now = Date.now();
  for (let i = 288; i >= 0; i--) {
    const ts = now - i * 5 * 60 * 1000;
    const phase = Math.sin((ts / 3600000) * 2) * 12;
    state.statsHistory.push({
      ts,
      cpu: Math.max(2, Math.min(95, 22 + phase + Math.sin(ts / 600000) * 8 + (Math.random() * 6 - 3))),
      memUsed: 4.2e9 + Math.sin(ts / 7200000) * 8e8 + Math.random() * 1e8,
      memTotal: 8 * 1024 * 1024 * 1024,
      diskUsed: 38.5e9 + Math.random() * 2e8,
      diskTotal: 80 * 1024 * 1024 * 1024,
      netRx: Math.max(1e4, 2.4e6 + phase * 1e5 + Math.random() * 3e5),
      netTx: Math.max(1e4, 5.1e6 + phase * 2e5 + Math.random() * 5e5),
      load1: Math.max(0.05, 0.6 + phase / 40 + Math.random() * 0.2)
    });
  }
}
seedStats();

// ---------------- drivers ----------------
const system = {
  async info() {
    return {
      hostname: 'gpanel-demo',
      platform: 'linux',
      distro: 'Ubuntu 24.04 LTS (simulated)',
      kernel: '6.8.0-45-generic',
      arch: 'x86_64',
      uptime: 61 * 24 * 3600 + 4211,
      cpuModel: 'Intel Xeon E5-2680 v4 @ 2.40GHz',
      cpuCount: 4,
      totalMem: 8 * 1024 * 1024 * 1024,
      panelVersion: '1.0.0'
    };
  },
  async stats() {
    const last = state.statsHistory[state.statsHistory.length - 1];
    const jitter = (v, a) => Math.max(0, v + (Math.random() * 2 - 1) * a);
    const s = {
      ts: Date.now(),
      cpu: Math.round(jitter(last.cpu, 5) * 10) / 10,
      memUsed: jitter(last.memUsed, 1e8),
      memTotal: last.memTotal,
      diskUsed: last.diskUsed,
      diskTotal: last.diskTotal,
      netRx: jitter(last.netRx, 4e5),
      netTx: jitter(last.netTx, 6e5),
      load1: Math.round(jitter(last.load1, 0.15) * 100) / 100,
      load5: Math.round(jitter(last.load1, 0.1) * 100) / 100,
      load15: Math.round(jitter(last.load1, 0.05) * 100) / 100
    };
    state.statsHistory.push(s);
    if (state.statsHistory.length > 400) state.statsHistory.shift();
    return s;
  },
  history(hours = 24) {
    const since = Date.now() - hours * 3600 * 1000;
    return state.statsHistory.filter((s) => s.ts >= since);
  },
  async services() {
    return [
      { name: 'nginx', label: 'Web server', active: true, enabled: true, state: 'active' },
      { name: 'php8.3-fpm', label: 'PHP 8.3 (FPM)', active: true, enabled: true, state: 'active' },
      { name: 'php8.2-fpm', label: 'PHP 8.2 (FPM)', active: true, enabled: true, state: 'active' },
      { name: 'bind9', label: 'DNS (BIND)', active: true, enabled: true, state: 'active' },
      { name: 'postfix', label: 'Mail transfer (SMTP)', active: true, enabled: true, state: 'active' },
      { name: 'dovecot', label: 'Mail delivery (IMAP/POP3)', active: true, enabled: true, state: 'active' },
      { name: 'opendkim', label: 'DKIM signing', active: true, enabled: true, state: 'active' },
      { name: 'mariadb', label: 'Databases (MariaDB)', active: true, enabled: true, state: 'active' },
      { name: 'vsftpd', label: 'FTP server', active: true, enabled: true, state: 'active' },
      { name: 'fail2ban', label: 'Intrusion prevention', active: true, enabled: true, state: 'active' },
      { name: 'ufw', label: 'Firewall', active: true, enabled: true, state: 'active' }
    ];
  },
  async restart(name) { return true; },
  async reload(name) { return true; },
  async start(name) { return true; },
  async stop(name) { return true; },
  async updatesCount() { return 7; },
  async provisionUser(user) {
    getDir(`${config.domainsDir(user)}`, { create: true });
    getDir(`${config.homeDir(user)}/logs`, { create: true });
    getDir(`${config.homeDir(user)}/.ssh`, { create: true });
    return true;
  },
  async deprovisionUser(user) {
    const home = getNode(`${config.homeDir(user)}`);
    if (home) getDir('/home').children.delete(user);
    state.crontabs.delete(user);
    state.authKeys.delete(user);
    return true;
  },
  async setShell(user, enabled) { state.shell = state.shell || {}; state.shell[user] = enabled; return true; },
  async diskUsageHome(user) {
    // deterministic-ish per user
    let h = 0;
    for (const c of user) h = (h * 31 + c.charCodeAt(0)) % 4096;
    return 120e6 + h * 3.1e6;
  },
  async userExists() { return true; }
};

const nginx = {
  async writeVhost(opts) {
    const text = buildVhost({ ...opts, hasCert: opts.hasCert || state.certs.has(opts.domain) });
    state.vhosts.set(opts.domain, text);
    putFile(`/etc/nginx/sites-available/gpanel/${opts.domain}.conf`, text);
    seedWebsite(opts.user, opts.domain, opts.type === 'php' ? 'php' : 'html');
    return true;
  },
  async removeVhost(domain) {
    state.vhosts.delete(domain);
    return true;
  },
  async readLog(domain, kind = 'access', lines = 200) {
    const node = getNode(`/home/*/logs/${domain}-${kind}.log`) || findFirstLog(domain, kind);
    if (!node) return '';
    return node.content.split('\n').slice(-lines).join('\n');
  },
  async trafficMonth(domain) {
    const node = findFirstLog(domain, 'access');
    if (!node) return 4.2e9;
    return node.content.split('\n').reduce((s, l) => s + (parseInt(l.match(/"\s(\d+)\s"-/)?.[1] || 0, 10)), 0) + 3.8e9;
  },
  async test() { return true; }
};

// regex matching "<domainsDir>/<user>/<domain>/public_html" on any platform
function sitePathRe() {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = config.domainsDir('USER').split('USER');
  return new RegExp('^' + parts.map(esc).join('([^/]+)') + '/([^/]+)/public_html$', 'i');
}

function findFirstLog(domain, kind) {
  // walk /home/*/logs
  const home = getDir('/home');
  for (const [uname, unode] of home.children) {
    const logs = unode.children?.get('logs');
    const f = logs?.children?.get(`${domain}-${kind}.log`);
    if (f) return f;
  }
  return null;
}

const php = {
  async versions() { return ['8.3', '8.2']; },
  async writePool(user, version, docrootBase, maxChildren = 8) {
    state.pools.set(`${user}@${version}`, buildPhpPool({ user, phpVersion: version, docrootBase, maxChildren }));
    return true;
  },
  async removePool(user, versions) {
    for (const v of versions) state.pools.delete(`${user}@${v}`);
    return true;
  },
  async reload(version) { return true; }
};

const dns = {
  async addZone(domain, primaryNs, secondaryNs) { return true; },
  async removeZone(domain) { state.zones.delete(domain); return true; },
  async writeZone(domain, zoneText) {
    state.zones.set(domain, zoneText);
    return true;
  },
  async readZone(domain) {
    return state.zones.get(domain) || '';
  }
};

const mail = {
  async provisionDomain(domain, selector = 'gpanel') {
    // plausible 2048-bit DKIM-looking keys
    const priv = `-----BEGIN PRIVATE KEY-----\n${b64block(24)}\n-----END PRIVATE KEY-----`;
    const pub = `v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA${b64line(3)}IDAQAB`;
    state.dkim.set(domain, { selector, private: priv, public: pub });
    return { privateKey: priv, publicKey: pub };
  },
  async deprovisionDomain(domain) { state.dkim.delete(domain); return true; },
  async provisionUser(domain, local) {
    getDir(`/home/vmail/${domain}/${local}/Maildir/cur`, { create: true });
    getDir(`/home/vmail/${domain}/${local}/Maildir/new`, { create: true });
    getDir(`/home/vmail/${domain}/${local}/Maildir/tmp`, { create: true });
    return true;
  },
  async deprovisionUser(domain, local) {
    const d = getDir(`/home/vmail/${domain}`);
    d?.children.delete(local);
    return true;
  },
  async mailboxUsage(domain, local) { return 12e6 + (local.length * 977e3) % 8e7; }
};

function b64line(chars) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let s = '';
  for (let i = 0; i < chars; i++) s += abc[(i * 37 + 11) % 64];
  return s;
}
function b64block(lines) {
  return Array.from({ length: lines }, (_, i) => b64line(64)).join('\n');
}

const ftp = {
  async syncUsers(rows, usersWithPlaintext = {}) {
    for (const [u, p] of Object.entries(usersWithPlaintext)) state.ftpUsers.set(u, p);
    for (const r of rows) if (!state.ftpUsers.has(r.username)) state.ftpUsers.set(r.username, generatePassword(12));
    for (const u of [...state.ftpUsers.keys()]) {
      if (!rows.some((r) => r.username === u)) state.ftpUsers.delete(u);
    }
    return true;
  }
};

const db = {
  async createDatabase(name) { state.mariadbSizes.set(name, 0.2); return true; },
  async dropDatabase(name) { state.mariadbSizes.delete(name); return true; },
  async createDbUser(name, password) { return true; },
  async dropDbUser(name) { return true; },
  async setDbUserPassword(name, password) { return true; },
  async grant(dbUser, dbName) { return true; },
  async revokeAll(dbUser) { return true; },
  async listSizes() {
    // grow sizes slightly over time for realism
    const out = {};
    for (const [name, size] of state.mariadbSizes) {
      const s = Math.max(0.1, size + Math.random() * 4);
      state.mariadbSizes.set(name, s);
      out[name] = Math.round(s * 10) / 10;
    }
    return out;
  },
  async dumpDatabase(name, toFile) { putFile(toFile, `-- MariaDB dump ${name}\n-- simulated\n`); return true; },
  async serverVersion() { return '11.4.3-MariaDB-1ubuntu4 (simulated)'; }
};

const pg = {
  async createDatabase(name) { state.pgSizes.set(name, 0.2); return true; },
  async dropDatabase(name) { state.pgSizes.delete(name); return true; },
  async createDbUser(name, password) { return true; },
  async dropDbUser(name) { return true; },
  async setDbUserPassword(name, password) { return true; },
  async grant(dbUser, dbName) { return true; },
  async revokeAll(dbUser, dbName) { return true; },
  async listSizes() {
    const out = {};
    for (const [name, size] of state.pgSizes) {
      const s = Math.max(0.1, size + Math.random() * 2);
      state.pgSizes.set(name, s);
      out[name] = Math.round(s * 10) / 10;
    }
    return out;
  },
  async dumpDatabase(name, toFile) { putFile(toFile, `-- PostgreSQL dump ${name}\n-- simulated\n`); return true; },
  async serverVersion() { return 'PostgreSQL 16.4 (simulated)'; }
};

const nodeapps = {
  unitName(username, appName) { return `gp-node-${username}-${appName}`; },
  appDir(username, appName) { return `/home/${username}/apps/${appName}`; },
  async create({ username, appName, port, startupFile }) {
    getDir(this.appDir(username, appName), { create: true });
    putFile(`${this.appDir(username, appName)}/${startupFile || 'app.js'}`,
      `const http = require('node:http');\nconst port = process.env.PORT || 3000;\nhttp.createServer((req, res) => {\n  res.end('Hello from ${appName} (simulated)');\n}).listen(port);\nconsole.log('${appName} listening on', port);\n`);
    state.nodeApps.set(`${username}/${appName}`, { status: 'running', logs: sampleNodeLogs(appName, port) });
    return true;
  },
  async start(username, appName) { const a = state.nodeApps.get(`${username}/${appName}`); if (a) a.status = 'running'; return true; },
  async stop(username, appName) { const a = state.nodeApps.get(`${username}/${appName}`); if (a) a.status = 'stopped'; return true; },
  async restart(username, appName) { const a = state.nodeApps.get(`${username}/${appName}`); if (a) a.status = 'running'; return true; },
  async status(username, appName) { return state.nodeApps.get(`${username}/${appName}`)?.status || 'stopped'; },
  async remove(username, appName) { state.nodeApps.delete(`${username}/${appName}`); return true; },
  async npmInstall(username, appName) {
    return { output: `added 62 packages in 4s (simulated npm install for ${appName})` };
  },
  async logs(username, appName) {
    return state.nodeApps.get(`${username}/${appName}`)?.logs || 'no log output yet';
  },
  async nodeVersions() { return [{ version: '22.11', path: '/usr/bin/node' }]; }
};

function sampleNodeLogs(appName, port) {
  const lines = [];
  const now = Date.now();
  for (let i = 8; i >= 0; i--) {
    const t = new Date(now - i * 3600000).toISOString();
    lines.push(`${t} ${appName}[1204]: ${appName} listening on ${port}`);
    if (i % 3 === 0) lines.push(`${t} ${appName}[1204]: GET / 200 12ms`);
  }
  return lines.join('\n');
}

const dnsthirdparty = {
  async check(domain) {
    const ns1 = 'ns1.example.com';
    const ns2 = 'ns2.example.com';
    const serverIp = '203.0.113.10';
    // doe-labs.com simulates a properly-delegated domain; everything else pending
    const delegated = domain === 'doe-labs.com';
    const nsFound = delegated ? [ns1, ns2] : ['ns1.registrar-dns.net'];
    const aRecords = delegated ? [serverIp] : [];
    return {
      domain,
      expected: { ns1, ns2, serverIp },
      found: {
        ns: nsFound,
        a: aRecords,
        www: delegated ? [serverIp] : [],
        mx: delegated ? [`10 mail.${domain}.`] : []
      },
      checks: [
        { key: 'ns', label: 'Nameservers point here', ok: delegated, detail: nsFound.join(', ') },
        { key: 'a', label: `A record → ${serverIp}`, ok: delegated, detail: aRecords.join(', ') || 'no A record found yet' },
        { key: 'www', label: `www → ${serverIp}`, ok: delegated, detail: delegated ? serverIp : 'no www record found yet' }
      ],
      delegated: delegated
    };
  }
};

const ssl = {
  async issue(domain, email) {
    const cert = {
      kind: 'letsencrypt',
      issuer: "Let's Encrypt (simulated)",
      subject: domain,
      validFrom: Date.now(),
      expiry: Date.now() + 90 * 86400 * 1000
    };
    state.certs.set(domain, cert);
    return cert;
  },
  async issueSelfSigned(domain) {
    const cert = { kind: 'selfsigned', issuer: 'G-Panel self-signed', subject: domain, validFrom: Date.now(), expiry: Date.now() + 3650 * 86400 * 1000 };
    state.certs.set(domain, cert);
    return cert;
  },
  async certInfo(domain) {
    const c = state.certs.get(domain);
    if (!c) return null;
    return { ...c, validFrom: new Date(c.validFrom).toISOString(), expiry: c.expiry };
  },
  async renewAll() { return true; }
};

const cron = {
  async list(user) { return state.crontabs.get(user) || ''; },
  async apply(user, jobs) {
    const lines = jobs.filter((j) => j.enabled).map((j) => `${j.schedule} ${j.command}${j.comment ? ` # gpanel-job:${j.comment}` : ''}`);
    state.crontabs.set(user, lines.join('\n') + (lines.length ? '\n' : ''));
    return true;
  }
};

const files = {
  async list(dir) {
    // lazily seed website content for DB-registered demo domains
    const m = normalize(dir).match(sitePathRe());
    if (m && !getNode(dir)) seedWebsite(m[1], m[2], 'php');
    const node = getNode(dir);
    if (!node || node.type !== 'dir') throw new Error(`No such directory: ${dir}`);
    const out = [];
    for (const [name, child] of node.children) {
      out.push({
        name,
        type: child.type,
        size: child.size(),
        mode: child.mode,
        mtime: child.mtime,
        owner: 'user'
      });
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  },
  async read(file) {
    const node = getNode(file);
    if (!node || node.type !== 'file') throw new Error(`No such file: ${file}`);
    if (node.size() > 4 * 1024 * 1024) throw new Error('File exceeds 4 MB edit limit — download and edit locally');
    return typeof node.content === 'string' ? node.content : Buffer.from(node.content).toString('utf8');
  },
  async write(file, content) {
    const existing = getNode(file);
    putFile(file, content, existing?.mode || '644');
    return true;
  },
  async mkdir(dir) { getDir(dir, { create: true }); return true; },
  async remove(p) {
    const parent = getDir(normalize(p).split('/').slice(0, -1).join('/') || '/');
    if (parent) parent.children.delete(normalize(p).split('/').pop());
    return true;
  },
  async rename(from, to) {
    const node = getNode(from);
    if (!node) throw new Error(`No such file: ${from}`);
    const newParent = getDir(normalize(to).split('/').slice(0, -1).join('/') || '/', { create: true });
    newParent.children.set(normalize(to).split('/').pop(), node);
    const oldParent = getDir(normalize(from).split('/').slice(0, -1).join('/') || '/');
    oldParent.children.delete(normalize(from).split('/').pop());
    return true;
  },
  async chmod(p, mode) {
    const node = getNode(p);
    if (node) node.mode = String(mode);
    return true;
  },
  async extract(archive, destDir) {
    getDir(destDir, { create: true });
    putFile(`${destDir}/extracted-readme.txt`, `Extracted from ${archive} (simulated).\n`);
    return true;
  },
  async diskUsage(dir) {
    let total = 0;
    const walk = (node) => {
      if (node.type === 'file') total += node.size();
      else for (const c of node.children.values()) walk(c);
    };
    const node = getNode(dir);
    if (node) walk(node);
    return total + 118e6; // base site weight so quota bars move
  },
  exists(p) { return Boolean(getNode(p)); },
  putFile, getNode, getDir, putFileRaw: putFile
};

const ssh = {
  async syncAuthorizedKeys(user, keys) {
    state.authKeys.set(user, keys);
    putFile(`/home/${user}/.ssh/authorized_keys`, keys.join('\n') + (keys.length ? '\n' : ''), '600');
    return true;
  },
  async ensurePanelKey(user = 'root') {
    state.panelKeys.add(user);
    return `/var/lib/gpanel/keys/${user}`;
  }
};

const firewall = {
  async status() {
    return { enabled: state.ufw.enabled, rules: state.ufw.rules.map((r) => ({ ...r })) };
  },
  async allow(port, proto = 'tcp', from = 'anywhere') {
    state.ufw.rules.push({ index: state.ufw.rules.length + 1, port: proto ? `${port}/${proto}` : String(port), action: 'ALLOW', from: from === 'anywhere' ? 'Anywhere' : from });
    return true;
  },
  async deny(port, proto = 'tcp') {
    state.ufw.rules.push({ index: state.ufw.rules.length + 1, port: `${port}/${proto}`, action: 'DENY', from: 'Anywhere' });
    return true;
  },
  async deleteByIndex(index) {
    state.ufw.rules = state.ufw.rules.filter((r) => r.index !== index);
    return true;
  },
  async setEnabled(on) { state.ufw.enabled = on; return true; },
  async fail2ban() {
    return {
      active: true,
      jails: [
        { jail: 'sshd', currentlyBanned: 2, totalBanned: 184 },
        { jail: 'postfix', currentlyBanned: 0, totalBanned: 41 },
        { jail: 'dovecot', currentlyBanned: 1, totalBanned: 67 },
        { jail: 'vsftpd', currentlyBanned: 0, totalBanned: 3 }
      ]
    };
  }
};

const backup = {
  backupDir(user) { return `/home/gpanel-backups/${user}`; },
  async create(user) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const filename = `${user}-${stamp}.tar.gz`;
    const filepath = `/home/gpanel-backups/${user}/${filename}`;
    putFile(filepath, `SIMULATED BACKUP ${filename}\n`.repeat(400));
    return { filename, filepath, size: 1.8e8 + Math.floor(Math.random() * 4e7) };
  },
  filepath(user, filename) { return `/home/gpanel-backups/${user}/${filename}`; },
  async remove(user, filename) {
    const dir = getDir(`/home/gpanel-backups/${user}`);
    dir?.children.delete(filename);
    return true;
  }
};

export default { system, nginx, php, dns, mail, ftp, db, pg, nodeapps, dnsthirdparty, ssl, cron, files, ssh, firewall, backup, __simState: state };

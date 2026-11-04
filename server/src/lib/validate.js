// Shared validators. Pure functions — safe to unit-test.

const RESERVED_USERS = new Set([
  'root', 'bin', 'daemon', 'sys', 'adm', 'tty', 'disk', 'lp', 'mail', 'news',
  'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'gnats', 'nobody',
  'systemd-network', 'systemd-resolve', 'messagebus', 'sshd', 'bind', 'postfix',
  'dovecot', 'dovenull', 'vmail', 'mysql', 'redis', 'postgres', 'gpanel',
  'gpanel-backups', 'opendkim', 'debian-spamd', 'ftp', 'firebird', 'www',
  'admin', 'administrator', 'panel', 'host', 'server', 'support', 'abuse',
  'postmaster', 'webmaster', 'hostmaster', 'nfsnobody', 'shutdown', 'halt',
  'sync', 'games', 'man', 'lpadmin', 'ssl-cert', 'sasl', 'vsftpd', 'nginx'
]);

const RESERVED_DOMAINS = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'invalid',
  'example.com', 'example.net', 'example.org', 'test', 'panel'
]);

export function validateUsername(name) {
  if (typeof name !== 'string') return 'Username is required';
  if (!/^[a-z][a-z0-9]{2,31}$/.test(name)) {
    return 'Username must be 3-32 chars: lowercase letters/digits, starting with a letter';
  }
  if (RESERVED_USERS.has(name)) return `"${name}" is a reserved system name`;
  return null;
}

export function validateDomain(domain) {
  if (typeof domain !== 'string') return 'Domain is required';
  const d = domain.trim().toLowerCase();
  if (d.length < 3 || d.length > 253) return 'Domain length must be 3-253 characters';
  if (RESERVED_DOMAINS.has(d)) return `"${d}" is reserved`;
  if (/^[\d.]+$/.test(d)) return 'Use the server IP, not a bare IP literal, as a domain';
  // one or more labels, each 1-63 chars, alnum + hyphen (not leading/trailing),
  // final label at least 2 alpha chars. Underscores are NOT valid for hostnames.
  const labels = d.split('.');
  if (labels.length < 2) return 'Domain must include a TLD (e.g. example.com)';
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) return 'Invalid domain label length';
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) {
      return 'Domain contains invalid characters (letters, digits and hyphens only)';
    }
  }
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1])) return 'Invalid TLD';
  return null;
}

export function validateEmail(email) {
  if (typeof email !== 'string' || email.length < 3 || email.length > 254) return 'Email is required';
  if (!/^[^\s@]+@([^\s@.]+\.)+[a-z]{2,}$/i.test(email)) return 'Invalid email address';
  return null;
}

export function validateMailboxLocalPart(local) {
  if (typeof local !== 'string') return 'Mailbox name is required';
  if (!/^[a-z0-9]([a-z0-9._+-]{0,63}[a-z0-9])?$/.test(local)) {
    return 'Mailbox name may contain letters, digits, dots, dashes, underscores (+)';
  }
  if (['abuse', 'postmaster', 'root'].includes(local)) return `"${local}" is reserved`;
  return null;
}

export function validateDbName(name, username) {
  if (typeof name !== 'string') return 'Name is required';
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(name)) {
    return 'Name must be 1-48 chars: lowercase letters, digits, underscores';
  }
  const full = `${username}_${name}`;
  if (full.length > 64) return `Full name ${full} exceeds MySQL's 64-char limit`;
  return null;
}

export function validatePort(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return 'Port must be 1-65535';
  return null;
}

export function validatePathSafe(requestedPath, allowedRoots) {
  // Returns absolute normalized path or error string.
  // Accepts POSIX absolute paths and Windows drive-letter paths (F:/…).
  if (typeof requestedPath !== 'string') return { error: 'Path is required' };
  const isWinPath = /^[a-z]:[\\/]/i.test(requestedPath);
  if (!requestedPath.startsWith('/') && !isWinPath) {
    return { error: 'Path must be absolute' };
  }
  const norm = pathNormalize(requestedPath);
  for (const root of allowedRoots) {
    const r = pathNormalize(root);
    if (r === '/' || norm === r || norm.startsWith(r + '/')) return { path: norm };
  }
  return { error: 'Path is outside your allowed directories' };
}

function pathNormalize(p) {
  p = String(p).replace(/\\/g, '/');
  // Windows drive-letter paths keep their drive prefix (f:/g-panel/…)
  const drive = p.match(/^([a-z]:)(\/.*)$/i);
  const parts = [];
  for (const seg of (drive ? drive[2] : p).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  const body = '/' + parts.join('/');
  return drive ? drive[1].toLowerCase() + body : body;
}

export const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'];

export function validateDnsRecord({ type, name, value, ttl, prio }) {
  if (!DNS_TYPES.includes(type)) return { error: `Unsupported record type ${type}` };
  if (typeof name !== 'string' || !/^(@|\*|([a-z0-9_*-]{1,100}))$/i.test(name)) {
    return { error: 'Invalid record name' };
  }
  const t = Number(ttl) || 3600;
  if (t < 60 || t > 86400 * 7) return { error: 'TTL must be 60s - 7 days' };

  const v = String(value || '').trim();
  switch (type) {
    case 'A':
      if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(v) ||
          v.split('.').some((o) => +o > 255)) return { error: 'Invalid IPv4 address' };
      break;
    case 'AAAA':
      if (!/^[0-9a-f:]{2,45}$/i.test(v) || !v.includes(':')) return { error: 'Invalid IPv6 address' };
      break;
    case 'MX':
      if (!prio && prio !== 0) return { error: 'MX records need a priority' };
      if (+prio < 0 || +prio > 65535) return { error: 'Priority must be 0-65535' };
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) return { error: 'MX value must be a hostname' };
      break;
    case 'CNAME':
    case 'NS':
      if (!/^[a-z0-9._-]+\.[a-z]{2,}$/i.test(v)) return { error: `${type} value must be a hostname` };
      break;
    case 'SRV':
      if (!prio && prio !== 0) return { error: 'SRV records need a priority' };
      if (!/^\d+\s+\d+\s+\S+$/.test(v)) return { error: 'SRV value: "weight port target"' };
      break;
    case 'CAA':
      if (!/^\d+\s+(issue|issuewild|iodef)\s+"[^"]*"$/.test(v)) {
        return { error: 'CAA value: "0 issue \"letsencrypt.org\""' };
      }
      break;
    case 'TXT':
      if (v.length < 1 || v.length > 4096) return { error: 'TXT value must be 1-4096 chars' };
      break;
  }
  return { value: v, ttl: t, name: name.toLowerCase() === '@' ? '@' : name.toLowerCase() };
}

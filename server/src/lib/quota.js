// Quota engine: checks package limits against current usage.
// Pure over passed-in counts — unit-testable.

export function quotaCheck(pkg, resource, currentCount) {
  // pkg: {max_domains, max_disk_mb, ...}; resource: string; current: number
  const key = `max_${resource}`;
  const max = pkg ? pkg[key] : null;
  if (max === null || max === undefined) return { ok: false, error: 'No package assigned — ask the administrator' };
  if (max < 0) return { ok: true }; // negative = unlimited
  if (currentCount >= max) {
    return { ok: false, error: `Package limit reached (${max} ${resource.replace(/_/g, ' ')} allowed)` };
  }
  return { ok: true };
}

/** Quota check with admin bypass: administrator accounts are never limited. */
export function quotaCheckFor(owner, pkg, resource, currentCount) {
  if (owner?.role === 'admin') return { ok: true };
  return quotaCheck(pkg, resource, currentCount);
}

export function quotaSummary(pkg, usage) {
  // usage: {domains, disk_mb, mailboxes, databases, ftp, cron, bandwidth_gb}
  const items = [
    ['Domains', usage.domains, pkg?.max_domains],
    ['Disk', usage.disk_mb, pkg?.max_disk_mb, 'mb'],
    ['Mailboxes', usage.mailboxes, pkg?.max_mailboxes],
    ['Databases', usage.databases, pkg?.max_databases],
    ['FTP accounts', usage.ftp, pkg?.max_ftp],
    ['Cron jobs', usage.cron, pkg?.max_cron],
    ['Bandwidth (mo)', usage.bandwidth_gb, pkg?.max_bandwidth_gb, 'gb']
  ];
  return items.map(([label, used, max, unit]) => {
    const unlimited = max === null || max === undefined || max < 0;
    const pct = unlimited ? 0 : max === 0 ? (used > 0 ? 100 : 0) : Math.min(100, (used / max) * 100);
    return {
      label,
      used: Math.round((used || 0) * 100) / 100,
      max: unlimited ? null : max,
      unit: unit || 'count',
      pct: Math.round(pct),
      state: pct >= 95 ? 'critical' : pct >= 80 ? 'warn' : 'ok'
    };
  });
}

export function formatBytes(bytes) {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const str = i === 0 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1);
  return `${str} ${units[i]}`;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotaCheck, quotaCheckFor, quotaSummary, formatBytes } from '../src/lib/quota.js';

const pkg = {
  max_domains: 5,
  max_disk_mb: 1024,
  max_mailboxes: 10,
  max_databases: 2,
  max_ftp: -1,      // unlimited
  max_cron: 0       // blocked entirely
};

test('quotaCheck enforces limits', () => {
  assert.deepEqual(quotaCheck(pkg, 'domains', 4), { ok: true });
  assert.ok(!quotaCheck(pkg, 'domains', 5).ok);
  assert.ok(!quotaCheck(null, 'domains', 0).ok, 'no package = blocked');
  assert.deepEqual(quotaCheck(pkg, 'ftp', 999), { ok: true }, 'unlimited');
  assert.ok(!quotaCheck(pkg, 'cron', 0).ok, 'zero limit blocks');
});

test('quotaCheckFor bypasses for admins', () => {
  const admin = { role: 'admin' };
  assert.deepEqual(quotaCheckFor(admin, null, 'domains', 100), { ok: true });
  const user = { role: 'user' };
  assert.ok(!quotaCheckFor(user, null, 'domains', 0).ok);
  assert.deepEqual(quotaCheckFor(user, pkg, 'ftp', 50), { ok: true });
});

test('quotaSummary computes percentages and states', () => {
  const items = quotaSummary(pkg, {
    domains: 5, disk_mb: 900, mailboxes: 3, databases: 1, ftp: 7, cron: 0, bandwidth_gb: 0
  });
  const byLabel = Object.fromEntries(items.map((i) => [i.label, i]));
  assert.equal(byLabel['Domains'].pct, 100);
  assert.equal(byLabel['Domains'].state, 'critical');
  assert.ok(byLabel['Disk'].pct > 85 && byLabel['Disk'].pct < 90);
  assert.equal(byLabel['Disk'].state, 'warn');
  assert.equal(byLabel['FTP accounts'].max, -1 === -1 ? null : -1);
  assert.equal(byLabel['Cron jobs'].max, 0);
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5 GB');
  assert.equal(formatBytes(null), '—');
});

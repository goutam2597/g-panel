import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildZoneFile, bumpSerial } from '../src/lib/zonefile.js';

const base = {
  domain: 'example.com',
  records: [
    { name: '@', type: 'A', value: '203.0.113.10', ttl: 3600 },
    { name: 'www', type: 'A', value: '203.0.113.10', ttl: 3600 },
    { name: '@', type: 'MX', value: 'mail.example.com', prio: 10, ttl: 3600 },
    { name: '@', type: 'TXT', value: 'v=spf1 mx ~all', ttl: 3600 },
    { name: 'docs', type: 'CNAME', value: 'example.com', ttl: 3600 }
  ],
  serial: 2026110300,
  primaryNs: 'ns1.example.com',
  secondaryNs: 'ns2.example.com',
  adminEmail: 'hostmaster@example.com'
};

test('zone file contains SOA with serial and NS records', () => {
  const zone = buildZoneFile(base);
  assert.match(zone, /\$ORIGIN example\.com\./);
  assert.match(zone, /IN\s+SOA\s+ns1\.example\.com\.\s+hostmaster\.example\.com\./);
  assert.match(zone, /2026110300/);
  assert.match(zone, /IN\s+NS\s+ns1\.example\.com\./);
  assert.match(zone, /IN\s+NS\s+ns2\.example\.com\./);
});

test('zone file formats records correctly', () => {
  const zone = buildZoneFile(base);
  assert.match(zone, /@\s+3600\s+IN\s+A\s+203\.0\.113\.10/);
  assert.match(zone, /www\s+3600\s+IN\s+A\s+203\.0\.113\.10/);
  assert.match(zone, /@\s+3600\s+IN\s+MX\s+10\s+mail\.example\.com\./);
  assert.match(zone, /@\s+3600\s+IN\s+TXT\s+"v=spf1 mx ~all"/);
  assert.match(zone, /docs\s+3600\s+IN\s+CNAME\s+example\.com\./);
});

test('TXT values with quotes are escaped', () => {
  const zone = buildZoneFile({ ...base, records: [{ name: '@', type: 'TXT', value: 'say "hi"' }] });
  assert.match(zone, /"say \\"hi\\""/);
});

test('serial bumps monotonically', () => {
  const now = new Date('2026-11-03T10:00:00Z');
  assert.equal(bumpSerial(0, now), 2026110300);
  assert.equal(bumpSerial(2026110300, now), 2026110301);
  assert.equal(bumpSerial(2025110350, now), 2026110300); // old serial resets to date-based
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateUsername, validateDomain, validateEmail, validateMailboxLocalPart,
  validateDbName, validatePathSafe, validateDnsRecord, validatePort
} from '../src/lib/validate.js';

test('username: accepts valid, rejects invalid', () => {
  assert.equal(validateUsername('johndoe'), null);
  assert.equal(validateUsername('a1b2c3'), null);
  assert.ok(validateUsername('Jo'));            // too short / uppercase
  assert.ok(validateUsername('1abc'));          // starts with digit
  assert.ok(validateUsername('john doe'));      // space
  assert.ok(validateUsername('root'));          // reserved
  assert.ok(validateUsername('www-data'));      // reserved
  assert.ok(validateUsername('j'.repeat(33)));  // too long
});

test('domain: accepts valid, rejects invalid', () => {
  assert.equal(validateDomain('example.com'), 'is-reserved' && validateDomain('example.com')); // RFC 2606 reserved
  assert.equal(validateDomain('acme-hosting.net'), null);
  assert.equal(validateDomain('sub.acme-hosting.co.uk'), null);
  assert.equal(validateDomain('my-shop.io'), null);
  assert.ok(validateDomain('localhost'));
  assert.ok(validateDomain('example'));          // no tld
  assert.ok(validateDomain('-bad.com'));
  assert.ok(validateDomain('bad-.com'));
  assert.ok(validateDomain('under_score.com'));  // underscore not valid hostname
  assert.ok(validateDomain('203.0.113.10'));     // bare IP
  assert.ok(validateDomain('a..b.com'));
});

test('email validation', () => {
  assert.equal(validateEmail('john@example.com'), null);
  assert.ok(validateEmail('nope'));
  assert.ok(validateEmail('a@b'));
  assert.ok(validateEmail(''));
});

test('mailbox local part', () => {
  assert.equal(validateMailboxLocalPart('hello'), null);
  assert.equal(validateMailboxLocalPart('john.doe+news'), null);
  assert.ok(validateMailboxLocalPart('.starts-dot'));
  assert.ok(validateMailboxLocalPart('postmaster'));
  assert.ok(validateMailboxLocalPart('SP ACE'));
});

test('db name', () => {
  assert.equal(validateDbName('wordpress', 'johndoe'), null);
  assert.equal(validateDbName('wp2_beta', 'johndoe'), null);
  assert.ok(validateDbName('Wordpress', 'johndoe'));
  assert.ok(validateDbName('1abc', 'johndoe'));
  assert.ok(validateDbName('x'.repeat(60), 'johndoe')); // exceeds 64 with prefix
});

test('path safety', () => {
  const roots = ['/home/johndoe/domains'];
  assert.equal(validatePathSafe('/home/johndoe/domains/site/public_html', roots).path,
    '/home/johndoe/domains/site/public_html');
  assert.equal(validatePathSafe('/home/johndoe/domains/../johndoe2/x', roots).error,
    'Path is outside your allowed directories');
  assert.ok(validatePathSafe('relative/path', roots).error);
  // traversal via ..
  const r = validatePathSafe('/home/johndoe/domains/../../etc/passwd', roots);
  assert.ok(r.error, 'traversal must be rejected');
  // root escape for admin root '/'
  assert.equal(validatePathSafe('/etc/nginx/nginx.conf', ['/']).path, '/etc/nginx/nginx.conf');
  assert.equal(validatePathSafe('/home/../etc/x', ['/']).path, '/etc/x');
});

test('dns record validation', () => {
  assert.equal(validateDnsRecord({ type: 'A', name: '@', value: '203.0.113.10', ttl: 3600 }).value, '203.0.113.10');
  assert.ok(validateDnsRecord({ type: 'A', name: '@', value: '999.1.1.1' }).error);
  assert.ok(validateDnsRecord({ type: 'A', name: '@', value: 'not-an-ip' }).error);
  assert.ok(validateDnsRecord({ type: 'MX', name: '@', value: 'mail.example.com' }).error, 'MX needs prio');
  const mx = validateDnsRecord({ type: 'MX', name: '@', value: 'mail.example.com', prio: 10 });
  assert.equal(mx.value, 'mail.example.com');
  assert.ok(validateDnsRecord({ type: 'TXT', name: '@', value: 'x'.repeat(5000) }).error);
  assert.ok(validateDnsRecord({ type: 'BOGUS', name: '@', value: 'x' }).error);
  assert.ok(validateDnsRecord({ type: 'A', name: '@', value: '1.2.3.4', ttl: 10 }).error, 'ttl too low');
  const srv = validateDnsRecord({ type: 'SRV', name: '_sip', value: '5 5060 sip.example.com', prio: 1 });
  assert.equal(srv.value, '5 5060 sip.example.com');
});

test('port validation', () => {
  assert.equal(validatePort(443), null);
  assert.equal(validatePort('80'), null);
  assert.ok(validatePort(0));
  assert.ok(validatePort(70000));
  assert.ok(validatePort('abc'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, mailPasswordHash, generatePassword } from '../src/lib/passwords.js';

test('scrypt hash roundtrip', () => {
  const hash = hashPassword('Correct-Horse-1');
  assert.match(hash, /^scrypt\$/);
  assert.equal(verifyPassword('Correct-Horse-1', hash), true);
  assert.equal(verifyPassword('wrong', hash), false);
  assert.equal(verifyPassword('', hash), false);
  assert.equal(verifyPassword('x', 'garbage'), false);
});

test('mail password is dovecot SSHA512 format', () => {
  const h = mailPasswordHash('MailPass123!');
  assert.match(h, /^\{SSHA512\}[A-Za-z0-9+/=]+$/);
  const raw = Buffer.from(h.slice('{SSHA512}'.length), 'base64');
  assert.equal(raw.length, 64 + 8); // sha512 digest + 8-byte salt
});

test('generatePassword length and charset', () => {
  const pw = generatePassword(20);
  assert.equal(pw.length, 20);
  assert.match(pw, /^[abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%]+$/);
  assert.notEqual(generatePassword(20), pw);
});

import crypto from 'node:crypto';

/**
 * Panel + FTP password hashing: scrypt with per-hash random salt.
 * Format: scrypt$N$r$p$saltB64$hashB64
 */
export function hashPassword(password) {
  const N = 16384, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Mail password in Dovecot-compatible SSHA512 format:
 * {SSHA512}base64(hash(salt+password) + salt)
 * Dovecot verifies this natively (passdb sqlite returns this string).
 */
export function mailPasswordHash(password) {
  const salt = crypto.randomBytes(8);
  const hash = crypto.createHash('sha512').update(salt).update(password).digest();
  return '{SSHA512}' + Buffer.concat([hash, salt]).toString('base64');
}

export function generatePassword(length = 16) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function token(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

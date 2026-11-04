import fs from 'node:fs';
import path from 'node:path';
import { runSafe } from './exec.js';
import { hostsPath } from './ports.js';

/**
 * Local hosts-file manager for <name>.test domains.
 *
 * Windows: C:\Windows\System32\drivers\etc\hosts — writable when the panel
 * runs elevated (installer registers it as a Windows service = LocalSystem).
 * Linux: /etc/hosts — writable when the panel runs as root (install.sh does).
 *
 * All panel entries are tagged with # gpanel-site so removals never touch
 * lines owned by the user or other tools.
 */

const TAG = '# gpanel-site';
export const LOCAL_TLD = '.test';

export function entryLine(domain) {
  return `127.0.0.1 ${domain} ${TAG}`;
}

/**
 * Ensure every domain in `domains` resolves to 127.0.0.1. Idempotent.
 * Returns { written, elevatedError } — elevatedError set when the hosts file
 * exists but could not be modified (panel not elevated).
 */
export async function ensureHostsEntries(domains) {
  const file = hostsPath();
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { written: false, elevatedError: `hosts file not readable: ${e.message}` };
  }
  const lines = content.split(/\r?\n/);
  const missing = domains.filter((d) => !lines.some((l) => new RegExp(`^\\s*127\\.0\\.0\\.1\\s+${d.replace(/\./g, '\\.')}(\\s|$)`).test(l)));
  if (!missing.length) return { written: false };

  lines.push(...missing.map(entryLine));
  try {
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return { written: true };
  } catch {
    // Panel not elevated — fall back to a single UAC prompt that appends all
    // missing lines in one elevated helper. Consent is explicit per batch.
    try {
      const payload = missing.map(entryLine).join('`\n`');
      const ps = `Add-Content -Path '${file.replace(/'/g, "''")}' -Value @'\n${missing.map(entryLine).join('\n')}\n'@`;
      const tmp = path.join(process.env.TEMP || '/tmp', `gpanel-hosts-${Date.now()}.ps1`);
      fs.writeFileSync(tmp, ps, { encoding: 'utf8' });
      await runSafe('powershell', [
        '-NoProfile', '-Command',
        `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${tmp.replace(/'/g, "''")}'`
      ], { timeout: 120000 });
      fs.rmSync(tmp, { force: true });
      // verify
      const after = fs.readFileSync(file, 'utf8');
      const ok = missing.every((d) => after.includes(` ${d} `));
      return ok ? { written: true, elevated: true } : { written: false, elevatedError: 'UAC declined or verification failed' };
    } catch (e) {
      return {
        written: false,
        elevatedError: `Cannot write the hosts file (${e.message}). Add these lines to ${file}:\n${missing.map(entryLine).join('\n')}`
      };
    }
  }
}

/** Remove panel-tagged entries for `domains` (or all panel entries if omitted). */
export function removeHostsEntries(domains = null) {
  const file = hostsPath();
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return { written: false }; }
  const before = content;
  const lines = content.split(/\r?\n/).filter((l) => {
    if (!l.includes(TAG)) return true;
    if (!domains) return false;
    return !domains.some((d) => l.includes(` ${d} `) || l.trim().endsWith(` ${d} ${TAG}`) || l.trim() === `127.0.0.1 ${d} ${TAG}`);
  });
  if (lines.join('\n') === before) return { written: false };
  try {
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return { written: true };
  } catch (e) {
    return { written: false, elevatedError: e.message };
  }
}

/** Flush the OS DNS cache so <name>.test resolves immediately. */
export async function flushDns() {
  if (process.platform === 'win32') {
    await runSafe('ipconfig', ['/flushdns'], { timeout: 15000 });
  } else {
    await runSafe('systemd-resolve', ['--flush-caches']).catch(() => {});
  }
  return true;
}

/**
 * Suggest a unique <name>.test domain — appends -2, -3… if taken.
 */
export function uniqueLocalName(name, existing) {
  let candidate = name, i = 2;
  while (existing.includes(candidate + LOCAL_TLD)) {
    candidate = `${name}-${i++}`;
  }
  return candidate + LOCAL_TLD;
}

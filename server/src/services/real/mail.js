import fs from 'node:fs';
import path from 'node:path';
import { run, runSafe } from '../../lib/exec.js';
import { config } from '../../config.js';

// Mail driver: Postfix (virtual domains via SQLite maps) + Dovecot (SQLite passdb)
// + OpenDKIM. The map/query configs live in /etc/postfix and /etc/dovecot and are
// written once by install.sh — the panel only manages data + OpenDKIM keys + Maildirs.

export default {
  async provisionDomain(domain, selector = 'gpanel') {
    const keysDir = path.join(config.paths.opendkimKeys, domain);
    fs.mkdirSync(keysDir, { recursive: true });

    const priv = path.join(keysDir, `${selector}.private`);
    const pub = path.join(keysDir, `${selector}.txt`);
    let privateKey = '', publicKey = '';
    if (!fs.existsSync(priv)) {
      await run('opendkim-genkey', ['-b', '2048', '-d', domain, '-D', keysDir, '-s', selector]);
      fs.chmodSync(priv, 0o600);
    }
    if (fs.existsSync(priv)) privateKey = fs.readFileSync(priv, 'utf8');
    if (fs.existsSync(pub)) publicKey = parseDkimTxt(fs.readFileSync(pub, 'utf8'));

    // OpenDKIM KeyTable / SigningTable
    const etc = '/etc/opendkim';
    const keyTable = `${etc}/KeyTable`;
    const signingTable = `${etc}/SigningTable`;
    const keyName = `${selector}._domainkey.${domain}`;
    appendUnique(keyTable, `${keyName} ${domain}:${selector}:${priv}`);
    appendUnique(signingTable, `*@${domain} ${keyName}`);

    // vmail Maildir base for the domain
    const maildir = path.join(config.paths.vmailDir, domain);
    fs.mkdirSync(maildir, { recursive: true });
    try { fs.chownSync(maildir, 5000, 5000); } catch {}
    await runSafe('chown', ['-R', 'vmail:vmail', maildir]);

    await runSafe('systemctl', ['reload', 'opendkim']);
    await runSafe('systemctl', ['reload', 'postfix']);
    return { privateKey, publicKey };
  },

  async deprovisionDomain(domain) {
    const keysDir = path.join(config.paths.opendkimKeys, domain);
    try { fs.rmSync(keysDir, { recursive: true, force: true }); } catch {}
    const etc = '/etc/opendkim';
    filterLines(`${etc}/KeyTable`, (l) => l.includes(`.${domain} `) || l.includes(`@${domain}`));
    filterLines(`${etc}/SigningTable`, (l) => l.includes(`@${domain}`));
    await runSafe('systemctl', ['reload', 'opendkim']);
  },

  async provisionUser(domain, local) {
    const maildir = path.join(config.paths.vmailDir, domain, local);
    for (const sub of ['', '/Maildir', '/Maildir/cur', '/Maildir/new', '/Maildir/tmp']) {
      const dir = path.join(maildir, sub);
      fs.mkdirSync(dir, { recursive: true });
      try { fs.chownSync(dir, 5000, 5000); } catch {}
    }
  },

  async deprovisionUser(domain, local) {
    const maildir = path.join(config.paths.vmailDir, domain, local);
    try { fs.rmSync(maildir, { recursive: true, force: true }); } catch {}
  },

  async mailboxUsage(domain, local) {
    const maildir = path.join(config.paths.vmailDir, domain, local);
    const { stdout } = await runSafe('du', ['-sb', maildir], { timeout: 60000 });
    return parseInt((stdout || '0').split('\t')[0], 10) || 0;
  }
};

function appendUnique(file, line) {
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch {}
  if (existing.split('\n').some((l) => l.trim() === line)) return;
  fs.appendFileSync(file, line + '\n');
}

function filterLines(file, predicate) {
  if (!fs.existsSync(file)) return;
  const kept = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !predicate(l));
  fs.writeFileSync(file, kept.join('\n') + (kept.length ? '\n' : ''));
}

// opendkim-genkey writes a DNS record file; extract the TXT value
function parseDkimTxt(content) {
  const joined = content.replace(/\n\t/g, '').replace(/\n\s+/g, ' ');
  const m = joined.match(/"([^"]+)"/g);
  if (!m) return '';
  return m.map((s) => s.replace(/"/g, '')).join('');
}

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runSafe } from '../../lib/exec.js';
import { config } from '../../config.js';

// vsftpd virtual users via pam_userdb:
//   - /etc/vsftpd/gpanel.users: plaintext "user\npassword\n" pairs (chmod 600)
//   - db_load -> /etc/vsftpd/gpanel.users.db (chmod 600)
//   - per-user config in /etc/vsftpd/gpanel.d/<user>: local_root, chroot
// PAM config + vsftpd.conf directives are written by install.sh.

export default {
  /**
   * rows: [{ username, password (plaintext, freshly provided or re-supplied), domain, directory }]
   * NOTE: vsftpd/pam_userdb needs the plaintext to build the db. We persist only
   * scrypt hashes in the panel DB; the plaintext rows passed here come from
   * creation or explicit password reset actions.
   */
  async syncUsers(rows, usersWithPlaintext = {}) {
    fs.mkdirSync(path.dirname(config.paths.vsftpdUsers), { recursive: true });
    fs.mkdirSync(config.paths.vsftpdUserConf, { recursive: true });

    const lines = [];
    for (const r of rows) {
      const pw = usersWithPlaintext[r.username];
      if (!pw) continue; // only accounts with known plaintext are usable; others must be reset
      lines.push(r.username, pw);
    }
    fs.writeFileSync(config.paths.vsftpdUsers, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
    execFileSync('db_load', ['-T', '-t', 'hash', '-f', config.paths.vsftpdUsers, config.paths.vsftpdUserDb]);
    fs.chmodSync(config.paths.vsftpdUserDb, 0o600);

    // per-user conf files
    const existing = fs.readdirSync(config.paths.vsftpdUserConf);
    for (const old of existing) {
      if (!rows.some((r) => r.username === old)) {
        try { fs.unlinkSync(path.join(config.paths.vsftpdUserConf, old)); } catch {}
      }
    }
    for (const r of rows) {
      const owner = r._owner || r.username.split('_')[0];
      const root = `/home/${owner}/domains/${r.domain}` + (r.directory && r.directory !== '/' ? `/${r.directory.replace(/^\//, '')}` : '');
      fs.writeFileSync(
        path.join(config.paths.vsftpdUserConf, r.username),
        `local_root=${root}\nguest_username=${owner}\nallow_writeable_chroot=YES\n`,
        { mode: 0o600 }
      );
    }
    await runSafe('systemctl', ['restart', 'vsftpd']);
    return true;
  }
};

function ownerOf(ftpUsername, rows) {
  const row = rows.find((r) => r.username === ftpUsername);
  // convention: ftp login "<paneluser>_<suffix>"; resolve via row._owner when present
  return row?._owner || ftpUsername.split('_')[0];
}

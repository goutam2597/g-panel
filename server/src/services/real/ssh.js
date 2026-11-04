import fs from 'node:fs';
import path from 'node:path';
import { run, runSafe } from '../../lib/exec.js';
import { config } from '../../config.js';

export default {
  async syncAuthorizedKeys(user, publicKeys) {
    const sshDir = `/home/${user}/.ssh`;
    await runSafe('mkdir', ['-p', sshDir]);
    fs.writeFileSync(path.join(sshDir, 'authorized_keys'), publicKeys.join('\n') + (publicKeys.length ? '\n' : ''), { mode: 0o600 });
    await runSafe('chown', ['-R', `${user}:${user}`, sshDir]);
    await runSafe('chmod', ['700', sshDir]);
    await runSafe('chmod', ['600', path.join(sshDir, 'authorized_keys')]);
    return true;
  },

  /**
   * Ensure an SSH keypair the panel uses to open terminal sessions:
   *  - admin terminal: root@localhost via /root/.ssh/gpanel_panel_ed25519
   *  - user terminal:  <user>@localhost via /var/lib/gpanel/keys/<user>
   * Returns the private key path.
   */
  async ensurePanelKey(user = 'root') {
    const privPath = user === 'root' ? config.paths.panelRootKey : path.join(config.dataDir, 'keys', user);
    if (fs.existsSync(privPath)) return privPath;
    fs.mkdirSync(path.dirname(privPath), { recursive: true });
    await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', privPath, '-C', 'gpanel-terminal']);
    fs.chmodSync(privPath, 0o600);

    // trust it for the target account
    const authFile = user === 'root' ? '/root/.ssh/authorized_keys' : `/home/${user}/.ssh/authorized_keys`;
    if (user !== 'root') await runSafe('mkdir', ['-p', `/home/${user}/.ssh`]);
    const pub = fs.readFileSync(privPath + '.pub', 'utf8').trim();
    let existing = '';
    try { existing = fs.readFileSync(authFile, 'utf8'); } catch {}
    if (!existing.split('\n').some((l) => l.trim() === pub)) {
      fs.appendFileSync(authFile, pub + '\n');
      if (user === 'root') {
        fs.mkdirSync('/root/.ssh', { recursive: true });
        fs.chmodSync('/root/.ssh', 0o700);
        fs.chmodSync(authFile, 0o600);
      } else {
        await runSafe('chown', ['-R', `${user}:${user}`, `/home/${user}/.ssh`]);
        await runSafe('chmod', ['700', `/home/${user}/.ssh`]);
        await runSafe('chmod', ['600', authFile]);
      }
    }
    return privPath;
  }
};

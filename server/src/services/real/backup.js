import fs from 'node:fs';
import path from 'node:path';
import { run, runSafe } from '../../lib/exec.js';
import { config } from '../../config.js';

// Per-user full backup: docroots + mail + database dumps + crontab.

export default {
  backupDir(user) {
    return path.join(config.paths.backupsDir, user);
  },

  async create(user, { databases = [], mailDomains = [] } = {}) {
    const dir = this.backupDir(user);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const filename = `${user}-${stamp}.tar.gz`;
    const filepath = path.join(dir, filename);
    const staging = fs.mkdtempSync(path.join(path.join(os_tmpdir()), 'gpanel-bak-'));

    try {
      // 1. docroots
      const domainsDir = `/home/${user}/domains`;
      if (fs.existsSync(domainsDir)) {
        await run('tar', ['-czf', path.join(staging, 'domains.tar.gz'), '-C', `/home/${user}`, 'domains'], { timeout: 900000 });
      }
      // 2. databases
      const dumpDir = path.join(staging, 'databases');
      fs.mkdirSync(dumpDir, { recursive: true });
      for (const dbName of databases) {
        await run('sh', ['-c', `mariadb-dump --protocol=socket -uroot --single-transaction --quick ${JSON.stringify(dbName)} > ${JSON.stringify(path.join(dumpDir, `${dbName}.sql`))}`], { timeout: 600000 });
      }
      // 3. mail
      const mailPaths = mailDomains.map((d) => path.join(config.paths.vmailDir, d)).filter((p) => fs.existsSync(p));
      if (mailPaths.length) {
        await run('tar', ['-czf', path.join(staging, 'mail.tar.gz'), '-C', config.paths.vmailDir, ...mailDomains], { timeout: 900000 });
      }
      // 4. crontab
      const { stdout: cronTab } = await runSafe('crontab', ['-l', '-u', user]);
      if (cronTab) fs.writeFileSync(path.join(staging, 'crontab.txt'), cronTab);

      // 5. manifest
      fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({
        user, created: new Date().toISOString(), databases, mailDomains, panelVersion: '1.0.0'
      }, null, 2));

      // assemble final archive
      const contents = fs.readdirSync(staging);
      await run('tar', ['-czf', filepath, '-C', staging, ...contents], { timeout: 900000 });
      const size = fs.statSync(filepath).size;
      return { filename, filepath, size };
    } finally {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    }
  },

  filepath(user, filename) {
    return path.join(this.backupDir(user), filename);
  },

  async remove(user, filename) {
    fs.rmSync(this.filepath(user, filename), { force: true });
    return true;
  }
};

function os_tmpdir() {
  return process.env.TMPDIR || '/tmp';
}

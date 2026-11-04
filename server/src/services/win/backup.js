import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from '../../config.js';

// Windows backup driver: tar (bsdtar ships with Windows 10+/11) over the
// user's site tree + database dumps via the detected mysqldump.

export default {
  backupDir(user) {
    return path.join(config.dataDir, 'backups', user).replace(/\\/g, '/');
  },

  async create(user, { databases = [], dumpFn = null } = {}) {
    const dir = this.backupDir(user);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const filename = `${user}-${stamp}.tar.gz`;
    const filepath = path.join(dir, filename).replace(/\//g, path.sep);
    const homeDir = path.join(config.dataDir, 'home', user);

    const staging = path.join(config.dataDir, 'tmp', `bak-${Date.now()}`);
    fs.mkdirSync(staging, { recursive: true });
    try {
      if (fs.existsSync(path.join(homeDir, 'domains'))) {
        fs.cpSync(path.join(homeDir, 'domains'), path.join(staging, 'domains'), { recursive: true });
      }
      if (databases.length && dumpFn) {
        const dumpDir = path.join(staging, 'databases');
        fs.mkdirSync(dumpDir, { recursive: true });
        for (const dbName of databases) {
          await dumpFn(dbName, path.join(dumpDir, `${dbName}.sql`));
        }
      }
      fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({
        user, created: new Date().toISOString(), databases, platform: 'win32'
      }, null, 2));

      const tarBin = process.platform === 'win32' && fs.existsSync('C:/Windows/System32/tar.exe')
        ? 'C:/Windows/System32/tar.exe'
        : 'tar';
      const contents = fs.readdirSync(staging);
      await new Promise((resolve, reject) => {
        
        execFile(tarBin, ['-czf', filepath, '-C', staging, ...contents], { timeout: 900000, windowsHide: true }, (err) => err ? reject(err) : resolve());
      });
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


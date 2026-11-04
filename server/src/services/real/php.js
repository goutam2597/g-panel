import fs from 'node:fs';
import path from 'node:path';
import { run, runSafe } from '../../lib/exec.js';
import { config } from '../../config.js';
import { buildPhpPool } from '../../lib/vhost-template.js';

export default {
  async versions() {
    try {
      const entries = fs.readdirSync('/etc/php').filter((d) => /^\d+\.\d+$/.test(d));
      return entries.sort().reverse();
    } catch {
      return [];
    }
  },

  async writePool(user, version, docrootBase, maxChildren = 8) {
    const poolDir = config.paths.phpPools(version);
    fs.mkdirSync(poolDir, { recursive: true });
    const file = path.join(poolDir, `gp-${user}.conf`);
    fs.writeFileSync(file, buildPhpPool({ user, phpVersion: version, docrootBase, maxChildren }), { mode: 0o644 });
    await runSafe('systemctl', ['reload', `php${version}-fpm`]);
  },

  async removePool(user, versions) {
    for (const version of versions) {
      const file = path.join(config.paths.phpPools(version), `gp-${user}.conf`);
      try { fs.unlinkSync(file); } catch {}
      await runSafe('systemctl', ['reload', `php${version}-fpm`]);
    }
  },

  async reload(version) {
    await runSafe('systemctl', ['reload', `php${version}-fpm`]);
  }
};

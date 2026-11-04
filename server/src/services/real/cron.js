import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, runSafe } from '../../lib/exec.js';

// Per-user crontab management. Each panel user owns a real unix crontab.
// Jobs written by the panel carry a marker comment so panel rows and
// foreign lines (added manually via shell) coexist safely.

const MARKER = '# gpanel-job:';

export default {
  async list(user) {
    const { stdout } = await runSafe('crontab', ['-l', '-u', user]);
    return stdout || '';
  },

  async apply(user, jobs) {
    const current = await this.list(user);
    const foreign = current
      .split('\n')
      .filter((l) => l.trim() && !l.includes(MARKER));

    const panelLines = [];
    for (const j of jobs) {
      if (!j.enabled) continue;
      panelLines.push(`${j.schedule} ${j.command}${j.comment ? ` ${MARKER}${j.comment}` : ''}`);
    }
    const text = [...foreign, ...panelLines].join('\n') + '\n';

    const tmp = path.join(os.tmpdir(), `crontab-${user}-${Date.now()}`);
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    try {
      await run('crontab', ['-u', user, tmp]);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
    return true;
  }
};

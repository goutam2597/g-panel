import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { run, runSafe } from '../../lib/exec.js';
import { config } from '../../config.js';
import { buildVhost } from '../../lib/vhost-template.js';

const avail = config.paths.nginxAvailable;

export default {
  async writeVhost(opts) {
    // opts: {domain, user, type, docroot, phpVersion, forceHttps, proxyTarget, hasCert}
    fs.mkdirSync(avail, { recursive: true });
    const file = path.join(avail, `${opts.domain}.conf`);
    const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const text = buildVhost(opts);
    fs.writeFileSync(file, text, { mode: 0o644 });

    const enabled = path.join(config.paths.nginxEnabled, `${opts.domain}.conf`);
    if (!fs.existsSync(enabled)) fs.symlinkSync(file, enabled);

    const test = await runSafe('nginx', ['-t']);
    if (test.failed) {
      // rollback
      if (prev !== null) fs.writeFileSync(file, prev);
      else {
        try { fs.unlinkSync(enabled); } catch {}
        try { fs.unlinkSync(file); } catch {}
      }
      throw new Error(`nginx config test failed: ${(test.stderr || '').split('\n').filter((l) => l.includes('nginx') || l.includes('emerg')).join(' ').slice(0, 400)}`);
    }
    await runSafe('systemctl', ['reload', 'nginx']);
    return true;
  },

  async removeVhost(domain) {
    try { fs.unlinkSync(path.join(config.paths.nginxEnabled, `${domain}.conf`)); } catch {}
    try { fs.unlinkSync(path.join(avail, `${domain}.conf`)); } catch {}
    await runSafe('nginx', ['-t']);
    await runSafe('systemctl', ['reload', 'nginx']);
  },

  async readLog(domain, kind = 'access', lines = 200) {
    // find owning user from docroot pattern
    const { stdout } = await runSafe('sh', ['-c', `grep -rl -- "-${kind}.log" /home/*/logs 2>/dev/null | head -5`]);
    // simpler: we know path convention from domain — search users' logs dirs
    const { stdout: found } = await runSafe('sh', ['-c', `find /home/*/logs -maxdepth 1 -name "${domain}-${kind}.log" 2>/dev/null | head -1`]);
    if (!found.trim()) return '';
    const { stdout: out } = await runSafe('tail', ['-n', String(lines), found.trim()]);
    return out;
  },

  async trafficMonth(domain) {
    // sum %b from the current month's access logs
    const month = new Date().toISOString().slice(0, 7);
    const { stdout } = await runSafe('sh', [
      '-c',
      `awk -v m="${month}" '$4 ~ /^\\[${m}/ {s+=$10} END {print s+0}' /home/*/logs/${domain}-access.log 2>/dev/null`
    ]);
    return parseInt(stdout.trim() || '0', 10) || 0;
  },

  async test() {
    const r = await runSafe('nginx', ['-t']);
    if (r.failed) throw new Error((r.stderr || 'nginx -t failed').slice(0, 400));
    return true;
  }
};

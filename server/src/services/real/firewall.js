import { run, runSafe } from '../../lib/exec.js';

export default {
  async status() {
    const { stdout } = await runSafe('ufw', ['status', 'numbered']);
    const enabled = /Status:\s*active/.test(stdout);
    const rules = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\[\s*(\d+)\]\s+(\S+(?:\/\w+)?)\s+(ALLOW|DENY|LIMIT|REJECT)(?:\s+IN)?\s+(\S+)/);
      if (m) {
        rules.push({ index: Number(m[1]), port: m[2], action: m[3], from: m[4], raw: line.trim() });
      }
    }
    return { enabled, rules };
  },

  async allow(port, proto = 'tcp', from = 'anywhere') {
    const spec = proto ? `${port}/${proto}` : String(port);
    await run('ufw', from === 'anywhere' ? ['allow', spec] : ['allow', 'from', from, 'to', 'any', 'port', String(port), 'proto', proto]);
    return true;
  },

  async deny(port, proto = 'tcp') {
    await run('ufw', ['deny', `${port}/${proto}`]);
    return true;
  },

  async deleteByIndex(index) {
    await run('ufw', ['--force', 'delete', String(index)]);
    return true;
  },

  async setEnabled(on) {
    await run('ufw', ['--force', on ? 'enable' : 'disable']);
    return true;
  },

  async fail2ban() {
    const { stdout } = await runSafe('fail2ban-client', ['status']);
    if (!stdout) return { active: false, jails: [] };
    const jailLine = stdout.split('\n').find((l) => l.includes('Jail list'));
    const jails = (jailLine || '').split(':')[1]?.split(',').map((j) => j.trim()).filter(Boolean) || [];
    const out = [];
    for (const jail of jails) {
      const { stdout: js } = await runSafe('fail2ban-client', ['status', jail]);
      const currently = (js.match(/Currently banned\s*:\s*(\d+)/) || [])[1];
      const total = (js.match(/Total banned\s*:\s*(\d+)/) || [])[1];
      out.push({ jail, currentlyBanned: Number(currently || 0), totalBanned: Number(total || 0) });
    }
    return { active: true, jails: out };
  }
};

import { run, runSafe } from '../../lib/exec.js';

// Windows Firewall driver: the panel manages only its own rules (named
// "GPanel …"), so it never fights the user's existing firewall config.
// Adding/removing rules requires an elevated prompt — errors surface as-is.

const RULE_PREFIX = 'GPanel ';

export default {
  async status() {
    const { stdout } = await runSafe('netsh', ['advfirewall', 'show', 'allprofiles', 'state'], { timeout: 20000 });
    const active = /State\s+ON/i.test(stdout || '');
    const rules = [];
    const { stdout: rulesOut } = await runSafe('powershell', ['-NoProfile', '-Command',
      "Get-NetFirewallRule -DisplayName 'GPanel *' | ForEach-Object { \"$($_.DisplayName);$($_.Direction);$($_.Action);$($_.Enabled)\" }"
    ], { timeout: 30000 });
    for (const line of (rulesOut || '').split('\n')) {
      const [name, direction, action, enabled] = line.trim().split(';');
      if (!name) continue;
      rules.push({ index: rules.length + 1, port: name.replace(RULE_PREFIX, ''), action: action === 'Allow' ? 'ALLOW' : 'DENY', from: direction === 'Inbound' ? 'Inbound' : 'Outbound', enabled: enabled === 'True', name });
    }
    return { enabled: active, rules };
  },

  async allow(port, proto = 'tcp') {
    const name = `${RULE_PREFIX}${port}/${proto}`;
    await run('netsh', ['advfirewall', 'firewall', 'add', 'rule',
      `name=${name}`, 'dir=in', `action=allow`, `protocol=${proto}`, `localport=${port}`], { timeout: 30000 });
    return true;
  },

  async deny(port, proto = 'tcp') {
    const name = `${RULE_PREFIX}block ${port}/${proto}`;
    await run('netsh', ['advfirewall', 'firewall', 'add', 'rule',
      `name=${name}`, 'dir=in', `action=block`, `protocol=${proto}`, `localport=${port}`], { timeout: 30000 });
    return true;
  },

  async deleteByIndex(index) {
    const { rules } = await this.status();
    const rule = rules.find((r) => r.index === Number(index));
    if (!rule) throw new Error('Rule not found');
    await run('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${rule.name}`], { timeout: 30000 });
    return true;
  },

  async setEnabled() {
    throw new Error('Toggling the whole Windows firewall is not supported from the panel — manage profiles in Windows Security');
  },

  async fail2ban() {
    return { active: false, jails: [], note: 'fail2ban is a Linux tool — on Windows, use Cloudflare protection in front of the tunnel' };
  }
};

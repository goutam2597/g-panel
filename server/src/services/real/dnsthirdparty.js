import { runSafe } from '../../lib/exec.js';
import { getSetting } from '../../db/index.js';

// Third-party DNS delegation checker: asks public resolvers what the
// world sees for a domain, so users can verify their registrar setup.

export default {
  async check(domain) {
    const [ns, a, www, mx] = await Promise.all([
      this.dig(domain, 'NS'),
      this.dig(domain, 'A'),
      this.dig(`www.${domain}`, 'A'),
      this.dig(domain, 'MX')
    ]);
    const ns1 = getSetting('ns1');
    const ns2 = getSetting('ns2');
    const serverIp = getSetting('server_ip');

    const nsFound = (ns.records || []).map((s) => s.replace(/\.$/, '').toLowerCase());
    const nsMatch = nsFound.length > 0 && nsFound.every((n) => n === ns1?.toLowerCase() || n === ns2?.toLowerCase());
    const aMatch = (a.records || []).includes(serverIp);
    const wwwMatch = (www.records || []).includes(serverIp);

    return {
      domain,
      expected: { ns1, ns2, serverIp },
      found: {
        ns: nsFound,
        a: a.records || [],
        www: www.records || [],
        mx: mx.records || []
      },
      checks: [
        { key: 'ns', label: 'Nameservers point here', ok: nsMatch, detail: nsFound.length ? nsFound.join(', ') : 'no NS records found (domain may not be registered or DNS not set up yet)' },
        { key: 'a', label: `A record → ${serverIp}`, ok: aMatch, detail: (a.records || []).join(', ') || 'no A record found' },
        { key: 'www', label: `www → ${serverIp}`, ok: wwwMatch, detail: (www.records || []).join(', ') || 'no www record found' }
      ],
      delegated: nsMatch && aMatch
    };
  },

  async dig(name, type) {
    const { stdout, failed } = await runSafe('dig', ['+short', '+time=2', '+tries=1', type, name], { timeout: 8000 });
    if (failed || !stdout) return { records: [] };
    if (type === 'MX') {
      return { records: stdout.trim().split('\n').filter(Boolean) };
    }
    return {
      records: stdout.trim().split('\n').map((l) => l.trim().replace(/\.$/, '')).filter((l) => l && !l.includes(' '))
    };
  }
};

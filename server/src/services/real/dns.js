import fs from 'node:fs';
import path from 'node:path';
import { run, runSafe } from '../../lib/exec.js';
import { config } from '../../config.js';

const zonesDir = config.paths.bindZones;
const zoneConf = config.paths.bindZoneConf;

export default {
  async addZone(domain) {
    fs.mkdirSync(zonesDir, { recursive: true });
    const marker = `// gpanel-zone:${domain}`;
    const conf = fs.existsSync(zoneConf) ? fs.readFileSync(zoneConf, 'utf8') : '';
    if (conf.includes(marker)) return;
    const entry = `
${marker}
zone "${domain}" {
    type master;
    file "${zonesDir}/${domain}.zone";
    allow-update { none; };
};
`;
    fs.appendFileSync(zoneConf, entry);
    await runSafe('rndc', ['reconfig']);
  },

  async removeZone(domain) {
    if (!fs.existsSync(zoneConf)) return;
    const conf = fs.readFileSync(zoneConf, 'utf8');
    const marker = `// gpanel-zone:${domain}`;
    if (!conf.includes(marker)) return;
    // remove the 5-line zone block + marker
    const cleaned = conf.split('\n').reduce((acc, line) => {
      if (line.includes(marker)) { acc.skip = true; return acc; }
      if (acc.skip) {
        if (line.trim() === '};') { acc.skip = false; return acc; }
        return acc;
      }
      acc.lines.push(line);
      return acc;
    }, { lines: [], skip: false }).lines.join('\n');
    fs.writeFileSync(zoneConf, cleaned);
    try { fs.unlinkSync(path.join(zonesDir, `${domain}.zone`)); } catch {}
    await runSafe('rndc', ['reconfig']);
  },

  async writeZone(domain, zoneText) {
    // validate with named-checkzone using a temp file, then commit
    const tmp = path.join('/tmp', `gpanel-${domain}-${Date.now()}.zone`);
    fs.writeFileSync(tmp, zoneText);
    try {
      const check = await runSafe('named-checkzone', [domain, tmp]);
      if (check.failed) {
        throw new Error(`Zone validation failed: ${(check.stderr || check.stdout || '').trim().slice(0, 400)}`);
      }
      fs.writeFileSync(path.join(zonesDir, `${domain}.zone`), zoneText, { mode: 0o644 });
      await runSafe('rndc', ['reload', domain]);
      return true;
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  },

  async readZone(domain) {
    try {
      return fs.readFileSync(path.join(zonesDir, `${domain}.zone`), 'utf8');
    } catch {
      return '';
    }
  }
};

import os from 'node:os';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { run, runSafe } from '../../lib/exec.js';
import { config } from '../../config.js';

// Windows system driver: real stats and service health via port probes.
// No Linux users — panel users map to directories under dataDir/home.

const SERVICE_LABELS = {
  nginx: 'Web server (nginx)',
  'php-cgi': 'PHP (FastCGI)',
  mysql: 'MySQL / MariaDB',
  cloudflared: 'Cloudflare Tunnel'
};

let lastCpu = null;

function cpuSample() {
  let total = 0, idle = 0;
  for (const c of os.cpus()) {
    for (const [k, t] of Object.entries(c.times)) { total += t; if (k === 'idle') idle += t; }
  }
  return { total, idle };
}

function portOpen(port, host = '127.0.0.1', timeout = 700) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(timeout, () => { s.destroy(); resolve(false); });
  });
}

function nginxDir() { return path.join(config.stackDir, 'nginx').replace(/\\/g, '/'); }

async function dirSize(dir, depth = 0) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 12) total += await dirSize(full, depth + 1);
    } else {
      try { total += fs.statSync(full).size; } catch {}
    }
  }
  return total;
}

export default {
  async info() {
    return {
      hostname: os.hostname(),
      platform: 'win32',
      distro: `${os.type()} (${os.release()})`,
      kernel: os.release(),
      arch: os.arch(),
      uptime: os.uptime(),
      cpuModel: os.cpus()[0]?.model?.trim() || 'CPU',
      cpuCount: os.cpus().length,
      totalMem: os.totalmem(),
      panelVersion: process.env.GPANEL_VERSION || '1.2.0'
    };
  },

  async stats() {
    const cpu = cpuSample();
    let cpuPct = 0;
    if (lastCpu) {
      const dTotal = cpu.total - lastCpu.total;
      const dIdle = cpu.idle - lastCpu.idle;
      cpuPct = dTotal > 0 ? Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100)) : 0;
    }
    lastCpu = cpu;

    const memTotal = os.totalmem();
    const memUsed = memTotal - os.freemem();

    // busiest local drive via PowerShell (wmic is removed on newest Win11)
    let disk = { used: 0, total: 1 };
    try {
      const { stdout } = await run('powershell', ['-NoProfile', '-Command',
        "Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used } | Sort-Object Used -Descending | Select-Object -First 1 | ForEach-Object { \"$($_.Used);$($_.Used + $_.Free)\" }"
      ], { timeout: 15000 });
      const [u, t] = stdout.trim().split(';').map(Number);
      if (t > 0) disk = { used: u, total: t };
    } catch { /* zeros */ }

    return {
      ts: Date.now(),
      cpu: Math.round(cpuPct * 10) / 10,
      memUsed,
      memTotal,
      diskUsed: disk.used,
      diskTotal: disk.total,
      netRx: null,
      netTx: null,
      load1: Math.round((cpuPct / 100) * os.cpus().length * 100) / 100,
      load5: null, load15: null
    };
  },

  async services() {
    const stack = config.stackDir;
    const nginxInstalled = fs.existsSync(path.join(stack, 'nginx', 'nginx.exe'));

    // Probe what this install actually runs — not hard-coded defaults:
    //  - web: nginx on :80 (real install) or the built-in per-site servers
    //  - mysql: the PANEL's own MySQL (private port), never Laragon's :3306
    //  - cloudflared: any live tunnel (panel-wide or per-site)
    let mysqlPort = 3307;
    try { const { MYSQL_PORT } = await import('./mysql.js'); mysqlPort = Number(MYSQL_PORT); } catch {}
    const [nginxUp, phpCgi, mysqlUp] = await Promise.all([portOpen(config.webPort), portOpen(9100), portOpen(mysqlPort)]);

    let webRow;
    if (nginxInstalled) {
      webRow = { name: 'nginx', label: SERVICE_LABELS.nginx, active: nginxUp, enabled: true, state: nginxUp ? 'active' : 'stopped' };
    } else {
      const { anySiteServerRunning } = await import('../site-server.js');
      const builtinUp = anySiteServerRunning();
      webRow = { name: 'web', label: 'Web server (built-in)', active: builtinUp, enabled: true, state: builtinUp ? 'active' : 'stopped' };
    }

    let tunnelUp = false;
    try { const cf = (await import('../real/cloudflare.js')).default; tunnelUp = cf.anyRunning(); } catch {}

    return [
      webRow,
      { name: 'php-cgi', label: SERVICE_LABELS['php-cgi'], active: phpCgi, enabled: true, state: phpCgi ? 'active' : 'stopped' },
      { name: 'mysql', label: SERVICE_LABELS.mysql, active: mysqlUp, enabled: true, state: mysqlUp ? 'active' : 'stopped' },
      { name: 'cloudflared', label: SERVICE_LABELS.cloudflared, active: tunnelUp, enabled: true, state: tunnelUp ? 'active' : 'installed' }
    ];
  },

  async restart(name) { return this.start(name); },
  async reload(name) { return this.start(name); },

  async start(name) {
    if (name === 'nginx') {
      const dir = nginxDir();
      if (!fs.existsSync(path.join(dir, 'nginx.exe'))) {
        throw new Error('nginx is not installed in the panel stack — run install-windows.ps1');
      }
      await runSafe(dir + '/nginx.exe', ['-p', dir + '/', '-c', 'conf/nginx.conf'], { cwd: dir });
      return true;
    }
    if (name === 'php-cgi') {
      const { default: php } = await import('./php.js');
      await php.ensurePools();
      return true;
    }
    if (name === 'mysql') {
      const { ensurePanelMySQL } = await import('./mysql.js');
      await ensurePanelMySQL();
      return true;
    }
    if (name === 'web' || name === 'cloudflared') {
      // built-in site servers and per-site tunnels self-manage — starting is
      // a no-op; they come up with the panel (restoreLocalSites) or per request
      return true;
    }
    throw new Error(`${name} is managed outside the panel on Windows`);
  },

  async stop(name) {
    if (name === 'nginx') {
      const dir = nginxDir();
      await runSafe(dir + '/nginx.exe', ['-p', dir + '/', '-c', 'conf/nginx.conf', '-s', 'quit'], { cwd: dir });
      return true;
    }
    throw new Error(`${name} is managed outside the panel on Windows`);
  },

  async updatesCount() { return null; },

  // Windows: panel users are directory-isolated, not OS users
  async provisionUser(user) {
    fs.mkdirSync(path.join(config.dataDir, 'home', user, 'domains'), { recursive: true });
    fs.mkdirSync(path.join(config.dataDir, 'home', user, 'logs'), { recursive: true });
    return true;
  },
  async deprovisionUser(user) {
    try { fs.rmSync(path.join(config.dataDir, 'home', user), { recursive: true, force: true }); } catch {}
    return true;
  },
  async setShell() { return true; },
  async userExists() { return true; },

  async diskUsageHome(user) {
    return dirSize(path.join(config.dataDir, 'home', user));
  },

  /**
   * Storage report for the drive the panel is installed on — everything the
   * panel owns (sites tree, stack, backups, database) lives on that drive.
   */
  async storageInfo() {
    const root = config.dataDir;
    const drive = path.parse(path.resolve(root)).root; // e.g. 'F:\'
    let used = 0, total = 0;
    try {
      // PSDrive has Used and Free (no Total) — total = used + free
      const { stdout } = await run('powershell', ['-NoProfile', '-Command',
        `Get-PSDrive -Name '${drive.charAt(0)}' | ForEach-Object { "$($_.Used);$($_.Used + $_.Free)" }`
      ], { timeout: 15000 });
      const [u, t] = stdout.trim().split(';').map(Number);
      if (t > 0) { used = u; total = t; }
    } catch { /* zeros */ }
    return {
      installRoot: process.env.GPANEL_HOME || 'C:/gpanel',
      dataDir: root,
      sitesDir: path.join(config.dataDir, 'home'),
      backupsDir: path.join(config.dataDir, 'backups'),
      stackDir: config.stackDir,
      drive,
      used,
      total,
      free: Math.max(0, total - used)
    };
  }
};

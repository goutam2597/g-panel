import os from 'node:os';
import fs from 'node:fs';
import { run, runSafe } from '../../lib/exec.js';

const SERVICE_LABELS = {
  nginx: 'Web server',
  'php8.3-fpm': 'PHP 8.3 (FPM)',
  'php8.2-fpm': 'PHP 8.2 (FPM)',
  bind9: 'DNS (BIND)',
  postfix: 'Mail transfer (SMTP)',
  dovecot: 'Mail delivery (IMAP/POP3)',
  opendkim: 'DKIM signing',
  mariadb: 'Databases (MariaDB)',
  vsftpd: 'FTP server',
  fail2ban: 'Intrusion prevention',
  ufw: 'Firewall'
};

let lastCpu = null;
let lastNet = null;

function readCpu() {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
  const parts = line.split(/\s+/).slice(1).map(Number);
  const idle = parts[3] + (parts[4] || 0);
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function readNet() {
  let rx = 0, tx = 0;
  for (const line of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
    const m = line.match(/^\s*(\w+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
    if (!m || m[1] === 'lo') continue;
    rx += Number(m[2]);
    tx += Number(m[3]);
  }
  return { rx, tx };
}

export default {
  async info() {
    const cpus = os.cpus();
    return {
      hostname: os.hostname(),
      platform: 'linux',
      distro: await distroName(),
      kernel: os.release(),
      arch: os.arch(),
      uptime: os.uptime(),
      cpuModel: cpus[0]?.model?.trim() || 'CPU',
      cpuCount: cpus.length,
      totalMem: os.totalmem(),
      panelVersion: process.env.GPANEL_VERSION || '1.0.0'
    };
  },

  async stats() {
    const cpu = readCpu();
    let cpuPct = 0;
    if (lastCpu) {
      const dTotal = cpu.total - lastCpu.total;
      const dIdle = cpu.idle - lastCpu.idle;
      cpuPct = dTotal > 0 ? Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100)) : 0;
    }
    lastCpu = cpu;

    const net = readNet();
    let netRx = 0, netTx = 0;
    if (lastNet) {
      netRx = Math.max(0, net.rx - lastNet.rx);
      netTx = Math.max(0, net.tx - lastNet.tx);
    }
    lastNet = net;

    const meminfo = {};
    for (const l of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const m = l.match(/^(\w+):\s+(\d+) kB/);
      if (m) meminfo[m[1]] = Number(m[2]) * 1024;
    }
    const memTotal = meminfo.MemTotal || os.totalmem();
    const memUsed = memTotal - (meminfo.MemAvailable || 0);

    const load = os.loadavg();
    let disk = { used: 0, total: 1 };
    try {
      const { stdout } = await run('df', ['-k', '-P', '/']);
      const parts = stdout.trim().split('\n')[1].split(/\s+/);
      disk = { used: Number(parts[2]) * 1024, total: Number(parts[1]) * 1024 };
    } catch { /* keep zeros */ }

    return {
      ts: Date.now(),
      cpu: Math.round(cpuPct * 10) / 10,
      memUsed,
      memTotal,
      diskUsed: disk.used,
      diskTotal: disk.total,
      netRx, netTx,
      load1: load[0], load5: load[1], load15: load[2]
    };
  },

  async services() {
    const names = Object.keys(SERVICE_LABELS);
    const { stdout } = await runSafe('systemctl', ['is-active', ...names]);
    const activeStates = stdout.trim().split('\n');
    const { stdout: enabledOut } = await runSafe('systemctl', ['is-enabled', ...names]);
    const enabledStates = enabledOut.trim().split('\n');
    return names.map((name, i) => ({
      name,
      label: SERVICE_LABELS[name],
      active: activeStates[i] === 'active',
      enabled: enabledStates[i] === 'enabled',
      state: activeStates[i] || 'unknown'
    }));
  },

  async restart(name) { await run('systemctl', ['restart', name]); },
  async reload(name) { await run('systemctl', ['reload', name]); },
  async start(name) { await run('systemctl', ['start', name]); },
  async stop(name) { await run('systemctl', ['stop', name]); },

  async updatesCount() {
    const { stdout } = await runSafe('apt-get', ['-q', 'list', '--upgradable'], { timeout: 60000 });
    return Math.max(0, stdout.trim().split('\n').length - 1);
  },

  // Linux user provisioning (cPanel-style: one unix user per panel user)
  async provisionUser(user, pkgMaxChildren = 8) {
    await runSafe('useradd', ['-m', '-U', '-s', '/bin/bash', user]);
    for (const dir of [`/home/${user}/domains`, `/home/${user}/logs`, `/home/${user}/.ssh`]) {
      await runSafe('mkdir', ['-p', dir]);
    }
    await runSafe('chown', ['-R', `${user}:${user}`, `/home/${user}/domains`, `/home/${user}/logs`]);
    await runSafe('chmod', ['700', `/home/${user}/.ssh`]);
  },

  async deprovisionUser(user) {
    // kill processes, remove crontab, delete user + home
    await runSafe('pkill', ['-u', user]);
    await runSafe('crontab', ['-r', '-u', user]);
    await runSafe('userdel', ['-r', user]);
  },

  async setShell(user, enabled) {
    await run('usermod', ['-s', enabled ? '/bin/bash' : '/usr/sbin/nologin', user]);
  },

  async diskUsageHome(user) {
    const { stdout } = await runSafe('du', ['-sb', `/home/${user}`, '--exclude', `/home/${user}/logs`], { timeout: 120000 });
    if (!stdout) return 0;
    return parseInt(stdout.split('\t')[0], 10) || 0;
  },

  /**
   * Storage report for the filesystem the panel data lives on.
   */
  async storageInfo() {
    const { config } = await import('../../config.js');
    const root = config.dataDir;
    let used = 0, total = 0;
    try {
      const { stdout } = await run('df', ['-k', '-P', root]);
      const parts = stdout.trim().split('\n')[1].split(/\s+/);
      used = Number(parts[2]) * 1024;
      total = Number(parts[1]) * 1024;
    } catch { /* zeros */ }
    return {
      installRoot: '/opt/gpanel',
      dataDir: root,
      sitesDir: '/home (per-user homes)',
      backupsDir: '/home/gpanel-backups',
      stackDir: null,
      drive: 'system',
      used,
      total,
      free: Math.max(0, total - used)
    };
  },

  async userExists(user) {
    const { stdout } = await runSafe('getent', ['passwd', user]);
    return Boolean(stdout.trim());
  }
};

async function distroName() {
  try {
    const content = fs.readFileSync('/etc/os-release', 'utf8');
    const m = content.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    return m ? m[1] : 'Linux';
  } catch {
    return 'Linux';
  }
}

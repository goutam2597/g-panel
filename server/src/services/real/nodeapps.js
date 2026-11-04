import fs from 'node:fs';
import path from 'node:path';
import { run, runSafe } from '../../lib/exec.js';

// cPanel-style Node.js app management without Passenger:
// each app is a systemd user service on its own loopback port; nginx
// reverse-proxies the app's domain to it (vhost type "proxy").

export default {
  unitName(username, appName) {
    return `gp-node-${username}-${appName}`;
  },

  appDir(username, appName) {
    return `/home/${username}/apps/${appName}`;
  },

  async create({ username, appName, port, startupFile, nodeVersion }) {
    const dir = this.appDir(username, appName);
    fs.mkdirSync(dir, { recursive: true });
    await run('chown', ['-R', `${username}:${username}`, `/home/${username}/apps`]);

    const unit = path.join('/etc/systemd/system', `${this.unitName(username, appName)}.service`);
    fs.writeFileSync(unit, `[Unit]
Description=G-Panel Node.js app ${appName} (${username})
After=network.target

[Service]
Type=simple
User=${username}
Group=${username}
WorkingDirectory=${dir}
ExecStart=/usr/bin/node ${startupFile}
Environment=PORT=${port}
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
`, { mode: 0o644 });
    await run('systemctl', ['daemon-reload']);
    await run('systemctl', ['enable', this.unitName(username, appName)]);
    return true;
  },

  async start(username, appName) {
    await run('systemctl', ['start', this.unitName(username, appName)]);
  },

  async stop(username, appName) {
    await run('systemctl', ['stop', this.unitName(username, appName)]);
  },

  async restart(username, appName) {
    await run('systemctl', ['restart', this.unitName(username, appName)]);
  },

  async status(username, appName) {
    const { stdout } = await runSafe('systemctl', ['is-active', this.unitName(username, appName)]);
    return stdout.trim() === 'active' ? 'running' : 'stopped';
  },

  async remove(username, appName) {
    await runSafe('systemctl', ['stop', this.unitName(username, appName)]);
    await runSafe('systemctl', ['disable', this.unitName(username, appName)]);
    try {
      fs.unlinkSync(path.join('/etc/systemd/system', `${this.unitName(username, appName)}.service`));
    } catch {}
    await runSafe('systemctl', ['daemon-reload']);
    try { fs.rmSync(this.appDir(username, appName), { recursive: true, force: true }); } catch {}
    return true;
  },

  async npmInstall(username, appName) {
    const dir = this.appDir(username, appName);
    const { stdout, stderr } = await run('sudo', ['-u', username, 'npm', 'install', '--prefix', dir, '--no-audit', '--no-fund'], { timeout: 600000 });
    return { output: (stdout + '\n' + stderr).slice(-4000) };
  },

  async logs(username, appName, lines = 200) {
    const { stdout } = await runSafe('journalctl', ['-u', this.unitName(username, appName), '-n', String(lines), '--no-pager', '-o', 'cat']);
    return stdout || '';
  },

  async nodeVersions() {
    const { stdout } = await runSafe('node', ['--version']);
    // one system node; per-version switching via nvm could be added later
    return [{ version: (stdout.trim() || 'v22').replace('v', '').split('.').slice(0, 2).join('.'), path: '/usr/bin/node' }];
  }
};

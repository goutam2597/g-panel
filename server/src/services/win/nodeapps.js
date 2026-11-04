import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';

// Node.js apps on Windows: panel-managed processes with a restart watchdog.
// nginx reverse-proxies the app's domain to its loopback port (vhost "proxy").

const procs = new Map(); // key: username/appName -> {child, port}

export default {
  unitName(username, appName) { return `gp-node-${username}-${appName}`; },
  appDir(username, appName) {
    return path.join(config.dataDir, 'home', username, 'apps', appName).replace(/\\/g, '/');
  },

  async create({ username, appName, port, startupFile }) {
    const dir = this.appDir(username, appName);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, startupFile))) {
      fs.writeFileSync(path.join(dir, startupFile), `const http = require('node:http');\nconst port = process.env.PORT || 3000;\nhttp.createServer((req, res) => {\n  res.end('Hello from ${appName} — served via G-Panel on Windows');\n}).listen(port);\nconsole.log('${appName} listening on', port);\n`);
    }
    this._start(username, appName, port, startupFile);
    return true;
  },

  _start(username, appName, port, startupFile) {
    const dir = this.appDir(username, appName);
    const key = `${username}/${appName}`;
    const child = spawn('node', [startupFile], {
      cwd: dir,
      env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let logs = procs.get(key)?.logs || [];
    const push = (line) => {
      logs.push(`${new Date().toISOString()} ${line}`);
      if (logs.length > 500) logs.shift();
    };
    child.stdout.on('data', (d) => push(String(d).trim()));
    child.stderr.on('data', (d) => push('[err] ' + String(d).trim()));
    const restart = () => {
      if (procs.get(key)?.child !== child) return; // superseded or removed
      procs.delete(key);
      setTimeout(() => {
        try { this._start(username, appName, port, startupFile); } catch {}
      }, 3000);
    };
    child.on('exit', (code) => { push(`exited (code ${code}) — restarting in 3s`); restart(); });
    procs.set(key, { child, port, logs, startupFile });
  },

  async start(username, appName) {
    const row = procs.get(`${username}/${appName}`);
    if (!row) throw new Error('App process state lost after panel restart — use Restart');
    this._start(username, appName, row.port, row.startupFile);
    return true;
  },

  async stop(username, appName) {
    const key = `${username}/${appName}`;
    const row = procs.get(key);
    if (row) {
      procs.delete(key); // prevents watchdog restart
      try { row.child.kill(); } catch {}
    }
    return true;
  },

  async restart(username, appName) {
    const row = procs.get(`${username}/${appName}`);
    if (row) {
      try { row.child.kill(); } catch {}
      // watchdog restarts it with the same port/startup file
      return true;
    }
    throw new Error('App process state lost after panel restart — use Restart');
  },

  async status(username, appName) {
    return procs.has(`${username}/${appName}`) ? 'running' : 'stopped';
  },

  async remove(username, appName) {
    await this.stop(username, appName);
    try { fs.rmSync(this.appDir(username, appName), { recursive: true, force: true }); } catch {}
    return true;
  },

  async npmInstall(username, appName) {
    const dir = this.appDir(username, appName);
    return new Promise((resolve, reject) => {
      execFile('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, timeout: 600000, windowsHide: true }, (err, stdout, stderr) => {
        if (err && !stdout && !stderr) return reject(new Error(err.message));
        resolve({ output: ((stdout || '') + '\n' + (stderr || '')).slice(-4000) });
      });
    });
  },

  async logs(username, appName) {
    return (procs.get(`${username}/${appName}`)?.logs || []).join('\n');
  },

  async nodeVersions() {
    return [{ version: process.versions.node.split('.').slice(0, 2).join('.'), path: process.execPath }];
  }
};

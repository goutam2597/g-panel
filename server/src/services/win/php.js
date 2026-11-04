import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { runSafe } from '../../lib/exec.js';
import { findPhpCandidates } from '../../lib/localstack.js';
import { config } from '../../config.js';

// PHP FastCGI on Windows: php-cgi.exe pools listen on 127.0.0.1:9100+.
// Pools spawn DETACHED (they must outlive panel restarts — children die with
// the parent on Windows otherwise) and their PIDs are tracked on disk so a
// new panel run can replace them cleanly.

const BASE_PORT = 9100;
const pools = new Map(); // phpDir -> {port, pid, adopted, watchdog}
const pidFile = () => path.join(config.stackDir, 'php-cgi.pids.json');

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: '127.0.0.1' }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(700, () => { s.destroy(); resolve(false); });
  });
}

function loadPidFile() {
  try { return JSON.parse(fs.readFileSync(pidFile(), 'utf8')); } catch { return {}; }
}

function savePidFile(map) {
  try { fs.writeFileSync(pidFile(), JSON.stringify(map, null, 2)); } catch {}
}

async function killPid(pid) {
  if (process.platform === 'win32') await runSafe('taskkill', ['/F', '/PID', String(pid)]);
  else try { process.kill(Number(pid), 'SIGTERM'); } catch {}
}

async function killPortOwner(port) {
  const { stdout } = await runSafe('powershell', ['-NoProfile', '-Command',
    `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`
  ], { timeout: 15000 });
  const pid = parseInt((stdout || '').trim(), 10);
  if (pid) await killPid(pid);
}

function spawnCgi(phpDir, port, version) {
  const exe = path.join(phpDir, 'php-cgi.exe');
  const child = spawn(exe, ['-b', `127.0.0.1:${port}`], {
    cwd: phpDir, detached: true, stdio: 'ignore', windowsHide: true
  });
  child.unref();

  // persist for clean replacement across panel restarts
  const persisted = loadPidFile();
  persisted[phpDir] = { pid: child.pid, port, version };
  savePidFile(persisted);

  // watchdog: if it dies while the panel is running, respawn once
  child.on('exit', () => {
    const entry = pools.get(phpDir);
    if (!entry || entry.pid !== child.pid) return; // superseded/stopped
    pools.delete(phpDir);
    setTimeout(() => { try { spawnCgi(phpDir, port, version); } catch {} }, 3000);
  });
  pools.set(phpDir, { port, pid: child.pid, adopted: false });
  return child;
}

export default {
  /** PHP versions usable for sites: detected php-cgi capable installs. */
  async versions() {
    const candidates = await findPhpCandidates();
    const versions = [];
    for (const php of candidates) {
      const dir = path.dirname(path.resolve(php === 'php' ? process.execPath : php));
      if (!fs.existsSync(path.join(dir, 'php-cgi.exe'))) continue;
      const vOut = await new Promise((resolve) => {
        const c = spawn(php, ['-v'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        let out = '';
        c.stdout.on('data', (d) => { out += d; });
        c.on('close', () => resolve(out));
        c.on('error', () => resolve(''));
      });
      const m = vOut.match(/PHP (\d+\.\d+)/);
      if (m && !versions.includes(m[1])) versions.push(m[1]);
    }
    return versions.sort((a, b) => {
      const [a1, a2] = a.split('.').map(Number);
      const [b1, b2] = b.split('.').map(Number);
      return b1 - a1 || b2 - a2;
    });
  },

  /** Start (or adopt) one php-cgi pool per detected PHP version. */
  async ensurePools() {
    const candidates = await findPhpCandidates();
    const versions = await this.versions();
    let port = BASE_PORT;
    for (const version of versions) {
      // find the install dir that provides this version
      let dir = null;
      for (const php of candidates) {
        const d = path.dirname(path.resolve(php === 'php' ? process.execPath : php));
        if (!fs.existsSync(path.join(d, 'php-cgi.exe'))) continue;
        const vOut = await new Promise((resolve) => {
          const c = spawn(php, ['-v'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
          let out = '';
          c.stdout.on('data', (d2) => { out += d2; });
          c.on('close', () => resolve(out));
          c.on('error', () => resolve(''));
        });
        if (vOut.includes(`PHP ${version}`)) { dir = d; break; }
      }
      if (!dir) continue;
      if (pools.has(dir)) { port = Math.max(port, pools.get(dir).port + 1); continue; }

      // replace a stale instance recorded by a previous panel run
      const persisted = loadPidFile();
      if (persisted[dir]?.pid) await killPid(persisted[dir].pid).catch(() => {});
      await new Promise((r) => setTimeout(r, 400));

      if (await portOpen(port)) {
        // already listening (from a survive-restart spawn) — adopt it
        pools.set(dir, { port, pid: persisted[dir]?.pid, adopted: true });
        port += 1;
        continue;
      }
      spawnCgi(dir, port, version);
      // wait until it accepts connections
      for (let i = 0; i < 20 && !(await portOpen(port)); i++) {
        await new Promise((r) => setTimeout(r, 300));
      }
      port += 1;
    }
    return [...pools.values()].map((p) => p.port);
  },

  /** Map a PHP version to its FastCGI target (starts the pool if needed). */
  async targetFor(version) {
    await this.ensurePools();
    const versions = await this.versions();
    const vi = versions.indexOf(version);
    let idx = vi < 0 ? 0 : vi;
    for (const [dir, entry] of pools) {
      if (idx === 0) return `127.0.0.1:${entry.port}`;
      idx -= 1;
    }
    return `127.0.0.1:${BASE_PORT}`;
  },

  async writePool() { return true; }, // per-user pools are a Linux concept
  async removePool() { return true; },
  async reload() { return this.ensurePools(); }
};

// Panel-owned MySQL for Windows: the panel runs its own mysqld on a private
// port (3307 by default) with its own data directory under <stack>/mysql-data.
// It never touches Laragon/XAMPP/val — those keep their own MySQL on :3306.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runSafe } from '../../lib/exec.js';
import { config } from '../../config.js';
import { findMysqlClient } from '../../lib/localstack.js';

export const MYSQL_PORT = parseInt(process.env.GPANEL_MYSQL_PORT || '3307', 10);
export const MYSQL_PASS = process.env.GPANEL_MYSQL_PASSWORD || 'gpanel-root';

const dataDir = () => path.join(config.stackDir, 'mysql-data');
const runDir = () => path.join(config.stackDir, 'mysql-run');
const pidFile = () => path.join(runDir(), 'mysql.pid');
const errLog = () => path.join(dataDir(), 'panel-mysql.err');

let client = null;
let started = false;

async function mysqldBin() {
  if (client?.mysqld) return client.mysqld;
  const c = await findMysqlClient();
  if (!c) return null;
  const dir = path.dirname(c.bin);
  const exe = path.join(dir, process.platform === 'win32' ? 'mysqld.exe' : 'mysqld');
  client = {
    mysql: c.bin,
    dump: c.dumpBin,
    mysqld: fs.existsSync(exe) ? exe : null,
    clientDir: dir
  };
  return client.mysqld;
}

function running() {
  try {
    const pid = fs.readFileSync(pidFile(), 'utf8').trim();
    if (!pid) return false;
    process.kill(Number(pid), 0);
    return true;
  } catch { return false; }
}

async function ping() {
  if (!client?.mysql) return false;
  const r = await runSafe(client.mysql, ['-h', '127.0.0.1', '-P', String(MYSQL_PORT), '-uroot', `-p${MYSQL_PASS}`, '--connect-expired-password', '-e', 'SELECT 1']);
  return !r.failed;
}

export async function ensurePanelMySQL() {
  const bin = await mysqldBin();
  if (!bin) throw new Error('No mysqld found on this machine — install Laragon/XAMPP (its MySQL is only used as engine, not the data server)');

  fs.mkdirSync(dataDir(), { recursive: true });
  fs.mkdirSync(runDir(), { recursive: true });

  // Running with the right password already? nothing to do.
  if (await ping()) {
    started = true;
    return true;
  }

  // Fresh datadir → initialize with a known root password.
  if (!fs.existsSync(path.join(dataDir(), 'mysql.ibd'))) {
    const init = await runSafe(bin, [
      `--no-defaults`,
      `--basedir=${path.dirname(client.clientDir)}`,
      `--datadir=${dataDir()}`,
      '--initialize-insecure'
    ]);
    if (init.failed) throw new Error(`mysqld --initialize failed: ${(init.stderr || '').split('\n').slice(-3).join(' ')}`);
  }

  // Kill any zombie panel mysqld holding the data dir.
  if (running()) {
    try {
      const pid = fs.readFileSync(pidFile(), 'utf8').trim();
      process.kill(Number(pid));
      await new Promise((r) => setTimeout(r, 2000));
    } catch {}
  }

  const child = spawn(bin, [
    '--no-defaults',
    `--basedir=${path.dirname(client.clientDir)}`,
    `--datadir=${dataDir()}`,
    `--port=${MYSQL_PORT}`,
    '--bind-address=127.0.0.1',
    '--mysqlx=OFF',
    `--secure-file-priv=${runDir()}`,
    '--skip-log-bin',
    '--innodb-buffer-pool-size=256M',
    `--pid-file=${pidFile()}`
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();

  // Wait for ready. The server is up even before WITH password ping works —
  // a fresh --initialize has an expired temp password, so the first ping
  // handshake needs special handling. Probe TCP port responsiveness instead.
  const ready = async () => {
    try {
      const r = await runSafe(client.mysql, ['-h', '127.0.0.1', '-P', String(MYSQL_PORT), '-uroot', '--connect-expired-password', '-e', 'SELECT 1']);
      return !r.failed || /ready|error|access/i.test((r.stderr || r.stdout || ''));
    } catch { return false; }
  };
  for (let i = 0; i < 40; i++) {
    if (await ready()) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  // First run: set root password. Try auth with the expired temp password.
  // Extract it from the init error log if we can.
  let pwd = null;
  try {
    const log = fs.readFileSync(path.join(dataDir(), 'GoutamKS.err'), 'utf8');
    const m = log.match(/temporary password is generated for root@localhost:\s*(\S+)/);
    if (m) pwd = m[1].trim().replace(/\r$/, '');
  } catch {}
  if (pwd) {
    await runSafe(client.mysql, [
      '-h', '127.0.0.1', '-P', String(MYSQL_PORT), '-uroot', `-p${pwd}`,
      '--connect-expired-password',
      '-e', `ALTER USER 'root'@'localhost' IDENTIFIED BY '${MYSQL_PASS}'; CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY '${MYSQL_PASS}'; GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION; FLUSH PRIVILEGES;`
    ]);
  }
  // Verify now with the real password
  for (let i = 0; i < 40; i++) {
    if (await ping()) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!(await ping())) {
    let tail = '';
    try {
      const candidates = [errLog(), path.join(dataDir(), 'mysql.err'), path.join(dataDir(), 'GoutamKS.err')];
      for (const f of candidates) {
        if (fs.existsSync(f)) { tail = fs.readFileSync(f, 'utf8').split('\n').slice(-8).join('\n'); break; }
      }
    } catch {}
    throw new Error(`Panel MySQL did not start on :${MYSQL_PORT}. Log: ${errLog()}\n${tail}`);
  }

  started = true;
  return true;
}

export function panelDbConfig() {
  return {
    bin: client?.mysql || 'mysql',
    dumpBin: client?.dump || null,
    baseArgs: ['-h', '127.0.0.1', '-P', String(MYSQL_PORT), '-uroot', `-p${MYSQL_PASS}`]
  };
}

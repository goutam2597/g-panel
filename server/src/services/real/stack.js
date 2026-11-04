import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { runSafe } from './exec.js';

/**
 * Panel-owned service stack installer. Downloads official builds into the
 * panel's own stack directory so the server runtime is fully independent of
 * Laragon / XAMPP / WAMP / IIS / preinstalled services:
 *
 *   stack/mariadb/     — portable MariaDB (panel-owned MySQL on :3307+)
 *   stack/nginx/       — nginx for Windows (web server)
 *   stack/php/         — PHP (NTS with php-cgi for FastCGI)
 *   stack/composer.phar— Composer for Laravel projects
 *
 * Everything is idempotent: present components are skipped, so calling
 * ensureStack() repeatedly only downloads what is missing. Existing
 * applications on the machine are never touched.
 */

const MARIADB_VERSION = '11.4.5';
const NGINX_VERSION = '1.26.3';
const PHP_VERSION = '8.3.14';

const mariadbDir = () => path.join(config.stackDir, 'mariadb').replace(/\\/g, '/');
const nginxDir = () => path.join(config.stackDir, 'nginx').replace(/\\/g, '/');
const phpDir = () => path.join(config.stackDir, 'php').replace(/\\/g, '/');

function tarBin() {
  return process.platform === 'win32' && fs.existsSync('C:/Windows/System32/tar.exe')
    ? 'C:/Windows/System32/tar.exe'
    : 'tar';
}

function extract(archive, destDir, strip = 0) {
  return new Promise((resolve, reject) => {
    const args = ['-xf', archive, '-C', destDir];
    if (strip) args.push('--strip-components', String(strip));
    execFile(tarBin(), args, { timeout: 600000, windowsHide: true }, (err) => err ? reject(err) : resolve());
  });
}

async function fetchBinary(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

export async function installMariaDb() {
  const dest = mariadbDir();
  if (fs.existsSync(path.join(dest, 'bin', 'mysqld.exe'))) return { skipped: true, dir: dest };

  const version = MARIADB_VERSION;
  // archive.mariadb.org is the canonical location for every release
  const candidates = [
    `https://archive.mariadb.org/mariadb-${version}/winx64-packages/mariadb-${version}-winx64.zip`,
  ];
  const tmp = path.join(config.stackDir, 'downloads');
  fs.mkdirSync(tmp, { recursive: true });
  const zip = path.join(tmp, `mariadb-${version}.zip`);

  let lastErr = null;
  for (const url of candidates) {
    try {
      await fetchBinary(url, zip);
      fs.rmSync(dest, { recursive: true, force: true });
      // MariaDB zips carry a versioned root folder: mariadb-11.4.5-winx64/
      await extract(zip, config.stackDir);
      const extracted = path.join(config.stackDir, `mariadb-${version}-winx64`);
      if (fs.existsSync(path.join(extracted, 'bin', 'mysqld.exe'))) {
        fs.renameSync(extracted, dest);
      } else {
        // some layouts extract directly
        if (!fs.existsSync(path.join(dest, 'bin', 'mysqld.exe'))) throw new Error('mysqld.exe not found after extract');
      }
      fs.rmSync(zip, { force: true });
      return { installed: true, dir: dest };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`MariaDB install failed: ${lastErr?.message || 'unknown'}`);
}

export async function installNginx() {
  const dest = nginxDir();
  if (fs.existsSync(path.join(dest, 'nginx.exe'))) return { skipped: true, dir: dest };

  const zip = path.join(config.stackDir, 'downloads', `nginx-${NGINX_VERSION}.zip`);
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  await fetchBinary(`https://nginx.org/download/nginx-${NGINX_VERSION}.zip`, zip);
  const extractDir = path.join(config.stackDir, 'downloads', `nginx-${NGINX_VERSION}`);
  await extract(zip, extractDir);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(extractDir, dest);
  try { fs.rmSync(path.join(config.stackDir, 'downloads'), { recursive: true, force: true }); } catch {}
  return { installed: true, dir: dest };
}

export async function installPhp() {
  const dest = phpDir();
  if (fs.existsSync(path.join(dest, 'php-cgi.exe'))) return { skipped: true, dir: dest };

  const zip = path.join(config.stackDir, 'downloads', `php-${PHP_VERSION}.zip`);
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  const urls = [
    `https://windows.php.net/downloads/releases/php-${PHP_VERSION}-nts-Win32-vs16-x64.zip`,
    `https://windows.php.net/downloads/releases/archives/php-${PHP_VERSION}-nts-Win32-vs16-x64.zip`
  ];
  let ok = false, lastErr = null;
  for (const url of urls) {
    try { await fetchBinary(url, zip); ok = true; break; } catch (e) { lastErr = e; }
  }
  if (!ok) throw new Error(`PHP download failed: ${lastErr?.message}`);
  fs.mkdirSync(dest, { recursive: true });
  await extract(zip, dest);
  try { fs.rmSync(zip, { force: true }); } catch {}

  // minimal php.ini for FastCGI + phpMyAdmin + MySQL
  const ini = [
    `extension_dir = "ext"`,
    'extension=curl', 'extension=mbstring', 'extension=openssl',
    'extension=mysqli', 'extension=pdo_mysql', 'extension=pdo_sqlite',
    'extension=fileinfo', 'extension=gd', 'extension=exif', 'extension=zip',
    `session.save_path = "${path.join(dest, 'sessions').replace(/\\/g, '/')}"`,
    'upload_max_filesize = 512M', 'post_max_size = 512M', 'memory_limit = 256M'
  ].join('\n');
  fs.writeFileSync(path.join(dest, 'php.ini'), ini);
  fs.mkdirSync(path.join(dest, 'sessions'), { recursive: true });
  return { installed: true, dir: dest };
}

export async function installComposer() {
  const { ensureComposer } = await import('../lib/laravel.js');
  const dest = await ensureComposer();
  return { installed: true, dir: path.dirname(dest) };
}

/** Full stack bring-up; returns per-component status. */
export async function ensureStack(components = ['mariadb', 'nginx', 'php', 'composer']) {
  fs.mkdirSync(config.stackDir, { recursive: true });
  const result = {};
  for (const c of components) {
    try {
      if (c === 'mariadb') result.mariadb = await installMariaDb();
      else if (c === 'nginx') result.nginx = await installNginx();
      else if (c === 'php') result.php = await installPhp();
      else if (c === 'composer') result.composer = await installComposer();
    } catch (e) {
      result[c] = { error: e.message?.slice(0, 300) };
    }
  }
  return result;
}

/** Panel's own mysqld binary (stack MariaDB) — preferred over system installs. */
export function stackMysqld() {
  const exe = path.join(mariadbDir(), 'bin', process.platform === 'win32' ? 'mysqld.exe' : 'mysqld');
  return fs.existsSync(exe) ? exe : null;
}

// DEV-MODE phpMyAdmin — the panel owns its own instance:
// the LATEST official package (resolved from phpmyadmin.net's version feed,
// same feed phpMyAdmin itself checks) is downloaded into the panel's data
// directory and served with the machine's PHP (php -S) behind the same
// signon-only auth the production server uses. Laragon/XAMPP phpMyAdmin
// installs are never touched — their config stays theirs, ours stays ours.

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { findPhpCandidates } from './lib/localstack.js';
import { runSafe } from './lib/exec.js';

// fallback if the version feed is unreachable — updated per release
const PMA_FALLBACK_VERSION = '5.2.3';
const PMA_PORT = 2084;

let cachedLatest = null;

/** Resolve the newest phpMyAdmin release (feeds falls back if offline). */
async function latestPmaVersion() {
  if (cachedLatest) return cachedLatest;
  try {
    const res = await fetch('https://www.phpmyadmin.net/home_page/version.json', { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const feed = await res.json();
      if (feed && typeof feed.version === 'string' && /^\d+\.\d+(\.\d+)?$/.test(feed.version)) {
        cachedLatest = feed.version;
        return cachedLatest;
      }
    }
  } catch { /* offline — use fallback */ }
  cachedLatest = PMA_FALLBACK_VERSION;
  return cachedLatest;
}

let state = { checked: false, url: null, error: null, source: null, child: null };

export async function startDevPma() {
  // success is cached; a failed attempt is retried on the next click
  if (state.checked && state.url) return state;
  state.checked = true;
  state.url = null;
  state.error = null;

  // ---- the panel's own copy of the official package, always latest ----
  const pmaVersion = await latestPmaVersion();
  const workDir = path.join(config.dataDir, 'pma-local');
  const versionMarker = path.join(workDir, '.gpanel-pma-version');
  try {
    const current = fs.existsSync(versionMarker) ? fs.readFileSync(versionMarker, 'utf8').trim() : null;
    if (current !== pmaVersion || !fs.existsSync(path.join(workDir, 'index.php'))) {
      const extracted = await downloadOfficialPma(config.dataDir, pmaVersion);
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.cpSync(extracted, workDir, { recursive: true });
      fs.writeFileSync(versionMarker, pmaVersion);
    }
  } catch (e) {
    state.error = `Could not stage the panel's phpMyAdmin (official ${pmaVersion} package): ${e.message}`;
    return state;
  }
  const source = `official ${pmaVersion} (panel-owned copy)`;

  // ---- signon-only config + one-time-token bridge (same as production) ----
  const mysqlHost = process.env.GPANEL_MYSQL_HOST || '127.0.0.1';
  fs.writeFileSync(path.join(workDir, 'config.inc.php'), `<?php
$cfg['Servers'] = array();
$i = 1;
$cfg['Servers'][$i]['auth_type']      = 'signon';
$cfg['Servers'][$i]['SignonSession']  = 'GPanelSignon';
$cfg['Servers'][$i]['SignonURL']      = 'gpanel-signon.php';
$cfg['Servers'][$i]['LogoutURL']      = 'gpanel-signon.php';
$cfg['Servers'][$i]['host']           = '${mysqlHost}';
$cfg['Servers'][$i]['AllowNoPassword'] = false;
$cfg['ServerDefault'] = 1;
`);

  // The bridge exchanges the one-time token over HTTP with the panel, then
  // seeds the GPanelSignon session with the keys phpMyAdmin's signon auth
  // reads (PMA_single_signon_*). Works with any PHP build — no pdo_sqlite.
  const panelInternal = `http://127.0.0.1:${config.port}`;
  const devHost = process.env.GPANEL_MYSQL_HOST || '127.0.0.1';
  fs.writeFileSync(path.join(workDir, 'gpanel-signon.php'), `<?php
$token = $_GET['t'] ?? '';
if (!preg_match('/^[a-f0-9]{64}$/', $token)) { http_response_code(400); die('Invalid sign-on token.'); }
$ctx = stream_context_create(array('http' => array('timeout' => 5)));
$raw = @file_get_contents('${panelInternal}/api/v1/pma/token?t=' . urlencode($token), false, $ctx);
if ($raw === false) { http_response_code(502); die('Cannot reach the G-Panel token service — is the panel running?'); }
$data = json_decode($raw, true);
if (!is_array($data) || empty($data['mysql_user'])) { http_response_code(403); die($data['error'] ?? 'Sign-on token expired or already used.'); }
session_name('GPanelSignon');
session_start();
session_regenerate_id(true);
$_SESSION['PMA_single_signon_user'] = $data['mysql_user'];
$_SESSION['PMA_single_signon_password'] = $data['mysql_pass'];
$_SESSION['PMA_single_signon_host'] = '${devHost}';
$_SESSION['PMA_single_signon_port'] = '';
$_SESSION['PMA_single_signon_token'] = bin2hex(random_bytes(16));
header('Location: index.php');
`);

  fs.writeFileSync(path.join(workDir, 'router.php'), `<?php
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$file = __DIR__ . $path;
if ($path !== '/' && file_exists($file) && !is_dir($file)) return false;
require __DIR__ . '/index.php';
`);

  // ---- serve with the machine's PHP ----
  // phpMyAdmin versions only run on certain PHP releases (e.g. 5.2.x breaks
  // on PHP 8.4/8.5), so try candidates newest-first and keep the first one
  // that actually renders the app — verified against signon.php itself.
  const pidFile = path.join(workDir, 'php.pid');
  try {
    const oldPid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
    if (oldPid) {
      if (process.platform === 'win32') await runSafe('taskkill', ['/F', '/PID', String(oldPid)]);
      else process.kill(oldPid, 'SIGTERM');
    }
  } catch { /* no stale process */ }

  const phpCandidates = await findPhpCandidates();
  if (!phpCandidates.length) {
    state.error = 'No PHP found on this machine (checked PATH, Laragon, XAMPP). The original phpMyAdmin is a PHP application — install.php sets both up automatically on the VPS.';
    return state;
  }

  for (const php of phpCandidates) {
    // display_errors off + deprecations muted: phpMyAdmin 5.2.x vendor deps
    // emit PHP 8.3+ deprecation notices that would otherwise flood the output
    state.child = spawn(php, [
      '-d', 'display_errors=0', '-d', 'error_reporting=24575',
      '-S', `127.0.0.1:${PMA_PORT}`, '-t', workDir, path.join(workDir, 'router.php')
    ], {
      stdio: 'ignore'
    });
    try { fs.writeFileSync(pidFile, String(state.child.pid)); } catch {}
    state.child.on('exit', () => { state.url = null; });

    let up = false;
    for (let i = 0; i < 16; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PMA_PORT}/gpanel-signon.php`, { signal: AbortSignal.timeout(1500) });
        // 400 'Invalid sign-on token' = PHP + the app itself are working
        if (res.status === 400) { up = true; break; }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (up) {
      state.url = `http://127.0.0.1:${PMA_PORT}`;
      state.source = `${source} on ${path.basename(path.dirname(php))}`;
      break;
    }
    try { state.child.kill(); } catch {}
  }

  if (!state.url && !state.error) {
    state.error = 'None of the local PHP builds could run phpMyAdmin — check .devdata/pma-local with display_errors for details.';
  }
  return state;
}

async function downloadOfficialPma(dataDir, version) {
  const archive = path.join(dataDir, `phpMyAdmin-${version}-all-languages.tar.gz`);
  if (!fs.existsSync(archive)) {
    const url = `https://files.phpmyadmin.net/phpMyAdmin/${version}/phpMyAdmin-${version}-all-languages.tar.gz`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024 * 1024 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
      throw new Error('downloaded archive looks truncated');
    }
    fs.writeFileSync(archive, buf);
  }
  const dest = path.join(dataDir, `phpMyAdmin-${version}-all-languages`);
  if (!fs.existsSync(path.join(dest, 'index.php'))) {
    // Git Bash's GNU tar reads "F:/..." as a remote host — use the native
    // bsdtar on Windows, which handles drive-letter paths correctly.
    const tarBin = process.platform === 'win32' && fs.existsSync('C:/Windows/System32/tar.exe')
      ? 'C:/Windows/System32/tar.exe'
      : 'tar';
    await new Promise((resolve, reject) => {
      execFile(tarBin, ['-xzf', archive, '-C', dataDir], (err) => err ? reject(err) : resolve());
    });
  }
  return dest;
}

// Dev-machine local runtime detection (Laragon / XAMPP / WAMP / PATH).
// Only RUNTIMES are detected — a PHP binary to serve the panel's own
// phpMyAdmin and the mysql client to manage real local databases.
// phpMyAdmin itself is always the panel's own copy of the official package
// (downloaded once into the panel data dir), never a Laragon/XAMPP install —
// that keeps the panel's signon-only config isolated from other apps.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runSafe } from './exec.js';

const cache = {};

function* candidates() {
  const home = os.homedir();
  yield 'C:/laragon';
  yield 'D:/laragon';
  yield path.join(home, 'laragon');
  yield 'C:/xampp';
  yield 'D:/xampp';
  yield 'C:/wamp64';
  yield 'C:/wamp';
}

function listDirs(base) {
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function versionKey(name) {
  const m = String(name).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return [0, 0, 0];
  return [+m[1], +m[2] || 0, +m[3] || 0];
}

function pickNewest(dir, names) {
  const sorted = [...names].sort((a, b) => {
    const ka = versionKey(a), kb = versionKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
  const last = sorted[sorted.length - 1];
  return last ? path.join(dir, last) : null;
}

/** Find PHP CLI candidates, ordered phpMyAdmin-compatibility first.
 *  phpMyAdmin 5.2.x officially supports PHP ≤ 8.2 (8.3 works; 8.4/8.5 fatal),
 *  so compatible releases are tried before bleeding-edge ones. */
export async function findPhpCandidates() {
  if (cache.phpCandidates) return cache.phpCandidates;
  const out = [];
  const compatRank = (name) => {
    const v = versionKey(name);
    if (v[0] === 8 && v[1] <= 2) return 0;      // ideal
    if (v[0] === 8 && v[1] === 3) return 1;      // works
    if (v[0] === 8 && v[1] === 0) return 2;
    return 3;                                    // newest/unknown — last resort
  };

  const onPath = await runSafe('php', ['-v']);
  if (!onPath.failed && /PHP (\d+)/.test(onPath.stdout || '')) {
    out.push({ cmd: 'php', rank: 1 });           // unknown version — middle
  }

  for (const base of candidates()) {
    // Laragon: <base>/bin/php/php-<ver>/php.exe
    const phpDir = path.join(base, 'bin', 'php');
    const entries = listDirs(phpDir).filter((d) => /^php/i.test(d)).map((name) => {
      const exe = path.join(phpDir, name, process.platform === 'win32' ? 'php.exe' : 'php');
      return fs.existsSync(exe) ? { cmd: exe, rank: compatRank(name) } : null;
    }).filter(Boolean);
    const xphp = path.join(base, 'php', process.platform === 'win32' ? 'php.exe' : 'php');
    if (fs.existsSync(xphp)) entries.push({ cmd: xphp, rank: 2 });
    out.push(...entries);
  }

  // stable sort keeps discovery order within the same rank
  cache.phpCandidates = out
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((e) => e.cmd);
  return cache.phpCandidates;
}

/** Find a usable PHP CLI binary. Returns absolute path or null. */
export async function findPhp() {
  const list = await findPhpCandidates();
  return list[0] || null;
}

/** Find the mysql CLI (+ mysqldump sibling). Returns {bin, dumpBin} or null. */
export async function findMysqlClient() {
  if (cache.mysql !== undefined) return cache.mysql;
  let mysql = null;

  const onPath = await runSafe('mysql', ['--version']);
  if (!onPath.failed && /MariaDB|MySQL/i.test(onPath.stdout || '')) {
    mysql = 'mysql';
  }

  if (!mysql) {
    outer: for (const base of candidates()) {
      const mysqlDir = path.join(base, 'bin', 'mysql');
      const newest = pickNewest(mysqlDir, listDirs(mysqlDir).filter((d) => /mysql/i.test(d)));
      if (newest) {
        const exe = path.join(newest, 'bin', process.platform === 'win32' ? 'mysql.exe' : 'mysql');
        if (fs.existsSync(exe)) { mysql = exe; break outer; }
      }
      const xmysql = path.join(base, 'mysql', 'bin', process.platform === 'win32' ? 'mysql.exe' : 'mysql');
      if (fs.existsSync(xmysql)) { mysql = xmysql; break outer; }
    }
  }

  if (!mysql) { cache.mysql = null; return null; }

  let dumpBin = null;
  if (mysql !== 'mysql') {
    const dumpName = process.platform === 'win32' ? 'mysqldump.exe' : 'mysqldump';
    const dump = path.join(path.dirname(mysql), dumpName);
    if (fs.existsSync(dump)) dumpBin = dump;
  }

  cache.mysql = { bin: mysql, dumpBin };
  return cache.mysql;
}

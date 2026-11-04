import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runSafe } from '../../lib/exec.js';

// File manager operations — cross-platform (Windows + Linux).
// Path-scoped by the caller (routes validate against allowed roots first).

async function dirSize(dir, depth = 0) {
  let total = 0;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 12) total += await dirSize(full, depth + 1);
    } else {
      try { total += (await fsp.stat(full)).size; } catch {}
    }
  }
  return total;
}

function tarBin() {
  return process.platform === 'win32' && fs.existsSync('C:/Windows/System32/tar.exe')
    ? 'C:/Windows/System32/tar.exe'
    : 'tar';
}

export default {
  async list(dir) {
    if (process.platform === 'win32' && dir === '/') {
      const out = [];
      for (let c = 67; c <= 90; c++) {
        const drv = String.fromCharCode(c) + ':/';
        if (!fs.existsSync(drv)) continue;
        const st = await fsp.stat(drv);
        out.push({ name: String.fromCharCode(c) + ':', type: 'dir', size: 0, mode: (st.mode & 0o777).toString(8).padStart(3, '0'), mtime: st.mtimeMs, owner: 'user' });
      }
      return out;
    }
    // Windows drive roots ('D:/') are valid readdir targets — do NOT strip
    // the slash: bare 'd:' means "cwd on that drive" and reads the wrong dir.
    if (/^[a-z]:$/i.test(dir)) dir = dir + '/';
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      try {
        const full = path.join(dir, e.name);
        const st = await fsp.stat(full);
        out.push({
          name: e.name,
          type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file',
          size: e.isDirectory() ? 0 : st.size,
          mode: (st.mode & 0o777).toString(8).padStart(3, '0'),
          mtime: st.mtimeMs,
          owner: 'user'
        });
      } catch { /* raced delete */ }
    }
    return out;
  },

  async read(file) {
    const stat = await fsp.stat(file);
    if (stat.size > 4 * 1024 * 1024) throw new Error('File exceeds 4 MB edit limit — download and edit locally');
    return fsp.readFile(file, 'utf8');
  },

  async write(file, content) {
    await fsp.writeFile(file, content);
    return true;
  },

  async mkdir(dir) {
    await fsp.mkdir(dir, { recursive: true });
    return true;
  },

  async remove(p) {
    await fsp.rm(p, { recursive: true, force: true });
    return true;
  },

  async rename(from, to) {
    await fsp.rename(from, to);
    return true;
  },

  async chmod(p, mode) {
    if (process.platform === 'win32') return true; // POSIX perms don't apply
    await fsp.chmod(p, parseInt(mode, 8));
    return true;
  },

  async extract(archive, destDir) {
    await fsp.mkdir(destDir, { recursive: true });
    if (/\.zip$/i.test(archive)) {
      if (process.platform === 'win32') {
        await runSafe('powershell', ['-NoProfile', '-Command',
          `Expand-Archive -LiteralPath "${archive.replace(/'/g, "''")}" -DestinationPath "${destDir.replace(/'/g, "''")}" -Force`
        ], { timeout: 300000 });
      } else {
        await runSafe('unzip', ['-o', archive, '-d', destDir], { timeout: 300000 });
      }
    } else if (/\.tar\.gz$|\.tgz$|\.tar$/.test(archive)) {
      const args = archive.toLowerCase().endsWith('.tar') ? ['-xf', archive, '-C', destDir] : ['-xzf', archive, '-C', destDir];
      await runSafe(tarBin(), args, { timeout: 300000 });
    } else {
      throw new Error('Unsupported archive type (zip, tar.gz, tar)');
    }
    return true;
  },

  async diskUsage(dir) {
    return dirSize(dir);
  },

  exists(p) {
    return fs.existsSync(p);
  }
};

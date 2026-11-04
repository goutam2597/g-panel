import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { config } from '../config.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
  '.xml': 'application/xml', '.pdf': 'application/pdf'
};

const servers = new Map();   // domainId -> http.Server (static fallback)
const phpProcs = new Map();  // domainId -> { child, port, docroot, logs[] }

// ---------------------------------------------------------------- static --
// Fallback static web server so local sites remain reachable when PHP is not
// available. When nginx is present it stays authoritative on its own port.

export function startSiteServer(domainId, docroot, port) {
  if (!port || !docroot) return { ok: false, error: 'missing port/docroot' };
  if (servers.has(domainId)) return { ok: true, port, already: true };

  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
      let file = path.join(docroot, urlPath);
      const root = path.resolve(docroot);
      if (!path.resolve(file).startsWith(root + path.sep) && path.resolve(file) !== root) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        file = path.join(docroot, 'index.html');
      }
      if (!fs.existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>No files yet</h1><p>Add your website files to this site folder.</p>');
        return;
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500); res.end('site server error');
    }
  });

  return new Promise((resolve) => {
    server.on('error', (err) => {
      servers.delete(domainId);
      resolve({ ok: false, error: err.message, port });
    });
    server.listen(port, '127.0.0.1', () => {
      servers.set(domainId, server);
      resolve({ ok: true, port });
    });
  });
}

export function stopSiteServer(domainId) {
  const s = servers.get(domainId);
  if (s) { try { s.close(); } catch {} servers.delete(domainId); }
  stopPhpServer(domainId);
}

/** True when at least one built-in per-site server is serving. */
export function anySiteServerRunning() { return servers.size > 0 || phpProcs.size > 0; }

export function siteServerStatus(domainId) {
  return { running: servers.has(domainId) || phpProcs.has(domainId) };
}

export function starterHtml(domain, docroot) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${domain}</title>
<style>body{font-family:Georgia,serif;max-width:44rem;margin:4rem auto;padding:0 1.5rem;color:#1a1c20;line-height:1.6}
.badge{display:inline-block;background:#0E6B5A;color:#fff;font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;padding:.3rem .7rem;border-radius:3px}</style>
</head><body>
<span class="badge">Served by G-Panel</span>
<h1>${domain}</h1>
<p>This site is served locally from <code>${docroot}</code>. Replace this page by adding files to <code>public_html</code> via the File Manager.</p>
<p>On this PC it has no public DNS yet — the Websites page gives you a Cloudflare tunnel URL + a local URL to open it.</p>
</body></html>
`;
}

export function ensurePublicHtml(domain, docroot) {
  fs.mkdirSync(docroot, { recursive: true });
  const logsDir = path.join(path.dirname(docroot), 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const idx = path.join(docroot, 'index.html');
  if (!fs.existsSync(idx)) fs.writeFileSync(idx, starterHtml(domain, docroot));
}

// ------------------------------------------------------------------- PHP --
// Per-site PHP server (the dedicated port runs PHP directly):
//   php -S 127.0.0.1:<port> router.php
// The router streams static assets via the built-in server and hands every
// other request to index.php — so plain PHP sites and Laravel
// (docroot = <project>/public) work out of the box, including pretty URLs.

export async function startPhpServer(domainId, docroot, port, { phpBin = null } = {}) {
  if (phpProcs.has(domainId)) {
    const existing = phpProcs.get(domainId);
    return { ok: true, port: existing.port, already: true, engine: 'php' };
  }

  if (!phpBin) {
    const { findPhpCandidates } = await import('../lib/localstack.js');
    const candidates = await findPhpCandidates();
    if (!candidates.length) throw new Error('No PHP found on this machine — install the panel PHP stack');
    phpBin = candidates[0];
  }

  // PHP sites want index.php, not the static starter page
  const idxPhp = path.join(docroot, 'index.php');
  if (!fs.existsSync(idxPhp)) {
    const idxHtml = path.join(docroot, 'index.html');
    if (fs.existsSync(idxHtml)) {
      try { fs.mkdirSync(path.join(docroot, 'backup'), { recursive: true }); fs.renameSync(idxHtml, path.join(docroot, 'backup', 'index.html')); } catch {}
    }
    fs.writeFileSync(idxPhp, `<?php
http_response_code(200);
echo '<!doctype html><html><head><meta charset="utf-8"><title>' . $_SERVER['SERVER_NAME'] . '</title></head>';
echo '<body style="font-family:Georgia,serif;max-width:44rem;margin:4rem auto">';
echo '<span style="background:#0E6B5A;color:#fff;padding:.3rem .7rem;font-size:.75rem;letter-spacing:.08em;text-transform:uppercase">Served by G-Panel + PHP</span>';
echo '<h1>' . $_SERVER['SERVER_NAME'] . '</h1><p>PHP ' . PHP_VERSION . ' is running for this site.</p>';
echo '</body></html>';
`);
  }

  const router = path.join(docroot, '.gpanel-router.php');
  fs.writeFileSync(router, `<?php
// Generated by G-Panel — per-site local PHP router
// Auto-detects Laravel: when the folder is a Laravel project (artisan +
// public/index.php), the document root becomes <project>/public.
$base = __DIR__;
if (file_exists(__DIR__ . '/artisan') && file_exists(__DIR__ . '/public/index.php')) {
    $base = __DIR__ . '/public';
}
$uri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
$file = $base . $uri;
if ($uri !== '/' && file_exists($file) && !is_dir($file) && !preg_match('/\\.php$/i', $file)) {
    return false; // let the built-in server stream static assets
}
if (preg_match('/\\.php$/i', $file) && file_exists($file) && !is_dir($file)) {
    chdir(dirname($file));
    require $file;
    return;
}
chdir($base);
require $base . '/index.php';
`);

  const child = spawn(phpBin, ['-S', `127.0.0.1:${port}`, '-t', docroot, router], {
    cwd: docroot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, GPANEL_SITE: String(domainId) }
  });
  const logs = [];
  child.stdout.on('data', (d) => { logs.push(String(d).trim()); if (logs.length > 300) logs.shift(); });
  child.stderr.on('data', (d) => { logs.push('[err] ' + String(d).trim()); if (logs.length > 300) logs.shift(); });
  child.on('exit', (code) => {
    if (phpProcs.get(domainId)?.child === child) phpProcs.delete(domainId);
  });
  phpProcs.set(domainId, { child, port, docroot, logs });
  return { ok: true, port, engine: 'php' };
}

export function stopPhpServer(domainId) {
  const p = phpProcs.get(domainId);
  if (p) { try { p.child.kill(); } catch {} phpProcs.delete(domainId); }
}

export function phpServerLogs(domainId) {
  return (phpProcs.get(domainId)?.logs || []).join('\n');
}

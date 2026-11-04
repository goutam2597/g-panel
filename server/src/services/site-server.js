import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { config } from '../config.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json', '.xml': 'application/xml', '.pdf': 'application/pdf' };

const servers = new Map();

// Fallback static web server so local sites remain reachable when nginx-for-Windows
// is not installed in C:\gpanel\stack\nginx. When nginx is present it stays authoritative.
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
        res.end(`<h1>${domainId}</h1><p>No index.html yet — add files to public_html.</p>`);
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
}

/** True when at least one built-in per-site server is serving. */
export function anySiteServerRunning() { return servers.size > 0; }

export function siteServerStatus(domainId) {
  return { running: servers.has(domainId) };
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

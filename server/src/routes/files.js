import path from 'node:path';
import fs from 'node:fs';
import { db } from '../db/index.js';
import { audit } from '../auth/index.js';
import { validatePathSafe } from '../lib/validate.js';
import { sys } from '../services/index.js';
import { config } from '../config.js';

/**
 * File manager API. Every route resolves the caller's allowed roots first:
 *  - user: /home/<username>/domains
 *  - admin (not impersonating): full filesystem (dangerous but intentional, like cPanel's root file editor)
 */

function allowedRoots(request) {
  const s = request.gpanelSession;
  if (s.role === 'admin' && !s.impersonated_by) return ['/'];
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(s.user_id);
  // the ~/public_html junction plus the domains tree itself
  return [config.domainsDir(user.username), config.publicHtmlLink(user.username)];
}

function resolvePath(request, requested, reply) {
  const roots = allowedRoots(request);
  const res = validatePathSafe(String(requested || ''), roots);
  if (res.error) {
    reply.code(403).send({ error: res.error });
    return null;
  }
  return res.path;
}

export default async function (app) {
  app.get('/roots', { preHandler: [app.requireAuth] }, async (request) => {
    const s = request.gpanelSession;
    if (s.role === 'admin' && !s.impersonated_by) {
      return { roots: [{ label: 'Filesystem root', path: '/' }] };
    }
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(s.user_id);
    const domains = db.prepare('SELECT domain FROM domains WHERE user_id = ? ORDER BY created_at').all(s.user_id);
    const roots = [];
    // cPanel-style: ~/public_html is the main domain's document root
    const link = config.publicHtmlLink(user.username);
    if (fs.existsSync(link)) {
      roots.push({ label: 'public_html (main site)', path: link });
    }
    for (const d of domains) {
      roots.push({ label: `${d.domain} (public_html)`, path: config.webPublic(user.username, d.domain) });
    }
    return { roots };
  });

  app.get('/list', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const dir = resolvePath(request, request.query.path || '/', reply);
    if (dir === null) return;
    try {
      const entries = await sys.files.list(dir);
      const cwd = dir === '/' ? '/' : dir.replace(/\/$/, '');
      const parent = cwd === '/' ? null : path.dirname(cwd);
      return {
        path: cwd,
        parent,
        entries: entries.map((e) => ({ ...e, path: path.posix.join(cwd, e.name) }))
      };
    } catch (e) {
      reply.code(400).send({ error: e.message });
      return;
    }
  });

  app.get('/read', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const file = resolvePath(request, request.query.path, reply);
    if (file === null) return;
    try {
      return { path: file, content: await sys.files.read(file) };
    } catch (e) {
      reply.code(400).send({ error: e.message });
      return;
    }
  });

  app.put('/write', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const file = resolvePath(request, request.body?.path, reply);
    if (file === null) return;
    try {
      await sys.files.write(file, String(request.body?.content ?? ''));
      audit(request.gpanelSession.username, 'file.write', file, null, request.ip);
      return { ok: true };
    } catch (e) {
      reply.code(400).send({ error: e.message });
      return;
    }
  });

  app.post('/mkdir', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const dir = resolvePath(request, request.body?.path, reply);
    if (dir === null) return;
    try {
      await sys.files.mkdir(dir);
      audit(request.gpanelSession.username, 'file.mkdir', dir, null, request.ip);
      return { ok: true };
    } catch (e) {
      reply.code(400).send({ error: e.message });
      return;
    }
  });

  app.post('/rename', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const from = resolvePath(request, request.body?.from, reply);
    const to = resolvePath(request, request.body?.to, reply);
    if (from === null || to === null) return;
    try {
      await sys.files.rename(from, to);
      audit(request.gpanelSession.username, 'file.rename', from, to, request.ip);
      return { ok: true };
    } catch (e) {
      reply.code(400).send({ error: e.message });
      return;
    }
  });

  app.post('/chmod', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const p = resolvePath(request, request.body?.path, reply);
    if (p === null) return;
    if (!/^[0-7]{3,4}$/.test(String(request.body?.mode || ''))) {
      reply.code(400).send({ error: 'Mode must be octal, e.g. 644' });
      return;
    }
    try {
      await sys.files.chmod(p, request.body.mode);
      audit(request.gpanelSession.username, 'file.chmod', p, request.body.mode, request.ip);
      return { ok: true };
    } catch (e) {
      reply.code(400).send({ error: e.message });
      return;
    }
  });

  app.post('/delete', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const p = resolvePath(request, request.body?.path, reply);
    if (p === null) return;
    if (p === '/') { reply.code(400).send({ error: 'Refusing to delete filesystem root' }); return; }
    try {
      await sys.files.remove(p);
      audit(request.gpanelSession.username, 'file.delete', p, null, request.ip);
      return { ok: true };
    } catch (e) {
      reply.code(400).send({ error: e.message });
      return;
    }
  });

  app.post('/extract', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const archive = resolvePath(request, request.body?.archive, reply);
    const dest = resolvePath(request, request.body?.dest, reply);
    if (archive === null || dest === null) return;
    try {
      await sys.files.extract(archive, dest);
      audit(request.gpanelSession.username, 'file.extract', archive, dest, request.ip);
      return { ok: true };
    } catch (e) {
      reply.code(400).send({ error: e.message });
      return;
    }
  });

  // upload via multipart
  app.post('/upload', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const data = await request.file();
    if (!data) { reply.code(400).send({ error: 'No file received' }); return; }
    const dest = resolvePath(request, request.query.path || '/', reply);
    if (dest === null) return;
    const target = path.posix.join(dest, data.filename.replace(/[\/\\]/g, '_'));
    try {
      const chunks = [];
      await new Promise((resolve, reject) => {
        data.file.on('data', (c) => chunks.push(c));
        data.file.on('end', resolve);
        data.file.on('error', reject);
      });
      const buffer = Buffer.concat(chunks);
      await sys.files.write(target, buffer);
      audit(request.gpanelSession.username, 'file.upload', target, `${buffer.length} bytes`, request.ip);
      return { ok: true, path: target };
    } catch (e) {
      reply.code(400).send({ error: e.message });
      return;
    }
  });

  // download (streams in real driver; sim returns text)
  app.get('/download', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const p = resolvePath(request, request.query.path, reply);
    if (p === null) return;
    try {
      if (config.dev) {
        const content = await sys.files.read(p).catch(() => '');
        reply.header('content-disposition', `attachment; filename="${path.basename(p)}"`);
        return content;
      }
      const { default: fsp } = await import('node:fs/promises');
      const stat = await fsp.stat(p).catch(() => null);
      if (!stat) { reply.code(404).send({ error: 'Not found' }); return; }
      if (stat.isDirectory()) {
        // stream a tar.gz of the directory
        const { execFile } = await import('node:child_process');
        reply.header('content-type', 'application/gzip');
        reply.header('content-disposition', `attachment; filename="${path.basename(p)}.tar.gz"`);
        return reply.send(execFile('tar', ['-czf', '-', '-C', path.dirname(p), path.basename(p)]));
      }
      reply.header('content-disposition', `attachment; filename="${path.basename(p)}"`);
      return reply.send((await import('node:fs')).createReadStream(p));
    } catch (e) {
      reply.code(400).send({ error: e.message });
      return;
    }
  });
}

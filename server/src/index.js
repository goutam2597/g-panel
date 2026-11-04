import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { config, DEV, IS_WIN } from './config.js';
import { migrate, db } from './db/index.js';
import { seed } from './db/seed.js';
import { getSession, originCheck, csrfCheck, requireAuth, requireAdmin } from './auth/index.js';
import { startScheduler } from './jobs/scheduler.js';
import { sys } from './services/index.js';
import terminalWs from './routes/terminal.js';

const app = Fastify({
  logger: DEV
    ? { level: 'warn' }
    : { level: 'info', transport: undefined },
  bodyLimit: 16 * 1024 * 1024,
  trustProxy: true,
  ...(config.tls ? { https: { key: config.tls.key, cert: config.tls.cert } } : {})
});

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: config.limits.maxUploadMb * 1024 * 1024 } });

// ---- session parsing + security hooks ----
app.decorateRequest('gpanelSession', null);
app.addHook('onRequest', async (request) => {
  if (request.url.startsWith('/api/')) {
    const token = request.cookies[config.session.cookieName];
    request.gpanelSession = getSession(token);
  }
});
app.decorate('requireAuth', requireAuth);
app.decorate('requireAdmin', requireAdmin);

app.setErrorHandler((err, request, reply) => {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  const message = status === 500 ? (DEV ? err.stack : 'Internal server error') : err.message;
  if (status >= 500) request.log.error(err);
  reply.code(status).send({ error: message });
});

// ---- API routes ----
await app.register(
  async function api(api) {
    api.addHook('onRequest', originCheck);
    api.addHook('preHandler', csrfCheck);

    const modules = [
      'auth.js', 'dashboard.js', 'packages.js', 'users.js', 'domains.js', 'apps.js',
      'dns.js', 'mail.js', 'ftp.js', 'databases.js', 'cron.js', 'ssl.js',
      'files.js', 'ssh.js', 'backups.js', 'firewall.js', 'settings.js', 'audit.js',
      'pma.js', 'cloudflare.js'
    ];
    for (const m of modules) {
      const mod = await import(`./routes/${m}`);
      await api.register(mod.default, { prefix: modulePrefix(m) });
    }
  },
  { prefix: '/api/v1' }
);

function modulePrefix(filename) {
  return '/' + filename.replace('.js', '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// ---- static SPA ----
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/', index: 'index.html' });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    if (request.method === 'GET') return reply.type('text/html').send(fs.readFileSync(path.join(webDist, 'index.html')));
    return reply.code(404).send({ error: 'Not found' });
  });
} else if (DEV) {
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: `Not found. In dev, serve the SPA from web/ (npm run dev --workspace web) — API is on :${config.port}` });
  });
}

// ---- websocket terminal ----
terminalWs.attach(app);

// ---- boot ----
migrate();
await seed();
startScheduler();

// Bring every site's local server (and its tunnel, if it had one) back up
// after a panel restart — quick-tunnel URLs refresh automatically.
if (IS_WIN || DEV) {
  import('./services/sites.js').then(({ restoreLocalSites }) => restoreLocalSites())
    .then((r) => {
      if (r && (r.restored || r.reconnected)) {
        console.log(`[gpanel] local sites restored: ${r.restored} served, ${r.reconnected} tunnel(s) reconnected`);
      }
    })
    .catch(() => {});
}

const address = await app.listen({ port: config.port, host: config.host });
console.log(`G-Panel ${config.version}${DEV ? ' [DEV MODE — simulated services]' : ''}`);
console.log(`Listening on ${address} — open ${config.tls ? 'https' : 'http'}://<server-ip>:${config.port}`);

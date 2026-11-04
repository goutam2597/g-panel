import { sys } from '../services/index.js';

export default async function (app) {
  app.get('/status', { preHandler: [app.requireAdmin] }, async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const stack = (await import('../config.js')).config.stackDir;
    const has = (p) => fs.existsSync(p);
    return {
      stackDir: stack,
      mariadb: has(path.join(stack || '', 'mariadb', 'bin', 'mysqld.exe')),
      nginx: has(path.join(stack || '', 'nginx', 'nginx.exe')),
      php: has(path.join(stack || '', 'php', 'php-cgi.exe')),
      composer: has(path.join(stack || '', 'composer.phar'))
    };
  });

  app.post('/install', { preHandler: [app.requireAdmin] }, async (request, reply) => {
    const comps = Array.isArray(request.body?.components) && request.body.components.length
      ? request.body.components
      : ['mariadb', 'nginx', 'php', 'composer'];
    const { ensureStack } = await import('../services/real/stack.js');
    try {
      return { ok: true, result: await ensureStack(comps) };
    } catch (e) {
      reply.code(502).send({ error: e.message });
      return;
    }
  });
}

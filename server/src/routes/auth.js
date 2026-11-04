import {
  authenticate, createSession, destroySession, loginAllowed,
  recordLoginFailure, recordLoginSuccess, audit
} from '../auth/index.js';
import { config } from '../config.js';

export default async function (app) {
  // non-sensitive boot info for the login page
  app.get('/status', async () => {
    return { dev: config.dev, port: config.port, version: config.version, name: 'G-Panel', platform: config.isWin ? 'windows' : 'linux' };
  });

  app.post('/login', async (request, reply) => {
    const ip = request.ip;
    if (!loginAllowed(ip)) {
      reply.code(429).send({ error: `Too many attempts — locked for ${config.limits.loginLockMinutes} minutes` });
      return;
    }
    const { username, password } = request.body || {};
    const user = authenticate(username, password);
    if (!user) {
      recordLoginFailure(ip);
      audit(String(username || 'unknown'), 'login.failed', null, null, ip);
      reply.code(401).send({ error: 'Invalid username or password' });
      return;
    }
    recordLoginSuccess(ip);
    const session = createSession(user.id, ip, request.headers['user-agent']);
    reply.setCookie(config.session.cookieName, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.session.secureCookie,
      path: '/',
      maxAge: config.session.ttlHours * 3600
    });
    audit(user.username, 'login', null, null, ip);
    return { user: { id: user.id, username: user.username, role: user.role, email: user.email }, csrf: session.csrf };
  });

  app.post('/logout', { preHandler: [(req, rep, done) => { req.gpanelSession ? done() : rep.code(401).send({ error: 'Not authenticated' }); }] }, async (request, reply) => {
    audit(request.gpanelSession.username, 'logout', null, null, request.ip);
    destroySession(request.gpanelSession.token);
    reply.clearCookie(config.session.cookieName, { path: '/' });
    return { ok: true };
  });

  app.get('/me', { preHandler: [(req, rep, done) => { req.gpanelSession ? done() : rep.code(401).send({ error: 'Not authenticated' }); }] }, async (request) => {
    const s = request.gpanelSession;
    return {
      user: { id: s.user_id, username: s.username, email: s.email, role: s.role },
      impersonating: Boolean(s.impersonated_by),
      csrf: s.csrf,
      dev: config.dev
    };
  });
}

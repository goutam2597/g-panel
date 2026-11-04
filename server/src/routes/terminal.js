import { WebSocketServer } from 'ws';
import { Client } from 'ssh2';
import fs from 'node:fs';
import { getSession } from '../auth/index.js';
import { sys } from '../services/index.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import sim from '../services/sim/index.js';

/**
 * Web terminal over WebSocket (/api/v1/terminal).
 * Admin (not impersonating): root session via panel-managed key.
 * User: session to their own Linux account via panel-managed per-user key.
 * In dev mode: simulated shell backed by the simulator's virtual filesystem.
 */
export default {
  attach(app) {
    const wss = new WebSocketServer({ noServer: true });

    app.server.on('upgrade', async (req, socket, head) => {
      if (!req.url.startsWith('/api/v1/terminal')) return socket.destroy();

      // parse session cookie manually
      const cookies = Object.fromEntries(
        String(req.headers.cookie || '')
          .split(';')
          .map((c) => c.trim().split('=').map(decodeURIComponent))
          .filter((c) => c.length === 2)
      );
      const session = getSession(cookies[config.session.cookieName]);
      if (!session) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return socket.destroy();
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        startSession(ws, session);
      });
    });
  }
};

function startSession(ws, session) {
  const admin = session.role === 'admin' && !session.impersonated_by;
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(session.user_id);
  const username = admin ? 'root' : user.username;

  if (config.isWin) {
    windowsShell(ws, session);
    return;
  }

  if (config.dev) {
    simulatedShell(ws, session);
    return;
  }

  sys.ssh.ensurePanelKey(username).then((keyPath) => {
    const conn = new Client();
    conn
      .once('ready', () => {
        conn.shell({ term: 'xterm-256color' }, (err, stream) => {
          if (err) {
            ws.send(`\r\nShell error: ${err.message}\r\n`);
            ws.close();
            return;
          }
          stream.on('data', (d) => ws.send(d.toString('binary')));
          stream.stderr.on('data', (d) => ws.send(d.toString('binary')));
          stream.on('close', () => { ws.close(); conn.end(); });
          ws.on('message', (msg) => {
            try {
              const parsed = JSON.parse(msg.toString());
              if (parsed.type === 'resize') stream.setWindow(parsed.rows, parsed.cols, 0, 0);
              else stream.write(parsed.data || '');
            } catch {
              stream.write(msg.toString());
            }
          });
          ws.on('close', () => { stream.close(); conn.end(); });
        });
      })
      .once('error', (err) => {
        ws.send(`\r\nSSH connection failed: ${err.message}\r\n`);
        ws.close();
      })
      .connect({
        host: '127.0.0.1',
        port: 22,
        username,
        privateKey: fs.readFileSync(keyPath),
        readyTimeout: 10000
      });
  }).catch((e) => {
    ws.send(`\r\nTerminal key error: ${e.message}\r\n`);
    ws.close();
  });
}

// ---- Windows terminal: a real local PowerShell in line mode ----
// (no PTY on Windows without native builds — input is line-based, output is
// streamed live. Everything runs as the panel process user.)
function windowsShell(ws, session) {
  const admin = session.role === 'admin' && !session.impersonated_by;
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(session.user_id);
  const username = admin ? 'administrator' : user.username;
  const { spawn } = require_('node:child_process');

  const banner = [
    `Windows PowerShell — ${username}@${os_hostname()}`,
    'Line mode: type a command and press Enter. output streams live.',
    ''
  ].join('\r\n');
  const prompt = () => `\r\n\x1b[38;5;71mPS>\x1b[0m `;
  let busy = false;

  ws.send(banner + prompt());

  let buffer = '';
  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      const data = parsed.data || '';
      for (const ch of data) {
        if (ch === '\r') {
          const line = buffer.trim();
          buffer = '';
          ws.send('\r\n');
          if (line && !busy) run(line);
          else if (busy) ws.send('[busy — wait for the current command]\r\n');
          ws.send(prompt());
        } else if (ch === '\u007f') {
          if (buffer.length) { buffer = buffer.slice(0, -1); ws.send('\b \b'); }
        } else if (ch >= ' ') {
          buffer += ch;
          ws.send(ch);
        }
      }
    } catch { /* ignore malformed */ }
  });

  function run(line) {
    busy = true;
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', line], {
      windowsHide: true,
      env: { ...process.env }
    });
    child.stdout.on('data', (d) => ws.send(String(d).replace(/\n/g, '\r\n')));
    child.stderr.on('data', (d) => ws.send('\x1b[38;5;203m' + String(d).replace(/\n/g, '\r\n') + '\x1b[0m'));
    child.on('close', () => { busy = false; });
    child.on('error', (e) => { ws.send(`error: ${e.message}\r\n`); busy = false; });
  }
}

function os_hostname() {
  return require_('node:os').hostname();
}

function require_(mod) {
  return createRequire(import.meta.url)(mod);
}

import { createRequire } from 'node:module';
function simulatedShell(ws, session) {
  const admin = session.role === 'admin' && !session.impersonated_by;
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(session.user_id);
  const username = admin ? 'root' : user.username;
  let cwd = admin ? '/root' : `/home/${username}`;

  const banner = [
    'G-Panel simulated shell (DEV MODE — commands are not executed on a real server)',
    "Type 'help' for a few supported commands.",
    ''
  ].join('\r\n');
  const prompt = () => `\r\n\x1b[38;5;71m${username}@gpanel-demo\x1b[0m:\x1b[38;5;39m${cwd}\x1b[0m$ `;
  let buffer = '';

  ws.send(banner + prompt());

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      const data = parsed.data || '';
      for (const ch of data) {
        if (ch === '\r') {
          const line = buffer.trim();
          buffer = '';
          ws.send('\r\n');
          if (line) run(line);
          ws.send(prompt());
        } else if (ch === '\u007f') {
          if (buffer.length) { buffer = buffer.slice(0, -1); ws.send('\b \b'); }
        } else if (ch >= ' ') {
          buffer += ch;
          ws.send(ch);
        }
      }
    } catch { /* ignore malformed */ }
  });

  function run(line) {
    const [cmd, ...args] = line.split(/\s+/);
    const out = (s) => ws.send(s + '\r\n');
    const resolve = (p) => {
      if (!p) return cwd;
      if (p.startsWith('/')) return p;
      if (p === '~') return admin ? '/root' : `/home/${username}`;
      if (p.startsWith('~/')) return (admin ? '/root' : `/home/${username}`) + p.slice(1);
      return cwd === '/' ? '/' + p : cwd + '/' + p;
    };
    const node = (p) => (sim.files.getNode ? sim.files.getNode(p) : null);

    switch (cmd) {
      case 'help':
        out('Supported: help, ls, pwd, cd, cat, whoami, hostname, uname, uptime, systemctl status <svc>, echo, clear, exit');
        break;
      case 'ls': {
        const dir = node(args[0] ? resolve(args[0]) : cwd);
        if (!dir || dir.type !== 'dir') out(`ls: cannot access '${args[0] || cwd}'`);
        else out([...dir.children.keys()].sort().join('  ') || '(empty)');
        break;
      }
      case 'pwd':
        out(cwd);
        break;
      case 'cd': {
        const target = resolve(args[0] || (admin ? '/root' : `/home/${username}`));
        const n = node(target);
        if (n && n.type === 'dir') cwd = target;
        else out(`cd: ${args[0]}: No such directory`);
        break;
      }
      case 'cat': {
        const n = node(resolve(args[0] || ''));
        if (n && n.type === 'file') out(String(n.content ?? '').slice(0, 2000));
        else out(`cat: ${args[0]}: No such file`);
        break;
      }
      case 'whoami': out(username); break;
      case 'hostname': out('gpanel-demo'); break;
      case 'uname': out('Linux gpanel-demo 6.8.0-45-generic (simulated)'); break;
      case 'uptime': out(' 14:32:01 up 61 days,  1:10,  1 user,  load average: 0.62, 0.58, 0.55'); break;
      case 'systemctl':
        out(args[1] ? `● ${args[1]}.service - active (running) (simulated)` : 'Usage: systemctl status <service>');
        break;
      case 'echo': out(args.join(' ')); break;
      case 'clear': ws.send('\x1b[2J\x1b[H'); break;
      case 'exit': ws.close(); break;
      case '':
        break;
      default:
        out(`${cmd}: command not found (simulated shell)`);
    }
  }
}

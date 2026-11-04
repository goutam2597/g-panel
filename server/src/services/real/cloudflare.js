import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runSafe } from '../../lib/exec.js';
import { config } from '../../config.js';

// Cloudflare Tunnel + DNS driver (cross-platform).
//  - one-click install of the official cloudflared binary
//  - quick tunnel:  instant public https://<random>.trycloudflare.com URL
//  - named tunnel:  user pastes the dashboard token → remote-managed ingress
//  - DNS:           optional API-token mode manages records via the CF API

let state = {
  installed: null,      // path to binary or null
  mode: null,           // 'quick' | 'named' | null
  child: null,
  url: null,            // quick tunnel public URL
  logs: []
};

const BIN = () => {
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  return path.join(config.stackDir || config.dataDir, name);
};

function pushLog(line) {
  state.logs.push(`${new Date().toISOString()} ${String(line).trim()}`);
  if (state.logs.length > 400) state.logs.shift();
}

function stopChild() {
  if (state.child) {
    try { state.child.kill(); } catch {}
    state.child = null;
  }
  state.mode = null;
  state.url = null;
}

export default {
  async installedPath() {
    if (state.installed !== null) return state.installed;
    const p = BIN();
    state.installed = fs.existsSync(p) ? p : null;
    // linux: also accept cloudflared from PATH (installer may apt-install it)
    if (!state.installed && process.platform !== 'win32') {
      const r = await runSafe('cloudflared', ['--version']);
      state.installed = r.failed ? null : 'cloudflared';
    }
    return state.installed;
  },

  async status() {
    const bin = await this.installedPath();
    return {
      installed: Boolean(bin),
      bin,
      running: Boolean(state.child),
      mode: state.mode,
      url: state.url,
      version: bin ? (await runSafe(bin, ['--version'])).stdout?.trim() || null : null
    };
  },

  /** One-click install of the official cloudflared binary. */
  async install() {
    let url;
    if (process.platform === 'win32') {
      url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
    } else if (process.arch === 'arm64') {
      url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64';
    } else {
      url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
    }
    const dir = config.stackDir || config.dataDir;
    fs.mkdirSync(dir, { recursive: true });
    const dest = BIN();
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`cloudflared download failed (${res.status})`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
    state.installed = dest;
    pushLog(`installed cloudflared (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB)`);
    return this.status();
  },

  /** Quick tunnel: zero-config instant public URL for the local web stack. */
  async quickStart(target = 'http://127.0.0.1:80') {
    const bin = await this.installedPath();
    if (!bin) throw new Error('cloudflared is not installed — click Install first');
    if (state.child) throw new Error(`A tunnel is already running (${state.mode}) — stop it first`);
    state.mode = 'quick';
    state.logs = [];
    state.child = spawn(bin, ['tunnel', '--url', target, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true });
    state.child.unref();
    state.child.stdout.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        pushLog(line);
        const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m) state.url = m[0];
      }
    });
    state.child.stderr.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        pushLog(line);
        const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m) state.url = m[0];
      }
    });
    state.child.on('exit', (code) => {
      pushLog(`tunnel exited (code ${code})`);
      state.child = null;
      state.mode = null;
      state.url = null;
    });

    // wait for the trycloudflare URL (usually 3-10s)
    for (let i = 0; i < 40; i++) {
      if (state.url) break;
      if (!state.child) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!state.url) throw new Error('Tunnel started but no URL was assigned — check the tunnel logs');
    return this.status();
  },

  /** Named tunnel: remote-managed via the dashboard token. */
  async namedStart(token) {
    const bin = await this.installedPath();
    if (!bin) throw new Error('cloudflared is not installed — click Install first');
    if (!/^[A-Za-z0-9+=/=_-]{20,}$/.test(String(token))) throw new Error('That does not look like a tunnel token — copy it from Cloudflare Zero Trust → Tunnels');
    if (state.child) throw new Error(`A tunnel is already running (${state.mode}) — stop it first`);

    state.mode = 'named';
    state.logs = [];
    state.child = spawn(bin, ['tunnel', 'run', '--token', String(token), '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true });
    state.child.unref();
    state.child.stdout.on('data', (d) => String(d).split('\n').forEach(pushLog));
    state.child.stderr.on('data', (d) => String(d).split('\n').forEach(pushLog));
    state.child.on('exit', (code) => {
      pushLog(`tunnel exited (code ${code})`);
      state.child = null;
      state.mode = null;
    });
    await new Promise((r) => setTimeout(r, 2500));
    if (!state.child) throw new Error('Tunnel exited immediately — check the token and the tunnel logs');
    return this.status();
  },

  async stop() {
    stopChild();
    return this.status();
  },

  logs() {
    return state.logs.join('\n');
  },

  // ---- Cloudflare DNS (optional, needs an API token in settings) ----

  _cfOpts(extra = {}) {
    const token = getSetting('cf_api_token');
    if (!token) throw new Error('No Cloudflare API token configured — set it on the Cloudflare page');
    return {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...extra
    };
  },

  async cfZones() {
    const res = await fetch('https://api.cloudflare.com/client/v4/zones?per_page=50', this._cfOpts());
    const j = await res.json();
    if (!j.success) throw new Error(j.errors?.[0]?.message || 'Cloudflare API error');
    return j.result.map((z) => ({ id: z.id, name: z.name, status: z.status, name_servers: z.name_servers }));
  },

  async cfRecords(zoneId) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?per_page=200`, this._cfOpts());
    const j = await res.json();
    if (!j.success) throw new Error(j.errors?.[0]?.message || 'Cloudflare API error');
    return j.result.map((r) => ({
      id: r.id, name: r.name, type: r.type, value: r.content,
      ttl: r.ttl === 1 ? 'auto' : r.ttl, proxied: r.proxied, priority: r.priority ?? null
    }));
  },

  async cfCreateRecord(zoneId, { type, name, content, ttl = 1, proxied = false, priority = null }) {
    const body = { type, name, content, ttl: ttl === 'auto' || ttl === 1 ? 1 : Number(ttl), proxied };
    if (priority !== null && (type === 'MX' || type === 'SRV')) body.priority = Number(priority);
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, this._cfOpts({ method: 'POST', body: JSON.stringify(body) }));
    const j = await res.json();
    if (!j.success) throw new Error(j.errors?.[0]?.message || 'Cloudflare API error');
    return j.result;
  },

  async cfUpdateRecord(zoneId, recordId, { type, name, content, ttl = 1, proxied = false, priority = null }) {
    const body = { type, name, content, ttl: ttl === 'auto' || ttl === 1 ? 1 : Number(ttl), proxied };
    if (priority !== null && (type === 'MX' || type === 'SRV')) body.priority = Number(priority);
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`, this._cfOpts({ method: 'PUT', body: JSON.stringify(body) }));
    const j = await res.json();
    if (!j.success) throw new Error(j.errors?.[0]?.message || 'Cloudflare API error');
    return j.result;
  },

  async cfDeleteRecord(zoneId, recordId) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`, this._cfOpts({ method: 'DELETE' }));
    const j = await res.json();
    if (!j.success) throw new Error(j.errors?.[0]?.message || 'Cloudflare API error');
    return true;
  },

  async cfVerifyToken() {
    const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', this._cfOpts());
    const j = await res.json();
    if (!j.success) throw new Error(j.errors?.[0]?.message || 'Token verification failed');
    return { status: j.result.status, zones: (await this.cfZones()).length };
  }
};


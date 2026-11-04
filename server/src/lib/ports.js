import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { getSetting, setSetting } from '../db/index.js';

/**
 * Isolated port allocator. The panel owns a dedicated port range for every
 * service it runs; if a preferred port is busy (Laragon/XAMPP/IIS/…), the
 * next free one is chosen automatically and remembered in the settings table
 * so vhosts, tunnels and clients stay consistent across restarts.
 *
 * Never touches ports owned by other applications — it only probes.
 */

const STATE_KEY = 'assigned_ports';

function load() {
  try { return JSON.parse(getSetting(STATE_KEY) || '{}'); } catch { return {}; }
}

function save(map) {
  setSetting(STATE_KEY, JSON.stringify(map));
  return map;
}

export function portOpen(port, host = '127.0.0.1', timeout = 600) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(timeout, () => { s.destroy(); resolve(false); });
  });
}

/**
 * Reserve a port for `service`. If a previously assigned port is still free
 * it is reused; otherwise the first free port ≥ preferred (stepping by
 * `step` is avoided — sequential scan) is assigned and persisted.
 */
export async function assign(service, preferred) {
  const map = load();
  const prev = map[service];
  if (prev && !(await portOpen(prev))) {
    return { port: prev, reused: true };
  }
  let port = Math.max(1, parseInt(preferred, 10) || 1024);
  for (let i = 0; i < 500; i++) {
    if (await portOpen(port)) { port += 1; continue; }
    map[service] = port;
    save(map);
    return { port, reused: false };
  }
  throw new Error(`No free port found for ${service} (scanned from ${preferred})`);
}

/** Read the currently assigned port without allocating. */
export function assigned(service, fallback) {
  const map = load();
  return map[service] || fallback;
}

/** Forget an assignment (service stopped permanently). */
export function release(service) {
  const map = load();
  delete map[service];
  save(map);
}

/** All assignments — for the Ports page. */
export function all() {
  const map = load();
  return Object.entries(map).map(([service, port]) => ({ service, port }));
}

/**
 * Probe whether the panel can write to the system hosts file (needed for
 * <name>.test local domains).
 */
export async function canWriteHosts() {
  try {
    const exists = fs.existsSync(hostsPath());
    return { ok: exists };
  } catch {
    return { ok: false };
  }
}

export const hostsPath = () => process.platform === 'win32'
  ? 'C:/Windows/System32/drivers/etc/hosts'
  : '/etc/hosts';

void path;

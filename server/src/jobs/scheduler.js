import { sys } from '../services/index.js';
import { db, getSetting } from '../db/index.js';
import { audit } from '../auth/index.js';

/**
 * Panel-internal scheduler (no external cron dependency):
 *  - sample server stats every minute (keep 24h)
 *  - renew Let's Encrypt certificates twice daily
 *  - refresh SSL expiry metadata daily
 */
const timers = [];

export function startScheduler() {
  if (process.env.GPANEL_NO_SCHEDULER === '1') return;

  // stats sampler
  timers.push(setInterval(sampleStats, 60 * 1000));
  sampleStats().catch(() => {});

  // cert maintenance: 03:17 and 15:17 panel-local time
  scheduleAt([3 * 60 + 17, 15 * 60 + 17], certMaintenance);

  // prune old stats
  timers.push(setInterval(pruneStats, 6 * 3600 * 1000));
  pruneStats();
}

async function sampleStats() {
  try {
    const stats = await sys.system.stats();
    db.prepare(
      'INSERT OR REPLACE INTO stats_samples (ts, cpu, mem_used, mem_total, disk_used, disk_total, net_rx, net_tx, load1) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(stats.ts, stats.cpu, stats.memUsed, stats.memTotal, stats.diskUsed, stats.diskTotal, stats.netRx, stats.netTx, stats.load1);
  } catch { /* sampler must never crash the panel */ }
}

function pruneStats() {
  try {
    db.prepare('DELETE FROM stats_samples WHERE ts < ?').run(Date.now() - 25 * 3600 * 1000);
  } catch { /* ignore */ }
}

async function certMaintenance() {
  try {
    await sys.ssl.renewAll();
    const domains = db.prepare("SELECT id, domain FROM domains WHERE ssl_state != 'none'").all();
    for (const d of domains) {
      const info = await sys.ssl.certInfo(d.domain).catch(() => null);
      if (info) {
        db.prepare('UPDATE domains SET ssl_expiry = ? WHERE id = ?').run(info.expiry, d.id);
      }
    }
    audit('scheduler', 'ssl.renew.tick', null, `${domains.length} domains checked`);
  } catch (e) {
    audit('scheduler', 'ssl.renew.error', null, e.message?.slice(0, 300));
  }
}

function scheduleAt(minutesOfDay, fn) {
  const check = () => {
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    if (minutesOfDay.includes(m)) fn();
  };
  timers.push(setInterval(check, 60 * 1000));
}

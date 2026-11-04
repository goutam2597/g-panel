import { run, runSafe } from '../../lib/exec.js';
import { config } from '../../config.js';

// Windows Task Scheduler driver for cron jobs. schtasks covers the common
// schedules; exotic 5-field expressions are rejected with a clear message.

const TASK_PREFIX = 'GPanelCron_';

function mapSchedule(schedule) {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts;
  const st = (hhmm) => ['/ST', hhmm];
  if (m === '*' && h === '*' && dom === '*' && mon === '*' && dow === '*') return { args: ['/SC', 'MINUTE'] };
  if (m.startsWith('*/') && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    const n = parseInt(m.slice(2), 10);
    if (n >= 1 && n <= 59) return { args: ['/SC', 'MINUTE', '/MO', String(n)] };
    return null;
  }
  if (m !== '*' && h !== '*' && dom === '*' && mon === '*' && dow === '*') {
    return { args: ['/SC', 'DAILY', ...st(`${h.padStart(2, '0')}:${m.padStart(2, '0')}`)] };
  }
  if (m !== '*' && h !== '*' && dom === '*' && mon === '*' && dow !== '*') {
    const dayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const d = Number(dow);
    if (!Number.isInteger(d) || d < 0 || d > 7 || dow.includes(',')) return null;
    return { args: ['/SC', 'WEEKLY', '/D', dayNames[d % 7], ...st(`${h.padStart(2, '0')}:${m.padStart(2, '0')}`)] };
  }
  if (m !== '*' && h !== '*' && dom !== '*' && mon === '*' && dow === '*') {
    return { args: ['/SC', 'MONTHLY', '/D', dom, ...st(`${h.padStart(2, '0')}:${m.padStart(2, '0')}`)] };
  }
  return null;
}

async function existingTasks() {
  const { stdout } = await runSafe('schtasks', ['/Query', '/FO', 'CSV', '/NH'], { timeout: 30000 });
  const names = [];
  for (const line of (stdout || '').split('\n')) {
    const m = line.match(/^"([^"]+)",/);
    if (m && m[1].startsWith(TASK_PREFIX)) names.push(m[1]);
  }
  return names;
}

export default {
  async list(user) {
    const jobs = await existingTasks();
    return jobs.filter((j) => j.startsWith(TASK_PREFIX + user + '_'))
      .map((j) => `${j} (managed by Task Scheduler)`);
  },

  async apply(user, jobs) {
    const existing = await existingTasks();
    const wanted = new Set();

    for (const j of jobs) {
      if (!j.enabled) continue;
      const mapped = mapSchedule(j.schedule);
      if (!mapped) {
        throw new Error(`Schedule "${j.schedule}" is not supported by Windows Task Scheduler — use one of the presets (every N minutes / daily / weekly / monthly)`);
      }
      const name = `${TASK_PREFIX}${user}_${j.id}`;
      wanted.add(name);
      const exists = existing.includes(name);
      const args = ['/Create', '/TN', name, '/TR', j.command, ...mapped.args, '/F'];
      if (exists) args.push('/F');
      await run('schtasks', args, { timeout: 30000 });
    }

    for (const name of existing) {
      if (!wanted.has(name) && name.startsWith(TASK_PREFIX + user + '_')) {
        await runSafe('schtasks', ['/Delete', '/TN', name, '/F']);
      }
    }
    return true;
  }
};

void config;

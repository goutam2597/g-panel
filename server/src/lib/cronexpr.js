// Cron expression validation + human description. Pure.

const FIELD_RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 7]
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const PRESETS = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *'
};

export function validateCron(expr) {
  if (typeof expr !== 'string') return { error: 'Schedule is required' };
  const e = expr.trim();
  if (PRESETS[e]) return { ok: true, fields: PRESETS[e].split(' ') };
  const parts = e.split(/\s+/);
  if (parts.length !== 5) return { error: 'Schedule must have 5 fields: minute hour day-of-month month day-of-week' };
  const names = ['minute', 'hour', 'dom', 'month', 'dow'];
  for (let i = 0; i < 5; i++) {
    const err = checkField(parts[i], FIELD_RANGES[names[i]], i === 4);
    if (err) return { error: `${names[i]}: ${err}` };
  }
  return { ok: true, fields: parts };
}

function checkField(field, [min, max], dow) {
  if (field === '*') return null;
  if (field === '') return 'empty field';
  for (const chunk of field.split(',')) {
    const err = checkChunk(chunk.trim(), min, max, dow);
    if (err) return err;
  }
  return null;
}

function checkChunk(chunk, min, max, dow) {
  let body = chunk, step = 1;
  const slash = chunk.indexOf('/');
  if (slash !== -1) {
    body = chunk.slice(0, slash);
    step = parseInt(chunk.slice(slash + 1), 10);
    if (!Number.isInteger(step) || step < 1) return 'invalid step';
  }
  if (body === '*') return null;
  let lo = min, hi = max;
  if (body !== '') {
    const dash = body.indexOf('-');
    if (dash !== -1) {
      lo = parseInt(body.slice(0, dash), 10);
      hi = parseInt(body.slice(dash + 1), 10);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return 'invalid range';
    } else {
      const v = parseInt(body, 10);
      if (!Number.isInteger(v)) return `invalid value "${body}"`;
      lo = hi = v;
    }
  }
  if (dow) { lo = normalizeDow(lo); hi = normalizeDow(hi); }
  if (lo < min || hi > max || lo > hi) return `value out of range (${min}-${max})`;
  return null;
}

function normalizeDow(v) { return v === 7 ? 0 : v; }

export function describeCron(expr) {
  const v = validateCron(expr);
  if (v.error) return null;
  if (PRESETS[expr.trim()]) {
    const map = { '@hourly': 'Every hour', '@daily': 'Every day at midnight', '@weekly': 'Every Sunday at midnight', '@monthly': '1st of every month at midnight', '@yearly': 'January 1st at midnight' };
    return map[expr.trim()];
  }
  const [m, h, dom, mon, dow] = v.fields;
  const time = part => {
    if (part === '*') return null;
    if (part.includes(',')) return part.split(',').map((x) => pad2(x)).join(':00, ').replace(/:(\d\d):(\d\d)/g, ':$1:$2');
    return `${pad2(part)}:00`;
  };
  const pieces = [];
  const everyMin = m === '*', everyHour = h === '*';

  if (everyMin && everyHour && dom === '*' && mon === '*' && dow === '*') return 'Every minute';
  if (everyHour && dom === '*' && mon === '*' && dow === '*') pieces.push(`Hour 0-59 ${m === '*' ? '' : `at minute ${m}`}`);
  else if (dom === '*' && mon === '*' && dow === '*') {
    pieces.push(m === '*' ? `Every minute of hour ${h}` : `At ${time(h)}-${m === '*' ? 'every minute' : `minute ${m}`}`);
  }
  if (dow !== '*') pieces.push(`on ${dowList(dow)}`);
  if (dom !== '*') pieces.push(`on day ${dom} of the month`);
  if (mon !== '*') pieces.push(`in ${MONTHS[+mon - 1] || mon}`);

  let out;
  if (dom === '*' && dow === '*' && mon === '*') {
    if (h === '*') out = m === '*' ? 'Every minute' : `Every hour at minute ${m}`;
    else out = `Every day at ${describeTime(m, h)}`;
  } else if (dow !== '*') {
    out = `Every ${dowList(dow)} at ${describeTime(m, h)}`;
  } else if (dom !== '*') {
    out = `On day ${dom}${mon !== '*' ? ` of ${MONTHS[+mon - 1] || ''}` : ' of every month'} at ${describeTime(m, h)}`;
  } else {
    out = pieces.join(' ') || expr;
  }
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function describeTime(m, h) {
  if (h === '*' && m === '*') return 'every minute';
  if (h === '*') return `minute ${m} of every hour`;
  if (m === '*') return `every minute of hour ${h}`;
  return `${pad2(h)}:${pad2(m)}`;
}

function dowList(dow) {
  if (dow === '*') return 'day';
  return dow.split(',').map((d) => DAYS[+d % 7] || d).join(', ');
}

function pad2(v) { return String(v).padStart(2, '0'); }

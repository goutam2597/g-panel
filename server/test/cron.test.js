import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCron, describeCron, PRESETS } from '../src/lib/cronexpr.js';

test('valid cron expressions pass', () => {
  for (const expr of [
    '* * * * *', '0 3 * * *', '*/15 * * * *', '0 0 * * 0', '0 0 1 * *',
    '30 4 1,15 * 5', '0 12 * 1-6 1-5', '@daily', '@hourly'
  ]) {
    const v = validateCron(expr);
    assert.equal(v.error, undefined, `${expr} should be valid: ${JSON.stringify(v)}`);
  }
});

test('invalid cron expressions fail', () => {
  for (const expr of ['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', 'a b c d e', '*/0 * * * *']) {
    const v = validateCron(expr);
    assert.ok(v.error, `"${expr}" should be invalid`);
  }
});

test('descriptions are human readable', () => {
  assert.equal(describeCron('* * * * *'), 'Every minute');
  assert.equal(describeCron('0 3 * * *'), 'Every day at 03:00');
  assert.equal(describeCron('0 * * * *'), 'Every hour at minute 0');
  assert.match(describeCron('0 0 * * 0'), /Every Sunday at 00:00/);
  assert.match(describeCron('0 0 1 * *'), /day 1/);
  assert.equal(describeCron('@hourly'), 'Every hour');
});

test('presets map to 5 fields', () => {
  assert.deepEqual(validateCron('@weekly').fields, '0 0 * * 0'.split(' '));
});

// Tasks page: next scheduled run, and the history of backup runs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { nextRun, previousRun } = require(path.join(process.cwd(), 'dist/main/cronSchedule.js'));
const { BackupHistory } = require(path.join(process.cwd(), 'dist/main/backupHistory.js'));

// Local times, like the schedules
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe('next run', () => {
  test('daily at 02:00, before and after the time', () => {
    assert.deepEqual(nextRun('0 2 * * *', at(2026, 10, 1, 1, 30)), at(2026, 10, 1, 2, 0));
    assert.deepEqual(nextRun('0 2 * * *', at(2026, 10, 1, 2, 0)), at(2026, 10, 2, 2, 0));
  });
  test('every 6 hours', () => {
    assert.deepEqual(nextRun('0 */6 * * *', at(2026, 10, 1, 13, 5)), at(2026, 10, 1, 18, 0));
  });
  test('weekdays only: Friday evening → Monday', () => {
    // 2 October 2026 is a Friday
    assert.deepEqual(nextRun('0 0 * * 1-5', at(2026, 10, 2, 23, 0)), at(2026, 10, 5, 0, 0));
  });
  test('monthly and yearly', () => {
    assert.deepEqual(nextRun('0 0 1 * *', at(2026, 10, 15)), at(2026, 11, 1));
    assert.deepEqual(nextRun('30 4 29 2 *', at(2026, 10, 1)), at(2028, 2, 29, 4, 30));
  });
  test('Sunday as 7 and day names', () => {
    assert.deepEqual(nextRun('0 9 * * 7', at(2026, 10, 1)), at(2026, 10, 4, 9, 0));
    assert.deepEqual(nextRun('0 9 * * sun', at(2026, 10, 1)), at(2026, 10, 4, 9, 0));
  });
  test('next and previous agree', () => {
    const from = at(2026, 10, 1, 12, 0);
    const next = nextRun('15 3 * * *', from);
    assert.deepEqual(previousRun('15 3 * * *', next), next);
  });
  test('an impossible date gives null', () => {
    assert.equal(nextRun('0 0 31 2 *', at(2026, 10, 1)), null);
  });
});

describe('backup history', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-history-')), 'backup-history.json');

  test('runs are kept newest first, 30 per database, and survive a reload', () => {
    const history = new BackupHistory(file);
    for (let i = 0; i < 35; i++) {
      history.record('db1', { at: new Date(2026, 0, 1, 0, i).toISOString(), success: i % 2 === 0, trigger: 'scheduled', durationMs: i });
    }
    history.record('db2', { at: new Date().toISOString(), success: false, trigger: 'manual', durationMs: 5, error: 'boom' });
    const reloaded = new BackupHistory(file);
    const runs = reloaded.runs('db1');
    assert.equal(runs.length, 30);
    assert.equal(runs[0].durationMs, 34);
    assert.equal(reloaded.runs('db2')[0].error, 'boom');
    assert.deepEqual(reloaded.runs('unknown'), []);
  });

  test('forgetting a database removes its runs', () => {
    const history = new BackupHistory(file);
    history.forget('db2');
    assert.deepEqual(new BackupHistory(file).runs('db2'), []);
    assert.equal(new BackupHistory(file).runs('db1').length, 30);
  });

  test('a damaged file starts an empty history', () => {
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(new BackupHistory(file).runs('db1'), []);
  });
});

describe('schedule in words', () => {
  const { transformSync } = require('esbuild');
  const compiled = transformSync(fs.readFileSync(path.join(process.cwd(), 'src/renderer/src/cronText.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(mod, mod.exports, require);
  const { describeCron } = mod.exports;
  // Echoes the key and its parameters, enough to check the shape
  const t = (key, params = {}) => `${key.split('.').pop()}(${Object.values(params).join('|')})`;
  const fr = (cron) => describeCron(cron, t, 'fr');

  test('common shapes', () => {
    assert.equal(fr('0 2 * * *'), 'at(daily()|02:00)');
    assert.equal(fr('0 0,12 * * *'), 'at(daily()|and(00:00|12:00))');
    assert.equal(fr('0 0 * * 1-5'), 'at(weekdays()|00:00)');
    assert.equal(fr('30 3 * * 0'), 'at(weekday(dimanche)|03:30)');
    assert.equal(fr('0 0 1 * *'), 'at(monthDay(1)|00:00)');
    assert.equal(fr('0 */6 * * *'), 'everyXHours(6)');
    assert.equal(fr('0 * * * *'), 'everyHour()');
    assert.equal(fr('*/15 * * * *'), 'everyXMinutes(15)');
  });
  test('unusual expressions are left to the raw cron', () => {
    assert.equal(fr('0 0 * 6 *'), null);
    assert.equal(fr('0 0 1 * 1'), null);
    assert.equal(fr('0 0 * *'), null);
  });
});

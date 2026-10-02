// Reading app.log for the Logs page: entries, and the lines that continue them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { parseLogText, parseLogLine } = require(path.join(process.cwd(), 'dist/main/logParse.js'));

test('an entry with and without a database', () => {
  assert.deepEqual(parseLogLine('[2026-10-01T15:20:17.899Z] [INFO] Configuration saved'), {
    timestamp: '2026-10-01T15:20:17.899Z', level: 'info', database: undefined, message: 'Configuration saved',
  });
  assert.deepEqual(parseLogLine('[2026-10-01T15:20:17.899Z] [ERROR] [shop_dev] pg_dump failed'), {
    timestamp: '2026-10-01T15:20:17.899Z', level: 'error', database: 'shop_dev', message: 'pg_dump failed',
  });
});

test('lines without a timestamp continue the entry before them', () => {
  const { entries, leading } = parseLogText([
    '[2026-10-01T10:00:00.000Z] [ERROR] Backup failed: Error: boom',
    '    at run (backup.js:12:3)',
    '    at main (main.js:4:1)',
    '[2026-10-01T10:00:01.000Z] [WARN] [shop] slow',
    '',
  ].join('\n'));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].message, 'Backup failed: Error: boom\n    at run (backup.js:12:3)\n    at main (main.js:4:1)');
  assert.equal(entries[1].level, 'warn');
  assert.equal(leading, null);
});

test('lines before the first entry are returned apart (end of an entry read earlier)', () => {
  const { entries, leading } = parseLogText('  detail line\n[2026-10-01T10:00:00.000Z] [INFO] next\n');
  assert.equal(leading, '  detail line');
  assert.equal(entries.length, 1);
});

test('a bracketed word at the start of a message is not taken for a timestamp', () => {
  const { entries } = parseLogText('[2026-10-01T10:00:00.000Z] [INFO] start\n[preparing] step 1\n');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message, 'start\n[preparing] step 1');
});

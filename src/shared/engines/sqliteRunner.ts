/**
 * The script that runs one SQLite statement in its own process (`node -e`, Electron as Node in
 * the app): SQLite's own loop cannot be interrupted from JavaScript, so a query that runs too
 * long has its process killed. Arguments come on stdin and the answer goes to stdout, both
 * through v8.serialize (bigints and blobs as they are). Pure text: shared by the app and the
 * MCP server (copied by scripts/copy-mcp-shared.mjs).
 *
 * Input: { file, sql, values, mode: 'read' | 'write', maxRows }. Output: { ok, rows, fields,
 * origins: [{ table, column }], rowCount, truncated, duration } or { ok: false, error }.
 */
export const SQLITE_RUNNER = `
const v8 = require('v8');
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  const { file, sql, values, mode, maxRows } = v8.deserialize(Buffer.concat(chunks));
  const { DatabaseSync } = require('node:sqlite');
  let db;
  let answer;
  try {
    db = new DatabaseSync(file, { readOnly: mode !== 'write' });
    db.exec('PRAGMA busy_timeout = 5000');
    if (mode === 'write') { db.exec('PRAGMA foreign_keys = ON'); db.exec('BEGIN'); }
    const statement = db.prepare(sql);
    const columns = statement.columns();
    const start = Date.now();
    let rows = [];
    let changes = 0;
    if (columns.length) rows = statement.all(...values);
    else changes = Number(statement.run(...values).changes);
    const duration = Date.now() - start;
    if (mode === 'write') db.exec('COMMIT');
    const bools = columns.filter(c => /bool/i.test(c.type || '')).map(c => c.name);
    const out = rows.slice(0, maxRows).map(row => {
      const plain = {};
      for (const key of Object.keys(row)) plain[key] = bools.includes(key) && (row[key] === 0 || row[key] === 1) ? row[key] === 1 : row[key];
      return plain;
    });
    answer = { ok: true, rows: out, fields: columns.map(c => c.name), origins: columns.map(c => ({ table: c.table, column: c.column })), rowCount: columns.length ? rows.length : changes, truncated: rows.length > maxRows, duration };
  } catch (error) {
    try { if (mode === 'write' && db) db.exec('ROLLBACK'); } catch {}
    answer = { ok: false, error: String(error && error.message || error) };
  } finally {
    try { if (db) db.close(); } catch {}
  }
  process.stdout.write(v8.serialize(answer), () => process.exit(0));
});
`;

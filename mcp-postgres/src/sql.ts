/**
 * SQL text helpers (no database access): keyword scanning that ignores strings,
 * comments and quoted names, row limiting, and result formatting.
 */

/**
 * The SQL with string literals, dollar-quoted bodies, quoted identifiers and comments
 * replaced by spaces, so keyword checks do not trip on `WHERE status = 'DELETE'`.
 */
export function stripSqlNoise(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    // -- line comment
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    // /* block comment */ (nested, as in PostgreSQL)
    if (c === '/' && next === '*') {
      let depth = 0;
      while (i < n) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; if (depth === 0) break; continue; }
        i++;
      }
      out += ' ';
      continue;
    }
    // 'string', E'string' (backslash escapes), '' inside
    if (c === "'") {
      const backslash = i > 0 && (sql[i - 1] === 'E' || sql[i - 1] === 'e');
      i++;
      while (i < n) {
        if (backslash && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += " '' ";
      continue;
    }
    // "quoted identifier"
    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += ' "" ';
      continue;
    }
    // $tag$ dollar-quoted $tag$
    if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? n : end + tag[0].length;
        out += ' $$ ';
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const READ_STARTS = new Set(['SELECT', 'WITH', 'SHOW', 'EXPLAIN', 'VALUES', 'TABLE']);
const EXPLAIN_OPTION = /^(ANALYZE|ANALYSE|VERBOSE|BUFFERS|COSTS|SETTINGS|SUMMARY|TIMING|WAL|GENERIC_PLAN|MEMORY|SERIALIZE)\b/i;

/**
 * Why a statement is not a plain read, or null. Looks at the statement's first keyword
 * (so a column named "comment" or "update" is fine), data-modifying CTEs
 * (WITH x AS (DELETE …)) and the query behind EXPLAIN.
 */
export function findWriteKeyword(sql: string): string | null {
  let text = stripSqlNoise(sql).trim().replace(/^\(+\s*/, '');
  const cte = /\(\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.exec(text);
  if (cte) return cte[1].toUpperCase();

  let first = (/^[A-Za-z_]+/.exec(text)?.[0] || '').toUpperCase();
  if (first === 'EXPLAIN') {
    text = text.slice(first.length).trim();
    if (text.startsWith('(')) text = text.slice(text.indexOf(')') + 1).trim();
    while (EXPLAIN_OPTION.test(text)) text = text.replace(EXPLAIN_OPTION, '').trim();
    first = (/^[A-Za-z_]+/.exec(text)?.[0] || '').toUpperCase();
    if (first === 'EXPLAIN') return 'EXPLAIN';
  }
  if (!first) return null;
  return READ_STARTS.has(first) ? null : first;
}

/** Number of statements (top-level semicolons, a trailing one does not count) */
export function statementCount(sql: string): number {
  const parts = stripSqlNoise(sql).split(';').map(part => part.trim());
  return parts.filter(Boolean).length;
}

/** The query without trailing semicolons and blanks */
export function trimStatement(sql: string): string {
  return sql.replace(/[\s;]+$/, '');
}

/** SELECT / WITH / VALUES / TABLE: can be wrapped in a subquery to limit rows server-side */
export function isRowQuery(sql: string): boolean {
  return /^\s*\(?\s*(SELECT|WITH|VALUES|TABLE)\b/i.test(stripSqlNoise(sql));
}

/** Server-side row limit: never loads more than `limit` rows into memory */
export function limitedQuery(sql: string, limit: number): string {
  return `SELECT * FROM (\n${trimStatement(sql)}\n) AS bbdump_result LIMIT ${Math.max(1, Math.floor(limit))}`;
}

export type RowFormat = 'json' | 'csv' | 'markdown';

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** CSV (RFC 4180) */
export function toCsv(fields: string[], rows: Record<string, unknown>[]): string {
  const quote = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const lines = [fields.map(quote).join(',')];
  for (const row of rows) lines.push(fields.map(field => quote(cellText(row[field]))).join(','));
  return lines.join('\n');
}

/** Markdown table: compact for a model to read */
export function toMarkdown(fields: string[], rows: Record<string, unknown>[], maxCell = 200): string {
  if (fields.length === 0) return '(no columns)';
  const cell = (value: unknown) => {
    const text = cellText(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    return text.length > maxCell ? `${text.slice(0, maxCell)}…` : text;
  };
  const lines = [
    `| ${fields.map(cell).join(' | ')} |`,
    `| ${fields.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${fields.map(field => cell(row[field])).join(' | ')} |`),
  ];
  return lines.join('\n');
}

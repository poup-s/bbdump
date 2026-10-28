/**
 * Read-only SQL for MySQL, MariaDB and SQLite (pure: app, MCP server and tests). The engines
 * refuse writes themselves (a READ ONLY transaction, a read-only SQLite connection); this check
 * comes first because MySQL commits DDL on its own, before the transaction could refuse it.
 */

export type SqlDialect = 'mysql' | 'sqlite';

/**
 * The SQL without comments and literals (strings become '', quoted identifiers ""), so that a
 * keyword inside them is never read as one. Backticks are identifiers in both dialects.
 */
export function stripSql(sql: string, dialect: SqlDialect): string {
    let out = '';
    let i = 0;
    const text = String(sql);
    while (i < text.length) {
        const c = text[i];
        const next = text[i + 1];
        if ((c === '-' && next === '-') || (c === '#' && dialect === 'mysql')) {
            const end = text.indexOf('\n', i);
            i = end === -1 ? text.length : end;
            out += ' ';
            continue;
        }
        if (c === '/' && next === '*') {
            const end = text.indexOf('*/', i + 2);
            // MySQL runs /*! … */ and /*M! … */: their content is code
            if (dialect === 'mysql' && /^(M?!)/.test(text.slice(i + 2, i + 4))) {
                const body = text.slice(i + 2, end === -1 ? text.length : end).replace(/^M?!\d*/, '');
                out += ` ${stripSql(body, dialect)} `;
            } else {
                out += ' ';
            }
            i = end === -1 ? text.length : end + 2;
            continue;
        }
        if (c === "'" || c === '"' || c === '`' || (c === '[' && dialect === 'sqlite')) {
            const close = c === '[' ? ']' : c;
            let j = i + 1;
            while (j < text.length) {
                if (text[j] === '\\' && dialect === 'mysql' && c !== '`') { j += 2; continue; }
                if (text[j] === close) {
                    if (c !== '[' && text[j + 1] === close) { j += 2; continue; }
                    break;
                }
                j++;
            }
            out += c === "'" ? "''" : '""';
            i = j + 1;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/** Statements in the SQL, empty ones (a trailing ;) left out */
export function statementCount(sql: string, dialect: SqlDialect): number {
    return stripSql(sql, dialect).split(';').filter(part => part.trim()).length;
}

/** The first keyword (INSERT, SELECT…), upper case; "(" for a parenthesized query */
export function statementKind(sql: string, dialect: SqlDialect): string {
    const stripped = stripSql(sql, dialect).trim();
    if (stripped.startsWith('(')) return '(';
    return stripped.match(/^[A-Za-z]+/)?.[0]?.toUpperCase() ?? '';
}

const READ_STARTS: Record<SqlDialect, string[]> = {
    mysql: ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'TABLE', 'VALUES', '('],
    // PRAGMA only on a read-only connection, where a writing one fails anyway
    sqlite: ['SELECT', 'WITH', 'EXPLAIN', 'VALUES', '(', 'PRAGMA'],
};

/** Why this SQL is not a single reading statement, or null when it is */
export function readOnlyProblem(sql: string, dialect: SqlDialect): string | null {
    const stripped = stripSql(sql, dialect).trim();
    if (!stripped) return 'The query is empty';
    if (statementCount(sql, dialect) > 1) return 'Only one statement is allowed';
    const first = statementKind(sql, dialect);
    if (!READ_STARTS[dialect].includes(first)) return `Only reading statements are allowed here (${first || 'unknown'} is not one)`;
    const upper = stripped.toUpperCase();
    // SELECT … INTO OUTFILE / DUMPFILE writes a file on the server; INTO @var sets a variable
    if (dialect === 'mysql' && /\bINTO\s+(OUTFILE|DUMPFILE|@)/.test(upper)) return 'SELECT … INTO is not allowed here';
    // SQLite: WITH … INSERT / UPDATE / DELETE
    if (first === 'WITH' && /\b(INSERT|UPDATE|DELETE|REPLACE)\b/.test(upper)) return 'Only reading statements are allowed here';
    return null;
}

/** Quotes an identifier: backticks for MySQL / MariaDB, double quotes for SQLite */
export function quoteIdent(name: string, dialect: SqlDialect): string {
    return dialect === 'mysql'
        ? '`' + String(name).replace(/`/g, '``') + '`'
        : '"' + String(name).replace(/"/g, '""') + '"';
}

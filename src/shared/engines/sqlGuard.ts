/**
 * Read-only SQL for MySQL, MariaDB, SQLite, DuckDB and SQL Server (pure: app, MCP server and
 * tests). The engines refuse writes themselves (a READ ONLY transaction, a read-only
 * connection, a SQL Server transaction always rolled back); this check comes first because
 * MySQL commits DDL on its own, before the transaction could refuse it.
 */

export type SqlDialect = 'mysql' | 'sqlite' | 'duckdb' | 'tsql';

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
        if (c === "'" || c === '"' || c === '`' || (c === '[' && (dialect === 'sqlite' || dialect === 'tsql'))) {
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
    // DuckDB also starts queries with FROM, and describes with DESCRIBE / SUMMARIZE / SHOW (the connection is read-only too)
    duckdb: ['SELECT', 'WITH', 'FROM', 'EXPLAIN', 'VALUES', '(', 'DESCRIBE', 'DESC', 'SUMMARIZE', 'SHOW', 'TABLE', 'PIVOT', 'UNPIVOT'],
    tsql: ['SELECT', 'WITH', '('],
};

/**
 * T-SQL needs no ";" between statements ("SELECT 1 DELETE FROM t COMMIT" is three): a reading
 * one has none of these words outside strings and [names]. All are reserved in T-SQL, so a
 * column of that name is always quoted, never refused by mistake.
 */
const TSQL_WRITES = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|CREATE|ALTER|EXEC|EXECUTE|COMMIT|ROLLBACK|SAVE|BEGIN|GRANT|REVOKE|DENY|BACKUP|RESTORE|SHUTDOWN|KILL|DBCC|BULK|WAITFOR|USE|SET|DECLARE|INTO|OPENROWSET|OPENDATASOURCE|OPENQUERY|RECONFIGURE|CHECKPOINT|UPDATETEXT|WRITETEXT|READTEXT)\b/;

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
    // DuckDB: COPY … TO and the file functions write or read files outside the database
    if (dialect === 'duckdb' && /\b(COPY|EXPORT|ATTACH|INSTALL|LOAD|CALL)\b/.test(upper)) return 'Only reading statements are allowed here';
    if (dialect === 'tsql') {
        const found = upper.match(TSQL_WRITES)?.[1];
        if (found) return `Only one reading statement is allowed here (${found} is not one)`;
    }
    return null;
}

/**
 * Each ? outside strings, quoted names and comments replaced by what `next` returns for it (its
 * index from 0): T-SQL takes @p1, @p2… where the other dialects take ?.
 */
export function replacePlaceholders(sql: string, dialect: SqlDialect, next: (index: number) => string): string {
    const text = String(sql);
    let out = '';
    let i = 0;
    let count = 0;
    while (i < text.length) {
        const c = text[i];
        const n = text[i + 1];
        if ((c === '-' && n === '-') || (c === '#' && dialect === 'mysql')) {
            const end = text.indexOf('\n', i);
            const stop = end === -1 ? text.length : end;
            out += text.slice(i, stop);
            i = stop;
            continue;
        }
        if (c === '/' && n === '*') {
            const end = text.indexOf('*/', i + 2);
            const stop = end === -1 ? text.length : end + 2;
            out += text.slice(i, stop);
            i = stop;
            continue;
        }
        if (c === "'" || c === '"' || c === '`' || (c === '[' && (dialect === 'sqlite' || dialect === 'tsql'))) {
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
            out += text.slice(i, j + 1);
            i = j + 1;
            continue;
        }
        out += c === '?' ? next(count++) : c;
        i++;
    }
    return out;
}

/** Quotes an identifier: backticks for MySQL / MariaDB, [brackets] for SQL Server, double quotes for SQLite and DuckDB */
export function quoteIdent(name: string, dialect: SqlDialect): string {
    if (dialect === 'mysql') return '`' + String(name).replace(/`/g, '``') + '`';
    if (dialect === 'tsql') return '[' + String(name).replace(/\]/g, ']]') + ']';
    return '"' + String(name).replace(/"/g, '""') + '"';
}

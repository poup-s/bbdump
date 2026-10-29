/**
 * DuckDB through its own command-line tool (duckdb), installed by the user like pg_dump: no
 * native module in bbdump. Shared by the app and the MCP server (copied by
 * scripts/copy-mcp-shared.mjs, Node's own modules only): where the tool is, its arguments,
 * values written as SQL literals (the tool takes no parameters), one run of it, and its JSON
 * output read back without losing large integers.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type Row = Record<string, unknown>;

/** Where installers put the tool when it is not on the PATH */
export function duckdbCandidates(platform: string = process.platform, home: string = os.homedir(), localAppData: string = process.env.LOCALAPPDATA || ''): string[] {
    if (platform === 'win32') return [path.win32.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'duckdb.exe'), path.win32.join(home, '.duckdb', 'cli', 'latest', 'duckdb.exe')];
    const own = path.posix.join(home, '.duckdb', 'cli', 'latest', 'duckdb');
    return platform === 'darwin' ? ['/opt/homebrew/bin/duckdb', '/usr/local/bin/duckdb', own] : [own, '/usr/local/bin/duckdb'];
}

/** How to install the tool */
export function duckdbInstallHint(platform: string = process.platform): string {
    if (platform === 'darwin') return 'brew install duckdb';
    if (platform === 'win32') return 'winget install DuckDB.cli';
    return 'curl https://install.duckdb.org | sh';
}

/** The tool on the PATH, else where installers put it; null when not installed */
export function findDuckdbTool(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null {
    const name = platform === 'win32' ? 'duckdb.exe' : 'duckdb';
    const dirs = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
    for (const file of [...dirs.map(dir => path.join(dir, name)), ...duckdbCandidates(platform)]) {
        try {
            if (fs.statSync(file).isFile()) return file;
        } catch { /* not there */ }
    }
    return null;
}

/** Turns off reading and writing other files from SQL (a SELECT of read_text('/…') is refused) */
export const DUCKDB_SANDBOX = 'SET enable_external_access = false;\n';
/** Agents' variables that make DuckDB 2 change its output (removed: -no-agent is not known before 2.0) */
const AGENT_VARIABLES = ['AI_AGENT', 'CLAUDECODE', 'CLAUDE_CODE', 'CURSOR_AGENT', 'CODEX_SANDBOX', 'GEMINI_CLI'];
const MAX_OUTPUT = 64 * 1024 * 1024;

export interface DuckdbRunOptions {
    readOnly?: boolean;
    /** false only for bbdump's own scripts that attach files (backups, restores) */
    sandbox?: boolean;
    timeoutMs?: number;
}

/**
 * One run of the tool on `file` (":memory:" for scripts that attach files themselves): the
 * script on stdin, the rows of each statement that returns some. A run past its time is killed.
 */
export function runDuckdbTool(tool: { file: string; version?: string }, file: string, script: string, options: DuckdbRunOptions = {}): Promise<Row[][]> {
    if (file !== ':memory:' && !fs.existsSync(file)) return Promise.reject(new Error(`The DuckDB file was not found: ${file}`));
    const timeoutMs = Math.max(100, Math.min(2 * 60 * 60 * 1000, Math.floor(Number(options.timeoutMs) || 60000)));
    const env = { ...process.env };
    for (const name of AGENT_VARIABLES) delete env[name];
    return new Promise((resolve, reject) => {
        const child = spawn(tool.file, duckdbArgs(file, { readOnly: options.readOnly, version: tool.version }), { env, windowsHide: true });
        const out: Buffer[] = [];
        let size = 0;
        let stderr = '';
        let timedOut = false;
        let tooLarge = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_OUTPUT) { tooLarge = true; child.kill('SIGKILL'); return; }
            out.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => {
            clearTimeout(timer);
            if (timedOut) return reject(new Error(`The query was stopped after ${Math.round(timeoutMs / 1000)} s`));
            if (tooLarge) return reject(new Error('The result is too large'));
            if (code !== 0) return reject(new Error(duckdbError(stderr)));
            try {
                resolve(parseDuckdbJson(Buffer.concat(out).toString('utf8')));
            } catch (error) {
                reject(new Error(`The answer of duckdb could not be read: ${error instanceof Error ? error.message : String(error)}`));
            }
        });
        child.stdin.on('error', () => { /* the tool ended first: close says why */ });
        child.stdin.end(`${options.sandbox === false ? '' : DUCKDB_SANDBOX}${script}\n`);
    });
}

/** The tool's arguments: JSON out, stop at the first error, read-only when asked. `version` "2.0.0"… */
export function duckdbArgs(file: string, options: { readOnly?: boolean; version?: string } = {}): string[] {
    const major = Number(String(options.version ?? '').split('.')[0]) || 0;
    return [
        // DuckDB 2 changes its output when it believes an AI agent runs it: always the plain one
        ...(major >= 2 ? ['-no-agent'] : []),
        '-json',
        '-bail',
        ...(options.readOnly ? ['-readonly'] : []),
        file,
    ];
}

/** "2.0.0" from "v2.0.0 (Cyanoptera) d54cbbe3df" */
export function duckdbVersionOf(output: string): string | undefined {
    return output.match(/v?(\d+\.\d+\.\d+)/)?.[1];
}

/** A value as a DuckDB literal */
export function duckdbLiteral(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    if (value instanceof Uint8Array) {
        let hex = '';
        for (const byte of value) hex += `\\x${byte.toString(16).padStart(2, '0').toUpperCase()}`;
        return `'${hex}'::BLOB`;
    }
    if (value instanceof Date) return `'${value.toISOString()}'::TIMESTAMPTZ`;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    // The tool reads its input as text: a NUL would end it
    return `'${text.replace(/\u0000/g, '').replace(/'/g, "''")}'`;
}

/**
 * The SQL with each ? (outside strings, quoted names and comments) replaced by the literal of
 * the next value. Too few values: refused.
 */
export function bindDuckdb(sql: string, values: unknown[] = []): string {
    let out = '';
    let next = 0;
    let i = 0;
    while (i < sql.length) {
        const c = sql[i];
        if (c === "'" || c === '"') {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === c) {
                    if (sql[j + 1] === c) { j += 2; continue; }
                    break;
                }
                j++;
            }
            out += sql.slice(i, j + 1);
            i = j + 1;
            continue;
        }
        if (c === '-' && sql[i + 1] === '-') {
            const end = sql.indexOf('\n', i);
            const stop = end === -1 ? sql.length : end;
            out += sql.slice(i, stop);
            i = stop;
            continue;
        }
        if (c === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            const stop = end === -1 ? sql.length : end + 2;
            out += sql.slice(i, stop);
            i = stop;
            continue;
        }
        if (c === '?') {
            if (next >= values.length) throw new Error('Not enough values for the query');
            out += duckdbLiteral(values[next++]);
            i++;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/**
 * The tool's JSON output: one array per statement that returns rows (nothing for the others).
 * Whole numbers past 2^53 come back as bigints, never rounded.
 */
export function parseDuckdbJson(stdout: string): Array<Array<Record<string, unknown>>> {
    const text = stdout.trim();
    if (!text) return [];
    const reviver = function (this: unknown, _key: string, value: unknown, context?: { source?: string }) {
        if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source)) {
            return BigInt(context.source);
        }
        return value;
    } as (this: unknown, key: string, value: unknown) => unknown;
    const results: Array<Array<Record<string, unknown>>> = [];
    // Arrays follow each other ("[…]\n[…]"): split at each top-level one
    let depth = 0;
    let start = -1;
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (c === '\\') i++;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') inString = true;
        else if (c === '[') {
            if (depth === 0) start = i;
            depth++;
        } else if (c === ']') {
            depth--;
            if (depth === 0 && start !== -1) {
                results.push(JSON.parse(text.slice(start, i + 1), reviver) as Array<Record<string, unknown>>);
                start = -1;
            }
        }
    }
    return results;
}

/** The error the tool printed (its first line, without the "Did you mean" hints) */
export function duckdbError(stderr: string): string {
    const lines = stderr.split('\n').map(l => l.trim()).filter(l => l && !/^duckdb agent mode/i.test(l));
    return lines[0] ?? 'DuckDB failed';
}

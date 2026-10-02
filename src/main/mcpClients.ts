/**
 * Install / uninstall the bbdump MCP server in the configuration of MCP clients
 * (Claude Desktop, Claude Code, Codex, Cursor, Windsurf, Devin desktop, VS Code, OpenCode).
 *
 * This module has no Electron dependency so it can be exercised against a
 * temporary HOME. The launch command itself (binary, script, env) is computed by
 * the caller and passed in as an McpLaunchSpec.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export const MCP_SERVER_NAME = 'bbdump-postgres';

export interface McpLaunchSpec {
    command: string;
    args: string[];
    env: Record<string, string>;
}

export interface McpClientContext {
    home: string;
    platform: NodeJS.Platform;
    /** %APPDATA% on Windows */
    appData?: string;
    /** $XDG_CONFIG_HOME on Linux */
    xdgConfigHome?: string;
    /** Path of the `claude` CLI; null/undefined = edit ~/.claude.json directly. */
    claudeCli?: string | null;
    /** $CODEX_HOME (defaults to ~/.codex) */
    codexHome?: string;
}

export type McpClientId = 'claude-desktop' | 'claude-code' | 'codex' | 'cursor' | 'windsurf' | 'devin' | 'vscode' | 'opencode';

export type McpInstallState = 'not-installed' | 'installed' | 'outdated';

export interface McpClientStatus {
    id: McpClientId;
    name: string;
    configPath: string;
    detected: boolean;
    state: McpInstallState;
    /** true when state !== 'not-installed' (kept for simple UIs) */
    installed: boolean;
    /** Installed macOS app bundle of the client, used to show its real icon */
    appPath?: string;
    error?: string;
}

type Json = { [key: string]: unknown };

const isJsonObject = (value: unknown): value is Json => !!value && typeof value === 'object';

interface ClientDef {
    id: McpClientId;
    name: string;
    /** Config file format; 'toml' clients are handled by the TOML helpers below. */
    format?: 'json' | 'toml';
    /** macOS app bundles of the client, by preference (for its icon) */
    apps?: string[];
    configPath(ctx: McpClientContext): string;
    detect(ctx: McpClientContext): boolean;
    /** Returns the container object holding server entries (created if `create`). */
    container(config: Json, create: boolean): Json | undefined;
    toEntry(spec: McpLaunchSpec): Json;
}

// ---------------------------------------------------------------------------
// JSONC helpers
// ---------------------------------------------------------------------------

/**
 * Strip // and /* *\/ comments and trailing commas, leaving string literals
 * untouched (a "//" inside a URL string stays as is).
 */
export function stripJsonc(text: string): string {
    let out = '';
    let i = 0;
    const n = text.length;
    let inString = false;

    // Pass 1: comments
    while (i < n) {
        const c = text[i];
        if (inString) {
            out += c;
            if (c === '\\' && i + 1 < n) {
                out += text[i + 1];
                i += 2;
                continue;
            }
            if (c === '"') inString = false;
            i++;
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
            i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '/') {
            while (i < n && text[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            i += 2;
            while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        out += c;
        i++;
    }

    // Pass 2: trailing commas (a comma followed only by whitespace before } or ])
    let result = '';
    inString = false;
    for (let j = 0; j < out.length; j++) {
        const c = out[j];
        if (inString) {
            result += c;
            if (c === '\\' && j + 1 < out.length) {
                result += out[j + 1];
                j++;
            } else if (c === '"') {
                inString = false;
            }
            continue;
        }
        if (c === '"') {
            inString = true;
            result += c;
            continue;
        }
        if (c === ',') {
            let k = j + 1;
            while (k < out.length && /\s/.test(out[k])) k++;
            if (out[k] === '}' || out[k] === ']') continue;
        }
        result += c;
    }
    return result;
}

export function parseJsonc(text: string): unknown {
    const cleaned = stripJsonc(text.replace(/^\uFEFF/, ''));
    if (cleaned.trim() === '') return {};
    return JSON.parse(cleaned);
}

function readConfig(filePath: string): Json {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8');
    let parsed: unknown;
    try {
        parsed = parseJsonc(raw);
    } catch (e) {
        throw new Error(`Cannot parse ${filePath} (left unchanged): ${(e as Error).message}`);
    }
    if (!isJsonObject(parsed) || Array.isArray(parsed)) {
        throw new Error(`${filePath} does not contain a JSON object (left unchanged)`);
    }
    return parsed;
}

/**
 * Write JSON atomically (tmp file in the same directory + rename). The previous
 * content is kept in <file>.bak. Symlinks are followed so dotfile managers keep
 * working, and the original file mode is preserved (~/.claude.json is 0600).
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
    writeTextAtomic(filePath, JSON.stringify(data, null, 2) + '\n');
}

/** Same guarantees as writeJsonAtomic, for any text content. */
export function writeTextAtomic(filePath: string, content: string): void {
    let target = filePath;
    try {
        target = fs.realpathSync(filePath);
    } catch {
        // file does not exist yet
    }
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });

    let mode = 0o644;
    if (fs.existsSync(target)) {
        mode = fs.statSync(target).mode & 0o777;
        fs.copyFileSync(target, `${target}.bak`);
    }

    const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
    try {
        fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode });
        fs.chmodSync(tmp, mode);
        fs.renameSync(tmp, target);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
    }
}

// ---------------------------------------------------------------------------
// TOML helpers (Codex: ~/.codex/config.toml, [mcp_servers.<name>] tables)
// ---------------------------------------------------------------------------
//
// Only our own tables are touched, as text: everything else in the file (other
// servers, settings, comments) is kept byte for byte. No TOML library needed.

// Any table / array-of-tables header, including quoted keys that contain ']'
// (Codex adds [projects."/some/path"] tables on its own, possibly after ours)
const TOML_TABLE_HEADER = /^\s*\[.*\]\s*(#[^"']*)?$/;

/** Header of `[mcp_servers.bbdump-postgres]` or `[mcp_servers.bbdump-postgres.<sub>]`, bare or quoted keys. */
function isOwnTomlHeader(line: string): boolean {
    const m = line.match(/^\s*\[\s*mcp_servers\s*\.\s*("([^"]*)"|'([^']*)'|[A-Za-z0-9_-]+)\s*(\.[^\]]*)?\]\s*(#.*)?$/);
    if (!m) return false;
    const name = m[2] ?? m[3] ?? m[1];
    return name === MCP_SERVER_NAME;
}

/** TOML basic string (JSON escapes are a valid subset of TOML basic string escapes). */
const tomlString = (s: string): string => JSON.stringify(s);
const tomlKey = (k: string): string => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

/** Splits the file into our tables' lines and all other lines. */
function splitOwnTomlTables(text: string): { own: string[]; rest: string[] } {
    const own: string[] = [];
    const rest: string[] = [];
    let inOwn = false;
    for (const line of text.split('\n')) {
        if (TOML_TABLE_HEADER.test(line)) inOwn = isOwnTomlHeader(line);
        (inOwn ? own : rest).push(line);
    }
    return { own, rest };
}

function codexBlock(spec: McpLaunchSpec): string {
    const lines = [
        `[mcp_servers.${MCP_SERVER_NAME}]`,
        `command = ${tomlString(spec.command)}`,
        `args = [${spec.args.map(tomlString).join(', ')}]`,
    ];
    const envKeys = Object.keys(spec.env);
    if (envKeys.length) {
        lines.push('', `[mcp_servers.${MCP_SERVER_NAME}.env]`);
        for (const key of envKeys) lines.push(`${tomlKey(key)} = ${tomlString(spec.env[key])}`);
    }
    return lines.join('\n') + '\n';
}

/**
 * Reads back what we wrote (single-line values). Anything we cannot read —
 * e.g. hand-edited literal strings — is reported as a different entry.
 */
function parseOwnTomlEntry(ownLines: string[]): McpLaunchSpec | null {
    if (!ownLines.length) return null;
    const entry: McpLaunchSpec = { command: '', args: [], env: {} };
    let section: 'main' | 'env' | 'other' = 'main';
    for (const line of ownLines) {
        if (TOML_TABLE_HEADER.test(line)) {
            section = /\.\s*"?env"?\s*\]\s*(#.*)?$/.test(line) ? 'env' : (/^\s*\[\s*mcp_servers\s*\.\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*\]/.test(line) ? 'main' : 'other');
            continue;
        }
        const kv = line.match(/^\s*("([^"]*)"|[A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
        if (!kv) continue;
        const key = kv[2] ?? kv[1];
        let value: unknown;
        try { value = JSON.parse(kv[3]); } catch { value = undefined; }
        if (section === 'main' && key === 'command' && typeof value === 'string') entry.command = value;
        else if (section === 'main' && key === 'args' && Array.isArray(value)) entry.args = value.map(String);
        else if (section === 'env' && typeof value === 'string') entry.env[key] = value;
    }
    return entry;
}

function readTextIfExists(filePath: string): string {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
}

function tomlStatusState(configPath: string, spec: McpLaunchSpec): McpInstallState {
    const entry = parseOwnTomlEntry(splitOwnTomlTables(readTextIfExists(configPath)).own);
    if (!entry) return 'not-installed';
    return sameEntry(entry, spec) ? 'installed' : 'outdated';
}

function installToml(configPath: string, spec: McpLaunchSpec): void {
    const { rest } = splitOwnTomlTables(readTextIfExists(configPath));
    const kept = rest.join('\n').replace(/\s+$/, '');
    writeTextAtomic(configPath, (kept ? kept + '\n\n' : '') + codexBlock(spec));
}

function uninstallToml(configPath: string): void {
    const text = readTextIfExists(configPath);
    const { own, rest } = splitOwnTomlTables(text);
    if (!own.length) return;
    const kept = rest.join('\n').replace(/\s+$/, '');
    writeTextAtomic(configPath, kept ? kept + '\n' : '');
}

// ---------------------------------------------------------------------------
// Client definitions
// ---------------------------------------------------------------------------

function exists(p: string): boolean {
    try {
        return fs.existsSync(p);
    } catch {
        return false;
    }
}

function macApp(ctx: McpClientContext, name: string): boolean {
    return !!findMacApp(ctx, [name]);
}

function findMacApp(ctx: McpClientContext, names: string[]): string | undefined {
    if (ctx.platform !== 'darwin') return undefined;
    for (const name of names) {
        for (const dir of ['/Applications', path.join(ctx.home, 'Applications')]) {
            const candidate = path.join(dir, name);
            if (exists(candidate)) return candidate;
        }
    }
    return undefined;
}

function appDataDir(ctx: McpClientContext): string {
    return ctx.appData || path.join(ctx.home, 'AppData', 'Roaming');
}

function xdgConfig(ctx: McpClientContext): string {
    return ctx.xdgConfigHome || path.join(ctx.home, '.config');
}

/** Returns config[key] when it is an object; otherwise creates it (if `create`). */
function childObject(config: Json, key: string, create: boolean): Json | undefined {
    const current = config[key];
    if (isJsonObject(current)) return current;
    if (!create) return undefined;
    const created: Json = {};
    config[key] = created;
    return created;
}

function mcpServersContainer(config: Json, create: boolean): Json | undefined {
    return childObject(config, 'mcpServers', create);
}

function stdioEntry(spec: McpLaunchSpec, withType: boolean): Json {
    const entry: Json = withType ? { type: 'stdio' } : {};
    entry.command = spec.command;
    entry.args = [...spec.args];
    entry.env = { ...spec.env };
    return entry;
}

function claudeDesktopConfigPath(ctx: McpClientContext): string {
    switch (ctx.platform) {
        case 'darwin':
            return path.join(ctx.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
        case 'win32':
            return path.join(appDataDir(ctx), 'Claude', 'claude_desktop_config.json');
        default:
            return path.join(xdgConfig(ctx), 'Claude', 'claude_desktop_config.json');
    }
}

function vscodeUserDir(ctx: McpClientContext): string {
    switch (ctx.platform) {
        case 'darwin':
            return path.join(ctx.home, 'Library', 'Application Support', 'Code', 'User');
        case 'win32':
            return path.join(appDataDir(ctx), 'Code', 'User');
        default:
            return path.join(xdgConfig(ctx), 'Code', 'User');
    }
}

function opencodeConfigPath(ctx: McpClientContext): string {
    const dir = path.join(ctx.home, '.config', 'opencode');
    const json = path.join(dir, 'opencode.json');
    const jsonc = path.join(dir, 'opencode.jsonc');
    if (!exists(json) && exists(jsonc)) return jsonc;
    return json;
}

const CLIENTS: ClientDef[] = [
    {
        id: 'claude-desktop',
        name: 'Claude Desktop',
        apps: ['Claude.app'],
        configPath: claudeDesktopConfigPath,
        detect: (ctx) => {
            if (ctx.platform === 'darwin') return macApp(ctx, 'Claude.app') || exists(path.dirname(claudeDesktopConfigPath(ctx)));
            if (ctx.platform === 'win32') {
                const local = path.join(ctx.home, 'AppData', 'Local');
                return exists(path.join(local, 'AnthropicClaude')) || exists(path.join(local, 'Programs', 'claude-desktop'))
                    || exists(path.dirname(claudeDesktopConfigPath(ctx)));
            }
            return exists(path.dirname(claudeDesktopConfigPath(ctx)));
        },
        container: mcpServersContainer,
        toEntry: (spec) => stdioEntry(spec, false),
    },
    {
        // User scope: top-level "mcpServers" of ~/.claude.json
        id: 'claude-code',
        name: 'Claude Code',
        configPath: (ctx) => path.join(ctx.home, '.claude.json'),
        detect: (ctx) => !!ctx.claudeCli || exists(path.join(ctx.home, '.claude.json')) || exists(path.join(ctx.home, '.claude')),
        container: mcpServersContainer,
        toEntry: (spec) => stdioEntry(spec, true),
    },
    {
        // OpenAI Codex CLI: TOML config, [mcp_servers.<name>] + [mcp_servers.<name>.env]
        id: 'codex',
        name: 'Codex',
        apps: ['Codex.app', 'ChatGPT.app'],
        format: 'toml',
        configPath: (ctx) => path.join(ctx.codexHome || path.join(ctx.home, '.codex'), 'config.toml'),
        detect: (ctx) => exists(ctx.codexHome || path.join(ctx.home, '.codex'))
            || ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(ctx.home, '.local', 'bin', 'codex'),
                // Codex bundled with the ChatGPT desktop app
                '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'].some(exists)
            || macApp(ctx, 'Codex.app'),
        // Unused for TOML clients (see installToml / tomlStatusState)
        container: () => undefined,
        toEntry: (spec) => stdioEntry(spec, false),
    },
    {
        id: 'cursor',
        name: 'Cursor',
        apps: ['Cursor.app'],
        configPath: (ctx) => path.join(ctx.home, '.cursor', 'mcp.json'),
        detect: (ctx) => exists(path.join(ctx.home, '.cursor')) || macApp(ctx, 'Cursor.app'),
        container: mcpServersContainer,
        toEntry: (spec) => stdioEntry(spec, true),
    },
    {
        id: 'windsurf',
        name: 'Windsurf',
        apps: ['Windsurf.app'],
        configPath: (ctx) => path.join(ctx.home, '.codeium', 'windsurf', 'mcp_config.json'),
        detect: (ctx) => exists(path.join(ctx.home, '.codeium', 'windsurf')) || macApp(ctx, 'Windsurf.app'),
        container: mcpServersContainer,
        toEntry: (spec) => stdioEntry(spec, false),
    },
    {
        // Windsurf was renamed Devin desktop; its MCP config moved to the XDG config dir
        // (docs.devin.ai/desktop/cascade/mcp), on macOS too.
        id: 'devin',
        name: 'Devin desktop',
        apps: ['Devin.app', 'Windsurf.app'],
        configPath: (ctx) => path.join(xdgConfig(ctx), 'devin', 'mcp_config.json'),
        detect: (ctx) => exists(path.join(xdgConfig(ctx), 'devin')) || macApp(ctx, 'Devin.app'),
        container: mcpServersContainer,
        toEntry: (spec) => stdioEntry(spec, false),
    },
    {
        // User-level mcp.json: { "servers": { name: { "type": "stdio", ... } } }
        id: 'vscode',
        name: 'VS Code',
        apps: ['Visual Studio Code.app'],
        configPath: (ctx) => path.join(vscodeUserDir(ctx), 'mcp.json'),
        detect: (ctx) => exists(vscodeUserDir(ctx)),
        container: (config, create) => childObject(config, 'servers', create),
        toEntry: (spec) => stdioEntry(spec, true),
    },
    {
        // { "mcp": { name: { "type": "local", "command": [cmd, ...args], "environment": {...} } } }
        id: 'opencode',
        name: 'OpenCode',
        configPath: opencodeConfigPath,
        detect: (ctx) => exists(path.join(ctx.home, '.config', 'opencode')) || exists(path.join(ctx.home, '.opencode', 'bin', 'opencode')),
        container: (config, create) => {
            if (!isJsonObject(config.mcp) && create && !config.$schema) {
                config.$schema = 'https://opencode.ai/config.json';
            }
            return childObject(config, 'mcp', create);
        },
        toEntry: (spec) => ({
            type: 'local',
            command: [spec.command, ...spec.args],
            environment: { ...spec.env },
            enabled: true,
        }),
    },
];

export function getClientDefs(): ReadonlyArray<{ id: McpClientId; name: string }> {
    return CLIENTS.map(({ id, name }) => ({ id, name }));
}

function getDef(id: string): ClientDef {
    const def = CLIENTS.find((c) => c.id === id);
    if (!def) throw new Error(`Unknown MCP client: ${id}`);
    return def;
}

function sameEntry(a: unknown, b: unknown): boolean {
    return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function normalize(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(normalize);
    if (isJsonObject(v)) {
        return Object.keys(v).sort().reduce((acc: Json, k) => {
            acc[k] = normalize(v[k]);
            return acc;
        }, {});
    }
    return v;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getClientStatus(id: McpClientId, ctx: McpClientContext, spec: McpLaunchSpec): McpClientStatus {
    const def = getDef(id);
    const configPath = def.configPath(ctx);
    const base = {
        id: def.id,
        name: def.name,
        configPath,
        detected: def.detect(ctx),
        appPath: def.apps ? findMacApp(ctx, def.apps) : undefined,
    };
    try {
        if (def.format === 'toml') {
            const state = tomlStatusState(configPath, spec);
            return { ...base, state, installed: state !== 'not-installed' };
        }
        const config = readConfig(configPath);
        const entry = def.container(config, false)?.[MCP_SERVER_NAME];
        if (!entry) return { ...base, state: 'not-installed', installed: false };
        const state: McpInstallState = sameEntry(entry, def.toEntry(spec)) ? 'installed' : 'outdated';
        return { ...base, state, installed: true };
    } catch (e) {
        return { ...base, state: 'not-installed', installed: false, error: (e as Error).message };
    }
}

export function listClientStatuses(ctx: McpClientContext, spec: McpLaunchSpec): McpClientStatus[] {
    return CLIENTS.map((c) => getClientStatus(c.id, ctx, spec));
}

function runClaudeCli(ctx: McpClientContext, args: string[]): void {
    execFileSync(ctx.claudeCli as string, args, {
        env: { ...process.env, HOME: ctx.home },
        stdio: 'pipe',
        timeout: 30000,
    });
}

/** Add (or replace) the bbdump entry in the client's config. Returns the config path. */
export function installClient(id: McpClientId, ctx: McpClientContext, spec: McpLaunchSpec): string {
    const def = getDef(id);
    const configPath = def.configPath(ctx);
    if (def.format === 'toml') {
        installToml(configPath, spec);
        return configPath;
    }
    const entry = def.toEntry(spec);

    // Claude Code rewrites ~/.claude.json while it runs: prefer its own CLI, which
    // locks the file. Fall back to a direct edit if the CLI is missing or fails.
    if (id === 'claude-code' && ctx.claudeCli) {
        try {
            try { runClaudeCli(ctx, ['mcp', 'remove', MCP_SERVER_NAME, '--scope', 'user']); } catch { /* not present */ }
            runClaudeCli(ctx, ['mcp', 'add-json', MCP_SERVER_NAME, JSON.stringify(entry), '--scope', 'user']);
            if (getClientStatus(id, ctx, spec).state === 'installed') return configPath;
        } catch {
            // fall through to direct edit
        }
    }

    const config = readConfig(configPath);
    const container = def.container(config, true)!;
    container[MCP_SERVER_NAME] = entry;
    writeJsonAtomic(configPath, config);
    return configPath;
}

/** Remove the bbdump entry from the client's config (no-op if absent). */
export function uninstallClient(id: McpClientId, ctx: McpClientContext): string {
    const def = getDef(id);
    const configPath = def.configPath(ctx);
    if (!fs.existsSync(configPath)) return configPath;

    if (def.format === 'toml') {
        uninstallToml(configPath);
        return configPath;
    }

    if (id === 'claude-code' && ctx.claudeCli) {
        try {
            runClaudeCli(ctx, ['mcp', 'remove', MCP_SERVER_NAME, '--scope', 'user']);
        } catch {
            // fall through to direct edit
        }
    }

    const config = readConfig(configPath);
    const container = def.container(config, false);
    if (container && MCP_SERVER_NAME in container) {
        delete container[MCP_SERVER_NAME];
        writeJsonAtomic(configPath, config);
    }
    return configPath;
}

/** Generic "mcpServers" snippet for clients without one-click install. */
export function buildCustomSnippet(spec: McpLaunchSpec): string {
    return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: stdioEntry(spec, false) } }, null, 2);
}

/** Locate the Claude Code CLI without relying on the GUI app's PATH. */
export function findClaudeCli(home: string, platform: NodeJS.Platform): string | null {
    if (platform === 'win32') return null;
    const candidates = [
        path.join(home, '.local', 'bin', 'claude'),
        path.join(home, '.claude', 'local', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
    ];
    for (const c of candidates) {
        try {
            fs.accessSync(c, fs.constants.X_OK);
            return c;
        } catch {
            // next
        }
    }
    return null;
}

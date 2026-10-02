/**
 * How MCP clients start the bundled bbdump MCP server.
 *
 * The server runs on bbdump's own Electron binary in Node mode
 * (ELECTRON_RUN_AS_NODE=1), so no system Node.js is needed and the Node version
 * is the one bbdump ships with.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { pathManager } from './paths';
import { McpClientContext, McpLaunchSpec, findClaudeCli } from './mcpClients';

const VERSION_MARKER = '.bbdump-version';

/** AppImage: the app runs from a temporary mount point that changes on every launch. */
function appImagePath(): string | null {
    return process.platform === 'linux' && process.env.APPIMAGE ? process.env.APPIMAGE : null;
}

/** Stable copy of the MCP server used when the bundled one lives in an ephemeral mount. */
function stableServerDir(): string {
    return path.join(pathManager.appDataPath, 'mcp-postgres');
}

/**
 * On AppImage, copy resources/mcp-postgres to userData once per app version so
 * client configs can reference a path that survives the app being closed.
 * No-op elsewhere. Safe to call often.
 */
export function prepareMcpRuntime(): void {
    if (!app.isPackaged || !appImagePath()) return;
    const src = path.join(process.resourcesPath, 'mcp-postgres');
    const dest = stableServerDir();
    const version = app.getVersion();
    try {
        const marker = path.join(dest, VERSION_MARKER);
        if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf-8').trim() === version) return;
        const tmp = `${dest}.tmp-${process.pid}`;
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.cpSync(src, tmp, { recursive: true });
        fs.writeFileSync(path.join(tmp, VERSION_MARKER), version);
        fs.rmSync(dest, { recursive: true, force: true });
        fs.renameSync(tmp, dest);
        logger.info(`MCP server copied to ${dest} (AppImage)`);
    } catch (error) {
        logger.error(`Failed to copy MCP server out of the AppImage: ${error}`);
    }
}

function serverEntryPath(): string {
    if (app.isPackaged && appImagePath()) {
        prepareMcpRuntime();
        return path.join(stableServerDir(), 'index.js');
    }
    return pathManager.mcpServerPath;
}

/** What confirm.ts launches to get a confirmation UI when bbdump is not running. */
function appLaunchPath(): string {
    if (!app.isPackaged) return '';
    const exe = app.getPath('exe');
    if (process.platform === 'darwin') return exe.replace(/\/Contents\/MacOS\/.*$/, '');
    return appImagePath() || exe;
}

export function getMcpLaunchSpec(): McpLaunchSpec {
    return {
        command: appImagePath() || process.execPath,
        args: [serverEntryPath()],
        env: {
            ELECTRON_RUN_AS_NODE: '1',
            BBDUMP_CONFIG_PATH: pathManager.configPath,
            BBDUMP_KEY_PATH: pathManager.encryptionKeyPath,
            MCP_CONFIRM_PORT_FILE: pathManager.mcpConfirmPortFilePath,
            BBDUMP_APP_PATH: appLaunchPath(),
        },
    };
}

/**
 * macOS runs quarantined apps that were not moved to /Applications from a random
 * read-only path (App Translocation); a config written from there breaks later.
 */
export function isAppTranslocated(): boolean {
    return process.platform === 'darwin' && process.execPath.includes('/AppTranslocation/');
}

export function getMcpClientContext(): McpClientContext {
    const home = app.getPath('home');
    return {
        home,
        platform: process.platform,
        appData: process.env.APPDATA,
        xdgConfigHome: process.env.XDG_CONFIG_HOME,
        codexHome: process.env.CODEX_HOME,
        claudeCli: findClaudeCli(home, process.platform),
    };
}

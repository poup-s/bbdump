import { ipcMain, BrowserWindow } from 'electron';
import type { SetupEnvironment, SetupInstallPlan, SetupInstallResult, SetupProgress } from '../../types/setup';
import { getEnvironment, getInstallPlan, installWindowsPgClient, isSetupComponent, runInstall } from '../platform/install';
import { logger } from '../logger';
import { backupManager } from '../backup';
import { getErrorMessage } from '../utils';
import { encryptionManager } from '../encryption';
import { localServerPassword, saveLocalServerCredential, withLocalServerPassword } from '../localServerCredential';
import { getConfig, saveConfig } from './configIpc';

/**
 * Windows: saved databases on the local server without a password get the server's one,
 * encrypted (the AI assistants read the saved databases, not local-server.json).
 */
function fillLocalServerPasswords(): void {
    const config = getConfig();
    let changed = 0;
    for (const db of config.databases) {
        if (db.password) continue;
        const password = withLocalServerPassword({ ...db, password: '' }).password;
        if (!password) continue;
        db.password = encryptionManager.encrypt(password);
        db.encrypted = true;
        changed++;
    }
    if (changed) {
        saveConfig(config);
        logger.info(`Local server password added to ${changed} saved database(s)`);
    }
}

/** Onboarding / setup handlers (contract: src/types/setup.d.ts). */
export function registerSetupHandlers(getMainWindow: () => BrowserWindow | null) {
    ipcMain.handle('setup-get-environment', async (): Promise<SetupEnvironment> => {
        const env = await getEnvironment();
        logger.info(`Setup environment: ${env.osLabel} (${env.arch}), client tools ${env.clientTools.ready ? 'ready' : 'missing'}, `
            + `server ${env.server.installed ? 'installed' : 'not installed'}${env.server.running ? ', running' : ''}`
            + `${env.server.role ? `, role ${env.server.role}` : ''}`);
        return env;
    });

    ipcMain.handle('setup-get-plan', async (_, component: unknown): Promise<SetupInstallPlan> => {
        if (!isSetupComponent(component)) throw new Error(`Unknown setup component: ${String(component)}`);
        return getInstallPlan(component);
    });

    ipcMain.handle('setup-install', async (_, component: unknown): Promise<SetupInstallResult> => {
        if (!isSetupComponent(component)) {
            return { success: false, error: `Unknown setup component: ${String(component)}` };
        }
        logger.info(`Setup: installing ${component}`);
        const send = (progress: SetupProgress) => {
            const win = getMainWindow();
            if (win && !win.isDestroyed()) win.webContents.send('setup-progress', progress);
        };
        try {
            const result = await runInstall(component, send);
            if (result.success) {
                logger.info(`Setup: ${component} installed`);
                // Backups and restores must use the tools just installed, not the startup lookup
                if (component !== 'homebrew') await backupManager.refreshToolPaths();
                if (component === 'server' && process.platform === 'win32' && localServerPassword('postgres')) fillLocalServerPasswords();
            }
            else {
                logger.warn(`Setup: ${component} not installed: ${result.error || 'unknown error'}`);
            }
            return result;
        } catch (error) {
            logger.error(`Setup: ${component} failed: ${getErrorMessage(error)}`);
            return { success: false, error: getErrorMessage(error) };
        }
    });

    // Windows: the "postgres" password of a server bbdump did not install, checked then kept encrypted
    ipcMain.handle('setup-local-password', async (_, password: unknown) => {
        if (process.platform !== 'win32') return { success: false, error: 'Not available on this system' };
        if (typeof password !== 'string' || !password || password.length > 1024) return { success: false, error: 'Invalid password' };
        const port = (await getEnvironment(10000)).server.port;
        const { Client } = await import('pg');
        const client = new Client({ host: 'localhost', port, user: 'postgres', password, database: 'postgres', connectionTimeoutMillis: 5000 });
        try {
            await client.connect();
        } catch (error) {
            const message = getErrorMessage(error);
            logger.warn(`Setup: the local server password was not accepted: ${message}`);
            return { success: false, code: /password authentication failed|authentification par mot de passe/i.test(message) ? 'wrong-password' : 'error', error: message };
        } finally {
            await client.end().catch(() => {});
        }
        saveLocalServerCredential({ user: 'postgres', password });
        fillLocalServerPasswords();
        logger.info('Setup: local server password saved');
        return { success: true, environment: await getEnvironment() };
    });

    // Windows: the pg_dump a server needs, installed from a backup error's button
    ipcMain.handle('setup-install-pg-client', async (_, major: unknown) => {
        if (typeof major !== 'string') return { success: false, error: 'Invalid version' };
        logger.info(`Setup: installing the PostgreSQL ${major} client tools with winget`);
        const result = await installWindowsPgClient(major);
        if (result.success) await backupManager.refreshToolPaths();
        else logger.warn(`Setup: PostgreSQL ${major} client tools not installed: ${result.error}`);
        return result;
    });
}

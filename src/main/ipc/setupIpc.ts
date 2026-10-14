import { ipcMain, BrowserWindow } from 'electron';
import type { SetupEnvironment, SetupInstallPlan, SetupInstallResult, SetupProgress } from '../../types/setup';
import { getEnvironment, getInstallPlan, installWindowsPgClient, isSetupComponent, runInstall } from '../platform/install';
import { logger } from '../logger';
import { backupManager } from '../backup';
import { getErrorMessage } from '../utils';

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

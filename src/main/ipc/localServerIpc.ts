/** The local server of MySQL, MariaDB and MongoDB (see localEngineServer.ts) */
import { ipcMain, type BrowserWindow } from 'electron';
import { isLocalEngine } from '../platform/localEngines';
import {
    type LocalDatabaseSettings, createLocalAccount, createLocalEngineDatabase, dropLocalEngineDatabase, installLocalServer, localServerState, saveLocalAccount, startLocalServer,
} from '../localEngineServer';
import { requireFeature } from '../featureFlags';
import { logger } from '../logger';

const validPort = (port: unknown): number | undefined => (Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535 ? port as number : undefined);

export function registerLocalServerHandlers(getMainWindow: () => BrowserWindow | null): void {
    ipcMain.handle('local-engine-state', async (_, engine: unknown, port?: unknown) => {
        if (!isLocalEngine(engine)) throw new Error('Unknown engine');
        return localServerState(engine, validPort(port));
    });

    ipcMain.handle('local-engine-install', async (_, engine: unknown) => {
        if (!isLocalEngine(engine)) return { success: false, error: 'Unknown engine' };
        requireFeature(engine, 'local.server');
        logger.info(`Installing the local ${engine} server`);
        return installLocalServer(engine, line => {
            const win = getMainWindow();
            if (win && !win.isDestroyed()) win.webContents.send('local-engine-progress', { engine, line });
        });
    });

    ipcMain.handle('local-engine-start', async (_, engine: unknown) => {
        if (!isLocalEngine(engine)) return { success: false, error: 'Unknown engine' };
        requireFeature(engine, 'local.server');
        return startLocalServer(engine);
    });

    ipcMain.handle('local-engine-save-account', async (_, engine: unknown, port: unknown, user: unknown, password: unknown) => {
        if (!isLocalEngine(engine) || !validPort(port) || typeof user !== 'string' || typeof password !== 'string') return { success: false, error: 'Invalid account' };
        return saveLocalAccount(engine, validPort(port)!, user.trim(), password);
    });

    ipcMain.handle('local-engine-create-account', async (_, engine: unknown, port: unknown) => {
        if (!isLocalEngine(engine) || !validPort(port)) return { success: false, error: 'Invalid server' };
        return createLocalAccount(engine, validPort(port)!);
    });

    ipcMain.handle('local-engine-create-database', async (_, params: { engine?: unknown; name?: unknown; port?: unknown; displayName?: unknown; settings?: LocalDatabaseSettings }) => {
        if (!isLocalEngine(params?.engine) || typeof params.name !== 'string') return { success: false, error: 'Invalid database' };
        requireFeature(params.engine, 'local.server');
        const settings = params.settings && typeof params.settings === 'object' ? params.settings : {};
        return createLocalEngineDatabase(params.engine, params.name.trim(), validPort(params.port), typeof params.displayName === 'string' ? params.displayName : undefined, settings);
    });

    ipcMain.handle('drop-local-engine-database', async (_, id: unknown) => {
        if (typeof id !== 'string') return { success: false, error: 'Invalid database' };
        return dropLocalEngineDatabase(id);
    });
}

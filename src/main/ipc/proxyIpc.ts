import { ipcMain } from 'electron';
import { getErrorMessage } from '../utils';
import { tcpProxyManager, ProxyStatus, TargetCredentials } from '../tcpProxy';
import { getConfig, saveConfig } from './configIpc';
import { encryptionManager } from '../encryption';
import { logger } from '../logger';
import { isSslEnabled } from '../sslConfig';
import { proxyActivityLog, ProxyActivityEvent } from '../proxyActivityLog';
import { holdTunnel, releaseHolder } from '../sshTunnel';

const proxyHolder = (projectId: string) => `proxy:${projectId}`;

/**
 * Where a project's proxy forwards to. A database on a server is reached through its SSH
 * tunnel, held open as long as the proxy runs (released by stopping or switching it).
 */
export async function resolveProxyTarget(dbId: string, projectId: string): Promise<TargetCredentials | null> {
    const target = resolveDbCredentials(dbId);
    releaseHolder(proxyHolder(projectId));
    if (!target) return null;
    const db = getConfig().databases.find(d => d.id === dbId);
    if (!db?.ssh) return target;
    const endpoint = await holdTunnel(db.ssh, proxyHolder(projectId));
    return { ...target, host: endpoint.host, port: endpoint.port };
}

export function releaseProxyTunnel(projectId: string): void {
    releaseHolder(proxyHolder(projectId));
}

/**
 * Resolve full credentials for a database (host, port, user, password, database, ssl).
 * Decrypts the password if encrypted.
 */
function resolveDbCredentials(dbId: string): TargetCredentials | null {
    const config = getConfig();
    const db = config.databases.find(d => d.id === dbId);
    if (!db) return null;

    // Decrypt password
    let password = db.password || '';
    if (password && db.encrypted) {
        try {
            password = encryptionManager.decrypt(password);
        } catch (err) {
            logger.error(`Failed to decrypt password for ${db.name}: ${getErrorMessage(err)}`);
        }
    }

    // If connectionString is provided, parse it
    if (db.connectionString) {
        try {
            const url = new URL(db.connectionString);
            return {
                host: url.hostname || 'localhost',
                port: parseInt(url.port) || 5432,
                user: decodeURIComponent(url.username) || 'postgres',
                password: decodeURIComponent(url.password) || password,
                database: url.pathname.replace(/^\//, '') || db.name || 'postgres',
                ssl: isSslEnabled(db),
            };
        } catch {
            // Fall back to individual fields
        }
    }

    return {
        host: db.host || 'localhost',
        port: db.port || 5432,
        user: db.user || 'postgres',
        password,
        database: db.name || 'postgres',
        ssl: isSslEnabled(db),
    };
}

export function registerProxyHandlers() {
    /**
     * Start a proxy for a project.
     */
    ipcMain.handle('proxy-start', async (_, projectId: string, port: number): Promise<{ success: boolean; error?: string }> => {
        try {
            const config = getConfig();
            const project = (config.projects || []).find(p => p.id === projectId);
            if (!project) return { success: false, error: 'Project not found' };

            const available = await tcpProxyManager.isPortAvailable(port);
            if (!available) return { success: false, error: 'Port is already in use' };

            const targetDbId = project.proxyTargetDbId;
            if (!targetDbId) return { success: false, error: 'No target database selected' };

            const target = await resolveProxyTarget(targetDbId, projectId);
            if (!target) return { success: false, error: 'Target database not found' };

            const targetDb = config.databases.find(d => d.id === targetDbId);
            const targetDbName = targetDb?.displayName || targetDb?.name;

            await tcpProxyManager.startProxy(projectId, port, target, targetDbName);

            project.proxyEnabled = true;
            project.proxyPort = port;
            saveConfig(config);

            return { success: true };
        } catch (err) {
            logger.error(`proxy-start error: ${getErrorMessage(err)}`);
            return { success: false, error: getErrorMessage(err) };
        }
    });

    /**
     * Stop a proxy for a project.
     */
    ipcMain.handle('proxy-stop', async (_, projectId: string): Promise<{ success: boolean; error?: string }> => {
        try {
            tcpProxyManager.stopProxy(projectId);
            releaseProxyTunnel(projectId);

            const config = getConfig();
            const project = (config.projects || []).find(p => p.id === projectId);
            if (project) {
                project.proxyEnabled = false;
                saveConfig(config);
            }

            return { success: true };
        } catch (err) {
            logger.error(`proxy-stop error: ${getErrorMessage(err)}`);
            return { success: false, error: getErrorMessage(err) };
        }
    });

    /**
     * Switch the target database of a running proxy.
     */
    ipcMain.handle('proxy-switch-target', async (_, projectId: string, targetDbId: string): Promise<{ success: boolean; error?: string }> => {
        try {
            const config = getConfig();
            const project = (config.projects || []).find(p => p.id === projectId);
            if (!project) return { success: false, error: 'Project not found' };

            if (!project.databaseIds.includes(targetDbId)) {
                return { success: false, error: 'Database does not belong to this project' };
            }

            // Only a running proxy needs the new target reachable (its SSH tunnel opened)
            const running = tcpProxyManager.isRunning(projectId);
            const target = running ? await resolveProxyTarget(targetDbId, projectId) : resolveDbCredentials(targetDbId);
            if (!target) return { success: false, error: 'Target database not found' };

            // Get display name for activity logs
            const db = config.databases.find(d => d.id === targetDbId);
            const dbName = db?.displayName || db?.name;

            if (tcpProxyManager.isRunning(projectId)) {
                tcpProxyManager.switchTarget(projectId, target, dbName);
            }

            project.proxyTargetDbId = targetDbId;
            saveConfig(config);

            return { success: true };
        } catch (err) {
            logger.error(`proxy-switch-target error: ${getErrorMessage(err)}`);
            return { success: false, error: getErrorMessage(err) };
        }
    });

    ipcMain.handle('proxy-status', async (_, projectId: string): Promise<ProxyStatus | null> => {
        return tcpProxyManager.getStatus(projectId);
    });

    ipcMain.handle('proxy-status-all', async (): Promise<Record<string, ProxyStatus>> => {
        return tcpProxyManager.getAllStatuses();
    });

    ipcMain.handle('proxy-check-port', async (_, port: number): Promise<boolean> => {
        return tcpProxyManager.isPortAvailable(port);
    });

    ipcMain.handle('proxy-get-logs', async (_, projectId: string, limit?: number): Promise<ProxyActivityEvent[]> => {
        return proxyActivityLog.getEvents(projectId, limit);
    });

    ipcMain.handle('proxy-clear-logs', async (_, projectId: string): Promise<{ success: boolean }> => {
        proxyActivityLog.clearEvents(projectId);
        return { success: true };
    });
}

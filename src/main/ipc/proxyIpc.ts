import { ipcMain } from 'electron';
import { getErrorMessage } from '../utils';
import { tcpProxyManager, ProxyStatus } from '../tcpProxy';
import { proxyProtocolOf, proxyTargetFor, type ProxyTarget } from '../proxyTargets';
import { toRuntimeDatabase } from '../dbSecrets';
import type { DatabaseConfig } from '../../types/config';
import { getConfig, saveConfig } from './configIpc';
import { logger } from '../logger';
import { proxyActivityLog, ProxyActivityEvent } from '../proxyActivityLog';
import { holdTunnel, releaseHolder } from '../sshTunnel';

const proxyHolder = (projectId: string) => `proxy:${projectId}`;

/**
 * Where a project's proxy forwards to. A database on a server is reached through its SSH
 * tunnel, held open as long as the proxy runs (released by stopping or switching it).
 */
export async function resolveProxyTarget(dbId: string, projectId: string): Promise<ProxyTarget | null> {
    const db = getConfig().databases.find(d => d.id === dbId);
    if (!db) return null;
    const runtime = runtimeOf(db);
    const holder = proxyHolder(projectId);
    if (!db.ssh) {
        const target = proxyTargetFor(runtime);
        if (target) releaseHolder(holder);
        return target;
    }
    // The new tunnel is up before the old one is let go: a failed switch keeps the running target reachable
    const pending = `${holder}:next`;
    const endpoint = await holdTunnel(db.ssh, pending);
    const target = proxyTargetFor(runtime, endpoint);
    if (target) {
        releaseHolder(holder);
        await holdTunnel(db.ssh, holder);
    }
    releaseHolder(pending);
    return target;
}

export function releaseProxyTunnel(projectId: string): void {
    releaseHolder(proxyHolder(projectId));
}

/** The saved database with its password decrypted (memory only) */
function runtimeOf(db: DatabaseConfig): DatabaseConfig {
    try {
        return toRuntimeDatabase(db);
    } catch (err) {
        logger.error(`Failed to decrypt password for ${db.name}: ${getErrorMessage(err)}`);
        return { ...db, password: '' };
    }
}

/** A proxy target without opening a tunnel (a proxy that is not running only checks it exists) */
function resolveDbCredentials(dbId: string): ProxyTarget | null {
    const db = getConfig().databases.find(d => d.id === dbId);
    return db ? proxyTargetFor(runtimeOf(db)) : null;
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

            const targetDb = config.databases.find(d => d.id === targetDbId);
            if (targetDb && !proxyProtocolOf(targetDb)) return { success: false, error: 'The project proxy does not support this engine' };
            const target = await resolveProxyTarget(targetDbId, projectId);
            if (!target) return { success: false, error: 'Target database not found' };

            const targetDbName = targetDb?.displayName || targetDb?.name;

            try {
                await tcpProxyManager.startProxy(projectId, port, target, targetDbName);
            } catch (error) {
                // Not started (the port was taken meanwhile): its tunnel is not held
                if (!tcpProxyManager.isRunning(projectId)) releaseProxyTunnel(projectId);
                throw error;
            }

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
                const status = tcpProxyManager.getStatus(projectId);
                if (tcpProxyManager.engineOf(projectId) !== target.engine && status) {
                    // Another engine: the connected apps speak the old one, the proxy restarts on its port
                    tcpProxyManager.stopProxy(projectId);
                    await tcpProxyManager.startProxy(projectId, status.port, target, dbName);
                } else {
                    tcpProxyManager.switchTarget(projectId, target, dbName);
                }
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

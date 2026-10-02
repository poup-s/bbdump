import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

const ALLOWED_INVOKE_CHANNELS = new Set([
    // Config
    'get-config', 'complete-onboarding', 'save-settings', 'whats-new-seen',
    'open-external', 'show-item-in-folder',
    'add-database', 'update-database', 'remove-database',
    'toggle-schedule', 'toggle-mask',
    'add-project', 'update-project', 'remove-project', 'toggle-project-mask',
    'reorder-projects', 'move-database-to-project', 'reorder-databases', 'save-view-mode',
    // System
    'check-prerequisites', 'install-homebrew', 'install-postgresql',
    'setup-get-environment', 'setup-get-plan', 'setup-install',
    'backup-now', 'restore-backup', 'get-backups', 'delete-backup', 'download-backup',
    'logs-read', 'clear-logs', 'get-scheduled-tasks', 'schedule-overview',
    'get-app-version', 'get-about-info', 'get-default-path', 'select-directory', 'select-ssl-root-cert',
    'check-for-updates', 'download-update', 'install-update',
    'check-encryption-key', 'check-key-status', 'export-encryption-key', 'import-encryption-key',
    'get-mcp-status', 'install-mcp-claude-desktop', 'uninstall-mcp-claude-desktop',
    'mcp-list-clients', 'mcp-install-client', 'mcp-uninstall-client', 'mcp-get-custom-config', 'mcp-client-icons',
    'mcp-confirm-response',
    // DB Viewer
    'get-database-tables', 'test-database-connection', 'get-db-schemas', 'get-db-tables', 'get-db-full-schema',
    'count-table-rows', 'get-table-schema',
    'get-table-relations', 'get-table-data', 'get-fk-row',
    'update-table-data', 'delete-table-row', 'insert-table-row', 'get-enum-values',
    'execute-sql', 'execute-sql-mutation',
    'get-postgres-config', 'kill-postgres-connection', 'disconnect-postgres-database',
    'drop-postgres-database', 'test-postgres-connection',
    'get-postgres-extensions', 'install-postgres-extension', 'uninstall-postgres-extension',
    'get-extension-catalog', 'install-extension-package',
    'ai-journal-list', 'ai-journal-preview', 'ai-journal-undo',
    'sync-analyze', 'sync-apply',
    'ssh-hosts', 'ssh-check', 'ssh-trust-host', 'ssh-read-env', 'ssh-find-env',
    'neon-status', 'neon-connect', 'neon-forget', 'neon-projects', 'neon-branches', 'neon-databases', 'neon-connection-uri',
    'get-postgres-performance-stats', 'reset-postgres-performance-stats',
    'restart-postgres', 'check-postgres-config', 'fix-postgres-config', 'get-database-size',
    // Database creation
    'create-local-database', 'duplicate-external-to-local',
    // Proxy
    'proxy-start', 'proxy-stop', 'proxy-switch-target', 'proxy-status', 'proxy-status-all',
    'proxy-check-port', 'proxy-get-logs', 'proxy-clear-logs',
]);

const ALLOWED_SEND_CHANNELS = new Set([
    'tray-open-app', 'tray-open-dbviewer', 'tray-edit-db', 'mcp-confirm-done',
]);

const ALLOWED_RECEIVE_CHANNELS = new Set([
    'backup-started', 'backup-complete', 'backup-progress', 'sync-progress',
    'scheduled-backup-started', 'scheduled-backup-completed',
    'install-progress', 'setup-progress',
    'create-database-progress', 'duplicate-progress',
    'tray-refresh', 'open-dbviewer', 'edit-db',
    'update-available', 'update-downloaded', 'update-error',
    'update-download-progress', 'update-not-available',
    'mcp-confirm-request', 'mcp-confirm-timeout',
]);

// Custom APIs for renderer
const api = {
    // IPC Wrapper
    ipcRenderer: {
        invoke: (channel: string, ...args: unknown[]) => {
            if (!ALLOWED_INVOKE_CHANNELS.has(channel)) {
                throw new Error(`IPC invoke blocked: unknown channel "${channel}"`);
            }
            return ipcRenderer.invoke(channel, ...args);
        },
        on: (channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void) => {
            if (!ALLOWED_RECEIVE_CHANNELS.has(channel)) {
                throw new Error(`IPC on blocked: unknown channel "${channel}"`);
            }
            ipcRenderer.on(channel, listener);
            return () => ipcRenderer.removeListener(channel, listener);
        },
        removeListener: (channel: string, listener: (...args: unknown[]) => void) => ipcRenderer.removeListener(channel, listener),
        removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),
        send: (channel: string, ...args: unknown[]) => {
            if (!ALLOWED_SEND_CHANNELS.has(channel)) {
                throw new Error(`IPC send blocked: unknown channel "${channel}"`);
            }
            ipcRenderer.send(channel, ...args);
        }
    },
    // Shell: `shell` is not available in a sandboxed preload, so go through the main
    // process, which validates the arguments.
    shell: {
        openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
        showItemInFolder: (path: string) => ipcRenderer.invoke('show-item-in-folder', path)
    },
    // Platform info
    platform: process.platform
};

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
    try {
        contextBridge.exposeInMainWorld('electron', api);
    } catch (error) {
        console.error(error);
    }
} else {
    // @ts-expect-error (define in dts)
    window.electron = api;
}

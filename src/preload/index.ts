import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

const ALLOWED_INVOKE_CHANNELS = new Set([
    // Config
    'get-config', 'save-config', 'complete-onboarding', 'save-settings',
    'add-database', 'update-database', 'remove-database',
    'toggle-schedule', 'toggle-mask',
    'add-project', 'update-project', 'remove-project', 'toggle-project-mask',
    'reorder-projects', 'move-database-to-project', 'reorder-databases', 'save-view-mode',
    // System
    'check-prerequisites', 'install-homebrew', 'install-postgresql',
    'backup-now', 'restore-backup', 'get-backups', 'delete-backup', 'download-backup',
    'get-logs', 'clear-logs', 'get-scheduled-tasks',
    'get-app-version', 'get-default-path', 'select-directory',
    'check-for-updates', 'download-update', 'install-update',
    'check-encryption-key', 'check-key-status', 'export-encryption-key', 'import-encryption-key',
    'get-mcp-status', 'install-mcp-claude-desktop', 'uninstall-mcp-claude-desktop',
    'mcp-confirm-response',
    // DB Viewer
    'get-database-tables', 'get-db-tables', 'get-db-full-schema', 'get-table-schema',
    'get-table-relations', 'get-table-data', 'get-fk-row',
    'update-table-data', 'delete-table-row', 'insert-table-row', 'get-enum-values',
    'execute-sql', 'execute-sql-mutation',
    'get-postgres-config', 'kill-postgres-connection', 'disconnect-postgres-database',
    'drop-postgres-database', 'test-postgres-connection',
    'get-postgres-extensions', 'install-postgres-extension', 'uninstall-postgres-extension',
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
    'backup-started', 'backup-complete', 'install-progress',
    'tray-refresh', 'open-dbviewer', 'edit-db',
    'update-available', 'update-downloaded', 'update-error',
]);

// Custom APIs for renderer
const api = {
    // IPC Wrapper
    ipcRenderer: {
        invoke: (channel: string, ...args: any[]) => {
            if (!ALLOWED_INVOKE_CHANNELS.has(channel)) {
                throw new Error(`IPC invoke blocked: unknown channel "${channel}"`);
            }
            return ipcRenderer.invoke(channel, ...args);
        },
        on: (channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void) => {
            if (!ALLOWED_RECEIVE_CHANNELS.has(channel)) {
                throw new Error(`IPC on blocked: unknown channel "${channel}"`);
            }
            ipcRenderer.on(channel, listener);
            return () => ipcRenderer.removeListener(channel, listener);
        },
        removeListener: (channel: string, listener: (...args: any[]) => void) => ipcRenderer.removeListener(channel, listener),
        removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),
        send: (channel: string, ...args: any[]) => {
            if (!ALLOWED_SEND_CHANNELS.has(channel)) {
                throw new Error(`IPC send blocked: unknown channel "${channel}"`);
            }
            ipcRenderer.send(channel, ...args);
        }
    },
    // Shell Wrapper (if needed, though we should avoid exposing full shell)
    shell: {
        openExternal: (url: string) => import('electron').then(({ shell }) => shell.openExternal(url)),
        showItemInFolder: (path: string) => import('electron').then(({ shell }) => shell.showItemInFolder(path))
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
    // @ts-ignore (define in dts)
    window.electron = api;
}

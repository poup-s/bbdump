import { onMounted, onUnmounted } from 'vue';
import { store } from '../store';
import { useI18n } from './useI18n';
import { useToast } from './useToast';
import { ipcRenderer } from '../electron';
import { getErrorMessage } from '../utils';
import type { BackupCompleteEvent, BackupProgress } from '../types';
import { shouldShowWhatsNew } from '../whatsNew';

export function useAppEvents() {
    const { t, setLanguage } = useI18n();
    const { addToast } = useToast();

    const loadConfig = async () => {
        try {
            const config = await ipcRenderer.invoke('get-config');
            store.databases = config.databases;
            store.projects = config.projects || [];
            store.viewMode = 'project';
            store.onboardingCompleted = config.onboardingCompleted || false;
            if (config.language) {
                store.language = config.language;
                setLanguage(config.language);
            }
            store.allowSqlMutations = config.allowSqlMutations || false;
            store.usageMode = config.usageMode === 'remote' ? 'remote' : 'local';
            // Updated from a version before this tour: show it once
            if (store.onboardingCompleted && shouldShowWhatsNew(config.whatsNewSeen)) store.showWhatsNew = true;
        } catch (error) {
            console.error('Error loading config:', getErrorMessage(error));
            addToast(t('toasts.configLoadError'), 'error');
        }
    };

    const loadAppInfo = async () => {
        try {
            const version = await ipcRenderer.invoke('get-app-version');
            store.appVersion = version;
        } catch (error) {
            console.error('Error loading app info:', getErrorMessage(error));
        }
    };

    const checkForUpdates = async () => {
        try {
            store.checkingUpdate = true;
            const result = await ipcRenderer.invoke('check-for-updates');
            store.checkingUpdate = false;
            store.lastUpdateCheck = Date.now();
            store.updateCheckFailed = !!result.error;
            if (result.updateAvailable) {
                store.updateAvailable = true;
                store.updateDetails = {
                    version: result.version,
                    url: result.url,
                    releaseNotes: result.releaseNotes
                };
                addToast(t('settings.updateAvailable', { version: result.version }), 'info', {
                    action: { label: t('toasts.actions.see'), run: () => { store.activeTab = 'about'; } },
                });
            } else {
                store.updateAvailable = false;
                store.updateDetails = null;
            }
        } catch (error) {
            store.checkingUpdate = false;
            console.error('Error checking for updates:', getErrorMessage(error));
        }
    };

    const setupListeners = () => {
        ipcRenderer.on('backup-complete', (_: unknown, result: BackupCompleteEvent) => {
            store.isBackingUp = false;
            if (result.success) {
                const db = store.databases.find(d => d.id === result.databaseId);
                addToast(t('backup.success', { db: db?.displayName || db?.name || result.database }), 'success');
                if (db) db.lastBackup = result.timestamp;
            } else {
                const db = store.databases.find(d => d.id === result.databaseId);
                addToast(t('backup.error', { db: db?.displayName || db?.name || result.database }), 'error', { detail: result.error });
            }
            store.backupProgress = null;
        });

        ipcRenderer.on('backup-progress', (_: unknown, data: BackupProgress) => {
            store.backupProgress = data;
        });

        ipcRenderer.on('backup-started', (_: unknown, dbId: string) => {
            store.isBackingUp = true;
            const db = store.databases.find(d => d.id === dbId);
            store.backupProgress = { status: 'starting', dbId, logs: [], error: null };
            addToast(t('backup.started', { db: db?.displayName || db?.name || dbId }), 'info');
        });

        ipcRenderer.on('open-dbviewer', (_: unknown, dbId: string) => {
            const db = store.databases.find(d => d.id === dbId);
            if (db) {
                store.viewerDb = db;
                store.showDbViewer = true;
            }
        });

        ipcRenderer.on('edit-db', (_: unknown, dbId: string) => {
            const db = store.databases.find(d => d.id === dbId);
            if (db) {
                store.editingDatabase = JSON.parse(JSON.stringify(db));
                store.showDatabaseModal = true;
            }
        });

        ipcRenderer.on('update-download-progress', (_: unknown, progress: { percent: number }) => {
            store.downloadingUpdate = true;
            store.downloadProgress = progress.percent;
        });

        ipcRenderer.on('update-downloaded', () => {
            store.downloadingUpdate = false;
            store.updateDownloaded = true;
            addToast(t('settings.updateReady'), 'success');
        });

        ipcRenderer.on('update-error', () => {
            store.downloadingUpdate = false;
            store.downloadProgress = 0;
            addToast(t('settings.updateError'), 'error');
        });
    };

    const teardownListeners = () => {
        ipcRenderer.removeAllListeners('backup-complete');
        ipcRenderer.removeAllListeners('backup-progress');
        ipcRenderer.removeAllListeners('backup-started');
        ipcRenderer.removeAllListeners('open-dbviewer');
        ipcRenderer.removeAllListeners('edit-db');
        ipcRenderer.removeAllListeners('update-download-progress');
        ipcRenderer.removeAllListeners('update-downloaded');
        ipcRenderer.removeAllListeners('update-error');
    };

    onMounted(() => {
        loadConfig();
        loadAppInfo();
        checkForUpdates();
        setupListeners();
    });

    onUnmounted(teardownListeners);
}

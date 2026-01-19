import { reactive } from 'vue';
import { Database, Backup, Log, ScheduledTask } from './types';

export const store = reactive({
    databases: [] as Database[],
    backups: [] as Backup[],
    logs: [] as Log[],
    scheduledTasks: [] as ScheduledTask[],
    isBackingUp: false,
    appVersion: '1.0.0', // Will be updated from IPC
    appAuthor: 'Sebastien Poupineau',
    latestVersion: null as string | null,
    updateAvailable: false,
    checkingUpdate: false,

    // Modal states
    showAddModal: false,
    showEditModal: false,
    editingDb: null as Database | null,
    showDbViewer: false,
    viewerDb: null as Database | null,
    showDatabaseModal: false,
    showCreateDatabaseModal: false,
    showRestoreModal: false,
    showRestoreConfirmModal: false,
    restoreBackupFile: null as string | null,
    restoreTargetDb: null as Database | null,
    editingDatabase: null as Database | null,
    showBackupModal: false,
    backupProgress: null as {
        status: string;
        dbName: string;
        logs: string[];
        error: string | null;
    } | null,
    newlyAddedDbName: null as string | null,
    onboardingCompleted: false,
    language: 'en' as 'en' | 'fr',
    activeTab: 'dashboard' as string,
    isLoading: true
});

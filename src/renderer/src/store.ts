import { reactive } from 'vue';
import { Database, Backup, Log, ScheduledTask, Project, ProxyActivityEvent, RestoreTarget } from './types';

export const store = reactive({
    databases: [] as Database[],
    backups: [] as Backup[],
    logs: [] as Log[],
    scheduledTasks: [] as ScheduledTask[],
    isBackingUp: false,
    appVersion: '1.0.0', // Will be updated from IPC
    appAuthor: 'Poups',
    latestVersion: null as string | null,
    updateAvailable: false,
    checkingUpdate: false,
    updateDetails: null as { version: string; url: string; releaseNotes: string } | null,
    downloadingUpdate: false,
    downloadProgress: 0,
    updateDownloaded: false,

    // Modal states
    showDbViewer: false,
    viewerDb: null as Database | null,
    showDatabaseModal: false,
    showCreateDatabaseModal: false,
    createDatabaseForProjectId: null as string | null,
    showRestoreModal: false,
    showRestoreConfirmModal: false,
    restoreBackupFile: null as string | null,
    restoreTargetDb: null as RestoreTarget | null,
    editingDatabase: null as Database | null,
    modalTargetSection: null as 'schedule' | null,
    showBackupModal: false,
    showExtensionsModal: false,
    extensionsModalDb: null as Database | null,
    backupProgress: null as {
        status: string;
        dbId: string;
        logs: string[];
        error: string | null;
    } | null,
    newlyAddedDbId: null as string | null,
    // Project mode
    projects: [] as Project[],
    viewMode: 'list' as 'list' | 'project',
    showProjectModal: false,
    editingProject: null as Project | null,
    // Proxy statuses per project
    proxyStatuses: {} as Record<string, { running: boolean; port: number; activeConnections: number }>,
    // Proxy activity logs
    proxyActivityLogs: {} as Record<string, ProxyActivityEvent[]>,
    proxyActivityProjectId: null as string | null, // Project whose logs are currently displayed

    onboardingCompleted: false,
    language: 'en' as 'en' | 'fr',
    activeTab: 'dashboard' as string,
    isLoading: true,
    allowSqlMutations: false
});

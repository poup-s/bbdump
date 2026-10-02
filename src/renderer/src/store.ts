import { reactive } from 'vue';
import type { UsageMode } from '../../types/setup';
import { Database, Backup, BackupProgress, ScheduledTask, Project, ProxyActivityEvent, RestoreTarget } from './types';

export const store = reactive({
    databases: [] as Database[],
    backups: [] as Backup[],
    scheduledTasks: [] as ScheduledTask[],
    isBackingUp: false,
    appVersion: '1.0.0', // Will be updated from IPC
    appAuthor: 'Poups',
    latestVersion: null as string | null,
    updateAvailable: false,
    checkingUpdate: false,
    /** When the last update check ended (ms), and whether it failed */
    lastUpdateCheck: null as number | null,
    updateCheckFailed: false,
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
    extensionsModalDb: null as Pick<Database, 'name' | 'port' | 'host' | 'user'> | null,
    /** Database whose AI journal (changes made through MCP) is open */
    aiJournalDb: null as Database | null,
    /** Local database being updated from another one ("Update from…") */
    syncTargetDb: null as Database | null,
    backupProgress: null as BackupProgress | null,
    newlyAddedDbId: null as string | null,
    // Project mode
    projects: [] as Project[],
    viewMode: 'project' as 'list' | 'project',
    showProjectModal: false,
    editingProject: null as Project | null,
    // Proxy statuses per project
    proxyStatuses: {} as Record<string, { running: boolean; port: number; activeConnections: number }>,
    // Proxy activity logs
    proxyActivityLogs: {} as Record<string, ProxyActivityEvent[]>,
    proxyActivityProjectId: null as string | null, // Project whose logs are currently displayed

    onboardingCompleted: false,
    /** The "What's new" tour is open (after an update, or from Info) */
    showWhatsNew: false,
    /** How the onboarding was opened from the app (null: first run). Not persisted. */
    onboardingEntry: null as null | 'replay' | 'add-local-server',
    language: 'en' as 'en' | 'fr',
    activeTab: 'dashboard' as string,
    isLoading: true,
    allowSqlMutations: false,
    /** 'remote': no local PostgreSQL server features. Older configs have none: 'local'. */
    usageMode: 'local' as UsageMode
});

/** Remote-only mode: hide everything that needs a PostgreSQL server on this computer. */
export const isRemoteOnly = () => store.usageMode === 'remote';

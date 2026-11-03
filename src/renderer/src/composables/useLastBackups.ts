/**
 * The result of each database's last backup run (from the backup history), shared by the
 * database cards. The list refreshes it when it opens and after each backup.
 */
import { ref } from 'vue';
import { ipcRenderer } from '../electron';

export interface LastBackup {
    success: boolean;
    at: string;
    error?: string;
}

const results = ref<Record<string, LastBackup>>({});

export function useLastBackups() {
    const refresh = async () => {
        try {
            results.value = ((await ipcRenderer.invoke('last-backup-results')) as Record<string, LastBackup> | undefined) ?? {};
        } catch {
            // The dots stay as they were
        }
    };
    return {
        refresh,
        lastBackupOf: (databaseId: string): LastBackup | null => results.value[databaseId] ?? null,
    };
}

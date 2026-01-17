import { ref, computed } from 'vue';
import { store } from '../store';
import { ipcRenderer } from '../electron';

export interface BackupFile {
    filename: string;
    database: string;
    size: number;
    created: string;
    encrypted: boolean;
}

export interface BackupStats {
    total: number;
    totalSize: number;
}

export function useDashboardData() {
    const recentBackups = ref<BackupFile[]>([]);
    const stats = ref<BackupStats>({ total: 0, totalSize: 0 });
    const isLoading = ref(false);

    const loadDashboardData = async () => {
        isLoading.value = true;
        try {
            const result = await ipcRenderer.invoke('get-backups');
            recentBackups.value = result.backups.slice(0, 10); // Last 10
            stats.value = result.stats;
        } catch (error) {
            console.error('Failed to load dashboard data', error);
        } finally {
            isLoading.value = false;
        }
    };

    const totalDatabases = computed(() => store.databases.length);
    const localDatabases = computed(() => store.databases.filter(db => db.isLocalBbdump).length);
    const externalDatabases = computed(() => store.databases.filter(db => !db.isLocalBbdump).length);

    return {
        recentBackups,
        stats,
        isLoading,
        totalDatabases,
        localDatabases,
        externalDatabases,
        loadDashboardData
    };
}

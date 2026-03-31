<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { getErrorMessage } from '../utils';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { ipcRenderer } from '../electron';
import { store } from '../store';

const { t } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();

interface PostgresDatabase {
  name: string;
  owner: string;
  encoding: string;
  collate: string;
  ctype: string;
  size: string;
  connections?: number;
  isActive?: boolean;
  hasConnections?: boolean;
}

interface PostgresConnection {
  pid: number;
  database: string;
  username: string;
  clientAddr: string;
  state: string;
  query?: string;
  queryStart?: string;
  stateChange?: string;
}

interface PostgresConfigInfo {
  version: string;
  binVersion?: string;
  binPath?: string;
  port: number;
  dataDirectory?: string;
  isRunning: boolean;
  databases: PostgresDatabase[];
  activeConnections: PostgresConnection[];
}

const isLoading = ref(false);
const configInfo = ref<PostgresConfigInfo | null>(null);
const selectedPort = ref(5432);
const expandedSections = ref({
  databases: true,
  connections: false
});
const showPasswordModal = ref(false);
const passwordModalDbName = ref('');
const passwordInput = ref('');
const isConnecting = ref(false);
const copyToClipboard = (text: string) => {
  navigator.clipboard.writeText(text);
  addToast(t('postgresConfig.pathCopied'), 'success');
};

const loadConfig = async () => {
  isLoading.value = true;
  try {
    const info = await ipcRenderer.invoke('get-postgres-config', selectedPort.value);

    // Enrich with isActive from app store
    if (info && info.databases) {
      info.databases = info.databases.map((db: PostgresDatabase) => ({
        ...db,
        isActive: store.databases.some(managedDb =>
          managedDb.name === db.name &&
          managedDb.port === selectedPort.value &&
          managedDb.host === 'localhost'
        )
      }));
    }

    configInfo.value = info;
  } catch (error) {
    addToast(`Error loading PostgreSQL config: ${getErrorMessage(error)}`, 'error');
    configInfo.value = null;
  } finally {
    isLoading.value = false;
  }
};

const killConnection = async (pid: number) => {
  showConfirm({
    title: t('postgresConfig.killConnectionTitle'),
    message: t('postgresConfig.killConnectionMessage', { pid }),
    confirmText: t('postgresConfig.kill'),
    type: 'danger',
    onConfirm: async () => {
      try {
        const result = await ipcRenderer.invoke('kill-postgres-connection', pid, selectedPort.value);
        if (result.success) {
          addToast(t('postgresConfig.connectionKilled'), 'success');
          await new Promise(resolve => setTimeout(resolve, 500));
          await loadConfig();
        } else {
          addToast(result.error || t('postgresConfig.killError'), 'error');
        }
      } catch (error) {
        addToast(`Error killing connection: ${getErrorMessage(error)}`, 'error');
      }
    }
  });
};

const dropDatabase = async (dbName: string) => {
  showConfirm({
    title: t('postgresConfig.dropDatabaseTitle'),
    message: t('postgresConfig.dropDatabaseMessage', { name: dbName }),
    confirmText: t('postgresConfig.drop'),
    type: 'danger',
    onConfirm: async () => {
      try {
        const result = await ipcRenderer.invoke('drop-postgres-database', dbName, selectedPort.value, true);
        if (result.success) {
          addToast(t('postgresConfig.databaseDropped', { name: dbName }), 'success');
          await loadConfig();
        } else {
          addToast(result.error || t('postgresConfig.dropError'), 'error');
        }
      } catch (error) {
        addToast(`Error dropping database: ${getErrorMessage(error)}`, 'error');
      }
    }
  });
};

const isRestarting = ref(false);
const restartPostgres = async () => {
  showConfirm({
    title: t('viewer.restartPostgres'),
    message: 'Are you sure you want to restart the PostgreSQL server? Active connections will be terminated.',
    confirmText: t('common.confirm') || 'Confirm',
    type: 'danger',
    onConfirm: async () => {
      isRestarting.value = true;
      try {
        const result = await ipcRenderer.invoke('restart-postgres');
        if (result.success) {
          addToast(t('viewer.restartSuccess'), 'success');
          setTimeout(() => {
            loadConfig();
            isRestarting.value = false;
          }, 2000);
        } else {
          addToast(result.error || t('viewer.restartError'), 'error');
          isRestarting.value = false;
        }
      } catch (error) {
        addToast(getErrorMessage(error) || t('viewer.restartError'), 'error');
        isRestarting.value = false;
      }
    }
  });
};

const addDatabaseToConfig = async (connectionInfo: any) => {
  try {
    const existingDb = store.databases.find(db =>
      db.name === connectionInfo.database &&
      db.host === connectionInfo.host &&
      db.port === connectionInfo.port
    );

    if (existingDb) {
      addToast(t('postgresConfig.databaseAlreadyExists', { name: connectionInfo.database }), 'info');
      return;
    }

    const defaultPath = await ipcRenderer.invoke('get-default-path');
    const isLocal = connectionInfo.host === 'localhost' || connectionInfo.host === '127.0.0.1';

    const newDb = {
      name: connectionInfo.database,
      displayName: connectionInfo.database,
      host: connectionInfo.host,
      port: connectionInfo.port,
      user: connectionInfo.user,
      password: connectionInfo.password || '',
      output: defaultPath,
      cron: '0 0 * * *',
      enabled: false,
      encryptBackups: false,
      ssl: false,
      encrypted: true,
      isLocalBbdump: isLocal
    };

    await ipcRenderer.invoke('add-database', newDb);
    const config = await ipcRenderer.invoke('get-config');
    store.databases = config.databases;
    await loadConfig();

    const addedDb = store.databases.find(d => d.name === connectionInfo.database && d.host === connectionInfo.host && d.port === connectionInfo.port);
    store.newlyAddedDbId = addedDb?.id || null;
    setTimeout(() => {
      store.newlyAddedDbId = null;
    }, 2000);

    store.activeTab = 'databases';
    addToast(t('postgresConfig.databaseAdded', { name: connectionInfo.database }), 'success');
  } catch (error) {
    addToast(`Error adding database: ${getErrorMessage(error)}`, 'error');
  }
};

const testDatabase = async (dbName: string) => {
  isConnecting.value = true;
  try {
    let result = await ipcRenderer.invoke('test-postgres-connection', dbName, selectedPort.value);

    if (result.needsPassword) {
      passwordModalDbName.value = dbName;
      passwordInput.value = '';
      showPasswordModal.value = true;
      isConnecting.value = false;
      return;
    }

    if (result.success && result.connectionInfo) {
      await addDatabaseToConfig(result.connectionInfo);
    } else {
      addToast(result.error || t('postgresConfig.connectionError'), 'error');
    }
  } catch (error) {
    addToast(`Error testing connection: ${getErrorMessage(error)}`, 'error');
  } finally {
    isConnecting.value = false;
  }
};

const testConnectionWithPassword = async () => {
  if (!passwordModalDbName.value) return;

  isConnecting.value = true;
  try {
    const result = await ipcRenderer.invoke(
      'test-postgres-connection',
      passwordModalDbName.value,
      selectedPort.value,
      passwordInput.value
    );

    if (result.success && result.connectionInfo) {
      showPasswordModal.value = false;
      passwordInput.value = '';
      passwordModalDbName.value = '';
      await addDatabaseToConfig(result.connectionInfo);
    } else {
      addToast(result.error || t('postgresConfig.connectionError'), 'error');
    }
  } catch (error) {
    addToast(`Error testing connection: ${getErrorMessage(error)}`, 'error');
  } finally {
    isConnecting.value = false;
  }
};

const cancelPasswordModal = () => {
  showPasswordModal.value = false;
  passwordInput.value = '';
  passwordModalDbName.value = '';
};

const truncateQuery = (query?: string, maxLength: number = 50) => {
  if (!query) return '-';
  return query.length > maxLength ? query.substring(0, maxLength) + '...' : query;
};

const isSystemDatabase = (dbName: string) => {
  const systemDatabases = ['postgres', 'template0', 'template1'];
  return systemDatabases.includes(dbName);
};

const disconnectDatabase = async (dbName: string) => {
  const dbToRemove = store.databases.find(d => d.name === dbName && d.isLocalBbdump);
  if (!dbToRemove) return;
  showConfirm({
    title: t('postgresConfig.removeFromListTitle'),
    message: t('postgresConfig.removeFromListMessage', { name: dbName }),
    confirmText: t('postgresConfig.removeFromList'),
    type: 'warning',
    onConfirm: async () => {
      try {
        await ipcRenderer.invoke('remove-database', dbToRemove.id);
        const config = await ipcRenderer.invoke('get-config');
        store.databases = config.databases;
        addToast(
          t('postgresConfig.databaseRemovedFromList', { name: dbName }),
          'success'
        );
        await loadConfig();
      } catch (error) {
        addToast(`Error removing database from list: ${getErrorMessage(error)}`, 'error');
      }
    }
  });
};

const openExtensionsModal = async (dbName: string) => {
  const db = configInfo.value?.databases.find(d => d.name === dbName);
  if (db) {
    store.extensionsModalDb = {
      name: db.name,
      port: selectedPort.value,
      host: 'localhost',
      user: 'postgres'
    } as any;
    store.showExtensionsModal = true;
  }
};

onMounted(() => {
  loadConfig();
});
</script>

<template>
  <div class="bg-white dark:bg-zinc-900 rounded-xl p-4 border border-gray-200 dark:border-zinc-800" data-postgres-config>
    <!-- Header -->
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-2.5">
        <h3 class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ t('postgresConfig.title') }}</h3>
        <div v-if="configInfo" :class="[
          'flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold',
          configInfo.isRunning
            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            : 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
        ]">
          <span :class="['w-1.5 h-1.5 rounded-full', configInfo.isRunning ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500']"></span>
          {{ configInfo.isRunning ? t('postgresConfig.running') : t('postgresConfig.stopped') }}
        </div>
      </div>
      <div class="flex items-center gap-1.5">
        <div class="flex items-center gap-1.5 bg-gray-50 dark:bg-zinc-800 px-2.5 py-1 rounded-lg border border-gray-200 dark:border-zinc-700">
          <span class="text-[10px] font-bold text-gray-400">Port</span>
          <input
            v-model.number="selectedPort"
            type="number"
            class="w-14 bg-transparent text-xs font-bold text-gray-900 dark:text-white text-right focus:outline-none"
            @change="loadConfig"
          />
        </div>
        <button
          @click="restartPostgres"
          :disabled="isRestarting || isLoading || !configInfo?.isRunning"
          class="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-rose-600 dark:text-rose-400 bg-rose-500/10 hover:bg-rose-500/20 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <svg v-if="isRestarting" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <svg v-else class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {{ t('viewer.restartPostgres') }}
        </button>
        <button
          @click="loadConfig"
          :disabled="isLoading"
          class="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-md transition-colors disabled:opacity-30"
        >
          <svg class="w-3.5 h-3.5" :class="{ 'animate-spin': isLoading }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {{ t('common.refresh') }}
        </button>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="isLoading && !configInfo" class="flex items-center justify-center py-12">
      <div class="text-center">
        <div class="relative w-10 h-10 mx-auto mb-3">
          <div class="absolute inset-0 rounded-full border-4 border-blue-500/10"></div>
          <div class="absolute inset-0 rounded-full border-4 border-blue-600 border-t-transparent animate-spin"></div>
        </div>
        <p class="text-xs text-gray-400">{{ t('postgresConfig.loading') }}</p>
      </div>
    </div>

    <div v-else-if="configInfo" class="space-y-3">
      <!-- Info line -->
      <div class="flex items-center gap-2 text-xs bg-gray-50 dark:bg-zinc-800/50 px-3 py-2 rounded-lg">
        <span class="font-mono font-bold text-gray-700 dark:text-gray-300">v{{ configInfo.version }}</span>
        <span class="text-gray-300 dark:text-gray-600">|</span>
        <span class="text-gray-500">Client {{ configInfo.binVersion || '-' }}</span>
        <template v-if="configInfo.dataDirectory">
          <span class="text-gray-300 dark:text-gray-600">|</span>
          <code class="font-mono text-[11px] text-gray-400 truncate flex-1 min-w-0">{{ configInfo.dataDirectory }}</code>
          <button
            @click="copyToClipboard(configInfo.dataDirectory)"
            class="p-1 text-gray-400 hover:text-blue-500 rounded transition-colors shrink-0"
            :title="t('postgresConfig.copyPath')"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
            </svg>
          </button>
        </template>
      </div>

      <!-- Databases table -->
      <div class="rounded-lg border border-gray-100 dark:border-zinc-800 overflow-hidden">
        <div class="max-h-[400px] overflow-y-auto">
          <table class="w-full text-left">
            <thead class="sticky top-0 z-10">
              <tr class="bg-gray-50 dark:bg-zinc-800/80 border-b border-gray-100 dark:border-zinc-800">
                <th class="px-3 py-2 text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ t('postgresConfig.name') || 'Name' }}</th>
                <th class="px-3 py-2 text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ t('postgresConfig.size') }}</th>
                <th class="px-3 py-2 text-right text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ t('postgresConfig.actions') }}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-50 dark:divide-zinc-800/50">
              <tr v-for="db in configInfo.databases" :key="db.name" class="hover:bg-gray-50/50 dark:hover:bg-zinc-800/20 transition-colors">
                <td class="px-3 py-2">
                  <div class="flex items-center gap-2">
                    <div :class="['w-1.5 h-1.5 rounded-full shrink-0', db.hasConnections ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-zinc-700']"></div>
                    <span class="text-xs font-bold text-gray-900 dark:text-white truncate max-w-[200px]" :title="db.name">{{ db.name }}</span>
                  </div>
                </td>
                <td class="px-3 py-2 text-[11px] font-mono text-gray-400 dark:text-zinc-500">{{ db.size }}</td>
                <td class="px-3 py-2 text-right">
                  <div class="flex items-center justify-end gap-1">
                    <button
                      v-if="db.isActive"
                      @click="disconnectDatabase(db.name)"
                      class="px-2 py-1 text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 rounded-md transition-colors"
                    >
                      {{ t('postgresConfig.disconnect') }}
                    </button>
                    <button
                      v-else
                      @click="testDatabase(db.name)"
                      class="px-2 py-1 text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 rounded-md transition-colors"
                    >
                      {{ t('postgresConfig.connections') }}
                    </button>
                    <button
                      @click="openExtensionsModal(db.name)"
                      class="p-1 text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 rounded-md transition-colors"
                      :title="t('postgresConfig.addons')"
                    >
                      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" />
                      </svg>
                    </button>
                    <button
                      @click="dropDatabase(db.name)"
                      :disabled="isSystemDatabase(db.name)"
                      class="p-1 rounded-md transition-colors"
                      :class="isSystemDatabase(db.name) ? 'text-gray-300 dark:text-zinc-700 cursor-not-allowed' : 'text-rose-600 dark:text-rose-400 bg-rose-500/10 hover:bg-rose-500/20'"
                      :title="t('postgresConfig.drop')"
                    >
                      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Active Connections Accordion -->
      <div class="rounded-lg border border-gray-100 dark:border-zinc-800 overflow-hidden">
        <button
          @click="expandedSections.connections = !expandedSections.connections"
          class="w-full px-3 py-2.5 flex items-center justify-between hover:bg-gray-50/50 dark:hover:bg-zinc-800/20 transition-colors"
        >
          <div class="flex items-center gap-2">
            <span class="text-xs font-bold text-gray-700 dark:text-white">{{ t('postgresConfig.activeConnections') }}</span>
            <span class="px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-bold">
              {{ configInfo.activeConnections.length }}
            </span>
          </div>
          <svg class="w-3.5 h-3.5 text-gray-400 transition-transform duration-200" :class="{ 'rotate-180': expandedSections.connections }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        <div v-show="expandedSections.connections" class="px-3 pb-3 border-t border-gray-100 dark:border-zinc-800">
          <div v-if="configInfo.activeConnections.length === 0" class="py-6 text-center">
            <p class="text-xs text-gray-400">{{ t('postgresConfig.noConnections') }}</p>
          </div>
          <div v-else class="mt-2 rounded-lg border border-gray-100 dark:border-zinc-800 overflow-hidden">
            <div class="overflow-x-auto">
              <table class="w-full">
                <thead>
                  <tr class="bg-gray-50 dark:bg-zinc-800/80 border-b border-gray-100 dark:border-zinc-800">
                    <th class="px-3 py-2 text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ t('postgresConfig.pid') }}</th>
                    <th class="px-3 py-2 text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ t('postgresConfig.database') }}</th>
                    <th class="px-3 py-2 text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ t('postgresConfig.user') }}</th>
                    <th class="px-3 py-2 text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ t('postgresConfig.state') }}</th>
                    <th class="px-3 py-2 text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ t('postgresConfig.query') }}</th>
                    <th class="px-3 py-2 text-right text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ t('postgresConfig.actions') }}</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-50 dark:divide-zinc-800/50">
                  <tr
                    v-for="conn in configInfo.activeConnections"
                    :key="conn.pid"
                    class="hover:bg-gray-50/50 dark:hover:bg-zinc-800/20 transition-colors"
                  >
                    <td class="px-3 py-2 text-[11px] font-mono font-bold text-gray-500 dark:text-zinc-400">#{{ conn.pid }}</td>
                    <td class="px-3 py-2 text-xs font-bold text-gray-900 dark:text-white">{{ conn.database }}</td>
                    <td class="px-3 py-2 text-xs text-gray-600 dark:text-zinc-300">{{ conn.username }}</td>
                    <td class="px-3 py-2 text-xs">
                      <span :class="[
                        'px-1.5 py-0.5 rounded text-[10px] font-bold uppercase',
                        conn.state === 'active' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' :
                        conn.state === 'idle' ? 'bg-gray-100 dark:bg-gray-800 text-gray-500' :
                        'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                      ]">
                        {{ conn.state }}
                      </span>
                    </td>
                    <td class="px-3 py-2 text-[11px] font-mono text-gray-400 max-w-[200px] truncate" :title="conn.query">
                      {{ truncateQuery(conn.query) }}
                    </td>
                    <td class="px-3 py-2 text-right">
                      <button
                        @click="killConnection(conn.pid)"
                        :disabled="conn.query?.includes('bbdump-internal')"
                        class="px-2 py-1 text-[10px] font-bold rounded-md transition-colors uppercase"
                        :class="conn.query?.includes('bbdump-internal') ? 'text-gray-300 dark:text-zinc-700 cursor-not-allowed' : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20'"
                      >
                        {{ t('postgresConfig.kill') }}
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Not available -->
    <div v-else class="py-8 text-center text-sm text-gray-400">
      {{ t('postgresConfig.notAvailable') }}
    </div>

    <!-- Password Modal -->
    <div
      v-if="showPasswordModal"
      class="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-zinc-950/40 backdrop-blur-md"
      @click.self="cancelPasswordModal"
    >
      <div class="bg-white dark:bg-zinc-900 rounded-2xl p-6 border border-gray-200 dark:border-zinc-800 shadow-2xl max-w-sm w-full">
        <div class="w-12 h-12 rounded-xl bg-amber-500/10 flex items-center justify-center mx-auto mb-4">
          <svg class="w-6 h-6 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>

        <h3 class="text-lg font-bold text-center text-gray-900 dark:text-white mb-1">{{ t('postgresConfig.passwordRequired') }}</h3>
        <p class="text-xs text-gray-500 text-center mb-5">
          {{ t('postgresConfig.passwordRequiredMessage', { name: passwordModalDbName }) }}
        </p>

        <div class="space-y-3">
          <div>
            <label class="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1 block">{{ t('postgresConfig.password') }}</label>
            <input
              v-model="passwordInput"
              type="password"
              class="w-full h-10 px-3 bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all"
              :placeholder="t('postgresConfig.passwordPlaceholder')"
              @keyup.enter="testConnectionWithPassword"
              autofocus
            />
          </div>

          <div class="flex gap-2 pt-1">
            <button
              @click="cancelPasswordModal"
              class="flex-1 h-9 bg-gray-50 dark:bg-zinc-800 text-gray-500 rounded-lg text-xs font-medium hover:bg-gray-100 dark:hover:bg-zinc-700 transition-colors border border-gray-200 dark:border-zinc-700"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              @click="testConnectionWithPassword"
              :disabled="isConnecting || !passwordInput"
              class="flex-[2] h-9 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium transition-all disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <svg v-if="isConnecting" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {{ t('postgresConfig.connect') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
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
  } catch (error: any) {
    addToast(`Error loading PostgreSQL config: ${error.message}`, 'error');
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
          // Attendre un peu plus pour que PostgreSQL mette à jour ses statistiques
          await new Promise(resolve => setTimeout(resolve, 500));
          await loadConfig();
        } else {
          addToast(result.error || t('postgresConfig.killError'), 'error');
        }
      } catch (error: any) {
        addToast(`Error killing connection: ${error.message}`, 'error');
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
      } catch (error: any) {
        addToast(`Error dropping database: ${error.message}`, 'error');
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
          // Attendre un peu que le serveur redémarre avant de recharger
          setTimeout(() => {
            loadConfig();
            isRestarting.value = false;
          }, 2000);
        } else {
          addToast(result.error || t('viewer.restartError'), 'error');
          isRestarting.value = false;
        }
      } catch (error: any) {
        addToast(error.message || t('viewer.restartError'), 'error');
        isRestarting.value = false;
      }
    }
  });
};

const addDatabaseToConfig = async (connectionInfo: any) => {
  try {
    // Vérifier si la base existe déjà
    const existingDb = store.databases.find(db => 
      db.name === connectionInfo.database && 
      db.host === connectionInfo.host && 
      db.port === connectionInfo.port
    );
    
    if (existingDb) {
      addToast(t('postgresConfig.databaseAlreadyExists', { name: connectionInfo.database }), 'info');
      return;
    }
    
    // Obtenir le chemin par défaut
    const defaultPath = await ipcRenderer.invoke('get-default-path');
    
    // Détecter si c'est une base locale (localhost ou 127.0.0.1)
    const isLocal = connectionInfo.host === 'localhost' || connectionInfo.host === '127.0.0.1';
    
    // Créer la configuration de la base de données
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
      encrypted: true, // Chiffrer le mot de passe par défaut
      isLocalBbdump: isLocal // Marquer comme locale si c'est localhost
    };
    
    // Ajouter la base à la configuration
    await ipcRenderer.invoke('add-database', newDb);
    
    // Rafraîchir la liste des bases de données
    const config = await ipcRenderer.invoke('get-config');
    store.databases = config.databases;
    
    // Rafraîchir la liste PostgreSQL pour mettre à jour les boutons
    await loadConfig();
    
    // Déclencher l'animation
    store.newlyAddedDbName = connectionInfo.database;
    setTimeout(() => {
      store.newlyAddedDbName = null;
    }, 2000);
    
    // Rediriger vers l'onglet databases
    store.activeTab = 'databases';
    
    addToast(t('postgresConfig.databaseAdded', { name: connectionInfo.database }), 'success');
  } catch (error: any) {
    addToast(`Error adding database: ${error.message}`, 'error');
  }
};

const testDatabase = async (dbName: string) => {
  isConnecting.value = true;
  try {
    // Essayer d'abord sans mot de passe
    let result = await ipcRenderer.invoke('test-postgres-connection', dbName, selectedPort.value);
    
    // Si un mot de passe est nécessaire, afficher la modal
    if (result.needsPassword) {
      passwordModalDbName.value = dbName;
      passwordInput.value = '';
      showPasswordModal.value = true;
      isConnecting.value = false;
      return;
    }
    
    // Si la connexion réussit, ajouter la base à la configuration
    if (result.success && result.connectionInfo) {
      await addDatabaseToConfig(result.connectionInfo);
    } else {
      addToast(result.error || t('postgresConfig.connectionError'), 'error');
    }
  } catch (error: any) {
    addToast(`Error testing connection: ${error.message}`, 'error');
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
      // Fermer la modal
      showPasswordModal.value = false;
      passwordInput.value = '';
      passwordModalDbName.value = '';
      
      // Ajouter la base à la configuration
      await addDatabaseToConfig(result.connectionInfo);
    } else {
      addToast(result.error || t('postgresConfig.connectionError'), 'error');
    }
  } catch (error: any) {
    addToast(`Error testing connection: ${error.message}`, 'error');
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
  showConfirm({
    title: t('postgresConfig.removeFromListTitle'),
    message: t('postgresConfig.removeFromListMessage', { name: dbName }),
    confirmText: t('postgresConfig.removeFromList'),
    type: 'warning',
    onConfirm: async () => {
      try {
        await ipcRenderer.invoke('remove-database', dbName);
        const config = await ipcRenderer.invoke('get-config');
        store.databases = config.databases;
        addToast(
          t('postgresConfig.databaseRemovedFromList', { name: dbName }), 
          'success'
        );
        await loadConfig();
      } catch (error: any) {
        addToast(`Error removing database from list: ${error.message}`, 'error');
      }
    }
  });
};

const openExtensionsModal = async (dbName: string) => {
  const db = configInfo.value?.databases.find(d => d.name === dbName);
  if (db) {
    // Construct a Database-like object for the store
    store.extensionsModalDb = {
      name: db.name,
      port: selectedPort.value,
      host: 'localhost',
      user: 'postgres' // Default user for settings view
    } as any;
    store.showExtensionsModal = true;
  }
};

onMounted(() => {
  loadConfig();
});
</script>

<template>
  <div class="bg-white dark:bg-zinc-900 rounded-2xl p-6 border border-gray-200 dark:border-zinc-800 shadow-sm" data-postgres-config>
    <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
      <div class="flex items-center gap-4">
        <div>
          <div class="flex items-center gap-3">
            <h3 class="text-xl font-bold text-gray-900 dark:text-white">{{ t('postgresConfig.title') }}</h3>
            <div v-if="configInfo" :class="[
              'flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider',
              configInfo.isRunning 
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20' 
                : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20'
            ]">
              <span :class="['w-1.5 h-1.5 rounded-full animate-pulse', configInfo.isRunning ? 'bg-emerald-500' : 'bg-rose-500']"></span>
              {{ configInfo.isRunning ? t('postgresConfig.running') : t('postgresConfig.stopped') }}
            </div>
          </div>
          <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5 font-medium">{{ t('postgresConfig.description') }}</p>
        </div>
      </div>
      <div class="flex items-center gap-3 -mt-4">
        <div class="flex items-center gap-3 bg-gray-50 dark:bg-zinc-800/40 px-3 py-2 rounded-xl border border-gray-200/60 dark:border-zinc-700/60 backdrop-blur-sm">
          <label class="text-xs font-semibold text-gray-500 dark:text-gray-400">{{ t('postgresConfig.port') }}</label>
          <input
            v-model.number="selectedPort"
            type="number"
            class="w-16 bg-transparent border-0 text-sm font-bold text-gray-900 dark:text-white focus:outline-none focus:ring-0 p-0"
            @change="loadConfig"
          />
        </div>
        <button
          @click="restartPostgres"
          :disabled="isRestarting || isLoading || !configInfo?.isRunning"
          class="h-10 px-4 bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 rounded-xl text-xs font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 border border-rose-500/10 hover:scale-[1.02] active:scale-[0.98]"
        >
          <svg v-if="isRestarting" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {{ isRestarting ? t('viewer.restarting') : t('viewer.restartPostgres') }}
        </button>
        <button
          @click="loadConfig"
          :disabled="isLoading"
          class="h-10 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-lg shadow-blue-600/20 hover:scale-[1.02] active:scale-[0.98]"
        >
          <svg v-if="isLoading" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {{ t('common.refresh') || 'Refresh' }}
        </button>
      </div>
    </div>

    <div v-if="isLoading && !configInfo" class="flex items-center justify-center py-16">
      <div class="text-center">
        <div class="relative w-12 h-12 mx-auto mb-4">
          <div class="absolute inset-0 rounded-full border-4 border-blue-500/10"></div>
          <div class="absolute inset-0 rounded-full border-4 border-blue-600 border-t-transparent animate-spin"></div>
        </div>
        <p class="text-sm font-medium text-gray-500 dark:text-gray-400 animate-pulse">{{ t('postgresConfig.loading') }}</p>
      </div>
    </div>

    <div v-else-if="configInfo" class="space-y-6">
      <!-- Consolidated Overview Bar -->
      <div class="bg-gray-50/50 dark:bg-zinc-800/30 rounded-2xl border border-gray-100 dark:border-zinc-800/60 p-1.5 flex flex-wrap md:flex-nowrap items-stretch gap-1.5 overflow-hidden">
        <!-- Versions Group -->
        <div class="flex-1 min-w-[200px] bg-white dark:bg-zinc-900/40 rounded-xl p-3 border border-gray-100 dark:border-zinc-800/50 shadow-sm">
          <div class="flex flex-col gap-2">
            <div class="flex items-center justify-between">
              <span class="text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-tight">{{ t('postgresConfig.serverVersion') }}</span>
            </div>
            <div class="flex items-baseline gap-2">
              <span class="text-lg font-black text-gray-900 dark:text-white leading-none tracking-tight">{{ configInfo.version }}</span>
            </div>
            <div class="pt-2 mt-1 border-t border-gray-50 dark:border-zinc-800/50 flex items-center justify-between">
              <span class="text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-tight">{{ t('postgresConfig.clientVersion') }}</span>
              <span class="text-xs font-bold text-gray-700 dark:text-zinc-300">{{ configInfo.binVersion || '-' }}</span>
            </div>
          </div>
        </div>

        <!-- Path Group -->
        <div class="flex-[2] min-w-[300px] bg-white dark:bg-zinc-900/40 rounded-xl p-3 border border-gray-100 dark:border-zinc-800/50 shadow-sm flex flex-col justify-between">
          <span class="text-[10px] font-bold text-gray-400 dark:text-zinc-500 uppercase tracking-tight mb-2">{{ t('postgresConfig.dataDirectory') }}</span>
          <div v-if="configInfo.dataDirectory" class="flex items-center gap-2 group/path">
            <div class="flex-1 bg-gray-50/80 dark:bg-zinc-950/40 px-3 py-2 rounded-lg border border-gray-200/50 dark:border-zinc-800/50 overflow-hidden">
              <code class="text-[11px] text-gray-600 dark:text-zinc-400 truncate block font-mono">{{ configInfo.dataDirectory }}</code>
            </div>
            <button 
              @click="copyToClipboard(configInfo.dataDirectory)"
              class="p-2 bg-white dark:bg-zinc-800 text-gray-400 hover:text-blue-500 dark:text-zinc-500 dark:hover:text-blue-400 rounded-lg border border-gray-200 dark:border-zinc-700 transition-colors shadow-sm active:scale-95"
              :title="t('postgresConfig.copyPath')"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
              </svg>
            </button>
          </div>
          <div v-else class="text-sm text-gray-400 italic">No data directory found</div>
        </div>
      </div>

        <div v-show="expandedSections.databases" class="px-5 pb-5 pt-2 max-h-[500px] overflow-y-auto custom-scrollbar">
          <div class="bg-white dark:bg-zinc-900/60 rounded-xl border border-gray-100 dark:border-zinc-800/40 overflow-hidden shadow-sm">
            <table class="w-full text-left">
              <thead>
                <tr class="bg-gray-50/50 dark:bg-zinc-800/50 border-b border-gray-100 dark:border-zinc-800/50">
                  <th class="px-4 py-3 text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest">{{ t('postgresConfig.name') || 'Name' }}</th>
                  <th class="px-4 py-3 text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest">{{ t('postgresConfig.size') }}</th>
                  <th class="px-4 py-3 text-right text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest">{{ t('postgresConfig.actions') }}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-50 dark:divide-zinc-800/50">
                <tr v-for="db in configInfo.databases" :key="db.name" class="hover:bg-gray-50/50 dark:hover:bg-zinc-800/20 transition-colors">
                  <td class="px-4 py-3">
                    <div class="flex items-center gap-2">
                      <div :class="['w-1.5 h-1.5 rounded-full shrink-0', db.hasConnections ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-gray-300 dark:bg-zinc-700']"></div>
                      <span class="text-sm font-bold text-gray-900 dark:text-white truncate max-w-[200px]" :title="db.name">{{ db.name }}</span>
                    </div>
                  </td>
                  <td class="px-4 py-3 text-[11px] font-black font-mono text-gray-400 dark:text-zinc-500">{{ db.size }}</td>
                  <td class="px-4 py-3 text-right">
                    <div class="flex items-center justify-end gap-1.5">
                      <button 
                        v-if="db.isActive" 
                        @click="disconnectDatabase(db.name)" 
                        class="p-1.5 text-xs font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 rounded-lg transition-colors"
                        :title="t('postgresConfig.connections')"
                      >
                        {{ t('postgresConfig.disconnect') }}
                      </button>
                      <button
                        v-else
                        @click="testDatabase(db.name)" 
                        class="p-1.5 text-xs font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 rounded-lg transition-colors"
                        :title="t('postgresConfig.connections')"
                      >
                        {{ t('postgresConfig.connections') }}
                      </button>
                      <button 
                        @click="openExtensionsModal(db.name)" 
                        class="p-1.5 text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg transition-colors"
                        :title="t('postgresConfig.addons')"
                      >
                        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" />
                        </svg>
                      </button>
                      <button 
                        v-if="!isSystemDatabase(db.name)" 
                        @click="dropDatabase(db.name)" 
                        class="p-1.5 text-rose-600 dark:text-rose-400 bg-rose-500/10 hover:bg-rose-500/20 rounded-lg transition-colors"
                        :title="t('postgresConfig.drop')"
                      >
                        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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

      <!-- Active Connections Section -->
      <div class="bg-gray-50/50 dark:bg-zinc-800/30 rounded-2xl border border-gray-100 dark:border-zinc-800/60 overflow-hidden">
        <button
          @click="expandedSections.connections = !expandedSections.connections"
          class="w-full px-5 py-4 flex items-center justify-between group transition-colors hover:bg-white/40 dark:hover:bg-zinc-800/20"
        >
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center border border-emerald-500/10">
              <svg class="w-4 h-4 text-emerald-600 dark:text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.636 18.364a9 9 0 010-12.728m12.728 0a9 9 0 010 12.728m-9.9-2.828a5 5 0 117.07 0m-7.07 1.414L10 14m0 0l-2 2m2-2l2 2" />
              </svg>
            </div>
            <span class="text-sm font-bold text-gray-900 dark:text-white">{{ t('postgresConfig.activeConnections') }}</span>
            <span class="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-black border border-emerald-500/10">
              {{ configInfo.activeConnections.length }}
            </span>
          </div>
          <div class="w-6 h-6 rounded-full bg-gray-200/50 dark:bg-zinc-700/50 flex items-center justify-center transition-transform duration-300" :class="{ 'rotate-180': expandedSections.connections }">
            <svg class="w-3 h-3 text-gray-500 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </button>
        
        <div v-show="expandedSections.connections" class="px-5 pb-5">
          <div v-if="configInfo.activeConnections.length === 0" class="py-12 text-center">
            <p class="text-sm text-gray-400 italic">{{ t('postgresConfig.noConnections') }}</p>
          </div>
          <div v-else class="bg-white dark:bg-zinc-900/60 rounded-xl border border-gray-100 dark:border-zinc-800/40 overflow-hidden shadow-sm">
            <div class="overflow-x-auto custom-scrollbar">
              <table class="w-full">
                <thead>
                  <tr class="bg-gray-50/50 dark:bg-zinc-800/50 border-b border-gray-100 dark:border-zinc-800/50">
                    <th class="px-4 py-3 text-left text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest">{{ t('postgresConfig.pid') }}</th>
                    <th class="px-4 py-3 text-left text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest">{{ t('postgresConfig.database') }}</th>
                    <th class="px-4 py-3 text-left text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest">{{ t('postgresConfig.user') }}</th>
                    <th class="px-4 py-3 text-left text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest">{{ t('postgresConfig.state') }}</th>
                    <th class="px-4 py-3 text-left text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest">{{ t('postgresConfig.query') }}</th>
                    <th class="px-4 py-3 text-right text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest">{{ t('postgresConfig.actions') }}</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-50 dark:divide-zinc-800/50">
                  <tr
                    v-for="conn in configInfo.activeConnections"
                    :key="conn.pid"
                    class="hover:bg-gray-50/50 dark:hover:bg-zinc-800/20 transition-colors"
                  >
                    <td class="px-4 py-3 text-[11px] font-mono font-bold text-gray-500 dark:text-zinc-400">#{{ conn.pid }}</td>
                    <td class="px-4 py-3 text-xs font-bold text-gray-900 dark:text-white">{{ conn.database }}</td>
                    <td class="px-4 py-3 text-xs font-medium text-gray-600 dark:text-zinc-300">{{ conn.username }}</td>
                    <td class="px-4 py-3 text-xs">
                      <span :class="[
                        'px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-tight',
                        conn.state === 'active' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' :
                        conn.state === 'idle' ? 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400' :
                        'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                      ]">
                        {{ conn.state }}
                      </span>
                    </td>
                    <td class="px-4 py-3 text-[11px] font-mono text-gray-500 dark:text-zinc-500 max-w-xs truncate" :title="conn.query">
                      {{ truncateQuery(conn.query) }}
                    </td>
                    <td class="px-4 py-3 text-right">
                      <button
                        @click="killConnection(conn.pid)"
                        class="px-2.5 py-1 text-[10px] font-bold bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 rounded-md transition-all uppercase tracking-tight"
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

    <div v-else class="p-8 text-center text-gray-500">
      {{ t('postgresConfig.notAvailable') }}
    </div>

    <!-- Password Modal -->
    <div
      v-if="showPasswordModal"
      class="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-zinc-950/40 backdrop-blur-md"
      @click.self="cancelPasswordModal"
    >
      <div class="bg-white dark:bg-zinc-900 rounded-[2rem] p-8 border border-gray-100 dark:border-zinc-800 shadow-2xl max-w-sm w-full animate-in zoom-in-95 duration-200">
        <div class="w-16 h-16 rounded-2xl bg-amber-500/10 flex items-center justify-center border border-amber-500/10 mx-auto mb-6">
          <svg class="w-8 h-8 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
        
        <h3 class="text-xl font-black text-center text-gray-900 dark:text-white mb-2">{{ t('postgresConfig.passwordRequired') }}</h3>
        <p class="text-xs text-gray-500 dark:text-zinc-400 text-center mb-8 leading-relaxed">
          {{ t('postgresConfig.passwordRequiredMessage', { name: passwordModalDbName }) }}
        </p>

        <div class="space-y-4">
          <div class="space-y-1.5">
            <label class="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest px-1">{{ t('postgresConfig.password') }}</label>
            <input
              v-model="passwordInput"
              type="password"
              class="w-full h-12 px-4 bg-gray-50 dark:bg-zinc-950/40 border-2 border-transparent focus:border-blue-500/20 dark:focus:border-blue-400/20 focus:bg-white dark:focus:bg-zinc-900 rounded-xl transition-all outline-none text-sm font-bold placeholder:text-gray-400/60 dark:placeholder:text-zinc-600"
              :placeholder="t('postgresConfig.passwordPlaceholder')"
              @keyup.enter="testConnectionWithPassword"
              autofocus
            />
          </div>
          
          <div class="flex gap-3 pt-2">
            <button
              @click="cancelPasswordModal"
              class="flex-1 h-12 bg-gray-50 dark:bg-zinc-800/40 text-gray-500 dark:text-zinc-400 rounded-xl text-xs font-bold hover:bg-gray-100 dark:hover:bg-zinc-800/60 transition-colors"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              @click="testConnectionWithPassword"
              :disabled="isConnecting || !passwordInput"
              class="flex-[2] h-12 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-blue-600/20"
            >
              <svg v-if="isConnecting" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
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


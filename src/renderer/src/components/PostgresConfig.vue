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

const loadConfig = async () => {
  isLoading.value = true;
  try {
    configInfo.value = await ipcRenderer.invoke('get-postgres-config', selectedPort.value);
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

const removeDatabaseFromList = async (dbName: string) => {
  showConfirm({
    title: t('postgresConfig.removeFromListTitle'),
    message: t('postgresConfig.removeFromListMessage', { name: dbName }),
    confirmText: t('postgresConfig.removeFromList'),
    type: 'warning',
    onConfirm: async () => {
      try {
        // Retirer la base de la configuration de l'application (sans la supprimer de PostgreSQL)
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

const testConnection = async (dbName: string) => {
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
      const dbName = passwordModalDbName.value;
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

const formatDate = (dateStr?: string) => {
  if (!dateStr) return '-';
  try {
    return new Date(dateStr).toLocaleString();
  } catch {
    return dateStr;
  }
};

const truncateQuery = (query?: string, maxLength: number = 50) => {
  if (!query) return '-';
  return query.length > maxLength ? query.substring(0, maxLength) + '...' : query;
};

const isDatabaseInConfig = (dbName: string, port: number) => {
  return store.databases.some(db => 
    db.name === dbName && 
    db.host === 'localhost' && 
    db.port === port
  );
};

const isSystemDatabase = (dbName: string) => {
  const systemDatabases = ['postgres', 'template0', 'template1'];
  return systemDatabases.includes(dbName);
};

onMounted(() => {
  loadConfig();
});
</script>

<template>
  <div class="bg-white dark:bg-zinc-900 rounded-2xl p-6 border border-gray-200 dark:border-zinc-800 shadow-sm" data-postgres-config>
    <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/10 to-blue-600/5 flex items-center justify-center">
          <svg class="w-5 h-5 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </div>
        <div>
          <h3 class="text-lg font-semibold text-gray-900 dark:text-white">{{ t('postgresConfig.title') }}</h3>
          <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ t('postgresConfig.description') }}</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <div class="flex items-center gap-2 bg-gray-50 dark:bg-zinc-800/50 px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-zinc-700">
          <label class="text-xs text-gray-600 dark:text-gray-400">{{ t('postgresConfig.port') }}:</label>
          <input
            v-model.number="selectedPort"
            type="number"
            min="1"
            max="65535"
            class="w-14 px-1.5 py-0.5 bg-transparent border-0 text-sm font-medium text-gray-900 dark:text-white focus:outline-none"
            @change="loadConfig"
          />
        </div>
        <button
          @click="loadConfig"
          :disabled="isLoading"
          class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
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

    <div v-if="isLoading && !configInfo" class="flex items-center justify-center py-12">
      <div class="text-center">
        <svg class="w-8 h-8 animate-spin mx-auto text-blue-600" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <p class="mt-2 text-sm text-gray-500">{{ t('postgresConfig.loading') }}</p>
      </div>
    </div>

    <div v-else-if="configInfo" class="space-y-4">
      <!-- Status Info -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div class="p-3 bg-gray-50 dark:bg-zinc-800/50 rounded-xl border border-gray-200 dark:border-zinc-700">
          <div class="text-xs text-gray-500 dark:text-gray-400 mb-1">{{ t('postgresConfig.version') }}</div>
          <div class="text-base font-semibold text-gray-900 dark:text-white">{{ configInfo.version }}</div>
        </div>
        <div class="p-3 bg-gray-50 dark:bg-zinc-800/50 rounded-xl border border-gray-200 dark:border-zinc-700">
          <div class="text-xs text-gray-500 dark:text-gray-400 mb-1">{{ t('postgresConfig.status') }}</div>
          <div class="flex items-center gap-2">
            <div :class="[
              'w-2 h-2 rounded-full',
              configInfo.isRunning ? 'bg-green-500' : 'bg-red-500'
            ]"></div>
            <span class="text-base font-semibold text-gray-900 dark:text-white">
              {{ configInfo.isRunning ? t('postgresConfig.running') : t('postgresConfig.stopped') }}
            </span>
          </div>
        </div>
        <div class="p-3 bg-gray-50 dark:bg-zinc-800/50 rounded-xl border border-gray-200 dark:border-zinc-700">
          <div class="text-xs text-gray-500 dark:text-gray-400 mb-1">{{ t('postgresConfig.databasesCount') }}</div>
          <div class="text-base font-semibold text-gray-900 dark:text-white">{{ configInfo.databases.length }}</div>
        </div>
      </div>

      <!-- Databases Section -->
      <div class="border border-gray-200 dark:border-zinc-700 rounded-xl overflow-hidden bg-white dark:bg-zinc-900">
        <button
          @click="expandedSections.databases = !expandedSections.databases"
          class="w-full px-4 py-3 bg-gray-50 dark:bg-zinc-800/50 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors flex items-center justify-between group"
        >
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
            </svg>
            <span class="text-sm font-medium text-gray-900 dark:text-white">{{ t('postgresConfig.databases') }}</span>
            <span class="text-xs text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/30 px-2 py-0.5 rounded-full">
              {{ configInfo.databases.length }}
            </span>
          </div>
          <svg 
            class="w-4 h-4 text-gray-400 dark:text-gray-500 transition-transform"
            :class="{ 'rotate-180': expandedSections.databases }"
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        
        <div v-if="expandedSections.databases" class="border-t border-border">
          <div v-if="configInfo.databases.length === 0" class="p-8 text-center text-gray-500">
            {{ t('postgresConfig.noDatabases') }}
          </div>
          <div v-else class="divide-y divide-border">
            <div
              v-for="db in configInfo.databases"
              :key="db.name"
              class="p-4 hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors"
            >
              <div class="flex items-center justify-between gap-4">
                <div class="flex-1">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="font-semibold text-gray-900 dark:text-white">{{ db.name }}</span>
                    <span v-if="db.isActive" class="px-2 py-0.5 text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full">
                      {{ t('postgresConfig.active') }}
                    </span>
                  </div>
                  <div class="text-sm text-gray-500 space-y-1">
                    <div>{{ t('postgresConfig.owner') }}: {{ db.owner }}</div>
                    <div>{{ t('postgresConfig.size') }}: {{ db.size }}</div>
                    <div v-if="db.connections !== undefined && db.connections > 0" class="flex items-center gap-1">
                      <span class="w-2 h-2 rounded-full bg-green-500"></span>
                      {{ t('postgresConfig.connections') }}: {{ db.connections }}
                    </div>
                  </div>
                </div>
                <div class="flex items-center gap-2 flex-shrink-0">
                  <!-- Bouton Connexion : seulement si la base n'est pas déjà dans la config -->
                  <button
                    v-if="!isDatabaseInConfig(db.name, selectedPort)"
                    @click="testConnection(db.name)"
                    :disabled="isConnecting"
                    class="px-3 py-1.5 text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-lg hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                    :title="t('postgresConfig.connect')"
                  >
                    <svg v-if="isConnecting" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    {{ t('postgresConfig.connect') }}
                  </button>
                  <!-- Bouton Retirer de la liste : seulement si la base est dans la config -->
                  <button
                    v-if="isDatabaseInConfig(db.name, selectedPort)"
                    @click="removeDatabaseFromList(db.name)"
                    class="px-3 py-1.5 text-xs bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 rounded-lg hover:bg-yellow-200 dark:hover:bg-yellow-900/50 transition-colors flex items-center gap-1"
                    :title="t('postgresConfig.removeFromList')"
                  >
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                    </svg>
                    {{ t('postgresConfig.removeFromList') }}
                  </button>
                  <!-- Bouton Supprimer : désactivé pour les bases système -->
                  <button
                    v-if="!isSystemDatabase(db.name)"
                    @click="dropDatabase(db.name)"
                    class="px-3 py-1.5 text-xs bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded-lg hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors flex items-center gap-1"
                    :title="t('postgresConfig.drop')"
                  >
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    {{ t('postgresConfig.drop') }}
                  </button>
                  <div v-else class="px-3 py-1.5 text-xs bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded-lg flex items-center gap-1 cursor-not-allowed" :title="t('postgresConfig.systemDatabase')">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                    {{ t('postgresConfig.systemDatabase') }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Active Connections Section -->
      <div class="border border-gray-200 dark:border-zinc-700 rounded-xl overflow-hidden bg-white dark:bg-zinc-900">
        <button
          @click="expandedSections.connections = !expandedSections.connections"
          class="w-full px-4 py-3 bg-gray-50 dark:bg-zinc-800/50 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors flex items-center justify-between group"
        >
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
            </svg>
            <span class="text-sm font-medium text-gray-900 dark:text-white">{{ t('postgresConfig.activeConnections') }}</span>
            <span class="text-xs text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/30 px-2 py-0.5 rounded-full">
              {{ configInfo.activeConnections.length }}
            </span>
          </div>
          <svg 
            class="w-4 h-4 text-gray-400 dark:text-gray-500 transition-transform"
            :class="{ 'rotate-180': expandedSections.connections }"
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        
        <div v-if="expandedSections.connections" class="border-t border-border">
          <div v-if="configInfo.activeConnections.length === 0" class="p-8 text-center text-gray-500">
            {{ t('postgresConfig.noConnections') }}
          </div>
          <div v-else class="divide-y divide-border overflow-x-auto">
            <table class="w-full">
              <thead class="bg-surface">
                <tr>
                  <th class="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">{{ t('postgresConfig.pid') }}</th>
                  <th class="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">{{ t('postgresConfig.database') }}</th>
                  <th class="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">{{ t('postgresConfig.user') }}</th>
                  <th class="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">{{ t('postgresConfig.state') }}</th>
                  <th class="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">{{ t('postgresConfig.query') }}</th>
                  <th class="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">{{ t('postgresConfig.actions') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="conn in configInfo.activeConnections"
                  :key="conn.pid"
                  class="hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors"
                >
                  <td class="px-4 py-2 text-sm font-mono">{{ conn.pid }}</td>
                  <td class="px-4 py-2 text-sm">{{ conn.database }}</td>
                  <td class="px-4 py-2 text-sm">{{ conn.username }}</td>
                  <td class="px-4 py-2 text-sm">
                    <span :class="[
                      'px-2 py-1 text-xs rounded-full',
                      conn.state === 'active' ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' :
                      conn.state === 'idle' ? 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300' :
                      'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400'
                    ]">
                      {{ conn.state }}
                    </span>
                  </td>
                  <td class="px-4 py-2 text-sm font-mono text-gray-500 max-w-xs truncate" :title="conn.query">
                    {{ truncateQuery(conn.query) }}
                  </td>
                  <td class="px-4 py-2">
                    <button
                      @click="killConnection(conn.pid)"
                      class="px-3 py-1 text-xs bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded-lg hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors"
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

    <div v-else class="p-8 text-center text-gray-500">
      {{ t('postgresConfig.notAvailable') }}
    </div>

    <!-- Password Modal -->
    <div
      v-if="showPasswordModal"
      class="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      @click.self="cancelPasswordModal"
    >
      <div class="bg-white dark:bg-zinc-900 rounded-2xl p-6 border border-border shadow-2xl max-w-md w-full mx-4">
        <h3 class="text-lg font-semibold mb-4">{{ t('postgresConfig.passwordRequired') }}</h3>
        <p class="text-sm text-gray-500 mb-4">
          {{ t('postgresConfig.passwordRequiredMessage', { name: passwordModalDbName }) }}
        </p>
        <div class="mb-4">
          <label class="block text-sm font-medium mb-2">{{ t('postgresConfig.password') }}</label>
          <input
            v-model="passwordInput"
            type="password"
            class="w-full px-4 py-2 bg-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            :placeholder="t('postgresConfig.passwordPlaceholder')"
            @keyup.enter="testConnectionWithPassword"
            autofocus
          />
        </div>
        <div class="flex gap-3 justify-end">
          <button
            @click="cancelPasswordModal"
            class="px-4 py-2 bg-gray-100 dark:bg-zinc-800 hover:bg-gray-200 dark:hover:bg-zinc-700 rounded-lg text-sm font-medium transition-colors"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            @click="testConnectionWithPassword"
            :disabled="isConnecting || !passwordInput"
            class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
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
</template>


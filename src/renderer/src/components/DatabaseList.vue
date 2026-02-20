<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { ipcRenderer } from '../electron';
import { Database } from '../types';
import DatabaseCard from './DatabaseCard.vue';
import DuplicateDatabaseModal from './DuplicateDatabaseModal.vue';

const { t } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();

const hiddenDatabasesCount = ref(0);
const hiddenDatabases = ref<any[]>([]);
const isLoadingHiddenCount = ref(false);
const isImportingHidden = ref(false);

// Duplicate Modal State
const showDuplicateModal = ref(false);
const duplicateSourceDb = ref<Database | null>(null);

const loadHiddenDatabasesCount = async () => {
  try {
    isLoadingHiddenCount.value = true;
    const result = await ipcRenderer.invoke('get-postgres-config');
    if (result && result.databases) {
      const localDbs = store.databases.filter(db => db.isLocalBbdump);
      const localDbNames = new Set(localDbs.map(db => db.name));
      const postgresDbs = result.databases.filter((db: any) => 
        !db.name.startsWith('template') && 
        !localDbNames.has(db.name)
      );
      hiddenDatabases.value = postgresDbs;
      hiddenDatabasesCount.value = postgresDbs.length;
    }
  } catch (error) {
    console.error('Error loading hidden databases count:', error);
    hiddenDatabasesCount.value = 0;
  } finally {
    isLoadingHiddenCount.value = false;
  }
};

// Recharger le compteur quand les bases changent
watch(() => store.databases.length, () => {
  loadHiddenDatabasesCount();
});

onMounted(() => {
  loadHiddenDatabasesCount();
});

const openAddModal = () => {
  store.editingDatabase = null;
  store.showDatabaseModal = true;
};

const editDatabase = (db: Database) => {
  store.editingDatabase = JSON.parse(JSON.stringify(db)); // Deep copy
  store.showDatabaseModal = true;
};

const isSystemDatabase = (dbName: string) => {
  const systemDatabases = ['postgres', 'template0', 'template1'];
  return systemDatabases.includes(dbName);
};

const openDuplicateModal = (db: Database) => {
  duplicateSourceDb.value = db;
  showDuplicateModal.value = true;
};

const onDuplicateSuccess = async (newDbName: string) => {
    // Refresh config
    const config = await ipcRenderer.invoke('get-config');
    store.databases = config.databases;

    // Find the newly added DB by name to get its id
    const newDb = store.databases.find((d: any) => d.name === newDbName);
    if (newDb) {
      store.newlyAddedDbId = newDb.id;
      setTimeout(() => {
        store.newlyAddedDbId = null;
      }, 2000);
    }
}

const importAllHidden = async () => {
  if (hiddenDatabases.value.length === 0) return;
  
  try {
    isImportingHidden.value = true;
    
    for (const db of hiddenDatabases.value) {
      await ipcRenderer.invoke('add-database', {
        name: db.name,
        displayName: db.name,
        host: 'localhost',
        port: 5432,
        user: db.owner || 'postgres',
        password: '',
        encrypted: true,
        encryptBackups: false,
        cron: '',
        output: '',
        enabled: false,
        ssl: false,
        isLocalBbdump: true
      });
    }
    
    addToast(t('databases.importSuccess'), 'success');
    
    // Refresh config
    const config = await ipcRenderer.invoke('get-config');
    store.databases = config.databases;
    
    await loadHiddenDatabasesCount();
  } catch (error: any) {
    addToast('Error importing databases: ' + error.message, 'error');
  } finally {
    isImportingHidden.value = false;
  }
};

const deleteDatabase = (db: Database) => {
  if (isSystemDatabase(db.name)) {
    addToast(t('databases.cannotDeleteSystemDatabase', { name: db.name }), 'error');
    return;
  }
  
  const isLocal = db.isLocalBbdump;
  const confirmMessage = isLocal 
    ? t('modal.deleteConfirm', { name: db.name })
    : t('modal.deleteConnectionConfirm', { name: db.name });
  
  showConfirm({
    title: isLocal ? t('modal.deleteTitle') : t('modal.deleteConnectionTitle'),
    message: confirmMessage,
    confirmText: t('modal.deleteButton'),
    type: 'danger',
      onConfirm: async () => {
        try {
          if (isLocal) {
            const result = await ipcRenderer.invoke('drop-postgres-database', db.name, db.port, true);
            if (!result.success) {
              const isNotFoundError = result.error && (
                result.error.includes('does not exist') || 
                result.error.includes('n\'existe pas')
              );
              
              if (isNotFoundError) {
                addToast(t('databases.dbAlreadyDeleted', { name: db.name }), 'warning');
              } else {
                addToast(result.error || t('postgresConfig.dropError'), 'warning');
              }
            }
          }
          
          await ipcRenderer.invoke('remove-database', db.id);
          const config = await ipcRenderer.invoke('get-config');
          store.databases = config.databases;
          addToast(isLocal ? t('toasts.dbDeleted') : t('toasts.connectionDeleted'), 'success');
        } catch (error: any) {
          addToast('Error deleting database: ' + error.message, 'error');
        }
      }
  });
};

const backupNow = async (db: Database) => {
  try {
    store.isBackingUp = true;
    await ipcRenderer.invoke('backup-now', db.id);
  } catch (error: any) {
    store.isBackingUp = false;
    addToast('Error starting backup: ' + error.message, 'error');
  }
};

const openViewer = (db: Database) => {
  store.viewerDb = db;
  store.showDbViewer = true;
};

const copyConnectionUrl = async (db: Database) => {
  let url: string;
  if (db.connectionString) {
    // Use the existing connection string if available
    url = db.connectionString;
  } else if (db.isLocalBbdump && window.electron?.platform === 'linux') {
    // On Linux, local databases use peer auth via Unix socket
    url = `postgresql://${db.user}@/${db.name}?host=/var/run/postgresql&port=${db.port}`;
  } else {
    url = `postgresql://${db.user}@${db.host}:${db.port}/${db.name}`;
  }
  try {
    await navigator.clipboard.writeText(url);
    addToast(t('databases.urlCopied'), 'success');
  } catch (error) {
    addToast('Failed to copy URL', 'error');
  }
};

const openPostgresSettings = () => {
  store.activeTab = 'settings';
  setTimeout(() => {
    const postgresConfigElement = document.querySelector('[data-postgres-config]');
    if (postgresConfigElement) {
      postgresConfigElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, 300);
};

const disconnectDatabase = async (db: Database) => {
  showConfirm({
    title: t('databases.disconnectTitle'),
    message: t('databases.disconnectMessage', { name: db.name }),
    confirmText: t('databases.disconnect'),
    type: 'warning',
    onConfirm: async () => {
      try {
        await ipcRenderer.invoke('remove-database', db.id);
        const config = await ipcRenderer.invoke('get-config');
        store.databases = config.databases;
        addToast(
          t('databases.databaseRemovedFromList', { name: db.name }),
          'success'
        );
      } catch (error: any) {
        addToast(`Error removing database from list: ${error.message}`, 'error');
      }
    }
  });
};

const scrollToExternal = () => {
  const externalSection = document.querySelector('[data-external-connections]');
  if (externalSection) {
    externalSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
};

const toggleMask = async (db: Database) => {
  try {
    await ipcRenderer.invoke('toggle-mask', db.id, !db.masked);
    const config = await ipcRenderer.invoke('get-config');
    store.databases = config.databases;
  } catch (error: any) {
    addToast('Error toggling mask: ' + error.message, 'error');
  }
};

const openExtensions = (db: Database) => {
  store.extensionsModalDb = db;
  store.showExtensionsModal = true;
};
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="flex justify-between items-center mb-8">
      <div>
        <h2 class="text-3xl font-bold tracking-tight">{{ t('nav.databases') }}</h2>
        <p class="text-gray-500 mt-1">{{ store.databases.length }} configured connections</p>
      </div>
      <div class="flex gap-3">
        <!-- Bouton Créer une base -->
        <button
          @click="store.showCreateDatabaseModal = true"
          class="group relative overflow-hidden bg-gradient-to-br from-blue-600 via-blue-500 to-indigo-600 text-white px-4 py-2 rounded-xl text-sm font-medium shadow-lg shadow-blue-500/30 hover:shadow-xl hover:shadow-blue-500/40 transition-all duration-300 flex items-center gap-2 hover:scale-[1.02] active:scale-[0.98]"
        >
          <div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700"></div>
          <div class="relative z-10 flex items-center justify-center w-4 h-4">
            <svg class="w-4 h-4 transform group-hover:rotate-90 transition-transform duration-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
          </div>
          <span class="relative z-10">{{ t('modal.createDatabase') }}</span>
          <div class="absolute inset-0 rounded-xl bg-gradient-to-r from-blue-400/0 via-blue-400/50 to-blue-400/0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 blur-sm"></div>
        </button>
        
        <!-- Bouton Ajouter une connexion -->
        <button
          @click="openAddModal"
          class="group relative overflow-hidden bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 dark:from-gray-100 dark:via-gray-50 dark:to-gray-100 text-white dark:text-gray-900 px-4 py-2 rounded-xl text-sm font-medium shadow-lg shadow-gray-900/20 dark:shadow-gray-100/20 hover:shadow-xl hover:shadow-gray-900/30 dark:hover:shadow-gray-100/30 transition-all duration-300 flex items-center gap-2 hover:scale-[1.02] active:scale-[0.98] border border-gray-700/20 dark:border-gray-300/20"
        >
          <div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 dark:via-gray-900/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700"></div>
          <div class="relative z-10 flex items-center justify-center w-4 h-4">
            <svg class="w-4 h-4 transform group-hover:scale-110 transition-transform duration-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </div>
          <span class="relative z-10">{{ t('modal.addDatabase') }}</span>
          <div class="absolute inset-0 rounded-xl bg-gradient-to-r from-gray-400/0 via-gray-400/30 to-gray-400/0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 blur-sm"></div>
        </button>
      </div>
    </div>

    <div v-if="store.databases.length === 0" class="flex-1 flex flex-col items-center justify-center text-center opacity-60">
      <div class="w-24 h-24 bg-surface rounded-full flex items-center justify-center mb-4">
        <svg class="w-12 h-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
        </svg>
      </div>
      <h3 class="text-xl font-medium mb-2">{{ t('db.noDatabases') }}</h3>
      <p class="text-gray-500 max-w-sm">{{ t('db.noDatabasesDesc') }}</p>
    </div>

    <div v-else class="space-y-8 pb-8">
      <!-- Bases de données locales Bbdump -->
      <div v-if="store.databases.filter(db => db.isLocalBbdump).length > 0">
        <!-- Lien vers connexions externes si > 3 bases locales -->
        <div v-if="store.databases.filter(db => db.isLocalBbdump).length > 3 && store.databases.filter(db => !db.isLocalBbdump).length > 0" class="flex justify-start mb-4">
          <button 
            @click="scrollToExternal"
            class="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 flex items-center gap-1.5 group transition-colors px-1"
          >
            <span>{{ t('databases.scrollToExternal') }}</span>
            <svg class="w-3.5 h-3.5 transform group-hover:translate-y-0.5 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
        
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center gap-3">
            <div class="flex items-center gap-2">
              <svg class="w-5 h-5 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
              </svg>
              <h3 class="text-lg font-semibold text-gray-700 dark:text-gray-300">{{ t('databases.localDatabases') }}</h3>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs font-medium text-gray-600 dark:text-gray-400 bg-blue-50 dark:bg-blue-900/20 px-2.5 py-1 rounded-full border border-blue-200 dark:border-blue-800">
                {{ store.databases.filter(db => db.isLocalBbdump).length }}
              </span>
              <button
                @click="openPostgresSettings"
                class="group relative p-2 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-all duration-200 hover:scale-110"
                :title="t('databases.postgresSettings')"
              >
                <svg class="w-5 h-5 transition-transform duration-200 group-hover:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
              <button
                v-if="hiddenDatabasesCount > 0"
                @click="importAllHidden"
                :disabled="isImportingHidden"
                class="group inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-500/15 hover:bg-amber-200 dark:hover:bg-amber-500/25 border border-amber-200 dark:border-amber-500/30 rounded-full transition-all disabled:opacity-50 disabled:cursor-not-allowed ml-1"
                :title="t('databases.importHidden')"
              >
                <svg v-if="isImportingHidden" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <svg v-else class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                  <path fill-rule="evenodd" d="m18.922 16.8l3.17 3.17l-1.06 1.061L4.06 4.061L5.12 3l2.74 2.738A11.9 11.9 0 0 1 12 5c4.808 0 8.972 2.848 11 7a12.66 12.66 0 0 1-4.078 4.8m-8.098-8.097l4.473 4.473a3.5 3.5 0 0 0-4.474-4.474zm5.317 9.56A11.9 11.9 0 0 1 12 19c-4.808 0-8.972-2.848-11-7a12.66 12.66 0 0 1 4.078-4.8l3.625 3.624a3.5 3.5 0 0 0 4.474 4.474l2.964 2.964z" />
                </svg>
                {{ hiddenDatabasesCount }} {{ t('databases.hiddenDatabases') }}
              </button>
            </div>
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <DatabaseCard 
            v-for="db in store.databases.filter(db => db.isLocalBbdump)"
            :key="db.id"
            :db="db"
            @backup="backupNow"
            @view="openViewer"
            @duplicate="openDuplicateModal"
            @edit="editDatabase"
            @delete="deleteDatabase"
            @disconnect="disconnectDatabase"
            @copy-url="copyConnectionUrl"
            @addons="openExtensions"
            @toggle-mask="toggleMask"
          />
        </div>
      </div>

      <!-- Connexions externes -->
      <div v-if="store.databases.filter(db => !db.isLocalBbdump).length > 0" data-external-connections>
        <div class="flex items-center gap-3 mb-4">
          <div class="flex items-center gap-2">
            <svg class="w-5 h-5 text-gray-600 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
            </svg>
            <h3 class="text-lg font-semibold text-gray-700 dark:text-gray-300">{{ t('databases.externalConnections') }}</h3>
          </div>
          <span class="text-xs text-gray-500 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded-full">
            {{ store.databases.filter(db => !db.isLocalBbdump).length }}
          </span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <DatabaseCard 
            v-for="db in store.databases.filter(db => !db.isLocalBbdump)"
            :key="db.id"
            :db="db"
            @backup="backupNow"
            @view="openViewer"
            @duplicate="openDuplicateModal"
            @edit="editDatabase"
            @delete="deleteDatabase"
            @disconnect="disconnectDatabase"
            @copy-url="copyConnectionUrl"
            @addons="openExtensions"
            @toggle-mask="toggleMask"
          />
        </div>
      </div>
    </div>

    <!-- Duplicate to Local Modal -->
    <DuplicateDatabaseModal 
        v-if="showDuplicateModal"
        v-model="showDuplicateModal"
        :sourceDb="duplicateSourceDb"
        @success="onDuplicateSuccess"
    />
  </div>
</template>

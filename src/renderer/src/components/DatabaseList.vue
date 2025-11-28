<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { ipcRenderer } from '../electron';
import { Database } from '../types';
import BackupAnimation from './BackupAnimation.vue';
import NewDbAnimation from './NewDbAnimation.vue';
import PrerequisitesLoader from './PrerequisitesLoader.vue';

const { t } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();

const hiddenDatabasesCount = ref(0);
const isLoadingHiddenCount = ref(false);

const loadHiddenDatabasesCount = async () => {
  try {
    isLoadingHiddenCount.value = true;
    const result = await ipcRenderer.invoke('get-postgres-config');
    if (result.success && result.databases) {
      const localDbs = store.databases.filter(db => db.isLocalBbdump);
      const localDbNames = new Set(localDbs.map(db => db.name));
      const postgresDbs = result.databases.filter((db: any) => 
        !db.name.startsWith('template') && 
        db.name !== 'postgres' && 
        !localDbNames.has(db.name)
      );
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
watch(() => store.databases, () => {
  loadHiddenDatabasesCount();
}, { deep: true });

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

const showDuplicateModal = ref(false);
const duplicateSourceDb = ref<Database | null>(null);
const duplicateForm = ref({
  name: '',
  password: ''
});
const isDuplicating = ref(false);
const duplicateProgress = ref<{ step: string; message: string; progress: number } | null>(null);

const openDuplicateModal = (db: Database) => {
  duplicateSourceDb.value = db;
  duplicateForm.value = {
    name: `${db.name}_local`,
    password: ''
  };
  showDuplicateModal.value = true;
};

const duplicateToLocal = async () => {
  if (!duplicateSourceDb.value) return;
  
  if (!duplicateForm.value.name || duplicateForm.value.name.trim() === '') {
    addToast(t('databases.duplicateNameRequired'), 'error');
    return;
  }
  
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(duplicateForm.value.name)) {
    addToast(t('databases.duplicateNameInvalid'), 'error');
    return;
  }
  
  isDuplicating.value = true;
  duplicateProgress.value = { step: 'backup', message: t('databases.duplicateStepBackup'), progress: 0 };
  
  try {
    // Créer un objet simple sérialisable pour éviter les erreurs de clonage IPC
    const sourceDb = duplicateSourceDb.value;
    const sourceDbConfig = {
      name: sourceDb.name,
      displayName: sourceDb.displayName,
      host: sourceDb.host,
      port: sourceDb.port,
      user: sourceDb.user,
      password: sourceDb.password || '',
      encrypted: sourceDb.encrypted || false,
      encryptBackups: sourceDb.encryptBackups || false,
      cron: sourceDb.cron || '0 0 * * *',
      output: sourceDb.output || '',
      enabled: sourceDb.enabled || false,
      ssl: sourceDb.ssl || false,
      connectionString: sourceDb.connectionString,
      isLocalBbdump: sourceDb.isLocalBbdump || false
    };
    
    // Écouter les événements de progression
    const progressHandler = (progress: { step: string; message: string; progress: number }) => {
      duplicateProgress.value = progress;
    };
    
    ipcRenderer.on('duplicate-progress', progressHandler);
    
    const result = await ipcRenderer.invoke('duplicate-external-to-local', {
      sourceDb: sourceDbConfig,
      targetName: duplicateForm.value.name.trim(),
      targetPassword: duplicateForm.value.password || undefined,
      targetPort: 5432
    });
    
    ipcRenderer.removeListener('duplicate-progress', progressHandler);
    
    if (result.success) {
      addToast(t('databases.duplicateSuccess', { name: duplicateForm.value.name }), 'success');
      showDuplicateModal.value = false;
      duplicateSourceDb.value = null;
      isDuplicating.value = false;
      duplicateProgress.value = null;
      
      // Rafraîchir la liste des bases de données
      const config = await ipcRenderer.invoke('get-config');
      store.databases = config.databases;
      
      // Highlight la nouvelle base
      store.newlyAddedDbName = duplicateForm.value.name;
      setTimeout(() => {
        store.newlyAddedDbName = null;
      }, 2000);
    } else {
      addToast(result.error || t('databases.duplicateError'), 'error');
      isDuplicating.value = false;
      duplicateProgress.value = null;
    }
  } catch (error: any) {
    addToast(`Error duplicating database: ${error.message}`, 'error');
    isDuplicating.value = false;
    duplicateProgress.value = null;
  }
};

const deleteDatabase = (db: Database) => {
  // Empêcher la suppression des bases système
  if (isSystemDatabase(db.name)) {
    addToast(t('databases.cannotDeleteSystemDatabase', { name: db.name }), 'error');
    return;
  }
  
  // Message différent selon le type de base
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
          // Si c'est une base locale, essayer de supprimer complètement de PostgreSQL
          if (isLocal) {
            const result = await ipcRenderer.invoke('drop-postgres-database', db.name, db.port, true);
            if (!result.success) {
              // Si la base n'existe plus dans PostgreSQL, on continue quand même à la supprimer de la config
              const isNotFoundError = result.error && (
                result.error.includes('does not exist') || 
                result.error.includes('n\'existe pas')
              );
              
              if (isNotFoundError) {
                // La base n'existe plus dans PostgreSQL, on peut juste la retirer de la config
                addToast(t('databases.dbAlreadyDeleted', { name: db.name }), 'warning');
              } else {
                // Autre erreur, afficher l'erreur mais continuer quand même à retirer de la config
                addToast(result.error || t('postgresConfig.dropError'), 'warning');
              }
            }
          }
          
          // Toujours retirer de la configuration de l'application, même si la suppression PostgreSQL a échoué
          await ipcRenderer.invoke('remove-database', db.name);
          const config = await ipcRenderer.invoke('get-config');
          store.databases = config.databases;
          addToast(isLocal ? t('toasts.dbDeleted') : t('toasts.connectionDeleted'), 'success');
        } catch (error: any) {
          addToast('Error deleting database: ' + error.message, 'error');
        }
      }
  });
};

const toggleSchedule = async (db: Database) => {
  try {
    await ipcRenderer.invoke('toggle-schedule', db.name, !db.enabled);
    const config = await ipcRenderer.invoke('get-config');
    store.databases = config.databases;
    addToast(db.enabled ? 'Schedule paused' : 'Schedule enabled', 'info');
  } catch (error: any) {
    addToast('Error toggling schedule: ' + error.message, 'error');
  }
};

const backupNow = async (db: Database) => {
  try {
    store.isBackingUp = true;
    // store.showBackupModal = true; // Removed in favor of card animation
    await ipcRenderer.invoke('backup-now', db.name);
    // Success/Error handled by global listener in App.vue
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
  const url = `postgresql://${db.user}@${db.host}:${db.port}/${db.name}`;
  try {
    await navigator.clipboard.writeText(url);
    addToast(t('databases.urlCopied'), 'success');
  } catch (error) {
    addToast('Failed to copy URL', 'error');
  }
};

const openPostgresSettings = () => {
  store.activeTab = 'settings';
  // Scroll vers PostgresConfig après un court délai pour laisser le temps au composant de se charger
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
        // Retirer la base de la configuration de l'application (sans la supprimer de PostgreSQL)
        await ipcRenderer.invoke('remove-database', db.name);
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
          <!-- Effet de brillance au survol -->
          <div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700"></div>
          
          <!-- Icône avec animation -->
          <div class="relative z-10 flex items-center justify-center w-4 h-4">
            <svg class="w-4 h-4 transform group-hover:rotate-90 transition-transform duration-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
          </div>
          
          <span class="relative z-10">{{ t('databases.createButton') }}</span>
          
          <!-- Effet de bordure lumineuse -->
          <div class="absolute inset-0 rounded-xl bg-gradient-to-r from-blue-400/0 via-blue-400/50 to-blue-400/0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 blur-sm"></div>
        </button>
        
        <!-- Bouton Ajouter une connexion -->
        <button
          @click="openAddModal"
          class="group relative overflow-hidden bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 dark:from-gray-100 dark:via-gray-50 dark:to-gray-100 text-white dark:text-gray-900 px-4 py-2 rounded-xl text-sm font-medium shadow-lg shadow-gray-900/20 dark:shadow-gray-100/20 hover:shadow-xl hover:shadow-gray-900/30 dark:hover:shadow-gray-100/30 transition-all duration-300 flex items-center gap-2 hover:scale-[1.02] active:scale-[0.98] border border-gray-700/20 dark:border-gray-300/20"
        >
          <!-- Effet de brillance au survol -->
          <div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 dark:via-gray-900/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700"></div>
          
          <!-- Icône avec animation -->
          <div class="relative z-10 flex items-center justify-center w-4 h-4">
            <svg class="w-4 h-4 transform group-hover:scale-110 transition-transform duration-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </div>
          
          <span class="relative z-10">{{ t('modal.addDatabase') }}</span>
          
          <!-- Effet de bordure lumineuse -->
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
              <div v-if="hiddenDatabasesCount > 0" class="flex items-center gap-1.5">
                <span class="text-xs font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-2.5 py-1 rounded-full border border-amber-200 dark:border-amber-800 flex items-center gap-1.5">
                  <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {{ hiddenDatabasesCount }} {{ t('databases.hiddenDatabases') }}
                </span>
              </div>
            </div>
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <div
            v-for="db in store.databases.filter(db => db.isLocalBbdump)"
            :key="db.name"
            v-motion
            :initial="{ opacity: 0, y: 50 }"
            :enter="{ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 100, damping: 15 } }"
            class="group relative bg-white dark:bg-zinc-900 rounded-2xl p-6 border-2 border-blue-200 dark:border-blue-800 hover:border-blue-400 dark:hover:border-blue-600 transition-all duration-500 hover:shadow-2xl hover:-translate-y-2"
            style="transform-style: preserve-3d;"
          >
            <!-- Status Indicator -->
            <div class="absolute top-6 right-6 flex gap-2 items-center">
              <div 
                :class="[
                  'w-3 h-3 rounded-full shadow-sm',
                  db.enabled ? 'bg-green-500 shadow-green-500/50' : 'bg-gray-300 dark:bg-gray-600'
                ]"
                :title="db.enabled ? 'Backup Enabled' : 'Backup Paused'"
              ></div>
            </div>
            
            <!-- Local Badge -->
            <div class="absolute top-6 left-6">
              <span class="px-2 py-1 text-xs font-semibold bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 rounded-lg flex items-center gap-1">
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                {{ t('databases.localBbdump') }}
              </span>
            </div>

            <!-- Animation Overlay (covers entire card) -->
            <div v-if="store.newlyAddedDbName === db.name" class="absolute inset-0 z-50 rounded-2xl overflow-hidden pointer-events-none">
              <NewDbAnimation />
            </div>

            <!-- Content -->
            <div v-if="store.backupProgress?.dbName === db.name" class="h-32 mb-6 flex items-center justify-center mt-8">
              <BackupAnimation />
            </div>

            <div v-else class="mb-6 mt-8">
              <div class="flex items-center gap-2 mb-1">
                <h3 class="text-xl font-bold truncate pr-8">{{ db.displayName || db.name }}</h3>
              </div>
              <div class="flex items-center text-sm text-gray-500 mt-1 font-mono">
                <span class="truncate max-w-[150px]">{{ db.user }}@{{ db.host }}:{{ db.port }}</span>
                <button
                  @click="copyConnectionUrl(db)"
                  class="ml-2 p-1 hover:bg-surface rounded transition-colors"
                  :title="t('databases.copyUrl')"
                >
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
              </div>
              <div class="mt-4 flex items-center gap-2 text-xs font-medium px-3 py-1 bg-surface rounded-full w-fit">
                <span class="text-gray-400">{{ t('databases.lastBackup') }}:</span>
                <span>{{ db.lastBackup ? new Date(db.lastBackup).toLocaleDateString() : t('databases.never') }}</span>
              </div>
            </div>

            <!-- Actions (Reveal on Hover) -->
            <div class="grid grid-cols-5 gap-2 pt-4 border-t border-border opacity-80 group-hover:opacity-100 transition-opacity">
              <button
                @click="backupNow(db)"
                class="relative p-2 rounded-lg hover:bg-surface text-gray-500 hover:text-foreground transition-colors flex flex-col items-center gap-1 group/btn"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                </svg>
                <span class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 text-xs font-medium text-white bg-gray-900 dark:bg-gray-700 rounded-md whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity pointer-events-none z-50 shadow-lg">
                  {{ t('db.backupNow') }}
                  <span class="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-gray-900 dark:border-t-gray-700"></span>
                </span>
              </button>
              
              <button
                @click="openViewer(db)"
                class="relative p-2 rounded-lg hover:bg-surface text-gray-500 hover:text-foreground transition-colors flex flex-col items-center gap-1 group/btn"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                <span class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 text-xs font-medium text-white bg-gray-900 dark:bg-gray-700 rounded-md whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity pointer-events-none z-50 shadow-lg">
                  {{ t('db.viewData') }}
                  <span class="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-gray-900 dark:border-t-gray-700"></span>
                </span>
              </button>

              <button
                v-if="db.isLocalBbdump"
                @click="disconnectDatabase(db)"
                class="relative p-2 rounded-lg hover:bg-yellow-50 dark:hover:bg-yellow-900/20 text-gray-500 hover:text-yellow-600 dark:hover:text-yellow-400 transition-colors flex flex-col items-center gap-1 group/btn"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
                <span class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 text-xs font-medium text-white bg-gray-900 dark:bg-gray-700 rounded-md whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity pointer-events-none z-50 shadow-lg">
                  {{ t('databases.removeFromList') }}
                  <span class="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-gray-900 dark:border-t-gray-700"></span>
                </span>
              </button>

              <button
                @click="editDatabase(db)"
                class="relative p-2 rounded-lg hover:bg-surface text-gray-500 hover:text-foreground transition-colors flex flex-col items-center gap-1 group/btn"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                <span class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 text-xs font-medium text-white bg-gray-900 dark:bg-gray-700 rounded-md whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity pointer-events-none z-50 shadow-lg">
                  {{ t('db.edit') }}
                  <span class="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-gray-900 dark:border-t-gray-700"></span>
                </span>
              </button>

              <button
                @click="deleteDatabase(db)"
                class="relative p-2 rounded-lg hover:bg-red-50 text-gray-500 hover:text-red-600 transition-colors flex flex-col items-center gap-1 group/btn"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                <span class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 text-xs font-medium text-white bg-gray-900 dark:bg-gray-700 rounded-md whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity pointer-events-none z-50 shadow-lg">
                  {{ t('db.delete') }}
                  <span class="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-gray-900 dark:border-t-gray-700"></span>
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Connexions externes -->
      <div v-if="store.databases.filter(db => !db.isLocalBbdump).length > 0">
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
          <div
            v-for="db in store.databases.filter(db => !db.isLocalBbdump)"
            :key="db.name"
            v-motion
            :initial="{ opacity: 0, y: 50 }"
            :enter="{ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 100, damping: 15 } }"
            class="group relative bg-white dark:bg-zinc-900 rounded-2xl p-6 border border-border hover:border-foreground/20 transition-all duration-500 hover:shadow-2xl hover:-translate-y-2"
            style="transform-style: preserve-3d;"
          >
            <!-- Status Indicator -->
            <div class="absolute top-6 right-6 flex gap-2">
              <div 
                :class="[
                  'w-3 h-3 rounded-full shadow-sm',
                  db.enabled ? 'bg-green-500 shadow-green-500/50' : 'bg-gray-300 dark:bg-gray-600'
                ]"
                :title="db.enabled ? 'Backup Enabled' : 'Backup Paused'"
              ></div>
            </div>

            <!-- Animation Overlay (covers entire card) -->
            <div v-if="store.newlyAddedDbName === db.name" class="absolute inset-0 z-50 rounded-2xl overflow-hidden pointer-events-none">
              <NewDbAnimation />
            </div>

            <!-- Content -->
            <div v-if="store.backupProgress?.dbName === db.name" class="h-32 mb-6 flex items-center justify-center">
              <BackupAnimation />
            </div>

            <div v-else class="mb-6">
              <div class="flex items-center gap-2 mb-1">
                <h3 class="text-xl font-bold truncate pr-8">{{ db.displayName || db.name }}</h3>
              </div>
              <div class="flex items-center text-sm text-gray-500 mt-1 font-mono">
                <span class="truncate max-w-[150px]">{{ db.user }}@{{ db.host }}:{{ db.port }}</span>
              </div>
              <div class="mt-4 flex items-center gap-2 text-xs font-medium px-3 py-1 bg-surface rounded-full w-fit">
                <span class="text-gray-400">{{ t('databases.lastBackup') }}:</span>
                <span>{{ db.lastBackup ? new Date(db.lastBackup).toLocaleDateString() : t('databases.never') }}</span>
              </div>
            </div>

            <!-- Actions (Reveal on Hover) -->
            <div class="grid grid-cols-5 gap-2 pt-4 border-t border-border opacity-80 group-hover:opacity-100 transition-opacity">
              <button
                @click="backupNow(db)"
                class="relative p-2 rounded-lg hover:bg-surface text-gray-500 hover:text-foreground transition-colors flex flex-col items-center gap-1 group/btn"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                </svg>
                <span class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 text-xs font-medium text-white bg-gray-900 dark:bg-gray-700 rounded-md whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity pointer-events-none z-50 shadow-lg">
                  {{ t('db.backupNow') }}
                  <span class="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-gray-900 dark:border-t-gray-700"></span>
                </span>
              </button>
              
              <button
                @click="openViewer(db)"
                class="relative p-2 rounded-lg hover:bg-surface text-gray-500 hover:text-foreground transition-colors flex flex-col items-center gap-1 group/btn"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                <span class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 text-xs font-medium text-white bg-gray-900 dark:bg-gray-700 rounded-md whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity pointer-events-none z-50 shadow-lg">
                  {{ t('db.viewData') }}
                  <span class="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-gray-900 dark:border-t-gray-700"></span>
                </span>
              </button>

              <button
                @click="openDuplicateModal(db)"
                class="relative p-2 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors flex flex-col items-center gap-1 group/btn"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                </svg>
                <span class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 text-xs font-medium text-white bg-gray-900 dark:bg-gray-700 rounded-md whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity pointer-events-none z-50 shadow-lg">
                  {{ t('databases.duplicateToLocal') }}
                  <span class="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-gray-900 dark:border-t-gray-700"></span>
                </span>
              </button>

              <button
                @click="editDatabase(db)"
                class="relative p-2 rounded-lg hover:bg-surface text-gray-500 hover:text-foreground transition-colors flex flex-col items-center gap-1 group/btn"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                <span class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 text-xs font-medium text-white bg-gray-900 dark:bg-gray-700 rounded-md whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity pointer-events-none z-50 shadow-lg">
                  {{ t('db.edit') }}
                  <span class="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-gray-900 dark:border-t-gray-700"></span>
                </span>
              </button>

              <button
                @click="deleteDatabase(db)"
                class="relative p-2 rounded-lg hover:bg-red-50 text-gray-500 hover:text-red-600 transition-colors flex flex-col items-center gap-1 group/btn"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                <span class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 text-xs font-medium text-white bg-gray-900 dark:bg-gray-700 rounded-md whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity pointer-events-none z-50 shadow-lg">
                  {{ t('db.delete') }}
                  <span class="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-gray-900 dark:border-t-gray-700"></span>
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Duplicate to Local Modal -->
    <Transition
      enter-active-class="transition duration-300 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-200 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div v-if="showDuplicateModal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
        <div 
          class="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl max-w-md w-full border border-border overflow-hidden"
          @click.stop
        >
          <!-- Header -->
          <div class="px-6 py-4 border-b border-border flex justify-between items-center bg-surface">
            <div>
              <h3 class="text-lg font-semibold">{{ t('databases.duplicateToLocalTitle') }}</h3>
              <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">{{ t('databases.duplicateToLocalDesc', { name: duplicateSourceDb?.name }) }}</p>
            </div>
            <button 
              @click="showDuplicateModal = false" 
              :disabled="isDuplicating"
              class="text-gray-500 hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          
          <!-- Content -->
          <div class="p-6 space-y-4">
            <!-- Loading State -->
            <div v-if="isDuplicating" class="flex flex-col items-center justify-center py-8">
              <div class="w-full h-48 mb-4">
                <PrerequisitesLoader />
              </div>
              <div class="w-full space-y-2">
                <div class="flex items-center justify-between mb-2">
                  <span class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ duplicateProgress?.message || t('databases.duplicating') }}</span>
                  <span class="text-xs text-gray-500">{{ duplicateProgress?.progress || 0 }}%</span>
                </div>
                <div class="w-full bg-gray-200 dark:bg-zinc-700 rounded-full h-2">
                  <div 
                    class="bg-blue-600 h-2 rounded-full transition-all duration-300"
                    :style="{ width: `${duplicateProgress?.progress || 0}%` }"
                  ></div>
                </div>
              </div>
            </div>

            <!-- Form -->
            <div v-else>
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  {{ t('database.name') }} *
                </label>
                <input
                  v-model="duplicateForm.name"
                  type="text"
                  class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
                  :placeholder="t('database.namePlaceholder')"
                />
                <p class="text-xs text-gray-500 mt-1">{{ t('createDatabase.nameHint') }}</p>
              </div>

              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  {{ t('database.password') }} ({{ t('common.optional') }})
                </label>
                <input
                  v-model="duplicateForm.password"
                  type="password"
                  class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
                  :placeholder="t('database.password')"
                />
                <p class="text-xs text-gray-500 mt-1">{{ t('databases.duplicatePasswordHint') }}</p>
              </div>

              <div class="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800">
                <div class="flex items-start gap-2">
                  <svg class="w-4 h-4 text-blue-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p class="text-xs text-blue-700 dark:text-blue-300">{{ t('databases.duplicateInfo') }}</p>
                </div>
              </div>
            </div>
          </div>
          
          <!-- Footer -->
          <div class="bg-surface px-6 py-4 flex justify-end gap-3 border-t border-border">
            <button
              @click="showDuplicateModal = false"
              :disabled="isDuplicating"
              class="px-4 py-2 rounded-xl text-gray-600 hover:bg-white dark:hover:bg-zinc-800 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              @click="duplicateToLocal"
              :disabled="isDuplicating"
              class="px-6 py-2 rounded-xl bg-foreground text-background hover:bg-zinc-800 transition-colors font-medium flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg v-if="isDuplicating" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
              </svg>
              {{ t('databases.duplicate') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

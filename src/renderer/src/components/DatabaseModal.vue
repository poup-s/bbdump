<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';
import { Database } from '../types';

const { t } = useI18n();
const { addToast } = useToast();

const isEditing = computed(() => !!store.editingDatabase);
const isLoading = ref(false);
const connectionMode = ref<'manual' | 'url'>('url'); // Default to URL mode
const connectionUrl = ref('');

const form = ref<Database>({
  name: '',
  displayName: '',
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: '',
  output: '',
  cron: '0 0 * * *',
  enabled: true,
  encryptBackups: false,
  connectionString: '',
  ssl: false
});

const passwordVisible = ref(false);

watch(() => store.showDatabaseModal, async (show) => {
  if (show) {
    if (store.editingDatabase) {
      form.value = { ...store.editingDatabase };
      // If we have a connection string, switch to URL mode
      if (form.value.connectionString) {
        connectionMode.value = 'url';
        connectionUrl.value = form.value.connectionString;
      } else {
        connectionMode.value = 'manual';
        connectionUrl.value = '';
      }
    } else {
      // Get default path from settings
      let defaultPath = '';
      try {
        defaultPath = await ipcRenderer.invoke('get-default-path');
      } catch (e) {
        console.error('Failed to get default path', e);
      }

      form.value = {
        name: '',
        displayName: '',
        host: 'localhost',
        port: 5432,
        user: 'postgres',
        password: '',
        output: defaultPath,
        cron: '0 0 * * *',
        enabled: true,
        encryptBackups: false,
        connectionString: '',
        ssl: false
      };
      connectionMode.value = 'url'; // Default to URL mode for new databases
      connectionUrl.value = '';
    }
  }
});

const parseConnectionUrl = (url: string) => {
  try {
    // Basic regex for postgresql://user:password@host:port/dbname?params
    const regex = /postgresql:\/\/(?:([^:]+)(?::([^@]*))?@)?([^:/]+)(?::(\d+))?(?:\/([^?]+))?(?:\?(.*))?/;
    const match = url.match(regex);

    if (match) {
      const [_, user, password, host, port, dbname] = match;
      
      if (user) form.value.user = user;
      if (password) form.value.password = password;
      if (host) form.value.host = host;
      if (port) form.value.port = parseInt(port);
      if (dbname) form.value.name = dbname;
      
      // Check for sslmode=require in query params
      const query = match[6];
      if (query && query.includes('sslmode=require')) {
        form.value.ssl = true;
      } else {
        form.value.ssl = false;
      }

      // We don't automatically set display name, output, etc.
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
};

watch(connectionUrl, (newUrl) => {
  if (connectionMode.value === 'url' && newUrl) {
    parseConnectionUrl(newUrl);
    form.value.connectionString = newUrl;
  }
});

const selectOutput = async () => {
  const path = await ipcRenderer.invoke('select-directory');
  if (path) {
    form.value.output = path;
  }
};

const save = async () => {
  // If in URL mode, ensure we have parsed values or at least the connection string
  if (connectionMode.value === 'url') {
    if (!connectionUrl.value) {
      addToast(t('toasts.fillRequired'), 'error');
      return;
    }
    // Ensure parsing happened
    parseConnectionUrl(connectionUrl.value);
    form.value.connectionString = connectionUrl.value;
  } else {
    // In manual mode, clear connection string
    form.value.connectionString = undefined;
  }

  if (!form.value.name || !form.value.host || !form.value.user || !form.value.output) {
    addToast(t('toasts.fillRequired'), 'error');
    return;
  }

  // Check for duplicates
  if (!isEditing.value) {
    const duplicate = store.databases.find(db => 
      (db.host === form.value.host && 
       db.port === form.value.port && 
       db.name === form.value.name) ||
      (connectionMode.value === 'url' && db.connectionString === form.value.connectionString)
    );

    if (duplicate) {
      addToast(t('toasts.databaseExists'), 'error');
      return;
    }
  }

  isLoading.value = true;
  try {
    // Create a plain object to avoid cloning errors with Vue reactive objects
    const dbData: Database = {
      name: form.value.name,
      displayName: form.value.displayName,
      host: form.value.host,
      port: form.value.port,
      user: form.value.user,
      password: form.value.password,
      output: form.value.output,
      cron: form.value.cron,
      enabled: form.value.enabled,
      encryptBackups: form.value.encryptBackups,
      connectionString: form.value.connectionString,
      ssl: form.value.ssl
    };

    if (isEditing.value) {
      await ipcRenderer.invoke('update-database', store.editingDatabase!.name, dbData);
      addToast(t('toasts.databaseUpdated'), 'success');
    } else {
      await ipcRenderer.invoke('add-database', dbData);
      addToast(t('toasts.databaseAdded'), 'success');
      store.newlyAddedDbName = dbData.name;
      setTimeout(() => {
        store.newlyAddedDbName = null;
      }, 5000);
    }
    
    // Refresh databases
    const config = await ipcRenderer.invoke('get-config');
    store.databases = config.databases;
    close();
  } catch (error: any) {
    addToast('Error saving database: ' + error.message, 'error');
  } finally {
    isLoading.value = false;
  }
};

const close = () => {
  store.showDatabaseModal = false;
  store.editingDatabase = null;
};
</script>

<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition duration-150 ease-in"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div v-if="store.showDatabaseModal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div 
        class="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl max-w-2xl w-full border border-border overflow-hidden flex flex-col max-h-[90vh]"
        @click.stop
      >
        <div class="px-6 py-4 border-b border-border flex justify-between items-center bg-surface">
          <h3 class="text-xl font-bold">{{ isEditing ? t('modal.editDatabase') : t('modal.addDatabase') }}</h3>
          <button @click="close" class="text-gray-500 hover:text-foreground transition-colors">
            <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        <div class="p-6 overflow-y-auto space-y-6 custom-scrollbar">
          <!-- Connection Details -->
          <div class="space-y-6">
            <!-- Mode Switcher -->
            <div class="bg-gray-100 dark:bg-zinc-800 p-1 rounded-xl flex">
              <button
                @click="connectionMode = 'url'"
                :class="[
                  'flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all duration-200 flex items-center justify-center gap-2',
                  connectionMode === 'url' 
                    ? 'bg-white dark:bg-zinc-700 shadow-sm text-foreground' 
                    : 'text-gray-500 hover:text-foreground'
                ]"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                {{ t('database.modeUrl') }}
              </button>
              <button
                @click="connectionMode = 'manual'"
                :class="[
                  'flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all duration-200 flex items-center justify-center gap-2',
                  connectionMode === 'manual' 
                    ? 'bg-white dark:bg-zinc-700 shadow-sm text-foreground' 
                    : 'text-gray-500 hover:text-foreground'
                ]"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                {{ t('database.modeManual') }}
              </button>
            </div>
            
            <!-- URL Input -->
            <div v-if="connectionMode === 'url'" class="space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Connection URL</label>
                <div class="relative">
                  <input
                    v-model="connectionUrl"
                    type="text"
                    class="w-full bg-surface border border-border rounded-xl pl-10 pr-4 py-3 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all font-mono text-sm"
                    :placeholder="t('database.urlPlaceholder')"
                  />
                  <div class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                    <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                  </div>
                </div>
                <p class="text-xs text-gray-500 mt-2 ml-1">
                  Format: <code class="bg-gray-100 dark:bg-zinc-800 px-1 py-0.5 rounded text-xs">postgresql://user:password@host:port/dbname?sslmode=require</code>
                </p>
              </div>
              
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t('database.displayName') }}</label>
                <input
                  v-model="form.displayName"
                  type="text"
                  class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
                  :placeholder="t('database.displayNamePlaceholder')"
                />
              </div>
              
              <!-- Read-only parsed fields preview -->
              <div v-if="connectionUrl" class="grid grid-cols-2 gap-4 opacity-75 pointer-events-none bg-gray-50 dark:bg-zinc-800/50 p-4 rounded-xl border border-gray-100 dark:border-zinc-700/50">
                <div>
                  <label class="block text-xs font-medium text-gray-500 mb-1">{{ t('database.host') }}</label>
                  <div class="text-sm font-mono">{{ form.host }}</div>
                </div>
                <div>
                  <label class="block text-xs font-medium text-gray-500 mb-1">{{ t('database.port') }}</label>
                  <div class="text-sm font-mono">{{ form.port }}</div>
                </div>
                <div>
                  <label class="block text-xs font-medium text-gray-500 mb-1">{{ t('database.user') }}</label>
                  <div class="text-sm font-mono">{{ form.user }}</div>
                </div>
                <div>
                  <label class="block text-xs font-medium text-gray-500 mb-1">{{ t('database.name') }}</label>
                  <div class="text-sm font-mono">{{ form.name }}</div>
                </div>
              </div>
            </div>

            <!-- Manual Inputs -->
            <div v-else class="space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t('database.name') }} *</label>
                  <input
                    v-model="form.name"
                    type="text"
                    class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
                    :placeholder="t('database.namePlaceholder')"
                    :disabled="isEditing"
                  />
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t('database.displayName') }}</label>
                  <input
                    v-model="form.displayName"
                    type="text"
                    class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
                    :placeholder="t('database.displayNamePlaceholder')"
                  />
                </div>
              </div>
  
              <div class="grid grid-cols-3 gap-4">
                <div class="col-span-2">
                  <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t('database.host') }} *</label>
                  <input
                    v-model="form.host"
                    type="text"
                    class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
                    placeholder="localhost"
                  />
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t('database.port') }} *</label>
                  <input
                    v-model.number="form.port"
                    type="number"
                    class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
                    placeholder="5432"
                  />
                </div>
              </div>
  

  
              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t('database.user') }} *</label>
                  <input
                    v-model="form.user"
                    type="text"
                    class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
                    placeholder="postgres"
                  />
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t('database.password') }}</label>
                  <div class="relative">
                    <input
                      v-model="form.password"
                      :type="passwordVisible ? 'text' : 'password'"
                      class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all pr-10"
                      :placeholder="isEditing ? '••••••••' : ''"
                    />
                    <button
                      @click="passwordVisible = !passwordVisible"
                      class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-foreground"
                    >
                      <svg v-if="passwordVisible" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                      </svg>
                      <svg v-else class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>

              <!-- SSL Option -->
              <div>
                <label class="flex items-center gap-2 cursor-pointer">
                  <input
                    v-model="form.ssl"
                    type="checkbox"
                    class="w-5 h-5 rounded border-gray-300 text-foreground focus:ring-foreground/20"
                  />
                  <span class="text-sm text-gray-700 dark:text-gray-300">{{ t('database.useSsl') }} (Required for Neon, Supabase, etc.)</span>
                </label>
              </div>
            </div>
          </div>

          <!-- Backup Settings -->
          <div class="space-y-4">
            <h4 class="text-sm font-medium text-gray-500 uppercase tracking-wider">{{ t('database.backupSettings') }}</h4>
            
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t('database.output') }} *</label>
              <div class="flex gap-2">
                <input
                  v-model="form.output"
                  type="text"
                  class="flex-1 bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all font-mono text-sm"
                  readonly
                />
                <button
                  @click="selectOutput"
                  class="px-4 py-2 bg-surface border border-border rounded-xl hover:bg-border transition-colors"
                >
                  {{ t('common.browse') }}
                </button>
              </div>
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{{ t('database.cron') }}</label>
              <input
                v-model="form.cron"
                type="text"
                class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all font-mono"
                placeholder="0 0 * * *"
              />
              <p class="text-xs text-gray-500 mt-1">Format: min hour day month day-of-week</p>
            </div>

            <div class="flex items-center gap-4">
              <label class="flex items-center gap-2 cursor-pointer">
                <input
                  v-model="form.encryptBackups"
                  type="checkbox"
                  class="w-5 h-5 rounded border-gray-300 text-foreground focus:ring-foreground/20"
                />
                <span class="text-sm">{{ t('database.encrypt') }}</span>
              </label>
              
              <label class="flex items-center gap-2 cursor-pointer">
                <input
                  v-model="form.enabled"
                  type="checkbox"
                  class="w-5 h-5 rounded border-gray-300 text-foreground focus:ring-foreground/20"
                />
                <span class="text-sm">{{ t('database.enableAutoBackup') }}</span>
              </label>
            </div>
          </div>
        </div>
        
        <div class="bg-surface px-6 py-4 flex justify-end gap-3 border-t border-border">
          <button
            @click="close"
            class="px-4 py-2 rounded-xl text-gray-600 hover:bg-white dark:hover:bg-zinc-800 transition-colors font-medium"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            @click="save"
            :disabled="isLoading"
            class="px-4 py-2 rounded-xl bg-foreground text-background hover:bg-zinc-800 transition-colors font-medium flex items-center gap-2"
          >
            <svg v-if="isLoading" class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            {{ t('common.save') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

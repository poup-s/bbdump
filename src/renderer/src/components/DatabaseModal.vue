<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';
import { Database } from '../types';
import CronEditor from './CronEditor.vue';

const { t } = useI18n();
const { addToast } = useToast();

const isEditing = computed(() => !!store.editingDatabase);
const isLoading = ref(false);
const currentStep = ref(1);
const connectionMode = ref<'manual' | 'url' | null>(null);
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
  enabled: false,
  encryptBackups: false,
  connectionString: '',
  ssl: false
});

const passwordVisible = ref(false);

watch(() => store.showDatabaseModal, async (show) => {
  if (show) {
    if (store.editingDatabase) {
      // Edit mode - skip wizard, show all fields
      form.value = { ...store.editingDatabase };
      
      // If output path is missing (e.g. auto-imported), fallback to global default
      if (!form.value.output) {
        try {
          const defaultPath = await ipcRenderer.invoke('get-default-path');
          if (defaultPath) {
            form.value.output = defaultPath;
          }
        } catch (e) {
          console.error('Failed to get default path during edit', e);
        }
      }

      if (form.value.connectionString) {
        connectionMode.value = 'url';
        connectionUrl.value = form.value.connectionString;
      } else {
        connectionMode.value = 'manual';
        connectionUrl.value = '';
      }
      currentStep.value = 1; // Will be bypassed in edit mode
    } else {
      // New database - start wizard
      currentStep.value = 1;
      connectionMode.value = null;
      connectionUrl.value = '';
      
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
        enabled: false,
        encryptBackups: false,
        connectionString: '',
        ssl: false
      };
    }
  }
});

const parseConnectionUrl = (url: string) => {
  try {
    // Updated regex to handle special characters in user, password, and database name
    // Supports: underscores, hyphens, special chars in password, query params
    const regex = /^postgres(?:ql)?:\/\/(?:([^:@]+)(?::([^@]+))?@)?([^:/]+)(?::(\d+))?(?:\/([^?]+))?(?:\?(.*))?$/;
    const match = url.match(regex);

    if (match) {
      const [_, user, password, host, port, dbname, query] = match;
      
      if (user) form.value.user = user;
      if (password) form.value.password = password;
      if (host) form.value.host = host;
      if (port) form.value.port = parseInt(port);
      if (dbname) form.value.name = dbname;
      
      if (query && query.includes('sslmode=require')) {
        form.value.ssl = true;
      } else {
        form.value.ssl = false;
      }

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

const selectMode = (mode: 'url' | 'manual') => {
  connectionMode.value = mode;
  if (mode === 'url') {
    connectionUrl.value = '';
  }
};

const nextStep = () => {
  if (currentStep.value === 1) {
    if (!connectionMode.value) {
      addToast(t('toasts.fillRequired'), 'error');
      return;
    }
    currentStep.value = 2;
  } else if (currentStep.value === 2) {
    // Validate step 2
    if (connectionMode.value === 'url') {
      if (!connectionUrl.value) {
        addToast(t('toasts.fillRequired'), 'error');
        return;
      }
      parseConnectionUrl(connectionUrl.value);
      form.value.connectionString = connectionUrl.value;
    } else {
      if (!form.value.name || !form.value.host || !form.value.user) {
        addToast(t('toasts.fillRequired'), 'error');
        return;
      }
      form.value.connectionString = undefined;
    }
    currentStep.value = 3;
  }
};

const previousStep = () => {
  if (currentStep.value > 1) {
    currentStep.value--;
  }
};

const save = async () => {
  // Final validation
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
      }, 2000);
    }
    
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
  currentStep.value = 1;
  connectionMode.value = null;
};

// Skip wizard in edit mode
const showWizard = computed(() => !isEditing.value);

const scrollToSection = async (section: 'schedule') => {
  await new Promise(resolve => setTimeout(resolve, 100)); // Wait for modal transition
  const container = document.querySelector('.overflow-y-auto.custom-scrollbar');
  const target = document.querySelector(`[data-${section}-section]`);
  if (container && target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Clear the target after scrolling
    store.modalTargetSection = null;
  }
};

watch(() => store.showDatabaseModal, (show) => {
  if (show && store.modalTargetSection) {
    scrollToSection(store.modalTargetSection);
  }
});
</script>

<template>
  <Transition
    enter-active-class="transition duration-300 ease-out"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition duration-200 ease-in"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div v-if="store.showDatabaseModal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div 
        class="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl max-w-3xl w-full border border-border overflow-hidden flex flex-col max-h-[90vh]"
        @click.stop
      >
        <!-- Header -->
        <div class="px-6 py-4 border-b border-border flex justify-between items-center bg-surface">
          <div class="flex items-center gap-4">
            <h3 class="text-xl font-bold">{{ isEditing ? t('modal.editDatabase') : t('modal.addDatabase') }}</h3>
            <span v-if="showWizard" class="text-xs text-gray-500 dark:text-gray-400 px-3 py-1 bg-gray-100 dark:bg-zinc-800 rounded-full">
              {{ t('database.wizard.stepIndicator', { current: currentStep, total: 3 }) }}
            </span>
          </div>
          <button @click="close" class="text-gray-500 hover:text-foreground transition-colors">
            <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        <!-- Progress Bar -->
        <div v-if="showWizard" class="h-1 bg-gray-100 dark:bg-zinc-800 relative overflow-hidden">
          <div 
            class="h-full bg-foreground transition-all duration-500 ease-out"
            :style="{ width: `${(currentStep / 3) * 100}%` }"
          ></div>
        </div>
        
        <div class="p-6 overflow-y-auto space-y-6 custom-scrollbar flex-1">
          <!-- Step 1: Choose Mode -->
          <Transition
            enter-active-class="transition duration-300 ease-out"
            enter-from-class="opacity-0 translate-y-4"
            enter-to-class="opacity-100 translate-y-0"
            leave-active-class="transition duration-200 ease-in"
            leave-from-class="opacity-100 translate-y-0"
            leave-to-class="opacity-0 -translate-y-4"
            mode="out-in"
          >
            <div v-if="showWizard && currentStep === 1" key="step1" class="space-y-6">
              <div class="text-center space-y-2">
                <h4 class="text-2xl font-bold">{{ t('database.wizard.step1Title') }}</h4>
                <p class="text-gray-500 dark:text-gray-400">{{ t('database.wizard.step1Description') }}</p>
              </div>
              
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-8">
                <!-- URL Mode Card -->
                <button
                  @click="selectMode('url')"
                  :class="[
                    'group relative p-6 rounded-xl border-2 transition-all duration-300 text-left',
                    connectionMode === 'url'
                      ? 'border-foreground bg-foreground/5 shadow-lg scale-105'
                      : 'border-border hover:border-foreground/50 hover:bg-surface'
                  ]"
                >
                  <div class="flex items-start gap-4">
                    <div :class="[
                      'p-3 rounded-lg transition-colors',
                      connectionMode === 'url' ? 'bg-foreground text-background' : 'bg-gray-100 dark:bg-zinc-800'
                    ]">
                      <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                      </svg>
                    </div>
                    <div class="flex-1">
                      <h5 class="font-semibold text-lg mb-1">{{ t('database.wizard.modeUrlTitle') }}</h5>
                      <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('database.wizard.modeUrlDesc') }}</p>
                    </div>
                    <div v-if="connectionMode === 'url'" class="absolute top-4 right-4">
                      <div class="w-6 h-6 rounded-full bg-foreground flex items-center justify-center">
                        <svg class="w-4 h-4 text-background" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </button>

                <!-- Manual Mode Card -->
                <button
                  @click="selectMode('manual')"
                  :class="[
                    'group relative p-6 rounded-xl border-2 transition-all duration-300 text-left',
                    connectionMode === 'manual'
                      ? 'border-foreground bg-foreground/5 shadow-lg scale-105'
                      : 'border-border hover:border-foreground/50 hover:bg-surface'
                  ]"
                >
                  <div class="flex items-start gap-4">
                    <div :class="[
                      'p-3 rounded-lg transition-colors',
                      connectionMode === 'manual' ? 'bg-foreground text-background' : 'bg-gray-100 dark:bg-zinc-800'
                    ]">
                      <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </div>
                    <div class="flex-1">
                      <h5 class="font-semibold text-lg mb-1">{{ t('database.wizard.modeManualTitle') }}</h5>
                      <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('database.wizard.modeManualDesc') }}</p>
                    </div>
                    <div v-if="connectionMode === 'manual'" class="absolute top-4 right-4">
                      <div class="w-6 h-6 rounded-full bg-foreground flex items-center justify-center">
                        <svg class="w-4 h-4 text-background" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </button>
              </div>
            </div>

            <!-- Step 2: Connection Details -->
            <div v-else-if="showWizard && currentStep === 2" key="step2" class="space-y-6">
              <div class="text-center space-y-2">
                <h4 class="text-2xl font-bold">{{ t('database.wizard.step2Title') }}</h4>
                <p class="text-gray-500 dark:text-gray-400">{{ t('database.wizard.step2Description') }}</p>
              </div>

              <Transition
                enter-active-class="transition duration-300 ease-out"
                enter-from-class="opacity-0 translate-x-4"
                enter-to-class="opacity-100 translate-x-0"
                leave-active-class="transition duration-200 ease-in"
                leave-from-class="opacity-100 translate-x-0"
                leave-to-class="opacity-0 -translate-x-4"
                mode="out-in"
              >
                <!-- URL Mode Input -->
                <div v-if="connectionMode === 'url'" key="url" class="space-y-4">
                  <div>
                    <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Connection URL *
                    </label>
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
                    <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      {{ t('database.displayName') }}
                    </label>
                    <input
                      v-model="form.displayName"
                      type="text"
                      class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
                      :placeholder="t('database.displayNamePlaceholder')"
                    />
                  </div>

                  <!-- Parsed fields preview -->
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

                  <!-- Encrypt Password Option -->
                  <div class="p-4 bg-gray-50 dark:bg-zinc-800/50 rounded-xl border border-gray-100 dark:border-zinc-700/50">
                    <label class="flex items-start gap-3 cursor-pointer">
                      <input
                        v-model="form.encryptBackups"
                        type="checkbox"
                        class="mt-1 w-5 h-5 rounded border-gray-300 text-foreground focus:ring-foreground/20"
                      />
                      <div class="flex-1">
                        <span class="text-sm font-medium">{{ t('database.wizard.encryptPassword') }}</span>
                        <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">{{ t('database.wizard.encryptPasswordDesc') }}</p>
                      </div>
                    </label>
                  </div>
                </div>

                <!-- Manual Mode Input -->
                <div v-else-if="connectionMode === 'manual'" key="manual" class="space-y-4">
                  <div class="grid grid-cols-2 gap-4">
                    <div>
                      <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        {{ t('database.name') }} *
                      </label>
                      <input
                        v-model="form.name"
                        type="text"
                        class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
                        :placeholder="t('database.namePlaceholder')"
                      />
                    </div>
                    <div>
                      <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        {{ t('database.displayName') }}
                      </label>
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
                      <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        {{ t('database.host') }} *
                      </label>
                      <input
                        v-model="form.host"
                        type="text"
                        class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
                        placeholder="localhost"
                      />
                    </div>
                    <div>
                      <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        {{ t('database.port') }} *
                      </label>
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
                      <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        {{ t('database.user') }} *
                      </label>
                      <input
                        v-model="form.user"
                        type="text"
                        class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
                        placeholder="postgres"
                      />
                    </div>
                    <div>
                      <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        {{ t('database.password') }}
                      </label>
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

                  <!-- Encrypt Password Option -->
                  <div class="p-4 bg-gray-50 dark:bg-zinc-800/50 rounded-xl border border-gray-100 dark:border-zinc-700/50">
                    <label class="flex items-start gap-3 cursor-pointer">
                      <input
                        v-model="form.encryptBackups"
                        type="checkbox"
                        class="mt-1 w-5 h-5 rounded border-gray-300 text-foreground focus:ring-foreground/20"
                      />
                      <div class="flex-1">
                        <span class="text-sm font-medium">{{ t('database.wizard.encryptPassword') }}</span>
                        <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">{{ t('database.wizard.encryptPasswordDesc') }}</p>
                      </div>
                    </label>
                  </div>
                </div>
              </Transition>
            </div>

            <!-- Step 3: Backup Configuration -->
            <div v-else-if="showWizard && currentStep === 3" key="step3" class="space-y-6">
              <div class="text-center space-y-2">
                <h4 class="text-2xl font-bold">{{ t('database.wizard.step3Title') }}</h4>
                <p class="text-gray-500 dark:text-gray-400">{{ t('database.wizard.step3Description') }}</p>
              </div>

              <div class="space-y-4">
                <!-- Enable Backup Toggle -->
                <div class="p-6 bg-gray-50 dark:bg-zinc-800/50 rounded-xl border border-gray-100 dark:border-zinc-700/50">
                  <label class="flex items-start gap-3 cursor-pointer">
                    <input
                      v-model="form.enabled"
                      type="checkbox"
                      class="mt-1 w-5 h-5 rounded border-gray-300 text-foreground focus:ring-foreground/20"
                    />
                    <div class="flex-1">
                      <span class="text-sm font-medium">{{ t('database.wizard.enableBackup') }}</span>
                      <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">{{ t('database.wizard.enableBackupDesc') }}</p>
                    </div>
                  </label>
                </div>

                <!-- Backup Settings (shown when enabled) -->
                <Transition
                  enter-active-class="transition duration-300 ease-out"
                  enter-from-class="opacity-0 max-h-0"
                  enter-to-class="opacity-100 max-h-96"
                  leave-active-class="transition duration-200 ease-in"
                  leave-from-class="opacity-100 max-h-96"
                  leave-to-class="opacity-0 max-h-0"
                >
                  <div v-if="form.enabled" class="space-y-4 overflow-hidden">
                    <div>
                      <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        {{ t('database.output') }} *
                      </label>
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
                      <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        {{ t('database.cron') }}
                      </label>
                      <CronEditor v-model="form.cron!" />
                    </div>
                  </div>
                </Transition>
              </div>
            </div>

            <!-- Edit Mode (bypass wizard) -->
            <div v-else-if="!showWizard" key="edit" class="space-y-6">
              <!-- Same content as before but without wizard steps -->
              <div class="space-y-6">
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
                <div v-if="connectionMode === 'url'" class="space-y-4">
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

                <!-- Manual Inputs -->
                <div v-else class="space-y-4">
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
              <div class="space-y-4" data-schedule-section>
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
                  <CronEditor v-model="form.cron!" />
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
          </Transition>
        </div>
        
        <!-- Footer -->
        <div class="bg-surface px-6 py-4 flex justify-between gap-3 border-t border-border">
          <button
            v-if="showWizard && currentStep > 1"
            @click="previousStep"
            class="px-4 py-2 rounded-xl text-gray-600 hover:bg-white dark:hover:bg-zinc-800 transition-colors font-medium flex items-center gap-2"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
            {{ t('database.wizard.previous') }}
          </button>
          <div v-else></div>
          
          <div class="flex gap-3">
            <button
              @click="close"
              class="px-4 py-2 rounded-xl text-gray-600 hover:bg-white dark:hover:bg-zinc-800 transition-colors font-medium"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              v-if="showWizard && currentStep < 3"
              @click="nextStep"
              class="px-6 py-2 rounded-xl bg-foreground text-background hover:bg-zinc-800 transition-colors font-medium flex items-center gap-2"
            >
              {{ t('database.wizard.next') }}
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <button
              v-else
              @click="save"
              :disabled="isLoading"
              class="px-6 py-2 rounded-xl bg-foreground text-background hover:bg-zinc-800 transition-colors font-medium flex items-center gap-2 disabled:opacity-50"
            >
              <svg v-if="isLoading" class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {{ showWizard ? t('database.wizard.finish') : t('common.save') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

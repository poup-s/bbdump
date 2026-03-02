<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';

const { t } = useI18n();
const { addToast } = useToast();

const isLoading = ref(false);
const progress = ref<{ step: string; message: string; progress: number } | null>(null);
const isPortEditable = ref(false);
const showAdvanced = ref(false);
const selectedProjectId = ref<string | null>(null);
const form = ref({
  name: '',
  displayName: '',
  port: 5432,
  password: ''
});

const errors = ref({
  name: '',
  port: ''
});

const availableProjects = computed(() => store.projects || []);

watch(() => store.showCreateDatabaseModal, (show) => {
  if (show) {
    // Reset form
    form.value = {
      name: '',
      displayName: '',
      port: 5432,
      password: ''
    };
    errors.value = {
      name: '',
      port: ''
    };
    progress.value = null;
    isPortEditable.value = false;
    showAdvanced.value = false;
    // Pre-fill project from context
    selectedProjectId.value = store.createDatabaseForProjectId || null;
  }
});

// Écouter les événements de progression depuis le main process
onMounted(() => {
  ipcRenderer.on('create-database-progress', (_, prog: { step: string; message: string; progress: number }) => {
    progress.value = prog;
  });
});

onUnmounted(() => {
  ipcRenderer.removeAllListeners('create-database-progress');
});

const validateForm = () => {
  errors.value = { name: '', port: '' };
  let isValid = true;

  if (!form.value.name || form.value.name.trim() === '') {
    errors.value.name = t('createDatabase.errors.nameRequired');
    isValid = false;
  } else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(form.value.name)) {
    errors.value.name = t('createDatabase.errors.nameInvalid');
    isValid = false;
  }

  if (!form.value.port || form.value.port < 1024 || form.value.port > 65535) {
    errors.value.port = t('createDatabase.errors.portInvalid');
    isValid = false;
  }

  return isValid;
};

const createDatabase = async () => {
  if (!validateForm()) {
    return;
  }

  isLoading.value = true;
  progress.value = { step: 'starting', message: 'Starting...', progress: 0 };

  try {
    const result = await ipcRenderer.invoke('create-local-database', {
      name: form.value.name.trim(),
      displayName: form.value.displayName.trim() || undefined,
      port: form.value.port,
      password: form.value.password.trim() || undefined
    });

    if (result.success) {
      addToast(t('createDatabase.success', { name: form.value.name }), 'success');

      // Refresh databases
      const config = await ipcRenderer.invoke('get-config');
      store.databases = config.databases;

      // Find the newly created database
      const newDb = store.databases.find(d => d.name === form.value.name && d.isLocalBbdump);

      // Assign to project if selected
      if (selectedProjectId.value && newDb) {
        await ipcRenderer.invoke('move-database-to-project', newDb.id, selectedProjectId.value);
        const updatedConfig = await ipcRenderer.invoke('get-config');
        store.projects = updatedConfig.projects || [];
      }

      // Highlight the newly created database
      store.newlyAddedDbId = newDb?.id || null;
      setTimeout(() => {
        store.newlyAddedDbId = null;
      }, 2000);

      progress.value = null;
      close();
    } else {
      addToast(result.error || t('createDatabase.errors.createFailed'), 'error');
      progress.value = null;
    }
  } catch (error: any) {
    addToast(error.message || t('createDatabase.errors.createFailed'), 'error');
    progress.value = null;
  } finally {
    isLoading.value = false;
  }
};

const close = () => {
  store.showCreateDatabaseModal = false;
  store.createDatabaseForProjectId = null;
};
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
    <div v-if="store.showCreateDatabaseModal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <Transition
        enter-active-class="transition duration-300 ease-out"
        enter-from-class="opacity-0 scale-95 translate-y-4"
        enter-to-class="opacity-100 scale-100 translate-y-0"
        leave-active-class="transition duration-200 ease-in"
        leave-from-class="opacity-100 scale-100 translate-y-0"
        leave-to-class="opacity-0 scale-95 translate-y-4"
      >
        <div
          v-if="store.showCreateDatabaseModal"
          class="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl max-w-lg w-full border border-border overflow-hidden flex flex-col"
          @click.stop
        >
          <!-- Header with gradient -->
          <div class="relative px-6 py-5 border-b border-border bg-gradient-to-r from-blue-500/10 via-indigo-500/10 to-purple-500/10">
            <div class="flex items-start justify-between">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
                  <svg class="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                  </svg>
                </div>
                <div>
                  <h3 class="text-lg font-bold">{{ t('modal.createDatabaseTitle') }}</h3>
                  <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('modal.createDatabaseDesc') }}</p>
                </div>
              </div>
              <button @click="close" class="text-gray-400 hover:text-foreground transition-colors p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5">
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Content -->
          <div class="p-6 space-y-5 overflow-y-auto max-h-[60vh]">
            <template v-if="!progress">
              <!-- Database Name -->
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  {{ t('database.name') }} <span class="text-red-400">*</span>
                </label>
                <input
                  v-model="form.name"
                  type="text"
                  class="w-full bg-surface border border-border rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500/50 transition-all"
                  :class="{ 'border-red-500 focus:ring-red-500/30': errors.name }"
                  :placeholder="t('database.namePlaceholder')"
                />
                <p v-if="errors.name" class="text-xs text-red-500 mt-1">{{ errors.name }}</p>
                <p v-else class="text-xs text-gray-400 dark:text-gray-500 mt-1">{{ t('createDatabase.nameHint') }}</p>
              </div>

              <!-- Display Name -->
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  {{ t('database.displayName') }}
                </label>
                <input
                  v-model="form.displayName"
                  type="text"
                  class="w-full bg-surface border border-border rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500/50 transition-all"
                  :placeholder="t('database.displayNamePlaceholder')"
                />
              </div>

              <!-- Project Selector -->
              <div v-if="availableProjects.length > 0">
                <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  {{ t('createDatabase.projectLabel') }}
                </label>
                <div class="relative">
                  <select
                    v-model="selectedProjectId"
                    class="w-full bg-surface border border-border rounded-xl px-4 py-2.5 pr-10 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500/50 transition-all appearance-none cursor-pointer"
                  >
                    <option :value="null">{{ t('createDatabase.projectNone') }}</option>
                    <option
                      v-for="project in availableProjects"
                      :key="project.id"
                      :value="project.id"
                    >
                      {{ project.name }}
                    </option>
                  </select>
                  <!-- Custom chevron -->
                  <div class="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
                    <svg class="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                  <!-- Color dot for selected project -->
                  <div v-if="selectedProjectId" class="absolute inset-y-0 left-3 flex items-center pointer-events-none">
                    <span
                      class="w-2.5 h-2.5 rounded-full mr-1"
                      :class="availableProjects.find(p => p.id === selectedProjectId)?.color || 'bg-blue-500'"
                    ></span>
                  </div>
                </div>
                <p class="text-xs text-gray-400 dark:text-gray-500 mt-1">{{ t('createDatabase.projectHint') }}</p>
              </div>

              <!-- Advanced Settings Toggle -->
              <div class="border-t border-border pt-4">
                <button
                  @click="showAdvanced = !showAdvanced"
                  type="button"
                  class="flex items-center gap-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-foreground transition-colors w-full"
                >
                  <svg
                    class="w-4 h-4 transition-transform duration-200"
                    :class="{ 'rotate-90': showAdvanced }"
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
                  >
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  {{ t('createDatabase.advancedSettings') }}
                </button>

                <!-- Advanced Settings Content -->
                <Transition
                  enter-active-class="transition duration-200 ease-out"
                  enter-from-class="opacity-0 -translate-y-2"
                  enter-to-class="opacity-100 translate-y-0"
                  leave-active-class="transition duration-150 ease-in"
                  leave-from-class="opacity-100 translate-y-0"
                  leave-to-class="opacity-0 -translate-y-2"
                >
                  <div v-if="showAdvanced" class="mt-4 space-y-4">
                    <!-- Password -->
                    <div>
                      <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                        {{ t('database.password') }}
                        <span class="text-xs font-normal text-gray-400 ml-1">({{ t('common.optional') }})</span>
                      </label>
                      <input
                        v-model="form.password"
                        type="password"
                        class="w-full bg-surface border border-border rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500/50 transition-all"
                        :placeholder="t('database.password')"
                      />
                      <p class="text-xs text-gray-400 dark:text-gray-500 mt-1">{{ t('createDatabase.passwordHint') }}</p>
                    </div>

                    <!-- Port -->
                    <div>
                      <div class="flex items-center justify-between mb-1.5">
                        <label class="text-sm font-medium text-gray-700 dark:text-gray-300">
                          {{ t('database.port') }}
                        </label>
                        <button
                          v-if="!isPortEditable"
                          @click="isPortEditable = true"
                          type="button"
                          class="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors flex items-center gap-1"
                        >
                          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                          {{ t('common.edit') }}
                        </button>
                        <button
                          v-else
                          @click="isPortEditable = false; form.port = 5432"
                          type="button"
                          class="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                        >
                          {{ t('common.cancel') }}
                        </button>
                      </div>
                      <input
                        v-model.number="form.port"
                        type="number"
                        :disabled="!isPortEditable"
                        class="w-full bg-gray-50 dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500/50 transition-all disabled:cursor-not-allowed disabled:opacity-60"
                        :class="{
                          'border-red-500': errors.port,
                          'bg-surface border-border': isPortEditable
                        }"
                        placeholder="5432"
                        min="1024"
                        max="65535"
                      />
                      <p v-if="errors.port" class="text-xs text-red-500 mt-1">{{ errors.port }}</p>
                      <p v-else-if="isPortEditable" class="text-xs text-gray-400 dark:text-gray-500 mt-1">{{ t('createDatabase.portHint') }}</p>
                    </div>
                  </div>
                </Transition>
              </div>

              <!-- Info Box -->
              <div class="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-100 dark:border-blue-800/50">
                <div class="flex items-start gap-2.5">
                  <svg class="w-4 h-4 text-blue-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p class="text-sm text-blue-700 dark:text-blue-300 leading-relaxed">
                    {{ t('createDatabase.infoDesc') }}
                  </p>
                </div>
              </div>
            </template>

            <!-- Progress Logger -->
            <div v-if="progress" class="space-y-4">
              <div class="p-5 bg-gray-50 dark:bg-zinc-800/50 rounded-xl border border-gray-200 dark:border-zinc-700 space-y-3">
                <div class="flex items-center justify-between">
                  <span class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ t('createDatabase.progress') }}</span>
                  <span class="text-xs font-mono text-gray-500 bg-gray-100 dark:bg-zinc-700 px-2 py-0.5 rounded-full">{{ progress.progress }}%</span>
                </div>
                <div class="w-full bg-gray-200 dark:bg-zinc-700 rounded-full h-2 overflow-hidden">
                  <div
                    class="bg-gradient-to-r from-blue-500 to-indigo-500 h-2 rounded-full transition-all duration-500 ease-out"
                    :style="{ width: `${progress.progress}%` }"
                  ></div>
                </div>
                <div class="flex items-start gap-2 mt-1">
                  <svg class="w-4 h-4 text-gray-400 mt-0.5 shrink-0 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p class="text-xs text-gray-600 dark:text-gray-400 flex-1">{{ progress.message }}</p>
                </div>
              </div>
            </div>
          </div>

          <!-- Footer -->
          <div class="px-6 py-4 flex justify-end gap-3 border-t border-border bg-gray-50/50 dark:bg-zinc-800/30">
            <button
              @click="close"
              :disabled="isLoading"
              class="px-4 py-2 rounded-xl text-gray-600 dark:text-gray-400 hover:bg-white dark:hover:bg-zinc-800 transition-colors font-medium disabled:opacity-50"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              @click="createDatabase"
              :disabled="isLoading"
              class="px-6 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700 transition-all font-medium flex items-center gap-2 disabled:opacity-50 shadow-lg shadow-blue-500/20 hover:shadow-xl hover:shadow-blue-500/30"
            >
              <svg v-if="isLoading" class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              {{ t('modal.createDatabase') }}
            </button>
          </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>

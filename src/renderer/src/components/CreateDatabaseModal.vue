<script setup lang="ts">
/** Create a database on the local PostgreSQL server (same shell and fields as the other dialogs). */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { getErrorMessage } from '../utils';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';
import AppModal from './ui/AppModal.vue';
import ModalHeading from './ui/ModalHeading.vue';
import FormField from './ui/FormField.vue';
import { btnGhost, btnPrimary, inputClass, monoInputClass, selectClass } from './ui/classes';

const ICON_DB_PLUS = 'M4 7v10c0 2.21 3.582 4 8 4M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 0v5m-2 6h6m-3-3v6';

const { t } = useI18n();
const { addToast } = useToast();

const isLoading = ref(false);
const progress = ref<{ step: string; message: string; progress: number } | null>(null);
const isPortEditable = ref(false);
const showAdvanced = ref(false);
const passwordVisible = ref(false);
const selectedProjectId = ref<string | null>(null);
const attempted = ref(false);
const form = ref({
  name: '',
  displayName: '',
  port: 5432,
  password: ''
});

const availableProjects = computed(() => store.projects || []);
const selectedProject = computed(() => availableProjects.value.find(p => p.id === selectedProjectId.value) ?? null);
/** Project colors are a Tailwind class or "custom:#hex" */
const projectDot = (color: string | undefined) => color?.startsWith('custom:')
  ? { class: '', style: { backgroundColor: color.replace('custom:', '') } }
  : { class: color || 'bg-gray-400', style: {} };

onMounted(() => {
  selectedProjectId.value = store.createDatabaseForProjectId || null;
  ipcRenderer.on('create-database-progress', (_: unknown, prog: { step: string; message: string; progress: number }) => {
    progress.value = prog;
  });
});

onUnmounted(() => {
  ipcRenderer.removeAllListeners('create-database-progress');
});

const errors = computed(() => {
  const result: { name?: string; port?: string } = {};
  const name = form.value.name.trim();
  if (!name) result.name = t('createDatabase.errors.nameRequired');
  else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) result.name = t('createDatabase.errors.nameInvalid');
  else if (store.databases.some(db => db.isLocalBbdump && db.name === name)) result.name = t('createDatabase.errors.nameExists');
  if (!form.value.port || form.value.port < 1024 || form.value.port > 65535) result.port = t('createDatabase.errors.portInvalid');
  return result;
});
/** Typing shows the format problem right away; "required" waits for a first try */
const nameError = computed(() => (attempted.value || form.value.name ? errors.value.name : undefined));
const portError = computed(() => (attempted.value || isPortEditable.value ? errors.value.port : undefined));

const createDatabase = async () => {
  if (isLoading.value) return;
  attempted.value = true;
  if (errors.value.name || errors.value.port) {
    if (errors.value.port) showAdvanced.value = true;
    return;
  }

  isLoading.value = true;
  progress.value = { step: 'starting', message: t('createDatabase.starting'), progress: 0 };

  try {
    const result = await ipcRenderer.invoke('create-local-database', {
      name: form.value.name.trim(),
      displayName: form.value.displayName.trim() || undefined,
      port: form.value.port,
      password: form.value.password.trim() || undefined
    });

    if (result.success) {
      addToast(t('createDatabase.success', { name: form.value.name }), 'success');

      const config = await ipcRenderer.invoke('get-config');
      store.databases = config.databases;
      const newDb = store.databases.find(d => d.name === form.value.name.trim() && d.isLocalBbdump);

      // Assign to project if selected
      if (selectedProjectId.value && newDb) {
        await ipcRenderer.invoke('move-database-to-project', newDb.id, selectedProjectId.value);
        const updatedConfig = await ipcRenderer.invoke('get-config');
        store.projects = updatedConfig.projects || [];
      }

      // Highlight the newly created database
      store.newlyAddedDbId = newDb?.id || null;
      setTimeout(() => { store.newlyAddedDbId = null; }, 2000);

      progress.value = null;
      isLoading.value = false;
      close();
    } else {
      addToast(t('createDatabase.errors.createFailed'), 'error', { detail: result.error });
      progress.value = null;
    }
  } catch (error) {
    addToast(t('createDatabase.errors.createFailed'), 'error', { detail: getErrorMessage(error) });
    progress.value = null;
  } finally {
    isLoading.value = false;
  }
};

const resetPort = () => {
  isPortEditable.value = false;
  form.value.port = 5432;
};

const close = () => {
  if (isLoading.value) return;
  store.showCreateDatabaseModal = false;
  store.createDatabaseForProjectId = null;
};
</script>

<template>
  <AppModal
    :title="t('modal.createDatabaseTitle')"
    :icon="ICON_DB_PLUS"
    meta="localhost"
    :busy="isLoading"
    :close-label="t('common.cancel')"
    @close="close"
    @submit="createDatabase"
  >
    <!-- Creating: what the main process is doing -->
    <div v-if="progress" class="py-6" role="status" aria-live="polite">
      <ModalHeading :eyebrow="t('createDatabase.eyebrow')" :title="form.name" :subtitle="t('createDatabase.infoDesc')" />
      <div class="h-[3px] rounded-full overflow-hidden bg-gray-100 dark:bg-zinc-800">
        <div class="h-full rounded-full bg-emerald-500 transition-[width] duration-500" :style="{ width: `${Math.max(4, progress.progress)}%` }" />
      </div>
      <div class="mt-2 flex items-center justify-between gap-3 text-[12px]">
        <span class="text-gray-600 dark:text-zinc-400 min-w-0 break-words">{{ progress.message }}</span>
        <span class="font-mono text-gray-400 dark:text-zinc-500 tabular-nums">{{ progress.progress }}%</span>
      </div>
    </div>

    <template v-else>
      <ModalHeading :eyebrow="t('createDatabase.eyebrow')" :title="t('createDatabase.title')" :subtitle="t('createDatabase.subtitle')" />
      <div class="space-y-4">
        <FormField :label="t('database.name')" for="new-db-name" required :error="nameError" :hint="t('createDatabase.nameHint')">
          <input
            id="new-db-name"
            v-model="form.name"
            type="text"
            spellcheck="false"
            autocomplete="off"
            :class="monoInputClass"
            :placeholder="t('database.namePlaceholder')"
          />
        </FormField>

        <FormField :label="t('database.displayName')" for="new-db-display" :optional="t('common.optional')">
          <input id="new-db-display" v-model="form.displayName" type="text" :class="inputClass" :placeholder="t('database.displayNamePlaceholder')" />
        </FormField>

        <FormField v-if="availableProjects.length > 0" :label="t('createDatabase.projectLabel')" for="new-db-project" :optional="t('common.optional')">
          <div class="relative">
            <span
              v-if="selectedProject"
              class="absolute left-3 top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full pointer-events-none"
              :class="projectDot(selectedProject.color).class"
              :style="projectDot(selectedProject.color).style"
            />
            <select id="new-db-project" v-model="selectedProjectId" :class="[selectClass, selectedProject ? 'pl-8' : '']">
              <option :value="null">{{ t('createDatabase.projectNone') }}</option>
              <option v-for="project in availableProjects" :key="project.id" :value="project.id">{{ project.name }}</option>
            </select>
          </div>
        </FormField>

        <!-- Advanced -->
        <div class="pt-1">
          <button
            type="button"
            class="flex items-center gap-1.5 text-[12px] font-medium text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-zinc-100 transition-colors"
            :aria-expanded="showAdvanced"
            @click="showAdvanced = !showAdvanced"
          >
            <svg class="w-3.5 h-3.5 transition-transform duration-200" :class="showAdvanced ? 'rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            {{ t('createDatabase.advancedSettings') }}
          </button>
          <div v-if="showAdvanced" class="mt-3 grid grid-cols-[minmax(0,1fr)_9rem] gap-3">
            <FormField :label="t('database.password')" for="new-db-password" :optional="t('common.optional')" :hint="t('createDatabase.passwordHint')">
              <div class="relative">
                <input
                  id="new-db-password"
                  v-model="form.password"
                  :type="passwordVisible ? 'text' : 'password'"
                  autocomplete="new-password"
                  :class="inputClass"
                  class="pr-9"
                />
                <button
                  type="button"
                  class="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-md flex items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-zinc-200"
                  :aria-label="passwordVisible ? t('dbModal.hidePassword') : t('dbModal.showPassword')"
                  @click="passwordVisible = !passwordVisible"
                >
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path v-if="passwordVisible" stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    <path v-else stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                </button>
              </div>
            </FormField>
            <FormField :label="t('database.port')" for="new-db-port" :error="portError" :hint="isPortEditable ? t('createDatabase.portHint') : undefined">
              <template #action>
                <button
                  type="button"
                  class="text-[11px] text-emerald-600 dark:text-emerald-400 hover:underline"
                  @click="isPortEditable ? resetPort() : (isPortEditable = true)"
                >{{ isPortEditable ? t('createDatabase.portReset') : t('common.edit') }}</button>
              </template>
              <input id="new-db-port" v-model.number="form.port" type="number" min="1024" max="65535" :disabled="!isPortEditable" :class="monoInputClass" />
            </FormField>
          </div>
        </div>

        <p class="flex items-start gap-2 text-[12px] text-gray-500 dark:text-zinc-400">
          <svg class="w-3.5 h-3.5 mt-px shrink-0 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {{ t('createDatabase.infoDesc') }}
        </p>
      </div>
    </template>

    <template #footer>
      <button type="button" :class="btnGhost" :disabled="isLoading" @click="close">{{ t('common.cancel') }}</button>
      <span class="flex-1" />
      <span class="hidden sm:inline text-[11px] text-gray-400 dark:text-zinc-500"><kbd class="font-mono">↵</kbd> Enter</span>
      <button type="button" :class="btnPrimary" :disabled="isLoading" @click="createDatabase">
        <svg v-if="isLoading" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        {{ t('createDatabase.create') }}
      </button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
/** Restore, step 2 of 2: type the database name to confirm, then restore (shared dialog shell). */
import { ref, computed, defineAsyncComponent } from 'vue';
import { getErrorMessage } from '../utils';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';
import AppModal from './ui/AppModal.vue';
import ModalHeading from './ui/ModalHeading.vue';
import FormField from './ui/FormField.vue';
import SwitchRow from './ui/SwitchRow.vue';
import { btnDanger, btnGhost, btnPrimary, monoInputClass, panelClass } from './ui/classes';
// three.js-based: loaded only when a restore runs
const RestoreAnimation = defineAsyncComponent(() => import('./RestoreAnimation.vue'));

const ICON_RESTORE = 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15';

const { t } = useI18n();
const { addToast } = useToast();

const isLoading = ref(false);
const confirmInput = ref('');
const error = ref('');
/** Back up the database before its content is replaced (an existing, saved database) */
const backupFirst = ref(true);
const phase = ref<'backup' | 'restore'>('restore');

const isNew = computed(() => !!store.restoreTargetDb?.isNew);
const canBackupFirst = computed(() => !isNew.value && !!store.restoreTargetDb?.id && store.databases.some(d => d.id === store.restoreTargetDb?.id));
const targetDbName = computed(() => store.restoreTargetDb?.name || '');
const isConfirmValid = computed(() => confirmInput.value.trim() === targetDbName.value);
const backupName = computed(() => (store.restoreBackupFile || '').split(/[\\/]/).pop() || '');
const steps = computed(() => [t('modal.restoreStepTarget'), t('modal.restoreStepConfirm')]);

const restore = async () => {
  if (isLoading.value) return;
  if (!isConfirmValid.value) {
    error.value = t('modal.restoreConfirmError');
    return;
  }
  if (!store.restoreBackupFile || !store.restoreTargetDb) {
    addToast(t('toasts.restoreMissingInput'), 'warning');
    return;
  }

  isLoading.value = true;
  error.value = '';

  try {
    const target = {
      name: store.restoreTargetDb.name,
      host: store.restoreTargetDb.host,
      port: store.restoreTargetDb.port,
      user: store.restoreTargetDb.user,
      password: store.restoreTargetDb.password,
      connectionString: store.restoreTargetDb.connectionString
    };

    // If it's a new database, create it first
    if (store.restoreTargetDb.isNew) {
      const createResult = await ipcRenderer.invoke('create-local-database', {
        name: store.restoreTargetDb.name,
        port: store.restoreTargetDb.port,
        password: store.restoreTargetDb.password,
        enabled: false // Explicitly disable automatic backups for restored databases
      });

      if (!createResult.success || !createResult.database) {
        throw new Error(createResult.error || t('toasts.databaseCreateFailed'));
      }

      // Update target info with created database details (like the correct user)
      target.user = createResult.database.user;
      target.password = createResult.database.password;

      // Ensure the newly created database is added to the active databases list in the UI
      const config = await ipcRenderer.invoke('get-config');
      store.databases = config.databases;

      // Mark as no longer "new" so it's treated as an existing DB from now on
      store.restoreTargetDb.isNew = false;
    }

    // Its current content is replaced: keep a backup of it first (stop if that fails)
    if (canBackupFirst.value && backupFirst.value) {
      phase.value = 'backup';
      const backup = await ipcRenderer.invoke('backup-now', store.restoreTargetDb.id) as { success: boolean; error?: string };
      if (!backup?.success) {
        addToast(t('restoreFlow.backupFailed', { name: target.name }), 'error', { detail: backup?.error });
        return;
      }
    }

    phase.value = 'restore';
    // The main process answers { success, error, warnings }: a failure is not thrown
    const result = await ipcRenderer.invoke('restore-backup', { backupFile: store.restoreBackupFile, target }) as { success: boolean; error?: string; warnings?: string[] };
    if (!result?.success) {
      addToast(t('restoreFlow.failed', { name: target.name }), 'error', { detail: result?.error });
      return;
    }
    if (result.warnings?.length) {
      addToast(t('restoreFlow.doneWithErrors', { name: target.name }), 'warning', { detail: result.warnings.join('\n') });
    } else {
      addToast(t('restoreFlow.done', { name: target.name }), 'success');
    }
    isLoading.value = false;
    close();
  } catch (err) {
    addToast(t('toasts.restoreStartError'), 'error', { detail: getErrorMessage(err) });
  } finally {
    isLoading.value = false;
  }
};

/** Back to step 1 with the same file and target */
const back = () => {
  if (isLoading.value) return;
  store.showRestoreConfirmModal = false;
  store.showRestoreModal = true;
};

const close = () => {
  if (isLoading.value) return;
  store.showRestoreConfirmModal = false;
  store.restoreBackupFile = null;
  store.restoreTargetDb = null;
  confirmInput.value = '';
  error.value = '';
};
</script>

<template>
  <AppModal
    :title="t('modal.restoreTitle')"
    :icon="ICON_RESTORE"
    :tone="isNew ? 'default' : 'danger'"
    :steps="steps"
    :step="1"
    :busy="isLoading"
    :close-label="t('common.cancel')"
    @close="close"
    @submit="restore"
  >
    <!-- Running -->
    <div v-if="isLoading" class="flex flex-col items-center justify-center py-4" role="status" aria-live="polite">
      <RestoreAnimation />
      <p class="mt-4 text-[13px] text-gray-500 dark:text-zinc-400 animate-pulse">{{ phase === 'backup' ? t('restoreFlow.backingUp', { name: targetDbName }) : t('modal.titleProgress') }}</p>
    </div>

    <template v-else>
      <ModalHeading
        :eyebrow="t('modal.restoreEyebrow')"
        :title="isNew ? t('modal.restoreConfirmCreateTitle') : t('modal.restoreConfirmTitle')"
        :subtitle="isNew ? t('modal.restoreConfirmCreateMessage', { name: targetDbName }) : t('modal.restoreConfirmMessage')"
      />
      <div class="space-y-4">
        <!-- Backup → target -->
        <div :class="panelClass" class="px-3.5 py-2.5 flex items-center gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-[11px] text-gray-500 dark:text-zinc-400">{{ t('modal.restoreSource') }}</div>
            <div class="font-mono text-[12px] text-gray-800 dark:text-zinc-200 overflow-hidden text-ellipsis whitespace-nowrap" :title="store.restoreBackupFile || undefined">{{ backupName }}</div>
          </div>
          <svg class="w-4 h-4 shrink-0 text-gray-300 dark:text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
          <div class="min-w-0 flex-1 text-right">
            <div class="text-[11px] text-gray-500 dark:text-zinc-400">{{ t('modal.restoreTarget') }}</div>
            <div class="font-mono text-[13px] overflow-hidden text-ellipsis whitespace-nowrap" :class="isNew ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'">{{ targetDbName }}</div>
            <div class="font-mono text-[11px] text-gray-500 dark:text-zinc-500">{{ store.restoreTargetDb?.host }}:{{ store.restoreTargetDb?.port }}</div>
          </div>
        </div>

        <FormField :label="t('modal.typeToConfirmLabel', { name: targetDbName })" for="restore-confirm" :error="error">
          <input
            id="restore-confirm"
            v-model="confirmInput"
            type="text"
            spellcheck="false"
            autocomplete="off"
            :class="[monoInputClass, isConfirmValid ? '!border-emerald-500' : '']"
            :placeholder="targetDbName"
            @input="error = ''"
          />
        </FormField>

        <p
          class="flex items-start gap-2 text-[12px] leading-relaxed"
          :class="isNew ? 'text-gray-500 dark:text-zinc-400' : 'text-red-700 dark:text-red-400'"
        >
          <svg class="w-3.5 h-3.5 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          {{ isNew ? t('modal.restoreConfirmCreateWarning') : t('restoreFlow.replaceWarning', { name: targetDbName }) }}
        </p>

        <SwitchRow
          v-if="canBackupFirst"
          v-model="backupFirst"
          :title="t('restoreFlow.backupFirst', { name: targetDbName })"
          :description="t('restoreFlow.backupFirstHint')"
        />
      </div>
    </template>

    <template #footer>
      <button type="button" :class="btnGhost" :disabled="isLoading" @click="back">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        {{ t('database.wizard.previous') }}
      </button>
      <span class="flex-1" />
      <button
        type="button"
        :class="isNew ? btnPrimary : btnDanger"
        :disabled="isLoading || !isConfirmValid"
        @click="restore"
      >
        {{ isNew ? t('modal.restoreConfirmCreateButton') : t('modal.restoreConfirmButton') }}
      </button>
    </template>
  </AppModal>
</template>

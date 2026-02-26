<script setup lang="ts">
import { useI18n } from '../composables/useI18n';
import { Database } from '../types';
import { store } from '../store';
import { useConfirm } from '../composables/useConfirm';
import BackupAnimation from './BackupAnimation.vue';
import NewDbAnimation from './NewDbAnimation.vue';

const props = defineProps<{
  db: Database;
}>();

const onDragStart = (event: DragEvent) => {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-bbdump-db-reorder', props.db.id);
};

const emit = defineEmits<{
  (e: 'backup', db: Database): void;
  (e: 'view', db: Database): void;
  (e: 'duplicate', db: Database): void;
  (e: 'disconnect', db: Database): void;
  (e: 'edit', db: Database): void;
  (e: 'delete', db: Database): void;
  (e: 'copy-url', db: Database): void;
  (e: 'addons', db: Database): void;
  (e: 'toggle-mask', db: Database): void;
}>();

const { t } = useI18n();
const { showConfirm } = useConfirm();

const getBackupStatusTitle = (enabled: boolean | undefined) => {
  return enabled ? 'Backup Enabled' : 'Backup Paused';
};

const getLastBackupDate = (dateParam: string | Date | undefined) => {
    if (!dateParam) return t('databases.never');
    try {
        const date = new Date(dateParam);
        if (isNaN(date.getTime())) return t('databases.never');
        return date.toLocaleDateString();
    } catch {
        return t('databases.never');
    }
};

const handleStatusClick = () => {
  store.editingDatabase = props.db;
  store.modalTargetSection = 'schedule';
  store.showDatabaseModal = true;
};

const handleBackupClick = () => {
  showConfirm({
    title: t('modal.backupConfirmTitle'),
    message: t('modal.backupConfirmMessage', { name: props.db.displayName || props.db.name }),
    confirmText: t('db.backupNow'),
    type: 'info',
    onConfirm: () => {
      emit('backup', props.db);
    }
  });
};
</script>

<template>
  <div
    draggable="true"
    @dragstart="onDragStart"
    class="group relative bg-white dark:bg-zinc-900 rounded-2xl p-6 border transition-all duration-500 hover:shadow-2xl hover:-translate-y-2 cursor-grab active:cursor-grabbing"
    :class="[
      db.isLocalBbdump 
        ? 'border-blue-100/50 dark:border-blue-900/20 hover:border-blue-400 dark:hover:border-blue-600' 
        : 'border-indigo-100/50 dark:border-indigo-900/30 hover:border-indigo-400 dark:hover:border-indigo-600'
    ]"
    style="transform-style: preserve-3d;"
  >
    <!-- Status Indicator -->
    <div class="absolute top-4.5 right-6">
      <button 
        @click.stop="handleStatusClick"
        :class="[
          'text-[8px] cursor-pointer font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border transition-all duration-300 hover:scale-105 active:scale-95',
          db.enabled 
            ? 'text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 hover:bg-emerald-100 dark:hover:bg-emerald-900/50' 
            : 'text-gray-400 dark:text-gray-500 border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-900/50 hover:bg-gray-100 dark:hover:bg-gray-800/50'
        ]"
        :title="getBackupStatusTitle(db.enabled)"
      >
        {{ db.enabled ? t('databases.backupUp') : t('databases.backupDown') }}
      </button>
    </div>
    
    <!-- Local Badge -->
    <div v-if="db.isLocalBbdump" class="absolute top-6 left-6">
      <span class="px-1.5 py-0.5 text-[10px] font-semibold bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 rounded-lg flex items-center gap-1">
        <svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
        {{ t('databases.localBbdump') }}
      </span>
    </div>

    <!-- Animation Overlay (covers entire card) -->
    <div v-if="store.newlyAddedDbId === db.id" class="absolute inset-0 z-50 rounded-2xl overflow-hidden pointer-events-none">
      <NewDbAnimation />
    </div>

    <!-- Content -->
    <div v-if="store.backupProgress?.dbId === db.id" class="h-32 mb-6 flex items-center justify-center mt-8">
      <BackupAnimation />
    </div>

    <div v-else class="mb-4" :class="{ 'mt-8': db.isLocalBbdump }">
      <div class="flex items-center gap-2 mb-1">
        <button
          @click="emit('copy-url', db)"
          class="p-1 hover:bg-surface rounded transition-colors shrink-0"
          :title="t('databases.copyUrl')"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>
        <h3 class="text-lg font-bold truncate">{{ db.masked ? '••••••••' : (db.displayName || db.name) }}</h3>
        <button
          @click="emit('toggle-mask', db)"
          class="p-1 rounded transition-colors shrink-0"
          :class="db.masked ? 'text-purple-500 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20' : 'text-gray-400 hover:text-gray-600 hover:bg-surface'"
          :title="db.masked ? t('cardAction.unmask') : t('cardAction.mask')"
        >
          <!-- weui:eyes-on-filled (masked → show open eye to unmask) -->
          <svg v-if="db.masked" class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path fill-rule="evenodd" d="M1 12c2.028-4.152 6.192-7 11-7s8.972 2.848 11 7c-2.028 4.152-6.192 7-11 7s-8.972-2.848-11-7m11 3.5a3.5 3.5 0 1 0 0-7a3.5 3.5 0 0 0 0 7" />
          </svg>
          <!-- weui:eyes-off-filled (not masked → show barred eye to mask) -->
          <svg v-else class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path fill-rule="evenodd" d="m18.922 16.8l3.17 3.17l-1.06 1.061L4.06 4.061L5.12 3l2.74 2.738A11.9 11.9 0 0 1 12 5c4.808 0 8.972 2.848 11 7a12.66 12.66 0 0 1-4.078 4.8m-8.098-8.097l4.473 4.473a3.5 3.5 0 0 0-4.474-4.474zm5.317 9.56A11.9 11.9 0 0 1 12 19c-4.808 0-8.972-2.848-11-7a12.66 12.66 0 0 1 4.078-4.8l3.625 3.624a3.5 3.5 0 0 0 4.474 4.474l2.964 2.964z" />
          </svg>
        </button>
      </div>
      <div class="mt-4 flex items-center gap-2 text-xs font-medium px-1.5 py-0.5 bg-surface rounded-full w-fit">
        <span class="text-gray-400">{{ t('databases.lastBackup') }}:</span>
        <span>{{ getLastBackupDate(db.lastBackup) }}</span>
      </div>
    </div>

    <!-- Actions -->
    <div class="grid grid-cols-5 gap-1 pt-2 border-t border-border opacity-80 group-hover:opacity-100 transition-opacity">
      <button
        @click="handleBackupClick"
        class="p-1.5 rounded-lg hover:bg-surface text-gray-500 hover:text-foreground transition-colors flex flex-col items-center gap-0.5"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
        </svg>
        <span class="text-[9px] font-medium leading-tight">{{ t('cardAction.backup') }}</span>
      </button>
      <button
        @click="emit('view', db)"
        class="p-1.5 rounded-lg hover:bg-surface text-gray-500 hover:text-foreground transition-colors flex flex-col items-center gap-0.5"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
        <span class="text-[9px] font-medium leading-tight">{{ t('cardAction.view') }}</span>
      </button>

      <button
        v-if="!db.isLocalBbdump"
        @click="emit('duplicate', db)"
        class="p-1.5 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors flex flex-col items-center gap-0.5"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
        </svg>
        <span class="text-[9px] font-medium leading-tight">{{ t('cardAction.duplicate') }}</span>
      </button>

      <button
        v-if="db.isLocalBbdump"
        @click="emit('disconnect', db)"
        class="p-1.5 rounded-lg hover:bg-yellow-50 dark:hover:bg-yellow-900/20 text-gray-500 hover:text-yellow-600 dark:hover:text-yellow-400 transition-colors flex flex-col items-center gap-0.5"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
        </svg>
        <span class="text-[9px] font-medium leading-tight">{{ t('cardAction.hide') }}</span>
      </button>

      <button
        @click="emit('edit', db)"
        class="p-1.5 rounded-lg hover:bg-surface text-gray-500 hover:text-foreground transition-colors flex flex-col items-center gap-0.5"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
        <span class="text-[9px] font-medium leading-tight">{{ t('cardAction.edit') }}</span>
      </button>

      <button
        @click="emit('delete', db)"
        class="p-1.5 rounded-lg hover:bg-red-50 text-gray-500 hover:text-red-600 transition-colors flex flex-col items-center gap-0.5"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
        <span class="text-[9px] font-medium leading-tight">{{ t('cardAction.delete') }}</span>
      </button>
    </div>
  </div>
</template>

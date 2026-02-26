<script setup lang="ts">
import { useI18n } from '../composables/useI18n';
import { Database } from '../types';
import { store } from '../store';
import { useConfirm } from '../composables/useConfirm';

const props = defineProps<{
  db: Database;
  projectId?: string | null;
  size?: number | null;
}>();

const formatSize = (bytes: number | null | undefined): string => {
  if (!bytes || bytes <= 0) return '';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + sizes[i];
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

const onDragStart = (event: DragEvent) => {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-bbdump-db', JSON.stringify({
    databaseId: props.db.id,
    sourceProjectId: props.projectId ?? null,
  }));
};
</script>

<template>
  <div
    draggable="true"
    @dragstart="onDragStart"
    class="flex items-center gap-3 px-4 py-2.5 bg-white dark:bg-zinc-900 rounded-xl border border-gray-100 dark:border-zinc-800 hover:border-gray-300 dark:hover:border-zinc-600 transition-all duration-200 hover:shadow-md cursor-grab active:cursor-grabbing"
  >
    <!-- Backup status dot -->
    <div
      class="w-2 h-2 rounded-full shrink-0"
      :class="db.enabled ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'"
      :title="db.enabled ? t('databases.backupUp') : t('databases.backupDown')"
    />

    <!-- Name -->
    <div class="flex items-center gap-1.5 min-w-0 flex-1">
      <span class="text-sm font-semibold truncate">
        {{ db.masked ? '••••••••' : (db.displayName || db.name) }}
      </span>
      <span v-if="db.isLocalBbdump" class="text-[9px] px-1 py-0.5 bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 rounded font-medium shrink-0">
        local
      </span>
      <span v-if="formatSize(size)" class="text-[10px] text-gray-400 dark:text-gray-500 shrink-0">
        {{ formatSize(size) }}
      </span>
    </div>

    <!-- Backup in progress indicator -->
    <div v-if="store.backupProgress?.dbId === db.id" class="shrink-0">
      <svg class="w-4 h-4 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
    </div>

    <!-- Separator -->
    <div class="w-px h-5 bg-gray-200 dark:bg-zinc-700 shrink-0"></div>

    <!-- Actions (always visible) -->
    <div class="flex items-center gap-0.5 shrink-0">
      <button
        @click.stop="emit('copy-url', db)"
        class="px-1.5 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-400 hover:text-foreground transition-colors flex items-center gap-1"
        :title="t('databases.copyUrl')"
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
        <span class="text-[9px] font-medium">URL</span>
      </button>
      <button
        @click.stop="handleBackupClick"
        class="px-1.5 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-400 hover:text-foreground transition-colors flex items-center gap-1"
        :title="t('cardAction.backup')"
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
        </svg>
        <span class="text-[9px] font-medium">{{ t('cardAction.backup') }}</span>
      </button>
      <button
        @click.stop="emit('view', db)"
        class="px-1.5 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-400 hover:text-foreground transition-colors flex items-center gap-1"
        :title="t('cardAction.view')"
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
        <span class="text-[9px] font-medium">{{ t('cardAction.view') }}</span>
      </button>
      <button
        @click.stop="emit('edit', db)"
        class="px-1.5 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-400 hover:text-foreground transition-colors flex items-center gap-1"
        :title="t('cardAction.edit')"
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
        <span class="text-[9px] font-medium">{{ t('cardAction.edit') }}</span>
      </button>
      <button
        @click.stop="emit('delete', db)"
        class="px-1.5 py-1 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-400 hover:text-red-500 transition-colors flex items-center gap-1"
        :title="t('cardAction.delete')"
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
        <span class="text-[9px] font-medium">{{ t('cardAction.delete') }}</span>
      </button>
    </div>
  </div>
</template>

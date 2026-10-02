<script setup lang="ts">
import { useI18n } from '../composables/useI18n';
import { Database } from '../types';
import { store, isRemoteOnly } from '../store';
import { useConfirm } from '../composables/useConfirm';
import { computed } from 'vue';
import ActionMenu, { type ActionMenuItem } from './ActionMenu.vue';

const props = defineProps<{
  db: Database;
  projectId?: string | null;
  size?: number | null;
  proxyEnabled?: boolean;
  isProxyTarget?: boolean;
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
  (e: 'set-proxy-target'): void;
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

// Same actions and labels as before 1.1, in the same order (Delete / Disconnect last)
const ICONS = {
  url: 'M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z',
  duplicate: 'M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2',
  edit: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
  delete: 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16',
  plug: 'M12 22v-5M9 8V2m6 6V2m3 6v5a4 4 0 01-4 4h-4a4 4 0 01-4-4V8z',
  history: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  sync: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
  puzzle: 'M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z',
  disconnect: 'M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25',
};

/** A database of the local server, at an address of this computer (TCP loopback or Unix socket) */
const isOnThisComputer = computed(() => !!props.db.isLocalBbdump
  && (['localhost', '127.0.0.1', '::1'].includes((props.db.host || '').toLowerCase()) || (props.db.host || '').startsWith('/')));

/** Other databases in this database's project (the sources "Update from…" can use) */
const projectSiblings = computed(() => {
  const project = props.projectId ? store.projects.find(p => p.id === props.projectId) : null;
  return (project?.databaseIds ?? []).filter(id => id !== props.db.id && store.databases.some(d => d.id === id)).length;
});

const menuItems = computed<ActionMenuItem[]>(() => [
  // Behind SSH there is no URL another app could use (the project proxy is the way)
  ...(props.db.ssh ? [] : [{ key: 'copy-url', label: t('databases.copyUrl'), icon: ICONS.url }]),
  // Duplicate to a local database (needs a local server)
  ...(!isRemoteOnly() ? [{ key: 'duplicate', label: t('cardAction.duplicate'), icon: ICONS.duplicate }] : []),
  { key: 'edit', label: t('cardAction.edit'), icon: ICONS.edit },
  // Extensions of a database on the local server
  ...(props.db.isLocalBbdump && !isRemoteOnly() ? [{ key: 'addons', label: t('postgresConfig.extensions'), icon: ICONS.puzzle }] : []),
  // A local database can catch up with another database of its project (e.g. prod)
  // Never for a remote database: local server flag AND an address on this computer
  ...(isOnThisComputer.value && !isRemoteOnly() && projectSiblings.value > 0 ? [{ key: 'sync', label: t('sync.menu'), icon: ICONS.sync }] : []),
  // Changes made by AI clients through MCP, and their undo
  { key: 'ai-journal', label: t('aiJournal.title'), icon: ICONS.history },
  // Proxy on in the project: route it to this database from here too
  ...(props.proxyEnabled && !props.isProxyTarget ? [{ key: 'proxy-target', label: t('proxy.setTarget'), icon: ICONS.plug }] : []),
  props.db.isLocalBbdump
    ? { key: 'delete', label: t('cardAction.deleteFull'), icon: ICONS.delete, tone: 'danger', separated: true }
    : { key: 'disconnect', label: t('databases.disconnect'), icon: ICONS.disconnect, tone: 'warning', separated: true },
]);

const onMenu = (key: string) => {
  if (key === 'copy-url') emit('copy-url', props.db);
  else if (key === 'duplicate') emit('duplicate', props.db);
  else if (key === 'edit') emit('edit', props.db);
  else if (key === 'addons') emit('addons', props.db);
  else if (key === 'ai-journal') store.aiJournalDb = props.db;
  else if (key === 'sync') store.syncTargetDb = props.db;
  else if (key === 'proxy-target') emit('set-proxy-target');
  else if (key === 'delete') emit('delete', props.db);
  else if (key === 'disconnect') emit('disconnect', props.db);
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
    class="flex items-center gap-3 px-4 py-2.5 bg-white dark:bg-zinc-900 rounded-xl border transition-all duration-200 hover:shadow-md cursor-grab active:cursor-grabbing"
    :class="proxyEnabled && isProxyTarget
      ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/30 dark:bg-emerald-950/20 hover:border-emerald-400 dark:hover:border-emerald-600'
      : 'border-gray-100 dark:border-zinc-800 hover:border-gray-300 dark:hover:border-zinc-600'"
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
      <span
        v-else-if="db.ssh"
        class="text-[9px] px-1 py-0.5 bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 rounded font-medium shrink-0 font-mono"
        :title="t('ssh.badgeTitle', { host: db.ssh.host })"
      >ssh · {{ db.masked ? '••••' : db.ssh.host }}</span>
      <span v-else class="text-[9px] px-1 py-0.5 bg-gray-100 dark:bg-zinc-700 text-gray-500 dark:text-gray-400 rounded font-medium shrink-0">
        external
      </span>
      <!-- The project proxy routes here -->
      <span
        v-if="proxyEnabled && isProxyTarget"
        class="flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 font-medium shrink-0"
        :title="t('proxy.activeTarget')"
      >
        <svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" :d="ICONS.plug" />
        </svg>
        proxy
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

    <!-- Actions: the two frequent ones stay visible, the rest is in the ⋯ menu -->
    <div class="flex items-center gap-0.5 shrink-0">
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
      <ActionMenu :items="menuItems" :label="t('cardAction.more')" @select="onMenu" />
    </div>
  </div>
</template>

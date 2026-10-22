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
  mask: 'M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21',
  chart: 'M4 20h16M7 16v-5m5 5V6m5 10V8',
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
  // A dashboard of this database, made with the AI
  { key: 'dashboard', label: t('dashboards.fromDatabase'), icon: ICONS.chart },
  // Changes made by AI clients through MCP, and their undo
  { key: 'ai-journal', label: t('aiJournal.title'), icon: ICONS.history },
  // Personal data masked in what AI clients read
  { key: 'ai-masking', label: t('aiMasking.menu'), icon: ICONS.mask },
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
  else if (key === 'dashboard') {
    store.openDashboard = null;
    store.newDashboardDb = props.db;
    store.activeTab = 'boards';
  }
  else if (key === 'ai-masking') store.aiMaskingDb = props.db;
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
      <span
        v-if="store.aiMaskedIds.includes(db.id)"
        class="flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300 font-medium shrink-0"
        :title="t('aiMasking.badgeTitle')"
      >
        <svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" :d="ICONS.mask" />
        </svg>
        {{ t('aiMasking.badge') }}
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
        class="card-backup px-1.5 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-400 hover:text-foreground transition-colors flex items-center gap-1"
        :title="t('cardAction.backup')"
      >
        <svg class="card-backup-icon w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3" />
          <!-- The arrow drops into the tray on hover -->
          <path class="card-backup-arrow" stroke-linecap="round" stroke-linejoin="round" d="M15 11l-3 3m0 0l-3-3m3 3V4" />
        </svg>
        <span class="text-[9px] font-medium">{{ t('cardAction.backup') }}</span>
      </button>
      <button
        @click.stop="emit('view', db)"
        class="card-view px-1.5 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-400 hover:text-foreground transition-colors flex items-center gap-1"
        :title="t('cardAction.view')"
      >
        <!-- The eye blinks on hover -->
        <svg class="card-view-icon w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <g class="card-view-eye">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </g>
        </svg>
        <span class="text-[9px] font-medium">{{ t('cardAction.view') }}</span>
      </button>
      <!-- Ask the AI about this database (read only) -->
      <button
        @click.stop="store.aiChatDb = db"
        class="card-ai px-1.5 py-1 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-950/30 text-gray-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors flex items-center gap-1"
        :title="t('chat.menu')"
      >
        <svg class="card-ai-icon w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <!-- A messenger bubble with its three dots -->
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 01-.923 1.785A5.969 5.969 0 006 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337z" />
          <path class="card-ai-dots" stroke-linecap="round" stroke-width="2.6" d="M8.25 12h.01M12 12h.01M15.75 12h.01" />
        </svg>
        <span class="text-[9px] font-medium">{{ t('cardAction.ai') }}</span>
      </button>
      <ActionMenu :items="menuItems" :label="t('cardAction.more')" @select="onMenu" />
    </div>
  </div>
</template>

<style scoped>
.card-ai-icon { transform-origin: 30% 90%; transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); }
.card-ai:hover .card-ai-icon { transform: rotate(-10deg) scale(1.15); }
.card-ai:hover .card-ai-dots { animation: card-ai-typing 0.9s ease-in-out infinite; }
@keyframes card-ai-typing { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }

/* Backup: the icon lifts, its arrow keeps dropping into the tray */
.card-backup-icon { transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); }
.card-backup:hover .card-backup-icon { transform: scale(1.15); }
.card-backup:hover .card-backup-arrow { animation: card-backup-drop 1s cubic-bezier(0.45, 0, 0.2, 1) infinite; }
@keyframes card-backup-drop {
  0% { transform: translateY(-3px); opacity: 0; }
  25% { opacity: 1; }
  60% { transform: translateY(1.5px); }
  80%, 100% { transform: translateY(0); opacity: 1; }
}

/* View: the icon leans in, the eye blinks */
.card-view-icon { transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); }
.card-view:hover .card-view-icon { transform: scale(1.15); }
.card-view-eye { transform-box: view-box; transform-origin: 12px 12px; }
.card-view:hover .card-view-eye { animation: card-view-blink 1.8s ease-in-out infinite; }
@keyframes card-view-blink {
  0%, 40%, 52%, 100% { transform: scaleY(1); }
  46% { transform: scaleY(0.1); }
}

@media (prefers-reduced-motion: reduce) {
  .card-ai:hover .card-ai-icon, .card-backup:hover .card-backup-icon, .card-view:hover .card-view-icon { transform: none; }
  .card-ai:hover .card-ai-dots, .card-backup:hover .card-backup-arrow, .card-view:hover .card-view-eye { animation: none; }
}
</style>

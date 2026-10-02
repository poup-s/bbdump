<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { store, isRemoteOnly } from '../store';
import { Database, Project } from '../types';
import DatabaseCardCompact from './DatabaseCardCompact.vue';

const props = defineProps<{
  project: Project;
  databases: Database[];
  dbSizes?: Record<string, number | null>;
  proxyStatus?: { running: boolean; port: number; activeConnections: number } | null;
}>();

const emit = defineEmits<{
  (e: 'edit', project: Project): void;
  (e: 'delete', project: Project): void;
  (e: 'toggle-project-mask', project: Project): void;
  (e: 'move-db-to-project', databaseId: string, targetProjectId: string): void;
  (e: 'backup', db: Database): void;
  (e: 'view', db: Database): void;
  (e: 'duplicate', db: Database): void;
  (e: 'edit-db', db: Database): void;
  (e: 'delete-db', db: Database): void;
  (e: 'disconnect', db: Database): void;
  (e: 'copy-url', db: Database): void;
  (e: 'addons', db: Database): void;
  (e: 'toggle-mask', db: Database): void;
  (e: 'proxy-toggle', project: Project): void;
  (e: 'set-proxy-target', projectId: string, dbId: string): void;
  (e: 'show-proxy-logs', projectId: string): void;
  (e: 'update-proxy-config', projectId: string, config: { port?: number }): void;
}>();

const { t } = useI18n();
const { addToast } = useToast();
const collapsed = ref(props.project.collapsed || false);
const isDragOver = ref(false);
const proxyPanelOpen = ref(false);
const editingPort = ref(false);
const portInput = ref('');
const portError = ref('');

// Slugify: project name → URL-safe default
const slugify = (s: string) => s.toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const slugifiedName = computed(() => slugify(props.project.name));
const effectivePort = computed(() => props.proxyStatus?.port || props.project.proxyPort || 0);

// Proxy state: disabled | needs-target | running | stopped
const proxyState = computed(() => {
  if (!props.project.proxyEnabled) return 'disabled';
  if (!props.project.proxyTargetDbId) return 'needs-target';
  if (props.proxyStatus?.running) return 'running';
  return 'stopped';
});

/** Database the proxy routes to (shown in the header pill and the switch) */
const proxyTarget = computed(() => props.databases.find(db => db.id === props.project.proxyTargetDbId) ?? null);
const dbLabel = (db: Database) => (db.masked ? '••••••••' : (db.displayName || db.name));

// Needs a target: open the switch so the choice is right there
watch(proxyState, (state) => {
  if (state === 'needs-target') {
    proxyPanelOpen.value = true;
    collapsed.value = false;
  }
}, { immediate: true });

const toggleProxyPanel = () => {
  proxyPanelOpen.value = !proxyPanelOpen.value;
  if (proxyPanelOpen.value) collapsed.value = false;
};

// Auto-expand panel and project when proxy is first enabled
watch(() => props.project.proxyEnabled, (newVal, oldVal) => {
  if (newVal && !oldVal) {
    proxyPanelOpen.value = true;
    collapsed.value = false;
  }
});

const proxyConnectionString = () => {
  if (!effectivePort.value) return '';
  const slug = slugifiedName.value;
  return `postgresql://${slug}:${slug}@localhost:${effectivePort.value}/${slug}`;
};

const copyProxyUrl = () => {
  const connStr = proxyConnectionString();
  if (connStr) {
    navigator.clipboard.writeText(connStr);
    addToast(t('proxy.urlCopied'), 'success');
  }
};

// Port editing
const startEditPort = () => {
  portInput.value = String(effectivePort.value || '');
  portError.value = '';
  editingPort.value = true;
};

const cancelEditPort = () => {
  editingPort.value = false;
  portError.value = '';
};

const savePort = () => {
  const port = parseInt(portInput.value);
  if (isNaN(port) || port < 1024 || port > 65535) {
    portError.value = t('proxy.portInvalid');
    return;
  }
  editingPort.value = false;
  portError.value = '';
  emit('update-proxy-config', props.project.id, { port });
};

const toggle = () => {
  collapsed.value = !collapsed.value;
};

// --- Drag: project header (for reordering) ---
const onProjectDragStart = (event: DragEvent) => {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-bbdump-project', props.project.id);
};

// --- Drop zone: receive databases ---
const onDragOver = (event: DragEvent) => {
  if (!event.dataTransfer?.types.includes('application/x-bbdump-db')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  isDragOver.value = true;
};

const onDragLeave = (event: DragEvent) => {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const { clientX, clientY } = event;
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    isDragOver.value = false;
  }
};

const onDrop = (event: DragEvent) => {
  event.preventDefault();
  isDragOver.value = false;
  const data = event.dataTransfer?.getData('application/x-bbdump-db');
  if (!data) return;
  const { databaseId, sourceProjectId } = JSON.parse(data);
  if (sourceProjectId === props.project.id) return;
  emit('move-db-to-project', databaseId, props.project.id);
};
</script>

<template>
  <div
    class="mb-6 rounded-xl transition-all duration-200"
    :class="{ 'ring-2 ring-blue-400 ring-offset-2 ring-offset-white dark:ring-offset-zinc-900 bg-blue-50/50 dark:bg-blue-900/10': isDragOver }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Project Header (draggable for reorder) -->
    <div
      draggable="true"
      @dragstart.stop="onProjectDragStart"
      class="flex items-center justify-between px-4 py-3 rounded-xl cursor-grab active:cursor-grabbing select-none transition-colors hover:bg-gray-50 dark:hover:bg-zinc-800/50"
      @click="toggle"
    >
      <div class="flex items-center gap-3">
        <!-- Color dot -->
        <div
          class="w-3 h-3 rounded-full shrink-0"
          :class="project.color.startsWith('custom:') ? '' : project.color"
          :style="project.color.startsWith('custom:') ? { backgroundColor: project.color.replace('custom:', '') } : {}"
        />
        <!-- Name -->
        <h3 class="text-lg font-semibold text-gray-700 dark:text-gray-300">{{ project.masked ? '••••••••' : project.name }}</h3>
        <!-- Mask toggle (right after name) -->
        <button
          @click.stop="emit('toggle-project-mask', project)"
          class="px-2 py-0.5 rounded-lg transition-colors flex items-center gap-1"
          :class="project.masked
            ? 'text-purple-500 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20'
            : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-zinc-700'"
          :title="project.masked ? t('cardAction.unmask') : t('cardAction.mask')"
        >
          <svg v-if="project.masked" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
            <path fill-rule="evenodd" d="M1 12c2.028-4.152 6.192-7 11-7s8.972 2.848 11 7c-2.028 4.152-6.192 7-11 7s-8.972-2.848-11-7m11 3.5a3.5 3.5 0 1 0 0-7a3.5 3.5 0 0 0 0 7" />
          </svg>
          <svg v-else class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
            <path fill-rule="evenodd" d="m18.922 16.8l3.17 3.17l-1.06 1.061L4.06 4.061L5.12 3l2.74 2.738A11.9 11.9 0 0 1 12 5c4.808 0 8.972 2.848 11 7a12.66 12.66 0 0 1-4.078 4.8m-8.098-8.097l4.473 4.473a3.5 3.5 0 0 0-4.474-4.474zm5.317 9.56A11.9 11.9 0 0 1 12 19c-4.808 0-8.972-2.848-11-7a12.66 12.66 0 0 1 4.078-4.8l3.625 3.624a3.5 3.5 0 0 0 4.474 4.474l2.964 2.964z" />
          </svg>
          <span class="text-[10px] font-medium">{{ project.masked ? t('cardAction.unmask') : t('cardAction.mask') }}</span>
        </button>
      </div>
      <div class="flex items-center gap-2">
        <!-- Proxy: off → a quiet button; on → a pill ":port → target" that opens the switch -->
        <button
          v-if="!project.proxyEnabled"
          @click.stop="emit('proxy-toggle', project)"
          class="px-2 py-1 rounded-lg text-gray-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors flex items-center gap-1"
          :title="t('proxy.enable')"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 22v-5M9 8V2m6 6V2m3 6v5a4 4 0 01-4 4h-4a4 4 0 01-4-4V8z" />
          </svg>
          <span class="text-[10px] font-medium">Proxy</span>
        </button>
        <button
          v-else
          @click.stop="toggleProxyPanel"
          class="proxy-pill flex items-center gap-1.5 pl-2.5 pr-1 py-0.5 rounded-full border text-[11px] transition-colors max-w-[260px]"
          :class="proxyState === 'running'
            ? 'border-emerald-200 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 hover:border-emerald-300'
            : proxyState === 'needs-target'
              ? 'border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 hover:border-amber-300'
              : 'border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800/60 text-gray-500 dark:text-gray-400 hover:border-gray-300'"
          :title="proxyState === 'running' ? t('proxy.statusRunning') : proxyState === 'needs-target' ? t('proxy.selectTargetFirst') : t('proxy.statusStopped')"
          :aria-expanded="proxyPanelOpen"
        >
          <span
            class="w-1.5 h-1.5 rounded-full shrink-0"
            :class="proxyState === 'running' ? 'bg-emerald-500 animate-pulse' : proxyState === 'needs-target' ? 'bg-amber-500 animate-pulse' : 'bg-gray-400'"
          />
          <span class="font-mono shrink-0">:{{ effectivePort || '—' }}</span>
          <svg class="w-3 h-3 shrink-0 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
          <span
            class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap rounded-full px-2 py-px"
            :class="proxyTarget ? 'bg-white dark:bg-zinc-900 text-gray-700 dark:text-gray-200' : 'italic'"
          >{{ proxyTarget ? dbLabel(proxyTarget) : t('proxy.pickTarget') }}</span>
          <svg
            class="w-3 h-3 shrink-0 mr-0.5 transition-transform duration-200"
            :class="proxyPanelOpen ? 'rotate-180' : ''"
            fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        <!-- Create DB in this project (needs a local server) -->
        <button
          v-if="!isRemoteOnly()"
          @click.stop="store.createDatabaseForProjectId = project.id; store.showCreateDatabaseModal = true"
          class="px-2 py-1 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 text-gray-400 hover:text-blue-500 transition-colors flex items-center gap-1"
          :title="t('modal.createDatabase')"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          <span class="text-[10px] font-medium">{{ t('project.addDb') }}</span>
        </button>
        <!-- Edit -->
        <button
          @click.stop="emit('edit', project)"
          class="px-2 py-1 rounded-lg hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors flex items-center gap-1"
          :title="t('project.editProject')"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          <span class="text-[10px] font-medium">{{ t('cardAction.edit') }}</span>
        </button>
        <!-- Delete -->
        <button
          @click.stop="emit('delete', project)"
          class="px-2 py-1 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-400 hover:text-red-500 transition-colors flex items-center gap-1"
          :title="t('project.deleteProject')"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          <span class="text-[10px] font-medium">{{ t('cardAction.delete') }}</span>
        </button>
        <!-- Chevron -->
        <svg
          class="w-5 h-5 text-gray-400 transition-transform duration-200"
          :class="{ '-rotate-90': collapsed }"
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </div>
    </div>

    <!-- Collapsible Content -->
    <div
      class="overflow-hidden transition-all duration-300 ease-in-out"
      :style="{ maxHeight: collapsed ? '0px' : '2000px', opacity: collapsed ? 0 : 1 }"
    >
      <!-- Proxy switch: your app → stable URL → the database it routes to -->
      <div
        v-if="project.proxyEnabled && proxyPanelOpen"
        class="mx-4 mb-3 mt-1 rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50/70 dark:bg-zinc-800/30 px-4 py-3 space-y-3"
        @click.stop
      >
        <div class="flex items-center gap-2.5 flex-wrap">
          <span class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 shrink-0">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            {{ t('proxy.yourApp') }}
          </span>
          <svg class="w-3.5 h-3.5 text-gray-300 dark:text-zinc-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
          <!-- Stable URL (click to copy) -->
          <button
            v-if="effectivePort"
            @click.stop="copyProxyUrl"
            class="group flex items-center gap-1.5 font-mono text-xs px-2 py-1 rounded-lg bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 hover:border-gray-300 dark:hover:border-zinc-600 transition-colors min-w-0"
            :title="t('proxy.copyUrl')"
          >
            <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-gray-600 dark:text-gray-300">
              <span class="opacity-50">postgresql://</span>{{ slugifiedName }}:{{ slugifiedName }}@localhost:<span class="font-semibold" :class="proxyStatus?.running ? 'text-emerald-600 dark:text-emerald-400' : ''">{{ effectivePort }}</span>/{{ slugifiedName }}
            </span>
            <svg class="w-3.5 h-3.5 shrink-0 text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
          <span v-else class="text-xs text-gray-400 italic">{{ t('proxy.configurePort') }}</span>
          <svg class="w-3.5 h-3.5 text-gray-300 dark:text-zinc-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
          <!-- Target: one click switches the database behind the URL -->
          <div
            role="radiogroup"
            :aria-label="t('proxy.targetPicker')"
            class="flex flex-wrap gap-1 p-1 rounded-lg bg-white dark:bg-zinc-900 border transition-colors"
            :class="proxyState === 'needs-target' ? 'border-amber-300 dark:border-amber-700 ring-2 ring-amber-200/60 dark:ring-amber-900/40' : 'border-gray-200 dark:border-zinc-700'"
          >
            <button
              v-for="db in databases"
              :key="db.id"
              type="button"
              role="radio"
              :aria-checked="project.proxyTargetDbId === db.id"
              class="px-2.5 py-1 rounded-md text-xs transition-colors"
              :class="project.proxyTargetDbId === db.id
                ? 'bg-emerald-500 text-white font-medium shadow-sm'
                : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800'"
              @click.stop="project.proxyTargetDbId !== db.id && emit('set-proxy-target', project.id, db.id)"
            >
              {{ dbLabel(db) }}
            </button>
            <span v-if="!databases.length" class="px-2 py-1 text-xs text-gray-400 italic">{{ t('project.noDatabases') }}</span>
          </div>
        </div>

        <!-- Status, port, logs, on/off -->
        <div class="flex items-center gap-3 flex-wrap text-xs text-gray-500 dark:text-gray-400">
          <span v-if="proxyState === 'running'" class="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            {{ t('proxy.statusRunning') }}
            <span class="font-normal text-gray-500 dark:text-gray-400">· {{ t('proxy.connections', { count: proxyStatus?.activeConnections ?? 0 }) }}</span>
          </span>
          <span v-else-if="proxyState === 'needs-target'" class="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
            <span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            {{ t('proxy.selectTargetHint') }}
          </span>
          <span v-else class="flex items-center gap-1.5">
            <span class="w-1.5 h-1.5 rounded-full bg-gray-400" />
            {{ t('proxy.statusStopped') }}
          </span>

          <!-- Port (inline edit) -->
          <span v-if="!editingPort" class="flex items-center gap-1">
            {{ t('proxy.portLabel') }}
            <span class="font-mono text-gray-700 dark:text-gray-300">{{ effectivePort || '—' }}</span>
            <button
              @click.stop="startEditPort"
              class="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
              :title="t('proxy.configurePort')"
            >
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          </span>
          <span v-else class="flex items-center gap-1.5">
            <label class="shrink-0">{{ t('proxy.portLabel') }}</label>
            <input
              v-model="portInput"
              type="number"
              min="1024"
              max="65535"
              :placeholder="t('proxy.portPlaceholder')"
              class="w-24 px-2 py-1 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-md text-xs font-mono focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              @input="portError = ''"
              @keydown.enter.stop="savePort"
              @keydown.escape.stop="cancelEditPort"
            />
            <button @click.stop="savePort" class="px-2 py-1 rounded-md text-xs text-white bg-blue-600 hover:bg-blue-700 font-medium">
              {{ t('proxy.saveConfig') }}
            </button>
            <button @click.stop="cancelEditPort" class="px-2 py-1 rounded-md text-xs text-gray-500 hover:bg-gray-200 dark:hover:bg-zinc-700">
              {{ t('common.cancel') }}
            </button>
            <span v-if="portError" class="text-red-500">{{ portError }}</span>
          </span>

          <button
            @click.stop="emit('show-proxy-logs', project.id)"
            class="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
            :title="t('proxy.activity.title')"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 10h16M4 14h10M4 18h6" />
            </svg>
            Logs
          </button>

          <span class="flex-1" />

          <!-- On / off (same switch as before, now with the proxy it controls) -->
          <button
            @click.stop="emit('proxy-toggle', project)"
            class="flex items-center gap-1.5"
            :title="t('proxy.disable')"
            role="switch"
            aria-checked="true"
          >
            <span class="text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">Proxy</span>
            <span class="relative w-8 h-[18px] rounded-full bg-emerald-500">
              <span class="absolute left-0 top-[2px] translate-x-[16px] w-[14px] h-[14px] rounded-full bg-white shadow-sm" />
            </span>
          </button>
        </div>
      </div>
      <div v-if="databases.length > 0" class="flex flex-col gap-1.5 mt-3 pl-6 pr-1">
        <DatabaseCardCompact
          v-for="db in databases"
          :key="db.id"
          :db="db"
          :project-id="project.id"
          :size="dbSizes?.[db.id]"
          :proxy-enabled="project.proxyEnabled || false"
          :is-proxy-target="project.proxyTargetDbId === db.id"
          @backup="emit('backup', $event)"
          @view="emit('view', $event)"
          @duplicate="emit('duplicate', $event)"
          @edit="emit('edit-db', $event)"
          @delete="emit('delete-db', $event)"
          @disconnect="emit('disconnect', $event)"
          @copy-url="emit('copy-url', $event)"
          @addons="emit('addons', $event)"
          @toggle-mask="emit('toggle-mask', $event)"
          @set-proxy-target="emit('set-proxy-target', project.id, db.id)"
        />
      </div>
      <div v-else class="text-center py-8 text-sm text-gray-400">
        {{ t('project.noDatabases') }}
      </div>
    </div>
  </div>
</template>

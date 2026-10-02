<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { getErrorMessage } from '../utils';
import { store, isRemoteOnly } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { ipcRenderer } from '../electron';
import { Database, Project, ProxyActivityEvent } from '../types';
import DatabaseCardCompact from './DatabaseCardCompact.vue';
import DuplicateDatabaseModal from './DuplicateDatabaseModal.vue';
import ProjectSection from './ProjectSection.vue';
import ProjectModal from './ProjectModal.vue';
import AppModal from './ui/AppModal.vue';
import { btnGhost, btnSecondary } from './ui/classes';
// ProxyPortModal removed — config is now inline in ProjectSection

const { t } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();

// Duplicate Modal State
const showDuplicateModal = ref(false);
const duplicateSourceDb = ref<Database | null>(null);
const duplicateSourceProjectId = ref<string | null>(null);

const openAddModal = () => {
  store.editingDatabase = null;
  store.showDatabaseModal = true;
};

const editDatabase = (db: Database) => {
  store.editingDatabase = JSON.parse(JSON.stringify(db)); // Deep copy
  store.showDatabaseModal = true;
};

const isSystemDatabase = (dbName: string) => {
  const systemDatabases = ['postgres', 'template0', 'template1'];
  return systemDatabases.includes(dbName);
};

const openDuplicateModal = (db: Database, projectId?: string | null) => {
  duplicateSourceDb.value = db;
  duplicateSourceProjectId.value = projectId ?? null;
  showDuplicateModal.value = true;
};

const onDuplicateSuccess = async (newDbName: string) => {
    // Refresh config
    const config = await ipcRenderer.invoke('get-config');
    store.databases = config.databases;

    // Find the newly added DB by name to get its id
    const newDb = store.databases.find((d) => d.name === newDbName);
    if (newDb) {
      store.newlyAddedDbId = newDb.id;
      setTimeout(() => {
        store.newlyAddedDbId = null;
      }, 2000);

      // If duplicated from a project, add the new DB to the same project
      if (duplicateSourceProjectId.value) {
        await moveDatabaseToProject(newDb.id, duplicateSourceProjectId.value);
      }
    }

    duplicateSourceProjectId.value = null;
}

const deleteDatabase = (db: Database) => {
  if (isSystemDatabase(db.name)) {
    addToast(t('databases.cannotDeleteSystemDatabase', { name: db.name }), 'warning');
    return;
  }
  
  const isLocal = db.isLocalBbdump;
  const confirmMessage = isLocal 
    ? t('modal.deleteConfirm', { name: db.name })
    : t('modal.deleteConnectionConfirm', { name: db.name });
  
  showConfirm({
    title: isLocal ? t('modal.deleteTitle') : t('modal.deleteConnectionTitle'),
    message: confirmMessage,
    confirmText: t('modal.deleteButton'),
    type: 'danger',
      onConfirm: async () => {
        try {
          // One toast per outcome: dropped, already gone, or kept on the server but removed from bbdump
          let outcome: 'deleted' | 'gone' | 'kept' = 'deleted';
          if (isLocal) {
            const result = await ipcRenderer.invoke('drop-postgres-database', db.name, db.port, true);
            if (!result.success) {
              const isNotFoundError = result.error && (
                result.error.includes('does not exist') || 
                result.error.includes('n\'existe pas')
              );
              
              if (isNotFoundError) {
                outcome = 'gone';
                addToast(t('databases.dbAlreadyDeleted', { name: db.name }), 'info');
              } else {
                outcome = 'kept';
                addToast(t('toasts.dropFailedRemoved', { name: db.name }), 'warning', { detail: result.error });
              }
            }
          }
          
          await ipcRenderer.invoke('remove-database', db.id);
          const config = await ipcRenderer.invoke('get-config');
          store.databases = config.databases;
          if (outcome === 'deleted') addToast(isLocal ? t('toasts.dbDeleted', { name: db.name }) : t('toasts.connectionDeleted', { name: db.displayName || db.name }), 'success');
        } catch (error) {
          addToast(t('toasts.databaseDeleteError'), 'error', { detail: getErrorMessage(error) });
        }
      }
  });
};

const backupNow = async (db: Database) => {
  try {
    store.isBackingUp = true;
    await ipcRenderer.invoke('backup-now', db.id);
  } catch (error) {
    store.isBackingUp = false;
    addToast(t('toasts.backupStartError'), 'error', { detail: getErrorMessage(error) });
  }
};

const openViewer = (db: Database) => {
  store.viewerDb = db;
  store.showDbViewer = true;
};

const copyConnectionUrl = async (db: Database) => {
  let url: string;
  if (db.connectionString) {
    // Use the existing connection string if available
    url = db.connectionString;
  } else if (db.isLocalBbdump && window.electron?.platform === 'linux') {
    // On Linux, local databases use peer auth via Unix socket
    url = `postgresql://${db.user}@/${db.name}?host=/var/run/postgresql&port=${db.port}`;
  } else {
    url = `postgresql://${db.user}@${db.host}:${db.port}/${db.name}`;
  }
  try {
    await navigator.clipboard.writeText(url);
    addToast(t('databases.urlCopied'), 'success');
  } catch {
    addToast(t('toasts.urlCopyFailed'), 'error');
  }
};

const disconnectDatabase = async (db: Database) => {
  showConfirm({
    title: t('databases.disconnectTitle'),
    message: t('databases.disconnectMessage', { name: db.name }),
    confirmText: t('databases.disconnect'),
    type: 'warning',
    onConfirm: async () => {
      try {
        await ipcRenderer.invoke('remove-database', db.id);
        const config = await ipcRenderer.invoke('get-config');
        store.databases = config.databases;
        addToast(
          t('databases.databaseRemovedFromList', { name: db.name }),
          'success'
        );
      } catch (error) {
        addToast(t('toasts.databaseRemoveError'), 'error', { detail: getErrorMessage(error) });
      }
    }
  });
};

const toggleMask = async (db: Database) => {
  try {
    await ipcRenderer.invoke('toggle-mask', db.id, !db.masked);
    const config = await ipcRenderer.invoke('get-config');
    store.databases = config.databases;
  } catch (error) {
    addToast(t('toasts.maskToggleError'), 'error', { detail: getErrorMessage(error) });
  }
};

const openExtensions = (db: Database) => {
  store.extensionsModalDb = db;
  store.showExtensionsModal = true;
};

// --- Database sizes ---
const dbSizes = ref<Record<string, number | null>>({});

const fetchDatabaseSizes = async () => {
  for (const db of store.databases) {
    try {
      const size = await ipcRenderer.invoke('get-database-size', db.id);
      dbSizes.value[db.id] = size;
    } catch {
      dbSizes.value[db.id] = null;
    }
  }
};

// --- Project mode ---

const getProjectDatabases = (project: Project): Database[] => {
  const idSet = new Set(project.databaseIds);
  return store.databases.filter(db => idSet.has(db.id));
};

const ungroupedDatabases = computed(() => {
  const allProjectDbIds = new Set<string>();
  for (const p of store.projects) {
    for (const id of p.databaseIds) {
      allProjectDbIds.add(id);
    }
  }
  return store.databases.filter(db => !allProjectDbIds.has(db.id));
});

const openProjectModal = () => {
  store.editingProject = null;
  store.showProjectModal = true;
};

const editProject = (project: Project) => {
  store.editingProject = JSON.parse(JSON.stringify(project));
  store.showProjectModal = true;
};

const toggleProjectMask = async (project: Project) => {
  try {
    await ipcRenderer.invoke('toggle-project-mask', project.id, !project.masked);
    const config = await ipcRenderer.invoke('get-config');
    store.projects = config.projects || [];
    store.databases = config.databases || [];
  } catch (error) {
    addToast(t('toasts.projectMaskToggleError'), 'error', { detail: getErrorMessage(error) });
  }
};

// --- Ungrouped collapse ---
const ungroupedCollapsed = ref(false);
const toggleUngrouped = () => {
  ungroupedCollapsed.value = !ungroupedCollapsed.value;
};

// --- Drag & Drop ---
const isDraggingDb = ref(false);
const dragOverProjectId = ref<string | null>(null);
const dragOverPosition = ref<'above' | 'below' | null>(null);
const ungroupedDragOver = ref(false);

onMounted(() => {
  fetchDatabaseSizes();

  const onDragStartGlobal = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes('application/x-bbdump-db')) {
      isDraggingDb.value = true;
    }
  };
  const onDragEndGlobal = () => {
    isDraggingDb.value = false;
    dragOverProjectId.value = null;
    dragOverPosition.value = null;
    ungroupedDragOver.value = false;
  };
  document.addEventListener('dragstart', onDragStartGlobal);
  document.addEventListener('dragend', onDragEndGlobal);
});

const moveDatabaseToProject = async (databaseId: string, targetProjectId: string | null) => {
  try {
    const config = await ipcRenderer.invoke('move-database-to-project', databaseId, targetProjectId);
    store.projects = config.projects || [];
    addToast(t('project.databaseMoved'), 'success');
  } catch (error) {
    addToast(t('toasts.databaseMoveError'), 'error', { detail: getErrorMessage(error) });
  }
};

const onProjectDragOver = (event: DragEvent, projectId: string) => {
  if (!event.dataTransfer?.types.includes('application/x-bbdump-project')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  dragOverProjectId.value = projectId;
  dragOverPosition.value = event.clientY < midY ? 'above' : 'below';
};

const onProjectDragLeave = () => {
  dragOverProjectId.value = null;
  dragOverPosition.value = null;
};

const onProjectDrop = async (event: DragEvent, targetProjectId: string) => {
  event.preventDefault();
  const draggedProjectId = event.dataTransfer?.getData('application/x-bbdump-project');
  if (!draggedProjectId || draggedProjectId === targetProjectId) {
    dragOverProjectId.value = null;
    dragOverPosition.value = null;
    return;
  }
  const ids = store.projects.map(p => p.id);
  const fromIndex = ids.indexOf(draggedProjectId);
  if (fromIndex === -1) return;
  ids.splice(fromIndex, 1);
  const toIndex = ids.indexOf(targetProjectId);
  const insertAt = dragOverPosition.value === 'above' ? toIndex : toIndex + 1;
  ids.splice(insertAt, 0, draggedProjectId);

  dragOverProjectId.value = null;
  dragOverPosition.value = null;

  try {
    const config = await ipcRenderer.invoke('reorder-projects', ids);
    store.projects = config.projects || [];
  } catch (error) {
    addToast(t('toasts.projectsReorderError'), 'error', { detail: getErrorMessage(error) });
  }
};

const onUngroupedDragOver = (event: DragEvent) => {
  if (!event.dataTransfer?.types.includes('application/x-bbdump-db')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  ungroupedDragOver.value = true;
};

const onUngroupedDragLeave = (event: DragEvent) => {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const { clientX, clientY } = event;
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    ungroupedDragOver.value = false;
  }
};

const onUngroupedDrop = (event: DragEvent) => {
  event.preventDefault();
  ungroupedDragOver.value = false;
  const data = event.dataTransfer?.getData('application/x-bbdump-db');
  if (!data) return;
  const { databaseId, sourceProjectId } = JSON.parse(data);
  if (!sourceProjectId) return; // Already ungrouped
  moveDatabaseToProject(databaseId, null);
};

const deleteProject = (project: Project) => {
  showConfirm({
    title: t('project.deleteProject'),
    message: t('project.deleteConfirm', { name: project.name }),
    confirmText: t('common.delete'),
    type: 'danger',
    onConfirm: async () => {
      try {
        await ipcRenderer.invoke('remove-project', project.id);
        const config = await ipcRenderer.invoke('get-config');
        store.projects = config.projects || [];
        addToast(t('project.deleted', { name: project.name }), 'success');
      } catch (error) {
        addToast(t('toasts.projectDeleteError'), 'error', { detail: getErrorMessage(error) });
      }
    }
  });
};

// --- Proxy ---
let proxyStatusInterval: ReturnType<typeof setInterval> | null = null;

const findAvailablePort = async (startPort: number): Promise<number> => {
  for (let port = startPort; port <= Math.min(startPort + 100, 65535); port++) {
    const available = await ipcRenderer.invoke('proxy-check-port', port);
    if (available) return port;
  }
  return startPort;
};

const refreshProxyStatuses = async () => {
  try {
    const statuses = await ipcRenderer.invoke('proxy-status-all');
    store.proxyStatuses = statuses;
  } catch {
    // Silently ignore errors during polling
  }
};

const toPlainProject = (project: Project) => ({
  id: project.id,
  name: project.name,
  color: project.color,
  databaseIds: [...(project.databaseIds || [])],
  masked: project.masked,
  proxyEnabled: project.proxyEnabled,
  proxyPort: project.proxyPort,
  proxyTargetDbId: project.proxyTargetDbId,
  proxyUser: project.proxyUser,
  proxyPassword: project.proxyPassword,
  proxyDbName: project.proxyDbName,
});

const handleProxyToggle = async (project: Project) => {
  try {
    if (project.proxyEnabled) {
      // --- Disable proxy ---
      // Stop the TCP proxy if running
      const status = store.proxyStatuses[project.id];
      if (status?.running) {
        const result = await ipcRenderer.invoke('proxy-stop', project.id);
        if (!result.success) {
          addToast(t('proxy.stopError'), 'error', { detail: result.error });
          return;
        }
      }
      // Save proxyEnabled = false
      const plain = toPlainProject(project);
      plain.proxyEnabled = false;
      await ipcRenderer.invoke('update-project', project.id, plain);
      const config = await ipcRenderer.invoke('get-config');
      store.projects = config.projects || [];
      addToast(t('proxy.stopped'), 'info');
      await refreshProxyStatuses();
    } else {
      // --- Enable proxy ---
      let port = project.proxyPort;
      if (!port) {
        // No port configured → auto-assign one
        port = await findAvailablePort(54320);
      }
      // Save proxyEnabled = true + port
      const plain = toPlainProject(project);
      plain.proxyEnabled = true;
      plain.proxyPort = port;
      await ipcRenderer.invoke('update-project', project.id, plain);
      const config = await ipcRenderer.invoke('get-config');
      store.projects = config.projects || [];
      // If target already selected, auto-start the proxy
      if (project.proxyTargetDbId) {
        const result = await ipcRenderer.invoke('proxy-start', project.id, port);
        if (result.success) {
          addToast(t('proxy.started', { port }), 'success');
        } else {
          addToast(t('proxy.startError'), 'error', { detail: result.error });
        }
      } else {
        addToast(t('proxy.selectTargetFirst'), 'warning');
      }
      await refreshProxyStatuses();
    }
  } catch (err) {
    console.error('handleProxyToggle error:', err);
    addToast(t('proxy.startError'), 'error', { detail: getErrorMessage(err) || t('toasts.unknownError') });
  }
};

const handleUpdateProxyConfig = async (projectId: string, config: { port?: number }) => {
  const project = store.projects.find(p => p.id === projectId);
  if (!project) return;

  try {
    const portChanged = config.port !== undefined && config.port !== project.proxyPort;
    const wasRunning = store.proxyStatuses[projectId]?.running;

    // Stop proxy if port changed and it was running
    if (portChanged && wasRunning) {
      await ipcRenderer.invoke('proxy-stop', projectId);
    }

    // Save updated config
    const plain = toPlainProject(project);
    if (config.port !== undefined) plain.proxyPort = config.port;
    await ipcRenderer.invoke('update-project', projectId, plain);
    const appConfig = await ipcRenderer.invoke('get-config');
    store.projects = appConfig.projects || [];

    // Restart proxy if port changed and it was running
    if (portChanged && wasRunning && config.port) {
      const updatedProject = store.projects.find(p => p.id === projectId);
      if (updatedProject?.proxyTargetDbId) {
        const result = await ipcRenderer.invoke('proxy-start', projectId, config.port);
        if (result.success) {
          addToast(t('proxy.started', { port: config.port }), 'success');
        } else {
          addToast(t('proxy.startError'), 'error', { detail: result.error });
        }
      }
    }

    addToast(t('proxy.configSaved'), 'success');
    await refreshProxyStatuses();
  } catch (err) {
    console.error('handleUpdateProxyConfig error:', err);
    addToast(t('proxy.startError'), 'error', { detail: getErrorMessage(err) || t('toasts.unknownError') });
  }
};

const handleSetProxyTarget = (projectId: string, dbId: string) => {
  const db = store.databases.find(d => d.id === dbId);
  const name = db?.displayName || db?.name || dbId;

  showConfirm({
    title: t('proxy.confirmTarget', { name }),
    message: t('proxy.confirmTargetMessage'),
    confirmText: t('common.confirm'),
    cancelText: t('common.cancel'),
    type: 'info',
    onConfirm: async () => {
      try {
        const result = await ipcRenderer.invoke('proxy-switch-target', projectId, dbId);
        if (result.success) {
          addToast(t('proxy.targetSwitched', { name }), 'success');
          const config = await ipcRenderer.invoke('get-config');
          store.projects = config.projects || [];

          // Auto-start if proxy is enabled, port is set, but not yet running
          const project = store.projects.find(p => p.id === projectId);
          const status = store.proxyStatuses[projectId];
          if (project?.proxyEnabled && project?.proxyPort && !status?.running) {
            const startResult = await ipcRenderer.invoke('proxy-start', projectId, project.proxyPort);
            if (startResult.success) {
              addToast(t('proxy.started', { port: project.proxyPort }), 'success');
            } else {
              addToast(t('proxy.startError'), 'error', { detail: startResult.error });
            }
          }
        } else {
          addToast(t('proxy.switchError'), 'error', { detail: result.error });
        }
        await refreshProxyStatuses();
      } catch (err) {
        console.error('handleSetProxyTarget error:', err);
        addToast(t('proxy.switchError'), 'error', { detail: getErrorMessage(err) || t('toasts.unknownError') });
      }
    }
  });
};

// --- Proxy Activity Logs ---
let proxyLogInterval: ReturnType<typeof setInterval> | null = null;

const closeProxyLogs = () => {
  store.proxyActivityProjectId = null;
  if (proxyLogInterval) {
    clearInterval(proxyLogInterval);
    proxyLogInterval = null;
  }
};

const handleShowProxyLogs = async (projectId: string) => {
  if (store.proxyActivityProjectId === projectId) {
    closeProxyLogs();
    return;
  }
  store.proxyActivityProjectId = projectId;
  await refreshProxyLogs(projectId);
  // Poll every 3s while panel is open
  if (proxyLogInterval) clearInterval(proxyLogInterval);
  proxyLogInterval = setInterval(() => {
    if (store.proxyActivityProjectId) {
      refreshProxyLogs(store.proxyActivityProjectId);
    }
  }, 3000);
};

const refreshProxyLogs = async (projectId: string) => {
  try {
    const logs = await ipcRenderer.invoke('proxy-get-logs', projectId);
    store.proxyActivityLogs[projectId] = logs;
  } catch {
    // silently ignore
  }
};

const handleClearProxyLogs = (projectId: string) => {
  showConfirm({
    title: t('proxy.activity.clearConfirm'),
    message: t('proxy.activity.clearConfirmMessage'),
    confirmText: t('proxy.activity.clear'),
    type: 'warning',
    onConfirm: async () => {
      await ipcRenderer.invoke('proxy-clear-logs', projectId);
      store.proxyActivityLogs[projectId] = [];
      addToast(t('proxy.activity.cleared'), 'success');
    }
  });
};

const handleCopyProxyLogs = async (projectId: string) => {
  const logs = store.proxyActivityLogs[projectId] || [];
  if (logs.length === 0) return;
  const text = logs.map(l => {
    const time = new Date(l.timestamp).toLocaleTimeString();
    return `[${time}] [${l.type.toUpperCase()}] ${l.message}`;
  }).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    addToast(t('proxy.activity.copied'), 'success');
  } catch {
    addToast(t('toasts.copyFailed'), 'error');
  }
};

const getActivityColor = (type: ProxyActivityEvent['type']) => {
  switch (type) {
    case 'started': return 'border-blue-500';
    case 'stopped': return 'border-gray-500';
    case 'connected': return 'border-emerald-500';
    case 'disconnected': return 'border-red-400';
    case 'target-switched': return 'border-orange-500';
    default: return 'border-gray-400';
  }
};

const getActivityIcon = (type: ProxyActivityEvent['type']) => {
  switch (type) {
    case 'started': return '▶';
    case 'stopped': return '■';
    case 'connected': return '↗';
    case 'disconnected': return '↘';
    case 'target-switched': return '⇄';
    default: return '•';
  }
};

const formatLogTime = (timestamp: string) => {
  return new Date(timestamp).toLocaleTimeString();
};

const ICON_ACTIVITY = 'M4 6h16M4 10h16M4 14h10M4 18h6';
const proxyLogs = computed(() => (store.proxyActivityProjectId ? store.proxyActivityLogs[store.proxyActivityProjectId] || [] : []));
const proxyLogsMeta = computed(() => {
  const project = store.projects.find(p => p.id === store.proxyActivityProjectId);
  return project ? `${project.name} · ${proxyLogs.value.length}` : String(proxyLogs.value.length);
});

// Start proxy status polling
refreshProxyStatuses();
proxyStatusInterval = setInterval(refreshProxyStatuses, 5000);

onUnmounted(() => {
  if (proxyStatusInterval) {
    clearInterval(proxyStatusInterval);
    proxyStatusInterval = null;
  }
  if (proxyLogInterval) {
    clearInterval(proxyLogInterval);
    proxyLogInterval = null;
  }
});
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- Header row: title + action buttons -->
    <div class="flex justify-between items-center mb-4">
      <div>
        <h2 class="text-3xl font-bold tracking-tight">{{ t('nav.databases') }}</h2>
        <p class="text-gray-500 mt-1">{{ t('databases.configuredConnections', { count: store.databases.length }) }}</p>
      </div>
      <div class="flex gap-3">
        <!-- Create database button (needs a local server) -->
        <button
          v-if="!isRemoteOnly()"
          @click="store.createDatabaseForProjectId = null; store.showCreateDatabaseModal = true"
          class="group relative overflow-hidden bg-gradient-to-br from-blue-600 via-blue-500 to-indigo-600 text-white px-4 py-2 rounded-xl text-sm font-medium shadow-lg shadow-blue-500/30 hover:shadow-xl hover:shadow-blue-500/40 transition-all duration-300 flex items-center gap-2 hover:scale-[1.02] active:scale-[0.98]"
        >
          <div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700"></div>
          <div class="relative z-10 flex items-center justify-center w-4 h-4">
            <svg class="w-4 h-4 transform group-hover:rotate-90 transition-transform duration-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
          </div>
          <span class="relative z-10">{{ t('modal.createDatabase') }}</span>
          <div class="absolute inset-0 rounded-xl bg-gradient-to-r from-blue-400/0 via-blue-400/50 to-blue-400/0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 blur-sm"></div>
        </button>

        <!-- Add connection button -->
        <button
          @click="openAddModal"
          class="group relative overflow-hidden bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 dark:from-gray-100 dark:via-gray-50 dark:to-gray-100 text-white dark:text-gray-900 px-4 py-2 rounded-xl text-sm font-medium shadow-lg shadow-gray-900/20 dark:shadow-gray-100/20 hover:shadow-xl hover:shadow-gray-900/30 dark:hover:shadow-gray-100/30 transition-all duration-300 flex items-center gap-2 hover:scale-[1.02] active:scale-[0.98] border border-gray-700/20 dark:border-gray-300/20"
        >
          <div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 dark:via-gray-900/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700"></div>
          <div class="relative z-10 flex items-center justify-center w-4 h-4">
            <svg class="w-4 h-4 transform group-hover:scale-110 transition-transform duration-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </div>
          <span class="relative z-10">{{ t('modal.addDatabase') }}</span>
          <div class="absolute inset-0 rounded-xl bg-gradient-to-r from-gray-400/0 via-gray-400/30 to-gray-400/0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 blur-sm"></div>
        </button>
      </div>
    </div>

    <!-- New project button -->
    <div class="flex items-center gap-3 mb-6">
      <button
        @click="openProjectModal"
        class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-zinc-800 hover:bg-gray-200 dark:hover:bg-zinc-700 rounded-lg transition-colors"
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v12m6-6H6" />
        </svg>
        {{ t('project.newProject') }}
      </button>
    </div>

    <div v-if="store.databases.length === 0 && store.projects.length === 0" class="flex-1 flex flex-col items-center justify-center text-center opacity-60">
      <div class="w-24 h-24 bg-surface rounded-full flex items-center justify-center mb-4">
        <svg class="w-12 h-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
        </svg>
      </div>
      <h3 class="text-xl font-medium mb-2">{{ t('db.noDatabases') }}</h3>
      <p class="text-gray-500 max-w-sm">{{ t('db.noDatabasesDesc') }}</p>
    </div>

    <!-- ========== PROJECT MODE ========== -->
    <div v-else class="space-y-0 pb-8">
      <!-- Projects -->
      <template v-for="(project, index) in store.projects" :key="project.id">
        <!-- Separator between projects -->
        <div v-if="index > 0" class="border-t border-gray-200 dark:border-zinc-700 mx-4 my-2"></div>
        <div
          @dragover="onProjectDragOver($event, project.id)"
          @dragleave="onProjectDragLeave"
          @drop="onProjectDrop($event, project.id)"
          class="transition-all duration-200"
          :class="{
            'border-t-2 border-blue-400': dragOverProjectId === project.id && dragOverPosition === 'above',
            'border-b-2 border-blue-400': dragOverProjectId === project.id && dragOverPosition === 'below',
          }"
        >
          <ProjectSection
            :project="project"
            :databases="getProjectDatabases(project)"
            :db-sizes="dbSizes"
            :proxy-status="store.proxyStatuses[project.id] || null"
            @edit="editProject"
            @delete="deleteProject"
            @toggle-project-mask="toggleProjectMask"
            @move-db-to-project="moveDatabaseToProject"
            @backup="backupNow"
            @view="openViewer"
            @duplicate="(db: Database) => openDuplicateModal(db, project.id)"
            @edit-db="editDatabase"
            @delete-db="deleteDatabase"
            @disconnect="disconnectDatabase"
            @copy-url="copyConnectionUrl"
            @addons="openExtensions"
            @toggle-mask="toggleMask"
            @proxy-toggle="handleProxyToggle"
            @set-proxy-target="handleSetProxyTarget"
            @show-proxy-logs="handleShowProxyLogs"
            @update-proxy-config="handleUpdateProxyConfig"
          />

        </div>
      </template>

      <!-- Ungrouped databases -->
      <div
        v-if="ungroupedDatabases.length > 0 || isDraggingDb"
        @dragover="onUngroupedDragOver"
        @dragleave="onUngroupedDragLeave"
        @drop="onUngroupedDrop"
        class="rounded-xl transition-all duration-200"
        :class="{ 'ring-2 ring-blue-400 ring-offset-2 ring-offset-white dark:ring-offset-zinc-900 bg-blue-50/50 dark:bg-blue-900/10': ungroupedDragOver }"
      >
        <!-- Separator before ungrouped -->
        <div v-if="store.projects.length > 0" class="border-t border-gray-200 dark:border-zinc-700 mx-4 my-2"></div>
        <!-- Clickable header -->
        <div
          class="flex items-center justify-between px-4 py-3 rounded-xl cursor-pointer select-none transition-colors hover:bg-gray-50 dark:hover:bg-zinc-800/50"
          @click="toggleUngrouped"
        >
          <div class="flex items-center gap-3">
            <div class="w-3 h-3 rounded-full bg-gray-400 shrink-0" />
            <h3 class="text-lg font-semibold text-gray-500 dark:text-gray-400">{{ t('project.ungrouped') }}</h3>
            <span class="text-xs font-medium text-gray-500 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full">
              {{ ungroupedDatabases.length }}
            </span>
          </div>
          <svg
            class="w-5 h-5 text-gray-400 transition-transform duration-200"
            :class="{ '-rotate-90': ungroupedCollapsed }"
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
        <!-- Collapsible body -->
        <div
          class="overflow-hidden transition-all duration-300 ease-in-out"
          :style="{ maxHeight: ungroupedCollapsed ? '0px' : '2000px', opacity: ungroupedCollapsed ? 0 : 1 }"
        >
          <div v-if="ungroupedDatabases.length > 0" class="flex flex-col gap-1.5 mt-3 px-1">
            <DatabaseCardCompact
              v-for="db in ungroupedDatabases"
              :key="db.id"
              :db="db"
              :project-id="null"
              :size="dbSizes[db.id]"
              @backup="backupNow"
              @view="openViewer"
              @duplicate="openDuplicateModal"
              @edit="editDatabase"
              @delete="deleteDatabase"
              @disconnect="disconnectDatabase"
              @copy-url="copyConnectionUrl"
              @addons="openExtensions"
              @toggle-mask="toggleMask"
            />
          </div>
          <div v-else class="text-center py-6 text-sm text-gray-400">
            {{ t('project.noDatabases') }}
          </div>
        </div>
      </div>

      <!-- Empty project mode state -->
      <div v-if="store.projects.length === 0 && ungroupedDatabases.length === 0" class="flex-1 flex flex-col items-center justify-center text-center py-16 opacity-60">
        <div class="w-24 h-24 bg-surface rounded-full flex items-center justify-center mb-4">
          <svg class="w-12 h-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
        </div>
        <h3 class="text-xl font-medium mb-2">{{ t('project.newProject') }}</h3>
        <p class="text-gray-500 max-w-sm">{{ t('project.noDatabases') }}</p>
      </div>
    </div>

    <!-- Duplicate to Local Modal -->
    <DuplicateDatabaseModal
        v-if="showDuplicateModal"
        v-model="showDuplicateModal"
        :sourceDb="duplicateSourceDb"
        @success="onDuplicateSuccess"
    />

    <!-- Project Modal -->
    <ProjectModal v-if="store.showProjectModal" />

    <!-- ProxyPortModal removed — config is now inline in ProjectSection -->

    <!-- Proxy activity -->
    <AppModal
      v-if="store.proxyActivityProjectId"
      :title="t('proxy.activity.title')"
      :icon="ICON_ACTIVITY"
      :meta="proxyLogsMeta"
      width="lg"
      :close-label="t('common.close')"
      @close="closeProxyLogs"
    >
      <div class="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden">
        <p v-if="proxyLogs.length === 0" class="py-12 text-center text-[13px] text-zinc-500">{{ t('proxy.activity.empty') }}</p>
        <ul v-else class="py-1">
          <li
            v-for="log in proxyLogs"
            :key="log.id"
            class="flex items-start gap-2 px-4 py-1.5 hover:bg-zinc-800/50 border-l-2 font-mono text-xs"
            :class="getActivityColor(log.type)"
          >
            <span class="text-zinc-500 shrink-0 w-16 tabular-nums">{{ formatLogTime(log.timestamp) }}</span>
            <span class="shrink-0 w-4 text-center text-zinc-400" aria-hidden="true">{{ getActivityIcon(log.type) }}</span>
            <span class="text-zinc-300 min-w-0 break-words">{{ log.message }}</span>
          </li>
        </ul>
      </div>

      <template #footer>
        <button
          type="button"
          :class="btnGhost"
          class="hover:!text-red-600 dark:hover:!text-red-400"
          :disabled="proxyLogs.length === 0"
          @click="handleClearProxyLogs(store.proxyActivityProjectId!)"
        >{{ t('proxy.activity.clear') }}</button>
        <span class="flex-1" />
        <button type="button" :class="btnGhost" @click="refreshProxyLogs(store.proxyActivityProjectId!)">{{ t('common.refresh') }}</button>
        <button type="button" :class="btnSecondary" :disabled="proxyLogs.length === 0" @click="handleCopyProxyLogs(store.proxyActivityProjectId!)">{{ t('proxy.activity.copyAll') }}</button>
      </template>
    </AppModal>
  </div>
</template>

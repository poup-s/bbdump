<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { getErrorMessage } from '../utils';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { ipcRenderer } from '../electron';
import { Database, Project, ProxyActivityEvent } from '../types';
import DatabaseCardCompact from './DatabaseCardCompact.vue';
import DuplicateDatabaseModal from './DuplicateDatabaseModal.vue';
import ProjectSection from './ProjectSection.vue';
import ProjectModal from './ProjectModal.vue';
// ProxyPortModal removed — config is now inline in ProjectSection

const { t } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();

const hiddenDatabasesCount = ref(0);
const hiddenDatabases = ref<any[]>([]);
const isLoadingHiddenCount = ref(false);
const isImportingHidden = ref(false);

// Duplicate Modal State
const showDuplicateModal = ref(false);
const duplicateSourceDb = ref<Database | null>(null);
const duplicateSourceProjectId = ref<string | null>(null);

const loadHiddenDatabasesCount = async () => {
  try {
    isLoadingHiddenCount.value = true;
    const result = await ipcRenderer.invoke('get-postgres-config');
    if (result && result.databases) {
      const localDbs = store.databases.filter(db => db.isLocalBbdump);
      const localDbNames = new Set(localDbs.map(db => db.name));
      const postgresDbs = result.databases.filter((db: any) => 
        !db.name.startsWith('template') && 
        !localDbNames.has(db.name)
      );
      hiddenDatabases.value = postgresDbs;
      hiddenDatabasesCount.value = postgresDbs.length;
    }
  } catch (error) {
    console.error('Error loading hidden databases count:', error);
    hiddenDatabasesCount.value = 0;
  } finally {
    isLoadingHiddenCount.value = false;
  }
};

// Reload the count when databases change
watch(() => store.databases.length, () => {
  loadHiddenDatabasesCount();
});

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
    const newDb = store.databases.find((d: any) => d.name === newDbName);
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

const importAllHidden = async () => {
  if (hiddenDatabases.value.length === 0) return;
  
  try {
    isImportingHidden.value = true;
    
    for (const db of hiddenDatabases.value) {
      await ipcRenderer.invoke('add-database', {
        name: db.name,
        displayName: db.name,
        host: 'localhost',
        port: 5432,
        user: db.owner || 'postgres',
        password: '',
        encrypted: true,
        encryptBackups: false,
        cron: '',
        output: '',
        enabled: false,
        ssl: false,
        isLocalBbdump: true
      });
    }
    
    addToast(t('databases.importSuccess'), 'success');
    
    // Refresh config
    const config = await ipcRenderer.invoke('get-config');
    store.databases = config.databases;
    
    await loadHiddenDatabasesCount();
  } catch (error) {
    addToast('Error importing databases: ' + getErrorMessage(error), 'error');
  } finally {
    isImportingHidden.value = false;
  }
};

const deleteDatabase = (db: Database) => {
  if (isSystemDatabase(db.name)) {
    addToast(t('databases.cannotDeleteSystemDatabase', { name: db.name }), 'error');
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
          if (isLocal) {
            const result = await ipcRenderer.invoke('drop-postgres-database', db.name, db.port, true);
            if (!result.success) {
              const isNotFoundError = result.error && (
                result.error.includes('does not exist') || 
                result.error.includes('n\'existe pas')
              );
              
              if (isNotFoundError) {
                addToast(t('databases.dbAlreadyDeleted', { name: db.name }), 'warning');
              } else {
                addToast(result.error || t('postgresConfig.dropError'), 'warning');
              }
            }
          }
          
          await ipcRenderer.invoke('remove-database', db.id);
          const config = await ipcRenderer.invoke('get-config');
          store.databases = config.databases;
          addToast(isLocal ? t('toasts.dbDeleted') : t('toasts.connectionDeleted'), 'success');
        } catch (error) {
          addToast('Error deleting database: ' + getErrorMessage(error), 'error');
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
    addToast('Error starting backup: ' + getErrorMessage(error), 'error');
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
    addToast('Failed to copy URL', 'error');
  }
};

const openPostgresSettings = () => {
  store.activeTab = 'settings';
  setTimeout(() => {
    const postgresConfigElement = document.querySelector('[data-postgres-config]');
    if (postgresConfigElement) {
      postgresConfigElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, 300);
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
        addToast(`Error removing database from list: ${getErrorMessage(error)}`, 'error');
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
    addToast('Error toggling mask: ' + getErrorMessage(error), 'error');
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
    addToast('Error toggling project mask: ' + getErrorMessage(error), 'error');
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
  loadHiddenDatabasesCount();
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
    addToast('Error moving database: ' + getErrorMessage(error), 'error');
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
    addToast('Error reordering projects: ' + getErrorMessage(error), 'error');
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
        addToast('Error deleting project: ' + getErrorMessage(error), 'error');
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
          addToast(t('proxy.stopError', { error: result.error }), 'error');
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
          addToast(t('proxy.startError', { error: result.error }), 'error');
        }
      } else {
        addToast(t('proxy.selectTargetFirst'), 'info');
      }
      await refreshProxyStatuses();
    }
  } catch (err) {
    console.error('handleProxyToggle error:', err);
    addToast(t('proxy.startError', { error: getErrorMessage(err) || 'Unknown error' }), 'error');
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
          addToast(t('proxy.startError', { error: result.error }), 'error');
        }
      }
    }

    addToast(t('proxy.configSaved'), 'success');
    await refreshProxyStatuses();
  } catch (err) {
    console.error('handleUpdateProxyConfig error:', err);
    addToast(t('proxy.startError', { error: getErrorMessage(err) || 'Unknown error' }), 'error');
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
              addToast(t('proxy.startError', { error: startResult.error }), 'error');
            }
          }
        } else {
          addToast(t('proxy.switchError', { error: result.error }), 'error');
        }
        await refreshProxyStatuses();
      } catch (err) {
        console.error('handleSetProxyTarget error:', err);
        addToast(t('proxy.switchError', { error: getErrorMessage(err) || 'Unknown error' }), 'error');
      }
    }
  });
};

// --- Proxy Activity Logs ---
let proxyLogInterval: ReturnType<typeof setInterval> | null = null;

const handleShowProxyLogs = async (projectId: string) => {
  if (store.proxyActivityProjectId === projectId) {
    // Toggle off
    store.proxyActivityProjectId = null;
    if (proxyLogInterval) {
      clearInterval(proxyLogInterval);
      proxyLogInterval = null;
    }
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
      addToast(t('proxy.activity.cleared'), 'info');
    }
  });
};

const handleCopyProxyLogs = (projectId: string) => {
  const logs = store.proxyActivityLogs[projectId] || [];
  if (logs.length === 0) return;
  const text = logs.map(l => {
    const time = new Date(l.timestamp).toLocaleTimeString();
    return `[${time}] [${l.type.toUpperCase()}] ${l.message}`;
  }).join('\n');
  navigator.clipboard.writeText(text);
  addToast(t('proxy.activity.copied'), 'success');
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
        <!-- Create database button -->
        <button
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

    <!-- Proxy Activity Log Modal -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="store.proxyActivityProjectId"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
        @click="store.proxyActivityProjectId = null"
      >
        <div
          class="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl max-w-2xl w-full border border-border overflow-hidden flex flex-col max-h-[80vh]"
          @click.stop
        >
          <!-- Header -->
          <div class="px-6 py-4 border-b border-border flex justify-between items-center bg-surface shrink-0">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-xl bg-blue-500/10 flex items-center justify-center">
                <svg class="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 10h16M4 14h10M4 18h6" />
                </svg>
              </div>
              <div>
                <h3 class="text-lg font-bold">{{ t('proxy.activity.title') }}</h3>
                <p class="text-xs text-gray-500">
                  {{ store.projects.find(p => p.id === store.proxyActivityProjectId)?.name }}
                </p>
              </div>
              <span class="text-[10px] text-gray-400 bg-gray-200 dark:bg-zinc-700 px-1.5 py-0.5 rounded-full">
                {{ (store.proxyActivityLogs[store.proxyActivityProjectId!] || []).length }}
              </span>
            </div>
            <div class="flex items-center gap-1">
              <!-- Refresh -->
              <button
                @click="refreshProxyLogs(store.proxyActivityProjectId!)"
                class="p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                title="Refresh"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
              <!-- Copy all -->
              <button
                @click="handleCopyProxyLogs(store.proxyActivityProjectId!)"
                class="p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                :title="t('proxy.activity.copyAll')"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
              <!-- Clear -->
              <button
                @click="handleClearProxyLogs(store.proxyActivityProjectId!)"
                class="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-400 hover:text-red-500 transition-colors"
                :title="t('proxy.activity.clear')"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
              <!-- Close -->
              <button
                @click="store.proxyActivityProjectId = null"
                class="p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Log Content -->
          <div class="flex-1 overflow-y-auto bg-zinc-900 dark:bg-zinc-950">
            <div v-if="(store.proxyActivityLogs[store.proxyActivityProjectId!] || []).length === 0" class="py-12 text-center text-sm text-gray-500">
              {{ t('proxy.activity.empty') }}
            </div>
            <div v-else class="py-1">
              <div
                v-for="log in store.proxyActivityLogs[store.proxyActivityProjectId!]"
                :key="log.id"
                class="flex items-start gap-2 px-4 py-1.5 hover:bg-zinc-800/50 border-l-2 font-mono text-xs"
                :class="getActivityColor(log.type)"
              >
                <span class="text-zinc-500 shrink-0 w-16">{{ formatLogTime(log.timestamp) }}</span>
                <span class="shrink-0 w-4 text-center">{{ getActivityIcon(log.type) }}</span>
                <span class="text-zinc-300">{{ log.message }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

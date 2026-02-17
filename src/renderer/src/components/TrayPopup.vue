<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { ipcRenderer } from '../electron';
import { useI18n } from '../composables/useI18n';

const { t, setLanguage } = useI18n();

interface TrayDatabase {
  name: string;
  displayName?: string;
  host: string;
  enabled?: boolean;
  lastBackup?: string;
  status?: 'success' | 'error' | 'running' | 'idle';
  cron?: string;
}

interface TrayBackupStats {
  total: number;
  totalSize: number;
}

interface McpConfirmRequest {
  id: string;
  tool: string;
  database: string;
  table?: string;
  schema?: string;
  sql: string;
  description: string;
}

const databases = ref<TrayDatabase[]>([]);
const backupStats = ref<TrayBackupStats>({ total: 0, totalSize: 0 });
const loading = ref(true);

// MCP Confirmation state
const mcpConfirm = ref<McpConfirmRequest | null>(null);
const countdown = ref(60);
let countdownInterval: ReturnType<typeof setInterval> | null = null;

const operationLabel = computed(() => {
  const tool = mcpConfirm.value?.tool;
  if (!tool) return '';
  if (tool.includes('insert')) return t('mcp.insert');
  if (tool.includes('update')) return t('mcp.update');
  if (tool.includes('delete')) return t('mcp.delete');
  return t('mcp.write');
});

const operationColorClass = computed(() => {
  const tool = mcpConfirm.value?.tool;
  if (!tool) return 'bg-amber-500/20 text-amber-400';
  if (tool.includes('insert')) return 'bg-emerald-500/20 text-emerald-400';
  if (tool.includes('delete')) return 'bg-red-500/20 text-red-400';
  return 'bg-amber-500/20 text-amber-400';
});

function startCountdown() {
  countdown.value = 60;
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    countdown.value--;
    if (countdown.value <= 0) {
      stopCountdown();
    }
  }, 1000);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

const approveConfirm = () => {
  if (!mcpConfirm.value) return;
  ipcRenderer.invoke('mcp-confirm-response', { id: mcpConfirm.value.id, approved: true });
  stopCountdown();
  mcpConfirm.value = null;
  ipcRenderer.send('mcp-confirm-done');
};

const alwaysAllowConfirm = async () => {
  if (!mcpConfirm.value) return;
  ipcRenderer.invoke('mcp-confirm-response', { id: mcpConfirm.value.id, approved: true });
  stopCountdown();
  mcpConfirm.value = null;
  ipcRenderer.send('mcp-confirm-done');
  // Save mcpSkipConfirmation setting
  try {
    await ipcRenderer.invoke('save-settings', { mcpSkipConfirmation: true });
  } catch {
    // Silently ignore — the setting will apply on next mutation
  }
};

const denyConfirm = () => {
  if (!mcpConfirm.value) return;
  ipcRenderer.invoke('mcp-confirm-response', { id: mcpConfirm.value.id, approved: false });
  stopCountdown();
  mcpConfirm.value = null;
  ipcRenderer.send('mcp-confirm-done');
};

const loadData = async () => {
  try {
    const config = await ipcRenderer.invoke('get-config');
    if (config?.language) setLanguage(config.language);
    databases.value = (config?.databases || []).map((db: any) => ({
      name: db.name,
      displayName: db.displayName,
      host: db.host,
      enabled: db.enabled,
      lastBackup: db.lastBackup,
      status: db.status || 'idle',
      cron: db.cron
    }));

    const backupsResult = await ipcRenderer.invoke('get-backups');
    if (backupsResult?.stats) {
      backupStats.value = backupsResult.stats;
    }
  } catch (err) {
    console.error('Tray: failed to load data', err);
  } finally {
    loading.value = false;
  }
};

const openDbViewer = (dbName: string) => {
  ipcRenderer.send('tray-open-dbviewer', dbName);
};

const openApp = () => {
  ipcRenderer.send('tray-open-app');
};

const formatSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
};

const statusColor = (status?: string) => {
  switch (status) {
    case 'success': return 'bg-emerald-400';
    case 'error': return 'bg-red-400';
    case 'running': return 'bg-amber-400 animate-pulse';
    default: return 'bg-gray-400';
  }
};

onMounted(() => {
  loadData();
  ipcRenderer.on('tray-refresh', loadData);

  ipcRenderer.on('mcp-confirm-request', (_: any, data: McpConfirmRequest) => {
    mcpConfirm.value = data;
    startCountdown();
  });

  ipcRenderer.on('mcp-confirm-timeout', (_: any, id: string) => {
    if (mcpConfirm.value?.id === id) {
      stopCountdown();
      mcpConfirm.value = null;
      ipcRenderer.send('mcp-confirm-done');
    }
  });
});

onUnmounted(() => {
  stopCountdown();
  ipcRenderer.removeAllListeners('tray-refresh');
  ipcRenderer.removeAllListeners('mcp-confirm-request');
  ipcRenderer.removeAllListeners('mcp-confirm-timeout');
});
</script>

<template>
  <div class="w-[320px] select-none p-1">
    <!-- Card -->
    <div class="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl overflow-hidden">

      <!-- ===== MCP CONFIRMATION VIEW ===== -->
      <template v-if="mcpConfirm">
        <!-- Header -->
        <div class="px-4 pt-3 pb-2 flex items-center gap-2 border-b border-zinc-800">
          <div class="w-6 h-6 bg-amber-500/20 rounded-lg flex items-center justify-center">
            <svg class="w-3.5 h-3.5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-xs font-bold text-white">{{ t('mcp.confirmTitle') }}</div>
            <div class="text-[10px] text-zinc-400 truncate">{{ t('mcp.confirmMessage') }}</div>
          </div>
        </div>

        <!-- Content -->
        <div class="px-3 py-2.5 space-y-2.5 max-h-[360px] overflow-y-auto">
          <!-- Operation badge -->
          <div class="flex items-center gap-2">
            <span class="px-2 py-0.5 text-[10px] font-bold rounded-md" :class="operationColorClass">
              {{ operationLabel }}
            </span>
            <span class="text-[10px] text-zinc-500 font-mono truncate">{{ mcpConfirm.tool }}</span>
          </div>

          <!-- Database & Table -->
          <div class="p-2 bg-zinc-800/50 rounded-lg border border-zinc-700/50 space-y-1">
            <div class="flex items-center justify-between">
              <span class="text-[10px] text-zinc-500">{{ t('mcp.database') }}</span>
              <span class="text-[11px] font-semibold text-white font-mono">{{ mcpConfirm.database }}</span>
            </div>
            <div v-if="mcpConfirm.table" class="flex items-center justify-between">
              <span class="text-[10px] text-zinc-500">{{ t('mcp.table') }}</span>
              <span class="text-[11px] font-semibold text-white font-mono">
                {{ mcpConfirm.schema ? `${mcpConfirm.schema}.` : '' }}{{ mcpConfirm.table }}
              </span>
            </div>
          </div>

          <!-- Description -->
          <div v-if="mcpConfirm.description" class="text-[11px] text-zinc-300">
            {{ mcpConfirm.description }}
          </div>

          <!-- SQL Preview -->
          <div>
            <div class="text-[10px] text-zinc-500 mb-1">{{ t('mcp.sql') }}</div>
            <pre class="p-2 bg-black rounded-lg text-[10px] text-emerald-400 font-mono overflow-x-auto max-h-[120px] overflow-y-auto whitespace-pre-wrap break-all border border-zinc-800">{{ mcpConfirm.sql }}</pre>
          </div>

          <!-- Countdown -->
          <div class="flex items-center gap-2">
            <svg class="w-3 h-3 text-amber-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span class="text-[10px] text-amber-400">{{ t('mcp.timeoutWarning', { seconds: countdown }) }}</span>
            <div class="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
              <div
                class="h-full bg-amber-500 rounded-full transition-all duration-1000 ease-linear"
                :style="{ width: `${(countdown / 60) * 100}%` }"
              ></div>
            </div>
          </div>
        </div>

        <!-- Buttons -->
        <div class="px-3 pb-3 pt-1 space-y-1.5">
          <div class="flex gap-2">
            <button
              @click="denyConfirm"
              class="flex-1 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-xs font-bold transition-colors"
            >
              {{ t('mcp.deny') }}
            </button>
            <button
              @click="approveConfirm"
              class="flex-1 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-1.5"
            >
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
              {{ t('mcp.approve') }}
            </button>
          </div>
          <button
            @click="alwaysAllowConfirm"
            class="w-full py-1.5 text-[10px] text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 rounded-lg transition-colors"
          >
            {{ t('mcp.alwaysAllow') }}
          </button>
        </div>
      </template>

      <!-- ===== NORMAL TRAY VIEW ===== -->
      <template v-else>
        <!-- Header -->
        <div class="px-4 pt-3 pb-2 flex items-center justify-between border-b border-zinc-800">
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 bg-violet-500/20 rounded-lg flex items-center justify-center">
              <svg class="w-3.5 h-3.5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
              </svg>
            </div>
            <span class="text-sm font-bold text-white">bbdump</span>
          </div>
          <div class="flex items-center gap-1.5 text-[10px] text-zinc-500">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
            {{ databases.length }} {{ t('tray.databases') }}
          </div>
        </div>

        <!-- Loading -->
        <div v-if="loading" class="px-4 py-8 flex items-center justify-center">
          <svg class="w-5 h-5 text-violet-400 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>

        <!-- Database list -->
        <div v-else class="max-h-[260px] overflow-y-auto">
          <div v-if="databases.length === 0" class="px-4 py-6 text-center text-xs text-zinc-500">
            {{ t('tray.noDatabases') }}
          </div>
          <div
            v-for="db in databases"
            :key="db.name"
            class="px-4 py-2.5 flex items-center gap-3 hover:bg-zinc-800/50 transition-colors border-b border-zinc-800/50 last:border-b-0"
          >
            <!-- Status dot -->
            <div class="shrink-0">
              <div class="w-2 h-2 rounded-full" :class="statusColor(db.status)"></div>
            </div>

            <!-- Info -->
            <div class="flex-1 min-w-0">
              <div class="text-[12px] font-semibold text-white truncate">{{ db.displayName || db.name }}</div>
            </div>

            <!-- DB Viewer button -->
            <button
              @click.stop="openDbViewer(db.name)"
              class="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-all bg-zinc-800 text-zinc-400 hover:bg-violet-500/20 hover:text-violet-400"
              :title="t('tray.viewDb')"
            >
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
              </svg>
            </button>
          </div>
        </div>

        <!-- Stats footer -->
        <div v-if="!loading" class="px-4 py-2 border-t border-zinc-800 flex items-center justify-between text-[10px] text-zinc-500">
          <span>{{ backupStats.total }} {{ t('tray.totalBackups') }}</span>
          <span>{{ formatSize(backupStats.totalSize) }}</span>
        </div>

        <!-- Open app button -->
        <div class="px-3 pb-3 pt-1">
          <button
            @click="openApp"
            class="w-full py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-2 shadow-lg shadow-violet-500/20"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            {{ t('tray.openApp') }}
          </button>
        </div>
      </template>

    </div>
  </div>
</template>

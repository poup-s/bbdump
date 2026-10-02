<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { getErrorMessage } from '../utils';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer, shell } from '../electron';
import claudeGlyph from '../assets/client-icons/claude.svg';
import cursorGlyph from '../assets/client-icons/cursor.svg';
import windsurfGlyph from '../assets/client-icons/windsurf.svg';
import opencodeGlyph from '../assets/client-icons/opencode.svg';

interface McpClientStatus {
  id: string;
  name: string;
  configPath: string;
  detected: boolean;
  state: 'not-installed' | 'installed' | 'outdated';
  installed: boolean;
  appPath?: string;
  error?: string;
}

const props = withDefaults(defineProps<{ variant?: 'settings' | 'onboarding' }>(), { variant: 'settings' });
const emit = defineEmits<{ (e: 'changed', clients: McpClientStatus[]): void }>();

const { t } = useI18n();
const { addToast } = useToast();

const clients = ref<McpClientStatus[]>([]);
const appIcons = ref<Record<string, string>>({});
const busy = ref<string | null>(null);
const errors = ref<Record<string, string>>({});
const translocated = ref(false);
const loading = ref(false);
const showOthers = ref(false);

const dark = props.variant === 'onboarding';

// Monochrome glyphs (Simple Icons, CC0) for clients without an installed app icon
const GLYPHS: Record<string, string> = {
  'claude-desktop': claudeGlyph,
  'claude-code': claudeGlyph,
  cursor: cursorGlyph,
  windsurf: windsurfGlyph,
  devin: windsurfGlyph,
  opencode: opencodeGlyph,
};

const connected = computed(() => clients.value.filter(c => c.state !== 'not-installed'));
const available = computed(() => clients.value.filter(c => c.state === 'not-installed' && c.detected));
const others = computed(() => clients.value.filter(c => c.state === 'not-installed' && !c.detected));
const outdated = computed(() => clients.value.filter(c => c.state === 'outdated'));
const primary = computed(() => [...connected.value, ...available.value]);

const load = async () => {
  loading.value = true;
  try {
    clients.value = await ipcRenderer.invoke('mcp-list-clients');
    emit('changed', clients.value);
  } catch (error) {
    console.error('Error loading MCP clients:', error);
  } finally {
    loading.value = false;
  }
};

const loadIcons = async () => {
  try {
    appIcons.value = await ipcRenderer.invoke('mcp-client-icons');
  } catch {
    appIcons.value = {};
  }
};

const install = async (client: McpClientStatus): Promise<boolean> => {
  const result = await ipcRenderer.invoke('mcp-install-client', client.id);
  if (!result.success) {
    errors.value = { ...errors.value, [client.id]: result.error || t('mcpClients.error') };
  }
  return !!result.success;
};

const run = async (client: McpClientStatus, action: 'install' | 'uninstall') => {
  busy.value = client.id;
  errors.value = { ...errors.value, [client.id]: '' };
  try {
    if (action === 'install') {
      if (await install(client)) addToast(t('mcpClients.installSuccess', { name: client.name }), 'success');
    } else {
      const result = await ipcRenderer.invoke('mcp-uninstall-client', client.id);
      if (result.success) addToast(t('mcpClients.uninstallSuccess', { name: client.name }), 'success');
      else errors.value = { ...errors.value, [client.id]: result.error || t('mcpClients.error') };
    }
  } catch (error) {
    errors.value = { ...errors.value, [client.id]: getErrorMessage(error) || t('mcpClients.error') };
  } finally {
    busy.value = null;
    await load();
  }
};

const updateAll = async () => {
  busy.value = 'all';
  let updated = 0;
  try {
    for (const client of outdated.value) {
      try {
        if (await install(client)) updated++;
      } catch (error) {
        errors.value = { ...errors.value, [client.id]: getErrorMessage(error) || t('mcpClients.error') };
      }
    }
    if (updated) addToast(t('mcpClients.updatedAll', { count: updated }), 'success');
  } finally {
    busy.value = null;
    await load();
  }
};

const revealConfig = (client: McpClientStatus) => {
  shell.showItemInFolder(client.configPath);
};

const statusText = (c: McpClientStatus) =>
  c.state === 'installed' ? t('mcpClients.connected')
  : c.state === 'outdated' ? t('mcpClients.outdatedShort')
  : t('mcpClients.available');

const statusDot = (c: McpClientStatus) =>
  c.state === 'installed' ? 'bg-emerald-500'
  : c.state === 'outdated' ? 'bg-amber-400'
  : dark ? 'bg-zinc-600' : 'bg-gray-300 dark:bg-zinc-600';

onMounted(async () => {
  await Promise.all([load(), loadIcons()]);
  try {
    const custom = await ipcRenderer.invoke('mcp-get-custom-config');
    translocated.value = !!custom?.translocated;
  } catch {
    // ignore
  }
});

defineExpose({ reload: load });
</script>

<template>
  <div class="space-y-3">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div class="flex items-baseline gap-2">
        <span class="text-[10px] font-bold uppercase tracking-wider text-gray-400">{{ t('mcpClients.title') }}</span>
        <span v-if="clients.length" :class="['text-[11px]', dark ? 'text-gray-500' : 'text-gray-400']">
          {{ t('mcpClients.summary', { count: connected.length, total: clients.length }) }}
        </span>
      </div>
      <button
        @click="load(); loadIcons()"
        :disabled="loading || busy !== null"
        :title="t('mcpClients.refresh')"
        :class="['p-1 rounded-md transition-colors disabled:opacity-40', dark ? 'text-gray-500 hover:text-white' : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-200']"
      >
        <svg :class="['w-3.5 h-3.5', loading && 'animate-spin']" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>

    <p
      v-if="translocated"
      :class="['text-[11px] rounded-lg px-3 py-2 border', dark ? 'text-gray-300 border-zinc-700' : 'text-gray-600 dark:text-gray-300 border-gray-200 dark:border-zinc-700']"
    >
      {{ t('mcpClients.translocated') }}
    </p>

    <!-- Outdated entries: one notice, one action -->
    <div
      v-if="outdated.length"
      :class="['flex items-center justify-between gap-3 rounded-lg px-3 py-2 border', dark ? 'border-zinc-700 bg-zinc-900/40' : 'border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800/40']"
    >
      <span :class="['text-[11px] leading-snug', dark ? 'text-gray-300' : 'text-gray-600 dark:text-gray-300']">
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 mr-1.5 align-middle"></span>
        {{ t('mcpClients.outdatedNotice', { count: outdated.length }) }}
      </span>
      <button
        @click="updateAll"
        :disabled="busy !== null"
        :class="['shrink-0 px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors disabled:opacity-50', dark ? 'border-zinc-600 text-gray-200 hover:bg-zinc-800' : 'border-gray-300 dark:border-zinc-600 text-gray-700 dark:text-gray-200 hover:bg-white dark:hover:bg-zinc-800']"
      >
        {{ busy === 'all' ? t('mcpClients.updating') : t('mcpClients.updateAll') }}
      </button>
    </div>

    <!-- Clients -->
    <div :class="['grid gap-2', dark ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2']">
      <div
        v-for="client in primary"
        :key="client.id"
        :title="client.configPath"
        :class="[
          'group rounded-lg border px-3 py-2.5 transition-colors',
          dark ? 'border-zinc-700/60 hover:border-zinc-600' : 'border-gray-200 dark:border-zinc-700/70 hover:border-gray-300 dark:hover:border-zinc-600'
        ]"
      >
        <div class="flex items-center gap-3">
          <!-- Real app icon, else monochrome glyph, else initial -->
          <img v-if="appIcons[client.id]" :src="appIcons[client.id]" alt="" class="w-8 h-8 shrink-0" />
          <div
            v-else
            :class="['w-8 h-8 rounded-lg flex items-center justify-center shrink-0', dark ? 'bg-zinc-800' : 'bg-gray-100 dark:bg-zinc-800']"
          >
            <img v-if="GLYPHS[client.id]" :src="GLYPHS[client.id]" alt="" :class="['w-4 h-4 opacity-70', dark ? 'invert' : 'dark:invert']" />
            <span v-else :class="['text-xs font-semibold', dark ? 'text-gray-300' : 'text-gray-500 dark:text-gray-300']">{{ client.name.charAt(0) }}</span>
          </div>

          <div class="min-w-0 flex-1">
            <div :class="['text-sm truncate', dark ? 'text-white' : 'text-gray-800 dark:text-gray-100']">{{ client.name }}</div>
            <div class="flex items-center gap-1.5 mt-0.5">
              <span :class="['w-1.5 h-1.5 rounded-full shrink-0', statusDot(client)]"></span>
              <span :class="['text-[11px] truncate', dark ? 'text-gray-400' : 'text-gray-500 dark:text-gray-400']">{{ statusText(client) }}</span>
            </div>
          </div>

          <button
            v-if="variant === 'settings' && client.state !== 'not-installed'"
            @click="revealConfig(client)"
            :title="t('mcpClients.showFile')"
            class="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-opacity"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          </button>

          <!-- One neutral action -->
          <button
            v-if="client.state === 'not-installed'"
            @click="run(client, 'install')"
            :disabled="busy !== null"
            :class="['shrink-0 px-3 py-1 text-xs font-medium rounded-md transition-colors disabled:opacity-50', dark ? 'bg-white text-zinc-900 hover:bg-gray-200' : 'bg-gray-900 text-white hover:bg-gray-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-gray-200']"
          >
            {{ busy === client.id ? t('mcpClients.working') : t('mcpClients.connect') }}
          </button>
          <button
            v-else
            @click="run(client, 'uninstall')"
            :disabled="busy !== null"
            :class="['shrink-0 px-2 py-1 text-xs rounded-md transition-colors disabled:opacity-50', dark ? 'text-gray-500 hover:text-gray-200' : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-200']"
          >
            {{ busy === client.id ? t('mcpClients.working') : t('mcpClients.disconnect') }}
          </button>
        </div>

        <p v-if="errors[client.id] || client.error" class="text-[10px] text-red-600 dark:text-red-400 mt-2 break-words">
          {{ errors[client.id] || client.error }}
        </p>
      </div>
    </div>

    <!-- Clients not found on this computer -->
    <div v-if="others.length">
      <button
        @click="showOthers = !showOthers"
        :class="['flex items-center gap-1.5 text-[11px] transition-colors', dark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300']"
      >
        <svg :class="['w-3 h-3 transition-transform', showOthers && 'rotate-90']" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
        {{ t('mcpClients.others', { count: others.length }) }}
      </button>

      <div v-if="showOthers" class="mt-1.5">
        <div
          v-for="client in others"
          :key="client.id"
          :title="client.configPath"
          class="flex items-center gap-2.5 px-1 py-1.5"
        >
          <img v-if="GLYPHS[client.id]" :src="GLYPHS[client.id]" alt="" :class="['w-3.5 h-3.5 opacity-40', dark ? 'invert' : 'dark:invert']" />
          <span v-else class="w-3.5 text-center text-[10px] text-gray-400">{{ client.name.charAt(0) }}</span>
          <span :class="['text-xs flex-1 truncate', dark ? 'text-gray-400' : 'text-gray-500 dark:text-gray-400']">{{ client.name }}</span>
          <button
            @click="run(client, 'install')"
            :disabled="busy !== null"
            :class="['text-[11px] hover:underline underline-offset-2 disabled:opacity-50', dark ? 'text-gray-500 hover:text-gray-200' : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-200']"
          >
            {{ t('mcpClients.configureAnyway') }}
          </button>
        </div>
        <p v-for="client in others.filter(c => errors[c.id])" :key="`err-${client.id}`" class="text-[10px] text-red-600 dark:text-red-400 px-1">
          {{ client.name }}: {{ errors[client.id] }}
        </p>
      </div>
    </div>

    <p :class="['text-[10px] leading-relaxed', dark ? 'text-gray-500' : 'text-gray-400']">
      {{ t('mcpClients.footnote') }}
    </p>
  </div>
</template>

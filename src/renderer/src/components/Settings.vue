<script setup lang="ts">
/**
 * Settings page: a list of sections on the left (follows the scroll), the sections on
 * the right with the same row everywhere (what it does on the left, the control on the
 * right). The MCP clients and the PostgreSQL server keep their own components.
 */
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { useColorMode } from '@vueuse/core';
import { getErrorMessage } from '../utils';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { ipcRenderer } from '../electron';
import { store, isRemoteOnly } from '../store';
import PostgresConfig from './PostgresConfig.vue';
import McpClientList from './McpClientList.vue';
import ToggleSwitch from './ui/ToggleSwitch.vue';
import { btnSecondary } from './ui/classes';

const { t, setLanguage, currentLanguage } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();

const isMac = navigator.userAgent.includes('Mac');

// --- Values -------------------------------------------------------------------------

const defaultPath = ref('');
const allowSqlMutations = ref(false);
const mcpSkipConfirmation = ref(false);
const launchAtLogin = ref(false);
const key = ref<{ exists: boolean; path: string } | null>(null);

const loadSettings = async () => {
  try {
    const config = await ipcRenderer.invoke('get-config');
    allowSqlMutations.value = !!config.allowSqlMutations;
    mcpSkipConfirmation.value = !!config.mcpSkipConfirmation;
    launchAtLogin.value = !!config.launchAtLogin;
    defaultPath.value = await ipcRenderer.invoke('get-default-path');
    key.value = await ipcRenderer.invoke('check-key-status');
  } catch (error) {
    console.error('Error loading settings:', error);
  }
};

/** Saves settings; puts the previous value back if it fails */
const save = async (settings: Record<string, unknown>, rollback?: () => void, toast = t('toasts.settingsSaved')) => {
  try {
    await ipcRenderer.invoke('save-settings', settings);
    if (toast) addToast(toast, 'success');
    return true;
  } catch (error) {
    rollback?.();
    addToast(t('toasts.settingsSaveError'), 'error', { detail: getErrorMessage(error) });
    return false;
  }
};

// --- General ------------------------------------------------------------------------

const setLang = (lang: 'en' | 'fr') => {
  if (lang === currentLanguage.value) return;
  const previous = currentLanguage.value as 'en' | 'fr';
  setLanguage(lang);
  save({ language: lang }, () => setLanguage(previous));
};

/** Same storage as the sidebar's light / dark button; "auto" follows the system */
const colorMode = useColorMode({ emitAuto: true });
const theme = computed(() => colorMode.store.value);
const setTheme = (mode: 'light' | 'dark' | 'auto') => { colorMode.store.value = mode; };

const toggleLaunchAtLogin = () => {
  launchAtLogin.value = !launchAtLogin.value;
  save({ launchAtLogin: launchAtLogin.value }, () => { launchAtLogin.value = !launchAtLogin.value; });
};

const replayOnboarding = () => {
  store.onboardingEntry = 'replay';
  store.onboardingCompleted = false;
};

// --- Usage mode ---------------------------------------------------------------------
// 'remote' hides the local server features everywhere; it never installs or removes
// anything: going local goes through the machine check.

type LocalServer = { installed: boolean; running: boolean; version?: string; port: number };
const localServer = ref<LocalServer | null>(null);
const localServerChecked = ref(false);

const loadLocalServer = async () => {
  if (isRemoteOnly()) return;
  try {
    const env = await ipcRenderer.invoke('setup-get-environment');
    localServer.value = env?.server ?? null;
  } catch {
    localServer.value = null;
  } finally {
    localServerChecked.value = true;
  }
};

const usageModeStatus = computed(() => {
  if (isRemoteOnly()) return { tone: 'neutral', title: t('settings.usageModeRemote'), detail: t('settingsPage.remoteStatus') };
  const server = localServer.value;
  const title = t('settings.usageModeLocal');
  if (!localServerChecked.value) return { tone: 'neutral', title, detail: t('settings.usageModeLocalChecking') };
  if (!server?.installed) return { tone: 'warn', title, detail: t('settings.usageModeLocalMissing') };
  const version = server.version || '';
  if (!server.running) return { tone: 'warn', title, detail: t('settings.usageModeLocalStopped', { version }) };
  return { tone: 'ok', title, detail: t('settings.usageModeLocalRunning', { version, port: server.port }) };
});

const showAddLocalServer = computed(() =>
  isRemoteOnly() || (localServerChecked.value && !(localServer.value?.installed && localServer.value.running)));

const addLocalServer = () => {
  store.onboardingEntry = 'add-local-server';
  store.onboardingCompleted = false;
};

const switchToRemote = () => {
  showConfirm({
    title: t('settings.switchToRemoteTitle'),
    message: t('settingsPage.switchToRemoteMessage'),
    confirmText: t('settings.switchToRemoteConfirm'),
    type: 'info',
    onConfirm: async () => {
      const previous = store.usageMode;
      store.usageMode = 'remote';
      await save({ usageMode: 'remote' }, () => { store.usageMode = previous; }, t('settings.usageModeSaved'));
    },
  });
};

// --- Backups ------------------------------------------------------------------------

const changeBackupLocation = async () => {
  try {
    const chosen = await ipcRenderer.invoke('select-directory');
    if (!chosen) return;
    // The folder used to be shown here but never saved: new databases kept the old one
    const previous = defaultPath.value;
    defaultPath.value = chosen;
    await save({ defaultBackupPath: chosen }, () => { defaultPath.value = previous; }, t('settings.backupLocationChanged'));
  } catch (error) {
    addToast(t('toasts.backupLocationError'), 'error', { detail: getErrorMessage(error) });
  }
};
const revealBackupFolder = () => { if (defaultPath.value) ipcRenderer.invoke('show-item-in-folder', defaultPath.value); };

// --- Security -----------------------------------------------------------------------

const exportKey = async () => {
  try {
    const result = await ipcRenderer.invoke('export-encryption-key');
    if (result.success) addToast(t('settings.keyExportSuccess'), 'success');
    else if (result.error) addToast(t('toasts.keyExportError'), 'error', { detail: result.error });
  } catch (error) {
    addToast(t('toasts.keyExportError'), 'error', { detail: getErrorMessage(error) });
  }
};

const importKey = () => {
  showConfirm({
    title: t('settings.importKey'),
    message: t('settingsPage.importKeyWarning'),
    confirmText: t('settingsPage.importKeyConfirm'),
    type: 'danger',
    onConfirm: async () => {
      try {
        const result = await ipcRenderer.invoke('import-encryption-key');
        if (result.success) {
          addToast(t('settings.keyImportSuccess'), 'success');
          key.value = await ipcRenderer.invoke('check-key-status');
        } else if (result.error) {
          addToast(t('toasts.keyImportError'), 'error', { detail: result.error });
        }
      } catch (error) {
        addToast(t('toasts.keyImportError'), 'error', { detail: getErrorMessage(error) });
      }
    },
  });
};

const toggleSqlMutations = () => {
  allowSqlMutations.value = !allowSqlMutations.value;
  store.allowSqlMutations = allowSqlMutations.value;
  save({ allowSqlMutations: allowSqlMutations.value }, () => {
    allowSqlMutations.value = !allowSqlMutations.value;
    store.allowSqlMutations = allowSqlMutations.value;
  });
};

// --- AI (MCP) -----------------------------------------------------------------------

const mcpInstalled = ref(false);
const mcpCustomExpanded = ref(false);
const mcpCopied = ref(false);
const mcpJsonConfig = ref('');

const onMcpClientsChanged = (clients: Array<{ state: string }>) => {
  mcpInstalled.value = clients.some((c) => c.state !== 'not-installed');
};

const loadMcpCustomConfig = async () => {
  try {
    mcpJsonConfig.value = (await ipcRenderer.invoke('mcp-get-custom-config')).snippet;
  } catch (error) {
    console.error('Error loading MCP config snippet:', error);
  }
};

const copyMcpConfig = async () => {
  try {
    await navigator.clipboard.writeText(mcpJsonConfig.value);
    mcpCopied.value = true;
    setTimeout(() => { mcpCopied.value = false; }, 2000);
  } catch {
    addToast(t('toasts.copyFailed'), 'error');
  }
};

const toggleMcpSkipConfirmation = () => {
  if (mcpSkipConfirmation.value) {
    mcpSkipConfirmation.value = false;
    save({ mcpSkipConfirmation: false }, () => { mcpSkipConfirmation.value = true; });
    return;
  }
  showConfirm({
    title: t('settingsPage.skipConfirmTitle'),
    message: t('settingsPage.skipConfirmWarning'),
    confirmText: t('settingsPage.skipConfirmButton'),
    type: 'danger',
    onConfirm: async () => {
      mcpSkipConfirmation.value = true;
      await save({ mcpSkipConfirmation: true }, () => { mcpSkipConfirmation.value = false; });
    },
  });
};

// --- Sections and scroll ------------------------------------------------------------

const sections = computed(() => [
  { id: 'general', label: t('settingsPage.sections.general') },
  { id: 'usage', label: t('settingsPage.sections.usage') },
  { id: 'backups', label: t('settingsPage.sections.backups') },
  { id: 'security', label: t('settingsPage.sections.security') },
  { id: 'ai', label: t('settingsPage.sections.ai') },
  ...(isRemoteOnly() ? [] : [{ id: 'postgres', label: t('settingsPage.sections.postgres') }]),
]);
const active = ref('general');
const root = ref<HTMLElement | null>(null);
let scroller: HTMLElement | null = null;

const sectionEl = (id: string) => root.value?.querySelector<HTMLElement>(`[data-section="${id}"]`) ?? null;
const goTo = (id: string) => {
  const el = sectionEl(id);
  if (!el || !scroller) return;
  active.value = id;
  const offset = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 8;
  scroller.scrollTo({ top: offset, behavior: 'smooth' });
};

/** The section whose title passed the top of the view; the last one once at the bottom */
const onScroll = () => {
  if (!scroller) return;
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
    active.value = sections.value[sections.value.length - 1].id;
    return;
  }
  const top = scroller.getBoundingClientRect().top + 96;
  let current = sections.value[0].id;
  for (const s of sections.value) {
    const el = sectionEl(s.id);
    if (el && el.getBoundingClientRect().top <= top) current = s.id;
  }
  active.value = current;
};

onMounted(async () => {
  loadSettings();
  loadMcpCustomConfig();
  loadLocalServer();
  await nextTick();
  // The page scrolls inside the app's content area
  let el = root.value?.parentElement ?? null;
  while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
  scroller = el;
  scroller?.addEventListener('scroll', onScroll, { passive: true });
});
onUnmounted(() => scroller?.removeEventListener('scroll', onScroll));

const card = 'bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800';
const row = 'flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6 px-4 py-3.5';
const rowTitle = 'text-[13.5px] font-medium text-gray-900 dark:text-zinc-100';
const rowDesc = 'mt-0.5 text-[12px] leading-snug text-gray-500 dark:text-zinc-400';
const sectionHeading = 'text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2 px-1';
const segment = (on: boolean) => ['h-7 px-3 rounded-md text-[12.5px] transition-colors', on
  ? 'bg-white dark:bg-zinc-700 text-gray-900 dark:text-white shadow-sm font-medium'
  : 'text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-zinc-200'];
const THEMES = ['light', 'dark', 'auto'] as const;
</script>

<template>
  <div ref="root" class="flex flex-col">
    <div class="mb-4 shrink-0">
      <h2 class="text-lg font-bold tracking-tight">{{ t('navShort.settings') }}</h2>
      <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ t('settingsPage.description') }}</p>
    </div>

    <div class="flex gap-6 items-start">
      <!-- Sections -->
      <nav class="hidden md:block w-44 shrink-0 sticky top-0" :aria-label="t('navShort.settings')">
        <ul class="space-y-0.5">
          <li v-for="s in sections" :key="s.id">
            <button
              type="button"
              class="w-full text-left h-8 px-3 rounded-lg text-[13px] transition-colors"
              :class="active === s.id
                ? 'bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 text-gray-900 dark:text-white font-medium'
                : 'border border-transparent text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-zinc-100'"
              :aria-current="active === s.id ? 'true' : undefined"
              @click="goTo(s.id)"
            >{{ s.label }}</button>
          </li>
        </ul>
      </nav>

      <div class="flex-1 min-w-0 space-y-6 pb-10">
        <!-- General -->
        <section data-section="general">
          <h3 :class="sectionHeading">{{ t('settingsPage.sections.general') }}</h3>
          <div :class="card" class="divide-y divide-gray-100 dark:divide-zinc-800">
            <div :class="row">
              <div class="flex-1 min-w-0">
                <div :class="rowTitle">{{ t('settings.language') }}</div>
              </div>
              <div class="flex p-0.5 rounded-lg bg-gray-100 dark:bg-zinc-800/70 self-start sm:self-auto" role="radiogroup" :aria-label="t('settings.language')">
                <button type="button" role="radio" :aria-checked="currentLanguage === 'fr'" :class="segment(currentLanguage === 'fr')" @click="setLang('fr')">Français</button>
                <button type="button" role="radio" :aria-checked="currentLanguage === 'en'" :class="segment(currentLanguage === 'en')" @click="setLang('en')">English</button>
              </div>
            </div>
            <div :class="row">
              <div class="flex-1 min-w-0">
                <div :class="rowTitle">{{ t('settingsPage.theme') }}</div>
              </div>
              <div class="flex p-0.5 rounded-lg bg-gray-100 dark:bg-zinc-800/70 self-start sm:self-auto" role="radiogroup" :aria-label="t('settingsPage.theme')">
                <button v-for="m in THEMES" :key="m" type="button" role="radio" :aria-checked="theme === m" :class="segment(theme === m)" @click="setTheme(m)">
                  {{ t(`settingsPage.themes.${m}`) }}
                </button>
              </div>
            </div>
            <div :class="row">
              <div class="flex-1 min-w-0">
                <div :class="rowTitle">{{ t('settings.launchAtLogin') }}</div>
                <p :class="rowDesc">{{ t('settingsPage.launchAtLoginDesc') }}</p>
              </div>
              <ToggleSwitch :on="launchAtLogin" :label="t('settings.launchAtLogin')" @toggle="toggleLaunchAtLogin" />
            </div>
            <div :class="row">
              <div class="flex-1 min-w-0">
                <div :class="rowTitle">{{ t('settingsPage.introduction') }}</div>
                <p :class="rowDesc">{{ t('settingsPage.introductionDesc') }}</p>
              </div>
              <button type="button" :class="btnSecondary" class="shrink-0 self-start sm:self-auto" @click="replayOnboarding">{{ t('settingsPage.replay') }}</button>
            </div>
          </div>
        </section>

        <!-- Usage mode -->
        <section data-section="usage">
          <h3 :class="sectionHeading">{{ t('settingsPage.sections.usage') }}</h3>
          <div :class="card">
            <div :class="row">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span
                    class="w-2 h-2 shrink-0 rounded-full"
                    :class="{
                      'bg-emerald-500': usageModeStatus.tone === 'ok',
                      'bg-amber-500': usageModeStatus.tone === 'warn',
                      'bg-gray-400 dark:bg-zinc-500': usageModeStatus.tone === 'neutral',
                    }"
                    aria-hidden="true"
                  />
                  <span :class="rowTitle">{{ usageModeStatus.title }}</span>
                </div>
                <p :class="rowDesc" class="pl-4">{{ usageModeStatus.detail }}</p>
              </div>
              <button v-if="showAddLocalServer" type="button" :class="btnSecondary" class="shrink-0 self-start sm:self-auto" @click="addLocalServer">{{ t('settings.addLocalServer') }}</button>
            </div>
            <div v-if="!isRemoteOnly()" class="px-4 py-2.5 border-t border-gray-100 dark:border-zinc-800">
              <button type="button" class="text-[12px] text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-zinc-200 hover:underline underline-offset-2" @click="switchToRemote">
                {{ t('settings.switchToRemote') }}
              </button>
            </div>
          </div>
        </section>

        <!-- Backups -->
        <section data-section="backups">
          <h3 :class="sectionHeading">{{ t('settingsPage.sections.backups') }}</h3>
          <div :class="card" class="px-4 py-3.5">
            <div :class="rowTitle">{{ t('settingsPage.backupFolder') }}</div>
            <p :class="rowDesc">{{ t('settingsPage.backupFolderDesc') }}</p>
            <div class="mt-3 flex flex-col sm:flex-row gap-2">
              <div class="flex-1 min-w-0 flex items-center h-9 px-3 rounded-lg bg-gray-50 dark:bg-zinc-800/60 border border-gray-200 dark:border-zinc-700 font-mono text-[12px] text-gray-600 dark:text-zinc-300">
                <span class="truncate [direction:rtl] text-left" :title="defaultPath"><bdi dir="ltr">{{ defaultPath }}</bdi></span>
              </div>
              <div class="flex gap-2 shrink-0">
                <button type="button" :class="btnSecondary" @click="changeBackupLocation">{{ t('settings.change') }}</button>
                <button type="button" :class="btnSecondary" :disabled="!defaultPath" @click="revealBackupFolder">
                  {{ isMac ? t('about.showInFinder') : t('about.showInFolder') }}
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- Security -->
        <section data-section="security">
          <h3 :class="sectionHeading">{{ t('settingsPage.sections.security') }}</h3>
          <div :class="card" class="divide-y divide-gray-100 dark:divide-zinc-800">
            <div :class="row">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="w-2 h-2 shrink-0 rounded-full" :class="key?.exists ? 'bg-emerald-500' : 'bg-amber-500'" aria-hidden="true" />
                  <span :class="rowTitle">{{ t('settings.encryptionKey') }}</span>
                </div>
                <p :class="rowDesc" class="pl-4">{{ key?.exists ? t('settingsPage.keyPresent') : t('settingsPage.keyMissing') }}</p>
                <p :class="rowDesc" class="pl-4">{{ t('settingsPage.keyAdvice') }}</p>
              </div>
              <div class="flex gap-2 shrink-0 self-start sm:self-auto">
                <button type="button" :class="btnSecondary" :disabled="!key?.exists" @click="exportKey">{{ t('settings.exportKey') }}</button>
                <button type="button" :class="btnSecondary" @click="importKey">{{ t('settings.importKey') }}</button>
              </div>
            </div>
            <div :class="row">
              <div class="flex-1 min-w-0">
                <div :class="rowTitle">{{ t('settingsPage.sqlWrites') }}</div>
                <p :class="rowDesc">{{ t('settingsPage.sqlWritesDesc') }}</p>
              </div>
              <ToggleSwitch :on="allowSqlMutations" tone="warn" :label="t('settingsPage.sqlWrites')" @toggle="toggleSqlMutations" />
            </div>
          </div>
        </section>

        <!-- AI (MCP) -->
        <section data-section="ai">
          <div class="flex items-center gap-2 mb-2 px-1">
            <h3 class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ t('settingsPage.sections.ai') }}</h3>
            <span
              class="text-[10px] font-semibold px-1.5 py-px rounded"
              :class="mcpInstalled ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400' : 'bg-gray-100 dark:bg-zinc-800 text-gray-500'"
            >{{ mcpInstalled ? t('settings.mcpInstalled') : t('settings.mcpNotInstalled') }}</span>
          </div>
          <div :class="card" class="divide-y divide-gray-100 dark:divide-zinc-800">
            <div class="px-4 py-3.5">
              <div :class="rowTitle">{{ t('settingsPage.mcpTitle') }}</div>
              <p :class="rowDesc">{{ t('settingsPage.mcpDesc') }}</p>
            </div>
            <div class="px-4 py-3.5">
              <McpClientList variant="settings" @changed="onMcpClientsChanged" />
            </div>
            <div :class="row">
              <div class="flex-1 min-w-0">
                <div :class="rowTitle">{{ t('settingsPage.skipConfirm') }}</div>
                <p :class="rowDesc">{{ mcpSkipConfirmation ? t('settingsPage.skipConfirmOn') : t('settingsPage.skipConfirmOff') }}</p>
              </div>
              <ToggleSwitch :on="mcpSkipConfirmation" tone="danger" :label="t('settingsPage.skipConfirm')" @toggle="toggleMcpSkipConfirmation" />
            </div>
            <div class="px-4 py-3">
              <button
                type="button"
                class="flex items-center gap-2 text-[12.5px] font-medium text-gray-600 dark:text-zinc-300 hover:text-gray-900 dark:hover:text-white"
                :aria-expanded="mcpCustomExpanded"
                @click="mcpCustomExpanded = !mcpCustomExpanded"
              >
                <svg class="w-3 h-3 transition-transform" :class="{ 'rotate-90': mcpCustomExpanded }" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                {{ t('settingsPage.mcpOtherClient') }}
              </button>
              <div v-if="mcpCustomExpanded" class="mt-3 space-y-2">
                <p :class="rowDesc">{{ t('settings.mcpCustomDesc') }}</p>
                <div class="relative">
                  <pre class="bg-gray-50 dark:bg-zinc-800/60 border border-gray-200 dark:border-zinc-700 rounded-lg p-3 pr-20 text-[11.5px] font-mono text-gray-700 dark:text-zinc-300 overflow-x-auto leading-relaxed select-text">{{ mcpJsonConfig }}</pre>
                  <button type="button" :class="btnSecondary" class="absolute top-2 right-2 h-7! px-2.5! text-[12px]!" @click="copyMcpConfig">
                    {{ mcpCopied ? t('settings.mcpCopied') : t('settings.mcpCopy') }}
                  </button>
                </div>
                <p class="text-[11.5px] text-gray-400 dark:text-zinc-500">{{ t('settings.mcpCustomHint') }}</p>
              </div>
            </div>
          </div>
        </section>

        <!-- PostgreSQL (local server) -->
        <section v-if="!isRemoteOnly()" data-section="postgres">
          <h3 :class="sectionHeading">{{ t('settingsPage.sections.postgres') }}</h3>
          <PostgresConfig />
        </section>
      </div>
    </div>
  </div>
</template>

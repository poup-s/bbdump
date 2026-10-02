<script setup lang="ts">
/**
 * Info page: the version and its updates, the environment (what a bug report needs, one
 * click to copy), where bbdump keeps its files, and the project's links.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { ipcRenderer } from '../electron';
import { useToast } from '../composables/useToast';
import { getErrorMessage } from '../utils';
import { btnPrimary, btnSecondary } from './ui/classes';
import { WHATS_NEW_VERSION } from '../whatsNew';

const { t, currentLanguage } = useI18n();
const { addToast } = useToast();

interface AboutInfo {
  version: string;
  packaged: boolean;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  osVersion: string;
  pgDump: { version?: string; path?: string } | null;
  dataPath: string;
  logsPath: string;
  configPath: string;
  home: string;
  autoInstallUpdates: boolean;
}

const LINKS = {
  site: 'https://poups.dev/bbdump',
  source: 'https://github.com/poup-s/bbdump',
  releases: 'https://github.com/poup-s/bbdump/releases',
  issues: 'https://github.com/poup-s/bbdump/issues/new',
  kofi: 'https://ko-fi.com/poup_s',
};

const info = ref<AboutInfo | null>(null);

// "Checked 3 minutes ago", refreshed every half minute
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  clock = setInterval(() => { now.value = Date.now(); }, 30000);
  try {
    info.value = await ipcRenderer.invoke('get-about-info');
  } catch (error) {
    console.error('Info page:', getErrorMessage(error));
  }
});
onUnmounted(() => { if (clock) clearInterval(clock); });

const osName = computed(() => {
  if (!info.value) return '';
  const name = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[info.value.platform] ?? info.value.platform;
  return `${name} ${info.value.osVersion} · ${info.value.arch}`;
});

const lastCheck = computed(() => {
  if (!store.lastUpdateCheck) return '';
  const minutes = Math.round((now.value - store.lastUpdateCheck) / 60000);
  const rtf = new Intl.RelativeTimeFormat(currentLanguage.value, { numeric: 'auto' });
  const when = minutes < 1 ? t('about.justNow')
    : minutes < 60 ? rtf.format(-minutes, 'minute')
      : rtf.format(-Math.round(minutes / 60), 'hour');
  return t('about.lastCheck', { when });
});

/** One state for the update block */
const updateState = computed(() => {
  if (store.updateDownloaded) return 'ready';
  if (store.downloadingUpdate) return 'downloading';
  if (store.checkingUpdate) return 'checking';
  if (store.updateAvailable) return 'available';
  if (store.updateCheckFailed) return 'failed';
  return 'current';
});

const stateTone = computed(() => ({
  ready: 'bg-emerald-500', downloading: 'bg-sky-500', checking: 'bg-gray-400 animate-pulse',
  available: 'bg-sky-500', failed: 'bg-amber-500', current: 'bg-emerald-500',
}[updateState.value]));

const checkForUpdates = async () => {
  if (store.checkingUpdate) return;
  store.checkingUpdate = true;
  try {
    const result = await ipcRenderer.invoke('check-for-updates');
    store.lastUpdateCheck = Date.now();
    store.updateCheckFailed = !!result.error;
    if (result.error) {
      addToast(t('settings.updateError'), 'error', { detail: result.error });
    } else if (result.updateAvailable) {
      store.updateAvailable = true;
      store.updateDetails = { version: result.version, url: result.url, releaseNotes: result.releaseNotes };
    } else {
      store.updateAvailable = false;
      store.updateDetails = null;
      addToast(t('settings.upToDate'), 'success');
    }
  } catch (error) {
    store.updateCheckFailed = true;
    addToast(t('settings.updateError'), 'error', { detail: getErrorMessage(error) });
  } finally {
    store.checkingUpdate = false;
  }
};

const downloadUpdate = async () => {
  if (store.downloadingUpdate) return;
  store.downloadingUpdate = true;
  store.downloadProgress = 0;
  try {
    const result = await ipcRenderer.invoke('download-update');
    // macOS (unsigned) and .deb: the release page was opened in the browser
    if (result?.manual) store.downloadingUpdate = false;
  } catch (error) {
    store.downloadingUpdate = false;
    addToast(t('settings.updateError'), 'error', { detail: getErrorMessage(error) });
  }
};

const installUpdate = () => ipcRenderer.invoke('install-update');

const open = (url: string) => window.open(url, '_blank');
const reveal = (path: string) => ipcRenderer.invoke('show-item-in-folder', path);
/** ~/Library/… rather than /Users/name/Library/… */
const shortPath = (path: string) => (info.value?.home && path.startsWith(info.value.home) ? `~${path.slice(info.value.home.length)}` : path);

/** What a bug report needs, without any database or connection detail */
const diagnostics = computed(() => {
  const i = info.value;
  if (!i) return '';
  return [
    `bbdump ${i.version}${i.packaged ? '' : ' (dev)'}`,
    `${osName.value}`,
    `pg_dump ${i.pgDump?.version ?? (i.pgDump ? '?' : t('about.notFound'))}`,
    `Electron ${i.electron} · Chromium ${i.chrome} · Node ${i.node}`,
    `${t('about.language')}: ${currentLanguage.value}`,
  ].join('\n');
});

const copyDiagnostics = async () => {
  try {
    await navigator.clipboard.writeText(diagnostics.value);
    addToast(t('about.diagnosticsCopied'), 'success');
  } catch {
    addToast(t('toasts.copyFailed'), 'error');
  }
};

const rowLabel = 'text-[13px] text-gray-500 dark:text-zinc-400';
const rowValue = 'font-mono text-[12.5px] text-gray-800 dark:text-zinc-200 text-right truncate';
const sectionTitle = 'text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-3';
const card = 'bg-white dark:bg-zinc-900 rounded-xl p-4 border border-gray-200 dark:border-zinc-800';
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="mb-4 shrink-0">
      <h2 class="text-lg font-bold tracking-tight">{{ t('nav.about') }}</h2>
      <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ t('about.description') }}</p>
    </div>

    <div class="space-y-4 pb-6">
      <!-- Version and updates -->
      <div :class="card" class="p-5!">
        <div class="flex flex-col md:flex-row md:items-center gap-5">
          <div class="flex items-center gap-4 min-w-0 flex-1">
            <img src="/logo.png" alt="" class="w-14 h-14 shrink-0 rounded-2xl border border-gray-200 dark:border-zinc-700 bg-white p-1.5 object-contain" />
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-xl font-bold tracking-tight">bbdump</span>
                <span class="font-mono text-[11px] px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-300">v{{ store.appVersion }}</span>
                <span v-if="info && !info.packaged" class="font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400">dev</span>
              </div>
              <p class="mt-0.5 text-[13px] text-gray-500 dark:text-zinc-400">{{ t('about.tagline') }}</p>
              <button type="button" class="mt-1.5 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-emerald-600 dark:text-emerald-400 hover:underline" @click="store.showWhatsNew = true">
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
                {{ t('about.tour', { version: WHATS_NEW_VERSION.replace(/\.0$/, '') }) }}
              </button>
            </div>
          </div>

          <div class="md:w-[300px] shrink-0 rounded-lg border border-gray-200 dark:border-zinc-800 bg-gray-50/70 dark:bg-zinc-800/30 px-3.5 py-3" aria-live="polite">
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full shrink-0" :class="stateTone" aria-hidden="true" />
              <span class="text-[13px] font-medium text-gray-900 dark:text-zinc-100">
                <template v-if="updateState === 'ready'">{{ t('about.update.ready', { version: store.updateDetails?.version }) }}</template>
                <template v-else-if="updateState === 'downloading'">{{ t('about.update.downloading', { progress: store.downloadProgress }) }}</template>
                <template v-else-if="updateState === 'checking'">{{ t('about.update.checking') }}</template>
                <template v-else-if="updateState === 'available'">{{ t('about.update.available', { version: store.updateDetails?.version }) }}</template>
                <template v-else-if="updateState === 'failed'">{{ t('about.update.failed') }}</template>
                <template v-else>{{ t('about.update.current') }}</template>
              </span>
            </div>
            <p v-if="lastCheck && updateState !== 'downloading' && updateState !== 'ready'" class="mt-0.5 pl-4 text-[11.5px] text-gray-500 dark:text-zinc-400">{{ lastCheck }}</p>

            <div v-if="updateState === 'downloading'" class="mt-2.5 h-1.5 rounded-full bg-gray-200 dark:bg-zinc-700 overflow-hidden">
              <div class="h-full bg-sky-500 rounded-full transition-[width] duration-300" :style="{ width: `${store.downloadProgress}%` }" />
            </div>

            <p v-if="updateState === 'available' && info && !info.autoInstallUpdates" class="mt-2 text-[11.5px] leading-snug text-gray-500 dark:text-zinc-400">
              {{ t('about.update.manualHint') }}
            </p>

            <div class="mt-3 flex flex-wrap gap-2">
              <button v-if="updateState === 'ready'" type="button" :class="btnPrimary" @click="installUpdate">{{ t('settings.installAndRestart') }}</button>
              <template v-else-if="updateState === 'available'">
                <button type="button" :class="btnPrimary" @click="downloadUpdate">
                  {{ info && !info.autoInstallUpdates ? t('about.update.openDownload') : t('about.update.download', { version: store.updateDetails?.version }) }}
                </button>
                <button v-if="store.updateDetails?.url" type="button" :class="btnSecondary" @click="open(store.updateDetails.url)">{{ t('toasts.actions.releaseNotes') }}</button>
              </template>
              <button
                v-if="updateState !== 'ready' && updateState !== 'downloading' && updateState !== 'available'"
                type="button"
                :class="btnSecondary"
                :disabled="store.checkingUpdate"
                @click="checkForUpdates"
              >
                <svg class="w-3.5 h-3.5" :class="{ 'animate-spin': store.checkingUpdate }" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {{ t('settings.checkForUpdates') }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <!-- Environment -->
        <div :class="card" class="flex flex-col">
          <h3 :class="sectionTitle">{{ t('about.environment') }}</h3>
          <dl class="space-y-2.5 flex-1">
            <div class="flex items-center justify-between gap-4">
              <dt :class="rowLabel">{{ t('about.system') }}</dt>
              <dd :class="rowValue">{{ osName || '…' }}</dd>
            </div>
            <div class="flex items-center justify-between gap-4">
              <dt :class="rowLabel">pg_dump</dt>
              <dd v-if="!info" :class="rowValue">…</dd>
              <dd v-else-if="info.pgDump" :class="rowValue" :title="info.pgDump.path">{{ info.pgDump.version ?? '?' }}<span v-if="info.pgDump.path" class="text-gray-400 dark:text-zinc-500"> · {{ info.pgDump.path }}</span></dd>
              <dd v-else class="text-[12.5px] text-amber-700 dark:text-amber-400">{{ t('about.notFound') }}</dd>
            </div>
            <div class="flex items-center justify-between gap-4">
              <dt :class="rowLabel">Electron</dt>
              <dd :class="rowValue">{{ info?.electron ?? '…' }}</dd>
            </div>
            <div class="flex items-center justify-between gap-4">
              <dt :class="rowLabel">Chromium · Node</dt>
              <dd :class="rowValue">{{ info ? `${info.chrome} · ${info.node}` : '…' }}</dd>
            </div>
          </dl>
          <div class="mt-4 pt-3 border-t border-gray-100 dark:border-zinc-800 flex flex-wrap items-center gap-2">
            <button type="button" :class="btnSecondary" :disabled="!info" @click="copyDiagnostics">{{ t('about.copyDiagnostics') }}</button>
            <button type="button" :class="btnSecondary" @click="open(LINKS.issues)">{{ t('about.reportIssue') }}</button>
          </div>
          <p class="mt-2 text-[11px] leading-snug text-gray-400 dark:text-zinc-500">{{ t('about.diagnosticsHint') }}</p>
        </div>

        <!-- Files -->
        <div :class="card">
          <h3 :class="sectionTitle">{{ t('about.files') }}</h3>
          <ul class="space-y-1">
            <li v-for="item in info ? [
              { label: t('about.dataFolder'), path: info.dataPath },
              { label: t('about.configFile'), path: info.configPath },
              { label: t('about.logsFolder'), path: info.logsPath },
            ] : []" :key="item.label" class="flex items-center gap-3 -mx-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-zinc-800/50">
              <div class="min-w-0 flex-1">
                <div class="text-[13px] text-gray-700 dark:text-zinc-300">{{ item.label }}</div>
                <!-- Cut at the start: the end of a path is the part that tells -->
                <div class="font-mono text-[11.5px] text-gray-400 dark:text-zinc-500 truncate [direction:rtl] text-left" :title="item.path"><bdi dir="ltr">{{ shortPath(item.path) }}</bdi></div>
              </div>
              <button type="button" class="shrink-0 text-[12px] font-medium text-gray-600 dark:text-zinc-300 hover:text-gray-900 dark:hover:text-white px-2 py-1 rounded-md hover:bg-gray-100 dark:hover:bg-zinc-800" @click="reveal(item.path)">
                {{ info?.platform === 'darwin' ? t('about.showInFinder') : t('about.showInFolder') }}
              </button>
            </li>
          </ul>
          <p class="mt-3 text-[11px] leading-snug text-gray-400 dark:text-zinc-500">{{ t('about.filesHint') }}</p>
        </div>
      </div>

      <!-- Links -->
      <div :class="card">
        <h3 :class="sectionTitle">{{ t('about.links') }}</h3>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <button
            v-for="link in [
              { url: LINKS.site, title: t('about.site'), sub: 'poups.dev/bbdump' },
              { url: LINKS.releases, title: t('about.whatsNew'), sub: t('about.whatsNewSub') },
              { url: LINKS.source, title: t('about.source'), sub: 'github.com/poup-s/bbdump' },
              { url: LINKS.kofi, title: t('about.support'), sub: 'ko-fi.com/poup_s' },
            ]"
            :key="link.url"
            type="button"
            class="group text-left rounded-lg border border-gray-200 dark:border-zinc-800 px-3 py-2.5 hover:border-gray-300 dark:hover:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-800/40 transition-colors"
            @click="open(link.url)"
          >
            <div class="flex items-center gap-1.5 text-[13px] font-medium text-gray-800 dark:text-zinc-100">
              {{ link.title }}
              <svg class="w-3 h-3 text-gray-400 group-hover:text-gray-600 dark:group-hover:text-zinc-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
            </div>
            <div class="mt-0.5 text-[11.5px] text-gray-500 dark:text-zinc-400 truncate">{{ link.sub }}</div>
          </button>
        </div>
      </div>

      <p class="text-center text-[11px] text-gray-400 dark:text-zinc-500">
        {{ t('about.footer', { year: new Date().getFullYear() }) }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * PostgreSQL extensions of a local database, by category.
 * - on the server: enable (CREATE EXTENSION) / remove (DROP EXTENSION, confirmed);
 * - not on the server: one click with a Homebrew server (brew install, then enable),
 *   otherwise the apt / dnf command to run, or the documentation;
 * - extensions loaded at startup: PostgreSQL restart offered, then enabled.
 */
import { ref, onMounted, computed } from 'vue';
import { getErrorMessage } from '../utils';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { ipcRenderer } from '../electron';
import type { PostgresExtension } from '../types';
import AppModal from './ui/AppModal.vue';
import type { ModalSection } from './ui/AppModal.vue';
import { btnGhost, inputClass } from './ui/classes';

type Category = 'ai' | 'geo' | 'search' | 'types' | 'analytics' | 'jobs' | 'performance' | 'security' | 'integration' | 'dev' | 'other';
type PackageManager = 'brew' | 'apt' | 'dnf' | 'fedora';

interface CatalogEntry {
  name: string;
  category: Category;
  contrib?: boolean;
  preload?: boolean;
  homepage?: string;
  /** Package for this server (from the main process), null when there is none */
  package?: string | null;
  command?: string | null;
}
interface ServerInfo {
  major: number;
  packageManager: PackageManager | null;
  autoInstall: boolean;
  preloaded: string[];
  pendingPreload: string[];
}
interface Item {
  name: string;
  category: Category;
  order: number;
  version: string | null;
  description: string;
  state: 'enabled' | 'available' | 'missing';
  preload: boolean;
  homepage?: string;
  /** Set when bbdump can install it itself (Homebrew, or pkexec on Linux) */
  installPackage?: string;
  command: string | null;
}

const CATEGORIES: Category[] = ['ai', 'geo', 'search', 'types', 'analytics', 'jobs', 'performance', 'security', 'integration', 'dev', 'other'];
const ICON_PUZZLE = 'M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z';
const BUILT_IN = ['plpgsql'];

const { t, te } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();

const available = ref<PostgresExtension[]>([]);
const catalog = ref<CatalogEntry[]>([]);
const server = ref<ServerInfo | null>(null);
const isLoading = ref(false);
const searchQuery = ref('');
const section = ref<string>('all');
/** CREATE / DROP EXTENSION running (blocks closing: quick) */
const busyName = ref<string | null>(null);
/** brew install running (can take minutes: the dialog may be closed meanwhile) */
const packageName = ref<string | null>(null);
/** Enable these once PostgreSQL has restarted */
const afterRestart = ref<string[]>([]);
const isRestarting = ref(false);

const db = computed(() => store.extensionsModalDb);

const describe = (name: string, comment: string | null) => (te(`postgresConfig.extensionDescriptions.${name}`)
  ? t(`postgresConfig.extensionDescriptions.${name}`)
  : comment || '');

const items = computed<Item[]>(() => {
  const byName = new Map(catalog.value.map((entry, index) => [entry.name, { entry, index }]));
  const list: Item[] = available.value.map(ext => {
    const known = byName.get(ext.name);
    return {
      name: ext.name,
      category: known?.entry.category ?? 'other',
      order: known?.index ?? Number.MAX_SAFE_INTEGER,
      version: ext.installed_version || ext.default_version,
      description: describe(ext.name, ext.comment),
      state: ext.is_installed ? 'enabled' : 'available',
      preload: !!known?.entry.preload,
      homepage: known?.entry.homepage,
      command: null,
    };
  });
  const onServer = new Set(available.value.map(ext => ext.name));
  catalog.value.forEach((entry, index) => {
    if (onServer.has(entry.name) || entry.contrib) return;
    list.push({
      name: entry.name,
      category: entry.category,
      order: index,
      version: null,
      description: describe(entry.name, null),
      state: 'missing',
      preload: !!entry.preload,
      homepage: entry.homepage,
      installPackage: server.value?.autoInstall && entry.package ? entry.package : undefined,
      command: entry.command ?? null,
    });
  });
  const rank = { enabled: 0, available: 1, missing: 2 } as const;
  return list.sort((a, b) => rank[a.state] - rank[b.state] || a.order - b.order || a.name.localeCompare(b.name));
});

const enabledCount = computed(() => items.value.filter(item => item.state === 'enabled').length);

const sections = computed<ModalSection[]>(() => [
  { id: 'all', label: t('postgresConfig.ext.categories.all'), count: items.value.length },
  { id: 'enabled', label: t('postgresConfig.ext.categories.enabled'), count: enabledCount.value },
  ...CATEGORIES
    .map(category => ({ id: category, label: t(`postgresConfig.ext.categories.${category}`), count: items.value.filter(item => item.category === category).length }))
    .filter(entry => entry.count > 0),
]);

/** Several categories shown: one heading per category, in catalog order */
const groups = computed(() => {
  const grouped = section.value === 'all' || section.value === 'enabled';
  if (!grouped) return [{ category: null as Category | null, items: visible.value }];
  return CATEGORIES
    .map(category => ({ category: category as Category | null, items: visible.value.filter(item => item.category === category) }))
    .filter(group => group.items.length > 0);
});

const visible = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  return items.value.filter(item => {
    if (section.value === 'enabled' && item.state !== 'enabled') return false;
    if (section.value !== 'all' && section.value !== 'enabled' && item.category !== section.value) return false;
    return !query || item.name.toLowerCase().includes(query) || item.description.toLowerCase().includes(query);
  });
});

/** Loaded at the next start: enabled on the server but not active yet */
const pendingRestart = computed(() => [...new Set([...(server.value?.pendingPreload ?? []), ...afterRestart.value])]);
const sourceLabel = computed(() => t(`postgresConfig.ext.source.${server.value?.packageManager ?? 'unknown'}`));

const load = async () => {
  if (!db.value) return;
  isLoading.value = true;
  try {
    const [extensions, info] = await Promise.all([
      ipcRenderer.invoke('get-postgres-extensions', db.value.name, db.value.port),
      ipcRenderer.invoke('get-extension-catalog', db.value.name, db.value.port),
    ]);
    available.value = extensions;
    catalog.value = info?.entries ?? [];
    server.value = info?.server ?? null;
  } catch (error) {
    addToast(t('toasts.extensionsLoadError'), 'error', { detail: getErrorMessage(error) });
  } finally {
    isLoading.value = false;
  }
};

const enable = async (name: string) => {
  if (!db.value) return;
  const result = await ipcRenderer.invoke('install-postgres-extension', db.value.name, name, db.value.port);
  if (result.success && !result.needsRestart) {
    addToast(t('postgresConfig.extensionInstalled', { name }), 'success');
  } else if (result.needsRestart) {
    // Loaded at startup: enabled after the restart (or already, but inactive until then)
    if (!result.success && !afterRestart.value.includes(name)) afterRestart.value.push(name);
    addToast(t('postgresConfig.ext.enabledAfterRestart', { name }), 'info');
  } else {
    addToast(t('postgresConfig.extensionError'), 'error', { detail: result.error });
  }
};

const run = async (name: string, task: () => Promise<void>) => {
  if (busyName.value) return;
  busyName.value = name;
  try {
    await task();
    await load();
  } catch (error) {
    addToast(t('toasts.extensionManageError'), 'error', { detail: getErrorMessage(error) });
  } finally {
    busyName.value = null;
  }
};

const onEnable = (item: Item) => run(item.name, () => enable(item.name));

const onRemove = (item: Item) => {
  showConfirm({
    title: t('postgresConfig.uninstallTitle', { name: item.name }),
    message: t('postgresConfig.uninstallMessage', { name: item.name, db: db.value?.name ?? '' }),
    confirmText: t('postgresConfig.ext.remove'),
    type: 'danger',
    onConfirm: () => run(item.name, async () => {
      const result = await ipcRenderer.invoke('uninstall-postgres-extension', db.value!.name, item.name, db.value!.port);
      if (result.success) addToast(t('postgresConfig.extensionUninstalled', { name: item.name }), 'success');
      else addToast(t('postgresConfig.extensionError'), 'error', { detail: result.error });
    }),
  });
};

/** Install the package on the server (Homebrew, or one pkexec prompt on Linux), then enable it here */
const onInstallPackage = async (item: Item) => {
  if (!db.value || packageName.value || busyName.value) return;
  const target = { ...db.value };
  packageName.value = item.name;
  try {
    const result = await ipcRenderer.invoke('install-extension-package', target.name, item.name, target.port);
    if (result.cancelled) {
      addToast(t('postgresConfig.ext.packageCancelled'), 'info');
      return;
    }
    if (!result.success) {
      addToast(t('postgresConfig.ext.packageError', { name: item.installPackage ?? item.name }), 'error', { detail: result.error });
      return;
    }
    addToast(t('postgresConfig.ext.packageInstalled', { name: item.installPackage ?? item.name }), 'success');
    if (db.value?.name === target.name && db.value.port === target.port) await run(item.name, () => enable(item.name));
  } catch (error) {
    addToast(t('toasts.extensionManageError'), 'error', { detail: getErrorMessage(error) });
  } finally {
    packageName.value = null;
  }
};

const copyCommand = async (command: string) => {
  try {
    await navigator.clipboard.writeText(command);
    addToast(t('postgresConfig.ext.commandCopied'), 'success');
  } catch {
    addToast(t('toasts.copyFailed'), 'error');
  }
};

const restart = () => {
  showConfirm({
    title: t('postgresConfig.ext.restartTitle'),
    message: t('postgresConfig.ext.restartMessage'),
    confirmText: t('postgresConfig.ext.restartButton'),
    type: 'warning',
    onConfirm: async () => {
      isRestarting.value = true;
      try {
        const result = await ipcRenderer.invoke('restart-postgres');
        if (!result?.success) {
          addToast(t('postgresConfig.ext.restartError'), 'error', { detail: result?.error });
          return;
        }
        addToast(t('postgresConfig.ext.restarted'), 'success');
        // The server takes a moment to accept connections again
        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          try {
            await ipcRenderer.invoke('get-postgres-extensions', db.value!.name, db.value!.port);
            break;
          } catch { /* not up yet */ }
        }
        const retry = [...afterRestart.value];
        afterRestart.value = [];
        for (const name of retry) await enable(name);
        await load();
      } catch (error) {
        addToast(t('postgresConfig.ext.restartError'), 'error', { detail: getErrorMessage(error) });
      } finally {
        isRestarting.value = false;
      }
    },
  });
};

const openDocs = (url: string) => window.open(url, '_blank');

const close = () => {
  if (busyName.value || isRestarting.value) return;
  store.showExtensionsModal = false;
  store.extensionsModalDb = null;
};

onMounted(load);
</script>

<template>
  <AppModal
    :title="t('postgresConfig.extensions')"
    :icon="ICON_PUZZLE"
    :meta="db?.name"
    width="lg"
    :sections="sections"
    :section="section"
    :busy="!!busyName || isRestarting"
    :close-label="t('common.close')"
    @update:section="section = $event"
    @close="close"
  >
    <div class="sticky -top-5 z-10 -mx-6 px-6 -mt-5 pt-5 pb-3 mb-1 flex items-center gap-3 bg-white dark:bg-zinc-900">
      <div class="relative flex-1">
        <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
        </svg>
        <input v-model="searchQuery" type="search" :class="inputClass" class="pl-9" :placeholder="t('common.search') + '…'" :aria-label="t('common.search')" />
      </div>
    </div>

    <!-- Loaded at startup: needs a restart -->
    <div
      v-if="pendingRestart.length"
      class="mb-4 flex items-center gap-3 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/60 dark:bg-amber-950/20 px-3.5 py-2.5"
      role="status"
    >
      <p class="flex-1 min-w-0 text-[12px] leading-relaxed text-amber-800 dark:text-amber-300">
        {{ t('postgresConfig.ext.restartBanner', { names: pendingRestart.join(', ') }) }}
        <template v-if="!server?.packageManager"> {{ t('postgresConfig.ext.restartByHand') }}</template>
      </p>
      <!-- Only a server bbdump manages as a service: another one (Docker, Postgres.app…) is restarted by hand -->
      <button
        v-if="server?.packageManager"
        type="button"
        class="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[12px] font-medium border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30 disabled:opacity-50"
        :disabled="isRestarting || !!busyName"
        @click="restart"
      >
        <span v-if="isRestarting" class="w-3 h-3 rounded-full border-2 border-current/30 border-t-current animate-spin" />
        {{ t('postgresConfig.ext.restartButton') }}
      </button>
    </div>

    <div v-if="isLoading && !items.length" class="py-16 flex flex-col items-center justify-center gap-3" role="status">
      <span class="w-6 h-6 rounded-full border-2 border-emerald-500/30 border-t-emerald-500 animate-spin" />
      <span class="text-[12px] text-gray-500 dark:text-zinc-400">{{ t('common.loading') }}…</span>
    </div>

    <p v-else-if="visible.length === 0" class="py-16 text-center text-[13px] text-gray-500 dark:text-zinc-400">{{ t('postgresConfig.ext.empty') }}</p>

    <section v-for="group in groups" v-else :key="group.category ?? 'list'" class="mb-5 last:mb-0">
      <h3 v-if="group.category" class="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-gray-400 dark:text-zinc-500">{{ t(`postgresConfig.ext.categories.${group.category}`) }}</h3>
      <ul class="space-y-2">
        <li
          v-for="item in group.items"
          :key="item.name"
          class="rounded-xl border px-4 py-3 transition-colors"
          :class="item.state === 'enabled'
            ? 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/40 dark:bg-emerald-950/10'
            : 'border-gray-200 dark:border-zinc-800'"
        >
          <div class="flex items-start gap-3">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono text-[13px] font-medium text-gray-900 dark:text-zinc-100">{{ item.name }}</span>
                <span v-if="item.version" class="font-mono text-[10px] text-gray-400 dark:text-zinc-500">v{{ item.version }}</span>
                <span v-if="item.state === 'enabled'" class="px-1.5 py-px rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-[10px] font-medium">{{ t('postgresConfig.ext.enabled') }}</span>
                <span v-if="item.state === 'missing'" class="px-1.5 py-px rounded-full bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400 text-[10px] font-medium">{{ t('postgresConfig.ext.notOnServer') }}</span>
                <span
                  v-if="item.preload"
                  class="px-1.5 py-px rounded-full text-[10px] font-medium"
                  :class="pendingRestart.includes(item.name) ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400' : 'bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400'"
                  :title="t('postgresConfig.ext.preloadHint')"
                >{{ pendingRestart.includes(item.name) ? t('postgresConfig.ext.restartNeeded') : t('postgresConfig.ext.preload') }}</span>
                <button
                  v-if="item.homepage"
                  type="button"
                  class="text-gray-400 hover:text-gray-700 dark:hover:text-zinc-200 transition-colors"
                  :title="t('postgresConfig.ext.docs')"
                  :aria-label="t('postgresConfig.ext.docs') + ' — ' + item.name"
                  @click="openDocs(item.homepage)"
                >
                  <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </button>
              </div>
              <p v-if="item.description" class="mt-0.5 text-[12px] leading-relaxed text-gray-500 dark:text-zinc-400">{{ item.description }}</p>

              <!-- Not on the server, no one-click install: how to get it -->
              <template v-if="item.state === 'missing' && !item.installPackage">
                <div v-if="item.command" class="mt-2 flex items-center gap-2">
                  <code class="flex-1 min-w-0 overflow-x-auto whitespace-nowrap rounded-lg bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 px-2.5 py-1.5 font-mono text-[11px] text-gray-700 dark:text-zinc-300">{{ item.command }}</code>
                  <button type="button" class="shrink-0 h-7 px-2 rounded-lg text-[11px] text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-zinc-100 hover:bg-gray-100 dark:hover:bg-zinc-800" @click="copyCommand(item.command)">{{ t('postgresConfig.ext.copyCommand') }}</button>
                </div>
                <p class="mt-1.5 text-[11px] text-gray-400 dark:text-zinc-500">
                  {{ item.command
                    ? (server?.packageManager === 'brew' ? t('postgresConfig.ext.commandHint') : t('postgresConfig.ext.pgdgHint'))
                    : t('postgresConfig.ext.noPackage') }}
                </p>
              </template>
              <p v-if="packageName === item.name" class="mt-1.5 text-[11px] text-emerald-700 dark:text-emerald-400" role="status">{{ server?.packageManager === 'brew' ? t('postgresConfig.ext.installing', { formula: item.installPackage ?? '' }) : t('postgresConfig.ext.installingLinux', { package: item.installPackage ?? '' }) }}</p>
              <p
                v-if="item.name === 'pg_stat_statements' && item.state === 'enabled'"
                class="mt-2 px-2.5 py-1.5 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/60 dark:bg-amber-950/20 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300"
              >{{ t('viewer.performanceNote') }}</p>
            </div>

            <!-- Action -->
            <span v-if="item.state === 'enabled' && BUILT_IN.includes(item.name)" class="shrink-0 text-[11px] text-gray-400 dark:text-zinc-500 pt-1">{{ t('postgresConfig.builtIn') }}</span>
            <button
              v-else-if="item.state === 'enabled'"
              type="button"
              class="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[12px] font-medium border border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-zinc-300 hover:border-red-300 dark:hover:border-red-800 hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="!!busyName || isRestarting"
              @click="onRemove(item)"
            >
              <span v-if="busyName === item.name" class="w-3 h-3 rounded-full border-2 border-current/30 border-t-current animate-spin" />
              {{ t('postgresConfig.ext.remove') }}
            </button>
            <button
              v-else-if="item.state === 'available' || item.installPackage"
              type="button"
              class="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[12px] font-medium border border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="!!busyName || !!packageName || isRestarting"
              :title="item.state === 'missing' ? t('postgresConfig.ext.installVia', { package: item.installPackage ?? '', source: sourceLabel }) : undefined"
              @click="item.state === 'missing' ? onInstallPackage(item) : onEnable(item)"
            >
              <span v-if="busyName === item.name || packageName === item.name" class="w-3 h-3 rounded-full border-2 border-current/30 border-t-current animate-spin" />
              {{ item.state === 'missing' ? t('postgresConfig.ext.install') : t('postgresConfig.ext.enable') }}
            </button>
          </div>
        </li>
      </ul>
    </section>

    <template #rail-footer>
      <div v-if="server" class="px-3 pt-3 border-t border-gray-100 dark:border-zinc-800 text-[11px] leading-relaxed text-gray-400 dark:text-zinc-500">
        <div class="text-gray-600 dark:text-zinc-300">PostgreSQL {{ server.major }}</div>
        <div>{{ sourceLabel }}</div>
      </div>
    </template>

    <template #footer>
      <span class="text-[12px] text-gray-500 dark:text-zinc-400 tabular-nums">{{ t('postgresConfig.ext.enabledCount', { count: enabledCount }) }}</span>
      <span class="flex-1" />
      <button type="button" :class="btnGhost" :disabled="!!busyName || isRestarting" @click="close">{{ t('common.close') }}</button>
    </template>
  </AppModal>
</template>

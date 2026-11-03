<script setup lang="ts">
/**
 * Settings: the local servers of the engines other than PostgreSQL (its own section has its
 * settings). Only what is here: nothing is installed from this list; "Create a database" opens
 * the engine's dialog on "This computer", where installing is a choice.
 */
import { computed, onMounted, ref } from 'vue';
import { useI18n } from '../composables/useI18n';
import { useFeatures } from '../composables/useFeatures';
import { ipcRenderer } from '../electron';
import { store } from '../store';
import { manifestFor } from '../../../shared/engines/manifests';
import EngineMark from './ui/EngineMark.vue';
import { btnSecondary } from './ui/classes';

type LocalEngine = 'mysql' | 'mariadb' | 'mongodb' | 'sqlserver';
interface ServerState { running: boolean; answering?: LocalEngine; version?: string; installed: boolean }

const { t } = useI18n();
const { isEnabled } = useFeatures();

/** MySQL and MariaDB share a port: one row, named after what answers */
const SERVERS: { engine: LocalEngine; port: number }[] = [
  { engine: 'mysql', port: 3306 },
  { engine: 'mongodb', port: 27017 },
  { engine: 'sqlserver', port: 1433 },
];
const servers = computed(() => SERVERS.filter(server => isEnabled({ engine: server.engine }, 'local.server')));
const states = ref<Record<string, ServerState | 'error' | undefined>>({});
const checking = ref(false);

const check = async () => {
  checking.value = true;
  await Promise.all(servers.value.map(async server => {
    try {
      states.value[server.engine] = await ipcRenderer.invoke('local-engine-state', server.engine, server.port) as ServerState;
    } catch {
      states.value[server.engine] = 'error';
    }
  }));
  checking.value = false;
};
onMounted(check);

const stateOf = (engine: LocalEngine): ServerState | null => {
  const state = states.value[engine];
  return state && state !== 'error' ? state : null;
};

const label = (engine: LocalEngine) => {
  const answering = stateOf(engine)?.answering;
  if (engine === 'mysql') return answering ? manifestFor(answering)?.label ?? answering : 'MySQL / MariaDB';
  return manifestFor(engine)?.label ?? engine;
};

const status = (server: { engine: LocalEngine; port: number }) => {
  const state = states.value[server.engine];
  if (!state) return { tone: 'neutral', text: t('localServers.checking') };
  if (state === 'error') return { tone: 'neutral', text: t('localServers.unknown') };
  if (state.running) return { tone: 'ok', text: t('localServers.running', { version: state.version ? ` ${state.version}` : '', port: server.port }) };
  if (state.installed) return { tone: 'warn', text: t('localServers.stopped') };
  return { tone: 'neutral', text: t('localServers.notInstalled') };
};

/** The engine's dialog, on "This computer" */
const createHere = (server: { engine: LocalEngine }) => {
  store.editingDatabase = null;
  store.databaseModalIntent = 'local';
  store.databaseModalEngine = stateOf(server.engine)?.answering ?? server.engine;
  store.showDatabaseModal = true;
};
</script>

<template>
  <div class="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 divide-y divide-gray-100 dark:divide-zinc-800">
    <p class="px-4 py-3 text-[12px] leading-relaxed text-gray-500 dark:text-zinc-400">{{ t('localServers.intro') }}</p>
    <div v-for="server in servers" :key="server.engine" class="px-4 py-3 flex items-center gap-3">
      <EngineMark :engine="stateOf(server.engine)?.answering ?? server.engine" />
      <div class="flex-1 min-w-0">
        <div class="text-[13px] font-medium text-gray-900 dark:text-zinc-100">{{ label(server.engine) }}</div>
        <div class="flex items-center gap-1.5 text-[12px] text-gray-500 dark:text-zinc-400">
          <span
            class="w-1.5 h-1.5 rounded-full shrink-0"
            :class="status(server).tone === 'ok' ? 'bg-emerald-500' : status(server).tone === 'warn' ? 'bg-amber-500' : 'bg-gray-300 dark:bg-zinc-600'"
            aria-hidden="true"
          />
          {{ status(server).text }}
        </div>
      </div>
      <button type="button" :class="btnSecondary" class="shrink-0" @click="createHere(server)">{{ t('localServers.createHere') }}</button>
    </div>
    <div class="px-4 py-2.5">
      <button type="button" class="text-[12px] text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-zinc-200 hover:underline underline-offset-2 disabled:opacity-50" :disabled="checking" @click="check">
        {{ t('localServers.recheck') }}
      </button>
    </div>
  </div>
</template>

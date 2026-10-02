<script setup lang="ts">
/**
 * Adding a Neon database without copying its URL: with a Neon API key (kept encrypted by
 * the main process, never sent here), pick project → branch → database, and bbdump gets
 * the direct connection URI.
 */
import { ref, computed, onMounted, watch } from 'vue';
import { ipcRenderer } from '../electron';
import { useI18n } from '../composables/useI18n';
import FormField from './ui/FormField.vue';
import { btnPrimary, btnSecondary, btnGhost, monoInputClass, selectClass } from './ui/classes';

interface Project { id: string; name: string; region: string; org?: string }
interface Branch { id: string; name: string; default: boolean }
interface NeonDb { name: string; owner: string }
type Reply<T> = { success: true; data: T } | { success: false; error: string; code: 'no_key' | 'invalid_key' | 'network' | 'api' };

const emit = defineEmits<{ pick: [uri: string, label: string]; unpick: []; connected: [value: boolean] }>();
const { t } = useI18n();

const API_KEYS_URL = 'https://console.neon.tech/app/settings/api-keys';

const connected = ref<boolean | null>(null);
const open = ref(false);
const apiKey = ref('');
const busy = ref(false);
const error = ref('');

const projects = ref<Project[]>([]);
const branches = ref<Branch[]>([]);
const databases = ref<NeonDb[]>([]);
const projectId = ref('');
const branchId = ref('');
const databaseName = ref('');
/** The database whose URL is in the form ('' = none yet) */
const filled = ref('');
const fetching = ref(false);

const errorText = (reply: { error: string; code: string }) =>
  reply.code === 'invalid_key' ? t('neon.errors.invalidKey')
    : reply.code === 'network' ? t('neon.errors.network')
      : t('neon.errors.api', { error: reply.error });

/** Runs one call; a key refused later (revoked) goes back to the key form */
async function call<T>(channel: string, ...args: unknown[]): Promise<T | null> {
  error.value = '';
  const reply = await ipcRenderer.invoke(channel, ...args) as Reply<T>;
  if (reply.success) return reply.data;
  if (reply.code === 'no_key' || reply.code === 'invalid_key') connected.value = false;
  error.value = errorText(reply);
  return null;
}

watch(connected, value => emit('connected', value === true));

onMounted(async () => {
  connected.value = (await ipcRenderer.invoke('neon-status') as { connected: boolean }).connected;
  if (connected.value) {
    open.value = true;
    await loadProjects();
  }
});

const loadProjects = async () => {
  busy.value = true;
  const list = await call<Project[]>('neon-projects');
  busy.value = false;
  if (!list) return;
  projects.value = list;
  if (list.length === 1) projectId.value = list[0].id;
};

const connect = async () => {
  if (!apiKey.value.trim() || busy.value) return;
  busy.value = true;
  const list = await call<Project[]>('neon-connect', apiKey.value.trim());
  busy.value = false;
  if (!list) return;
  apiKey.value = '';
  connected.value = true;
  projects.value = list;
  if (list.length === 1) projectId.value = list[0].id;
};

const forget = async () => {
  await ipcRenderer.invoke('neon-forget');
  connected.value = false;
  projects.value = [];
  projectId.value = '';
  error.value = '';
};

watch(projectId, async (id) => {
  branches.value = [];
  branchId.value = '';
  if (!id) return;
  const list = await call<Branch[]>('neon-branches', id);
  if (!list || projectId.value !== id) return;
  branches.value = list;
  branchId.value = list.find(b => b.default)?.id ?? list[0]?.id ?? '';
});

watch(branchId, async (id) => {
  databases.value = [];
  databaseName.value = '';
  if (!id) return;
  const list = await call<NeonDb[]>('neon-databases', projectId.value, id);
  if (!list || branchId.value !== id) return;
  databases.value = list;
  if (list.length === 1) databaseName.value = list[0].name;
});

/** Projects grouped by organization when the key reaches several */
const projectGroups = computed(() => {
  const groups = new Map<string, Project[]>();
  for (const p of projects.value) {
    const org = p.org ?? '';
    groups.set(org, [...(groups.get(org) ?? []), p]);
  }
  return [...groups.entries()].map(([org, items]) => ({ org, items }));
});

/** Choosing the database is enough: its URL goes straight into the form */
watch(databaseName, async (name) => {
  // The URL of the previous choice must not stay in the form
  if (filled.value) emit('unpick');
  filled.value = '';
  const db = databases.value.find(d => d.name === name);
  if (!db) return;
  const pid = projectId.value;
  const bid = branchId.value;
  fetching.value = true;
  const uri = await call<string>('neon-connection-uri', pid, bid, db.name, db.owner);
  fetching.value = false;
  // Another choice was made meanwhile
  if (!uri || databaseName.value !== name || projectId.value !== pid || branchId.value !== bid) return;
  const project = projects.value.find(p => p.id === pid);
  const branch = branches.value.find(b => b.id === bid);
  const base = project?.name ?? db.name;
  const withDb = databases.value.length > 1 ? `${base} · ${db.name}` : base;
  emit('pick', uri, branch && !branch.default ? `${withDb} (${branch.name})` : withDb);
  filled.value = `${db.name}${branch ? ` · ${branch.name}` : ''}`;
});
</script>

<template>
  <div class="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3.5 py-3">
    <div class="flex items-center gap-2">
      <span class="w-2.5 h-2.5 rounded-full shrink-0 bg-[#00E599]" />
      <div class="text-[13px] font-medium text-gray-800 dark:text-zinc-100">{{ t('neon.title') }}</div>
      <button v-if="connected" type="button" :class="btnGhost" class="ml-auto h-7! px-2! text-[12px]!" @click="forget">{{ t('neon.forget') }}</button>
      <button v-else-if="connected === false && !open" type="button" :class="btnSecondary" class="ml-auto" @click="open = true">{{ t('neon.useKey') }}</button>
    </div>
    <p v-if="!open && connected === false" class="mt-1 text-[12px] text-gray-500 dark:text-zinc-400">{{ t('neon.pitch') }}</p>

    <!-- Key -->
    <div v-if="open && connected === false" class="mt-3 space-y-2.5">
      <p class="text-[12px] text-gray-500 dark:text-zinc-400">{{ t('neon.keyHelp') }}</p>
      <FormField :label="t('neon.keyLabel')" for="neon-key" :hint="t('neon.keyStored')">
        <div class="flex gap-2">
          <input
            id="neon-key"
            v-model="apiKey"
            type="password"
            autocomplete="off"
            spellcheck="false"
            :class="monoInputClass"
            class="min-w-0 flex-1"
            placeholder="napi_…"
            data-own-enter
            @keydown.enter.stop.prevent="connect"
          />
          <button type="button" :class="btnPrimary" class="shrink-0" :disabled="!apiKey.trim() || busy" @click="connect">
            {{ busy ? t('neon.connecting') : t('neon.connect') }}
          </button>
        </div>
      </FormField>
      <a :href="API_KEYS_URL" target="_blank" class="inline-flex text-[12px] text-emerald-700 dark:text-emerald-400 hover:underline">{{ t('neon.createKey') }}</a>
    </div>

    <!-- Pickers -->
    <div v-if="connected" class="mt-3 space-y-3">
      <p v-if="busy && projects.length === 0" class="text-[12px] text-gray-500 dark:text-zinc-400">{{ t('neon.loading') }}</p>
      <p v-else-if="projects.length === 0 && !error" class="text-[12px] text-gray-500 dark:text-zinc-400">{{ t('neon.noProjects') }}</p>
      <template v-else-if="projects.length">
        <FormField :label="t('neon.project')" for="neon-project">
          <select id="neon-project" v-model="projectId" :class="selectClass">
            <option value="" disabled>{{ t('neon.chooseProject') }}</option>
            <template v-for="group in projectGroups" :key="group.org">
              <optgroup v-if="projectGroups.length > 1" :label="group.org">
                <option v-for="p in group.items" :key="p.id" :value="p.id">{{ p.name }} · {{ p.region }}</option>
              </optgroup>
              <template v-else>
                <option v-for="p in group.items" :key="p.id" :value="p.id">{{ p.name }} · {{ p.region }}</option>
              </template>
            </template>
          </select>
        </FormField>
        <div class="grid grid-cols-2 gap-3">
          <FormField :label="t('neon.branch')" for="neon-branch">
            <select id="neon-branch" v-model="branchId" :class="selectClass" :disabled="!branches.length">
              <option v-for="b in branches" :key="b.id" :value="b.id">{{ b.name }}{{ b.default ? ` · ${t('neon.default')}` : '' }}</option>
            </select>
          </FormField>
          <FormField :label="t('neon.database')" for="neon-db">
            <select id="neon-db" v-model="databaseName" :class="selectClass" :disabled="!databases.length">
              <option v-if="databases.length > 1" value="" disabled>{{ t('neon.chooseDatabase') }}</option>
              <option v-for="d in databases" :key="d.name" :value="d.name">{{ d.name }}</option>
            </select>
          </FormField>
        </div>
        <p v-if="fetching" class="text-[12px] text-gray-500 dark:text-zinc-400">{{ t('neon.fetching') }}</p>
        <p v-else-if="filled" role="status" class="flex items-center gap-1.5 text-[12px] text-emerald-700 dark:text-emerald-400">
          <svg class="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          {{ t('neon.filled', { database: filled }) }}
        </p>
        <p v-else-if="databases.length > 1" class="text-[12px] text-gray-500 dark:text-zinc-400">{{ t('neon.pickDatabase') }}</p>
      </template>
    </div>

    <p v-if="error" role="alert" class="mt-2.5 text-[12px] text-red-600 dark:text-red-400">{{ error }}</p>
  </div>
</template>

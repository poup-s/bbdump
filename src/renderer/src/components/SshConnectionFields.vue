<script setup lang="ts">
/**
 * The "Server via SSH" connection: the SSH host (an alias of the user's ~/.ssh/config,
 * whose keys and agent bbdump's `ssh` uses as is), PostgreSQL as seen from the server,
 * and the credentials, read from an env file on the server or from a pasted URL.
 * The test checks SSH first (and offers to trust an unknown server, fingerprint shown),
 * then PostgreSQL through the tunnel.
 */
import { ref, computed, onMounted, watch } from 'vue';
import { useI18n } from '../composables/useI18n';
import { ipcRenderer } from '../electron';
import { parsePgUrl } from '../pgUrl';
import type { Database } from '../types';
import FormField from './ui/FormField.vue';
import { btnSecondary, inputClass, monoInputClass, panelClass } from './ui/classes';

type Ssh = NonNullable<Database['ssh']>;
type SshFailure = { success: false; code: string; error: string; fingerprints?: string[] };

const props = defineProps<{ editing: boolean; databaseId?: string; attempted: boolean }>();
const form = defineModel<Database>('form', { required: true });
const ssh = defineModel<Ssh>('ssh', { required: true });
const { t } = useI18n();

const hosts = ref<string[]>([]);
onMounted(async () => {
  try {
    hosts.value = await ipcRenderer.invoke('ssh-hosts');
  } catch {
    hosts.value = [];
  }
});

// The saved host / port are the server and the remote port (see config.d.ts)
const resolvedHost = ref('');
watch(() => ssh.value.host, (host) => {
  resolvedHost.value = '';
  form.value.host = host;
});
watch(() => ssh.value.remotePort, (port) => { form.value.port = Number(port) || 5432; }, { immediate: true });

/** An emptied number field is "": no SSH port means the one of ~/.ssh/config, no database port 5432 */
const sshPayload = () => ({
  ...ssh.value,
  port: Number(ssh.value.port) || undefined,
  remotePort: Number(ssh.value.remotePort) || 5432,
});

// --- Credentials ----------------------------------------------------------------

const source = ref<'env' | 'url'>(ssh.value.envFile || !props.editing ? 'env' : 'url');
const pastedUrl = ref('');
const reading = ref(false);
const readError = ref<SshFailure | null>(null);
const readOk = ref(false);
const containerName = ref('');

/** A name without a dot (Docker Compose service) only resolves between containers */
const remoteHostFor = (host: string) => {
  if (!host || ['localhost', '127.0.0.1', '::1'].includes(host)) return { host: 'localhost' };
  if (/^[\d.]+$/.test(host) || host.includes('.') || host.includes(':')) return { host };
  return { host: 'localhost', container: host };
};

const applyUrl = (url: string) => {
  const parsed = parsePgUrl(url);
  if (!parsed?.database) return false;
  form.value.name = parsed.database;
  if (parsed.user) form.value.user = parsed.user;
  if (parsed.password) form.value.password = parsed.password;
  // Through the tunnel the server name cannot be checked: verify-full becomes verify-ca
  form.value.sslMode = !parsed.sslMode ? 'disable' : parsed.sslMode === 'verify-full' ? 'verify-ca' : parsed.sslMode;
  const remote = remoteHostFor(parsed.host);
  ssh.value.remoteHost = remote.host;
  ssh.value.remotePort = parsed.port || 5432;
  containerName.value = remote.container ?? '';
  if (!form.value.displayName?.trim()) form.value.displayName = parsed.database;
  return true;
};

// Finding the env file: the server lists the files holding a PostgreSQL URL (names only)
type EnvFileMatch = { file: string; variables: string[]; example: boolean; copy: boolean };
const searching = ref(false);
const found = ref<EnvFileMatch[] | null>(null);
const findError = ref<SshFailure | null>(null);

const findEnv = async () => {
  if (!ssh.value.host) return;
  searching.value = true;
  found.value = null;
  findError.value = null;
  try {
    const result = await ipcRenderer.invoke('ssh-find-env', sshPayload()) as { success: true; files: EnvFileMatch[] } | SshFailure;
    if (!result.success) {
      findError.value = result;
      if (result.code === 'unknown-host') sshFailure.value = result;
      return;
    }
    found.value = result.files;
  } finally {
    searching.value = false;
  }
};

const pickEnv = (file: string, variable: string) => {
  ssh.value.envFile = file;
  ssh.value.envVar = variable;
  found.value = null;
  readEnv();
};

const readEnv = async () => {
  if (!ssh.value.host || !ssh.value.envFile?.trim()) return;
  reading.value = true;
  readError.value = null;
  readOk.value = false;
  try {
    const result = await ipcRenderer.invoke('ssh-read-env', sshPayload(), ssh.value.envFile.trim(), ssh.value.envVar || 'DATABASE_URL') as { success: true; value: string } | SshFailure;
    if (!result.success) {
      readError.value = result;
      if (result.code === 'unknown-host') sshFailure.value = result;
      return;
    }
    if (!applyUrl(result.value)) {
      readError.value = { success: false, code: 'not-url', error: '' };
      return;
    }
    readOk.value = true;
  } finally {
    reading.value = false;
  }
};

watch(pastedUrl, (url) => { if (url.trim()) applyUrl(url.trim()); });
const pastedInvalid = computed(() => !!pastedUrl.value.trim() && !parsePgUrl(pastedUrl.value.trim())?.database);

// --- Test -----------------------------------------------------------------------

type Step = { state: 'idle' | 'running' | 'ok' | 'error'; detail?: string };
const sshStep = ref<Step>({ state: 'idle' });
const pgStep = ref<Step>({ state: 'idle' });
const sshFailure = ref<SshFailure | null>(null);
const trusting = ref(false);
const testing = computed(() => sshStep.value.state === 'running' || pgStep.value.state === 'running');

watch(() => [ssh.value.host, ssh.value.user, ssh.value.port, ssh.value.remoteHost, ssh.value.remotePort, form.value.name, form.value.user, form.value.password], () => {
  if (testing.value) return;
  sshStep.value = { state: 'idle' };
  pgStep.value = { state: 'idle' };
});

const sshErrorText = (failure: SshFailure) => {
  const known = ['auth', 'unknown-host', 'host-changed', 'dns', 'timeout', 'unreachable', 'not-found', 'not-url'];
  return known.includes(failure.code)
    ? t(`ssh.errors.${failure.code}`, { host: ssh.value.host, file: ssh.value.envFile ?? '', variable: ssh.value.envVar || 'DATABASE_URL' })
    : t('ssh.errors.other');
};

const runTest = async () => {
  sshFailure.value = null;
  sshStep.value = { state: 'running' };
  pgStep.value = { state: 'idle' };
  const check = await ipcRenderer.invoke('ssh-check', sshPayload()) as { success: true; ms: number; hostname?: string; user?: string } | SshFailure;
  if (!check.success) {
    sshFailure.value = check;
    sshStep.value = { state: 'error' };
    return;
  }
  if (check.hostname) {
    resolvedHost.value = check.hostname;
    form.value.host = check.hostname;
  }
  sshStep.value = { state: 'ok', detail: t('ssh.test.sshOk', { target: `${check.user ? `${check.user}@` : ''}${check.hostname ?? ssh.value.host}`, ms: check.ms }) };
  pgStep.value = { state: 'running' };
  try {
    const result = await ipcRenderer.invoke('test-database-connection', {
      id: props.editing ? props.databaseId : undefined,
      host: form.value.host,
      port: Number(ssh.value.remotePort) || 5432,
      user: form.value.user,
      password: form.value.password,
      database: form.value.name,
      sslMode: form.value.sslMode,
      ssh: sshPayload(),
    }) as { version: string; tables: number };
    pgStep.value = { state: 'ok', detail: t('dbModal.testOk', { version: result.version, tables: result.tables }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pgStep.value = { state: 'error', detail: message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
  }
};

const trust = async () => {
  trusting.value = true;
  try {
    const result = await ipcRenderer.invoke('ssh-trust-host', sshPayload()) as { success: boolean } | SshFailure;
    if (!result.success) {
      sshFailure.value = result as SshFailure;
      return;
    }
    sshFailure.value = null;
    // The .env read stopped on the unknown server: read it now, then test
    const rereadEnv = readError.value?.code === 'unknown-host';
    readError.value = null;
    if (rereadEnv) await readEnv();
    if (form.value.name && form.value.user) await runTest();
  } finally {
    trusting.value = false;
  }
};

const missing = (value: unknown) => props.attempted && !String(value ?? '').trim();
const sectionLabel = 'text-[10px] font-bold uppercase tracking-[0.12em] text-gray-400 dark:text-zinc-500 mb-2';
const stepClass = (state: Step['state']) => (state === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : state === 'error' ? 'text-red-600 dark:text-red-400' : 'text-gray-400');
const stepMark = (state: Step['state']) => (state === 'ok' ? '✓' : state === 'error' ? '✕' : '…');
</script>

<template>
  <div class="space-y-5">
    <!-- 1. SSH -->
    <section>
      <div :class="sectionLabel">{{ t('ssh.sectionSsh') }}</div>
      <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,0.6fr)_5.5rem] gap-3">
        <FormField :label="t('ssh.host')" for="ssh-host" required :error="missing(ssh.host) ? t('dbModal.required') : undefined">
          <input id="ssh-host" v-model.trim="ssh.host" type="text" list="ssh-hosts" spellcheck="false" autocomplete="off" :class="monoInputClass" placeholder="mon-vps" />
          <datalist id="ssh-hosts"><option v-for="h in hosts" :key="h" :value="h" /></datalist>
        </FormField>
        <FormField :label="t('ssh.user')" for="ssh-user" :optional="t('common.optional')">
          <input id="ssh-user" v-model.trim="ssh.user" type="text" spellcheck="false" autocomplete="off" :class="monoInputClass" :placeholder="t('ssh.fromConfig')" />
        </FormField>
        <FormField :label="t('ssh.port')" for="ssh-port" :optional="t('common.optional')">
          <input id="ssh-port" v-model.number="ssh.port" type="number" min="1" max="65535" :class="monoInputClass" placeholder="22" />
        </FormField>
      </div>
      <div v-if="hosts.length" class="mt-2 flex flex-wrap items-center gap-1.5">
        <span class="text-[11.5px] text-gray-500 dark:text-zinc-400">{{ t('ssh.fromSshConfig') }}</span>
        <button
          v-for="h in hosts.slice(0, 8)"
          :key="h"
          type="button"
          class="h-6 px-2 rounded-md border font-mono text-[11.5px] transition-colors"
          :class="ssh.host === h ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400' : 'border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-zinc-300 hover:border-gray-300 dark:hover:border-zinc-600'"
          @click="ssh.host = h"
        >{{ h }}</button>
      </div>
      <p class="mt-1.5 text-[11.5px] text-gray-500 dark:text-zinc-400">{{ t('ssh.keysHint') }}</p>
    </section>

    <!-- 2. PostgreSQL on the server -->
    <section>
      <div :class="sectionLabel">{{ t('ssh.sectionRemote') }}</div>
      <div class="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
        <FormField :label="t('database.host')" for="ssh-remote-host" :hint="t('ssh.remoteHint')">
          <input id="ssh-remote-host" v-model.trim="ssh.remoteHost" type="text" spellcheck="false" :class="monoInputClass" placeholder="localhost" />
        </FormField>
        <FormField :label="t('database.port')" for="ssh-remote-port">
          <input id="ssh-remote-port" v-model.number="ssh.remotePort" type="number" min="1" max="65535" :class="monoInputClass" placeholder="5432" />
        </FormField>
      </div>
    </section>

    <!-- 3. Credentials -->
    <section>
      <div :class="sectionLabel">{{ t('ssh.sectionCredentials') }}</div>
      <div class="flex p-0.5 rounded-lg bg-gray-100 dark:bg-zinc-800/70 w-fit mb-3" role="radiogroup">
        <button
          v-for="s in (['env', 'url'] as const)"
          :key="s"
          type="button"
          role="radio"
          :aria-checked="source === s"
          class="h-7 px-3 rounded-md text-[12.5px] transition-colors"
          :class="source === s ? 'bg-white dark:bg-zinc-700 text-gray-900 dark:text-white shadow-sm font-medium' : 'text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-zinc-200'"
          @click="source = s"
        >{{ s === 'env' ? t('ssh.readEnv') : t('ssh.pasteUrl') }}</button>
      </div>

      <template v-if="source === 'env'">
        <div class="grid grid-cols-[minmax(0,1fr)_9rem_auto] gap-2 items-end">
          <FormField :label="t('ssh.envFile')" for="ssh-env-file">
            <input id="ssh-env-file" v-model.trim="ssh.envFile" type="text" spellcheck="false" :class="monoInputClass" placeholder="/srv/app/.env.production" />
          </FormField>
          <FormField :label="t('ssh.envVar')" for="ssh-env-var">
            <input id="ssh-env-var" v-model.trim="ssh.envVar" type="text" spellcheck="false" :class="monoInputClass" placeholder="DATABASE_URL" />
          </FormField>
          <button type="button" :class="btnSecondary" :disabled="reading || !ssh.host || !ssh.envFile" @click="readEnv">
            {{ reading ? t('ssh.reading') : t('ssh.read') }}
          </button>
        </div>
        <div class="mt-2 flex items-start gap-2">
          <button
            type="button"
            class="shrink-0 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-emerald-700 dark:text-emerald-400 hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
            :disabled="searching || !ssh.host"
            @click="findEnv"
          >
            <span v-if="searching" class="w-3 h-3 rounded-full border-2 border-emerald-500/30 border-t-emerald-500 animate-spin" aria-hidden="true" />
            <svg v-else class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" stroke-linecap="round" /></svg>
            {{ searching ? t('ssh.findingEnv') : t('ssh.findEnv') }}
          </button>
          <span class="text-[11.5px] leading-snug text-gray-500 dark:text-zinc-400 pt-px">{{ t('ssh.findEnvHint') }}</span>
        </div>
        <div v-if="found" :class="panelClass" class="mt-2 p-1 max-h-56 overflow-y-auto" role="listbox" :aria-label="t('ssh.findEnv')">
          <p v-if="!found.length" class="px-2.5 py-2 text-[12px] text-gray-500 dark:text-zinc-400">{{ t('ssh.findEnvNone') }}</p>
          <template v-for="match in found" :key="match.file">
            <button
              v-for="variable in match.variables"
              :key="`${match.file}:${variable}`"
              type="button"
              role="option"
              class="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
              :title="t('ssh.findEnvPick', { variable, file: match.file })"
              @click="pickEnv(match.file, variable)"
            >
              <span class="flex-1 min-w-0 truncate font-mono text-[12px] text-gray-800 dark:text-zinc-200 [direction:rtl] text-left"><bdi>{{ match.file }}</bdi></span>
              <span class="shrink-0 font-mono text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300">{{ variable }}</span>
              <span v-if="match.example" class="shrink-0 text-[10.5px] text-amber-600 dark:text-amber-400">{{ t('ssh.findEnvExample') }}</span>
              <span v-else-if="match.copy" class="shrink-0 text-[10.5px] text-gray-500 dark:text-zinc-400">{{ t('ssh.findEnvCopy') }}</span>
            </button>
          </template>
        </div>
        <p v-if="findError" class="mt-2 text-[12px] text-red-600 dark:text-red-400" role="alert">
          {{ sshErrorText(findError) }}
          <span v-if="findError.error && findError.code !== 'unknown-host'" class="block mt-0.5 font-mono text-[11px] text-gray-500 dark:text-zinc-400 break-words">{{ findError.error }}</span>
        </p>
        <p v-if="readOk" class="mt-2 text-[12px] text-emerald-700 dark:text-emerald-400" role="status">{{ t('ssh.readOk', { variable: ssh.envVar || 'DATABASE_URL' }) }}</p>
        <p v-else-if="readError" class="mt-2 text-[12px] text-red-600 dark:text-red-400" role="alert">
          {{ sshErrorText(readError) }}
          <span v-if="readError.error && !['not-url', 'unknown-host'].includes(readError.code)" class="block mt-0.5 font-mono text-[11px] text-gray-500 dark:text-zinc-400 break-words">{{ readError.error }}</span>
        </p>
      </template>
      <FormField v-else :label="t('database.connectionUrlLabel')" for="ssh-url" :error="pastedInvalid ? t('dbModal.urlInvalid') : undefined" :hint="t('ssh.urlHint')">
        <input id="ssh-url" v-model="pastedUrl" type="text" spellcheck="false" autocomplete="off" :class="monoInputClass" placeholder="postgresql://user:password@localhost:5432/app" />
      </FormField>

      <div v-if="containerName" class="mt-3 px-3 py-2.5 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 text-[12px] text-amber-900 dark:text-amber-200" role="alert">
        {{ t('ssh.containerHint', { name: containerName }) }}
      </div>

      <div class="mt-3 grid grid-cols-3 gap-3">
        <FormField :label="t('database.name')" for="ssh-db-name" required :error="missing(form.name) ? t('dbModal.required') : undefined">
          <input id="ssh-db-name" v-model.trim="form.name" type="text" spellcheck="false" :class="monoInputClass" />
        </FormField>
        <FormField :label="t('database.user')" for="ssh-db-user" required :error="missing(form.user) ? t('dbModal.required') : undefined">
          <input id="ssh-db-user" v-model.trim="form.user" type="text" spellcheck="false" autocomplete="off" :class="monoInputClass" />
        </FormField>
        <FormField :label="t('database.password')" for="ssh-db-password" :hint="editing ? t('dbModal.urlPasswordKept') : undefined">
          <input id="ssh-db-password" v-model="form.password" type="password" autocomplete="new-password" :class="monoInputClass" />
        </FormField>
      </div>
      <FormField :label="t('database.displayName')" for="ssh-display" :optional="t('common.optional')" class="mt-3">
        <input id="ssh-display" v-model="form.displayName" type="text" :class="inputClass" :placeholder="t('database.displayNamePlaceholder')" />
      </FormField>
    </section>

    <!-- Test -->
    <section>
      <button type="button" :class="btnSecondary" :disabled="testing || trusting || !ssh.host || !form.name || !form.user" @click="runTest">
        {{ testing ? t('dbModal.testing') : sshStep.state === 'idle' ? t('dbModal.test') : t('dbModal.testAgain') }}
      </button>
      <div v-if="sshStep.state !== 'idle' || sshFailure" :class="panelClass" class="mt-3 px-3.5 py-3 space-y-2 text-[12.5px]" aria-live="polite">
        <div class="flex items-start gap-2">
          <span class="mt-0.5 font-mono text-[11px] w-4" :class="stepClass(sshFailure ? 'error' : sshStep.state)">{{ stepMark(sshFailure ? 'error' : sshStep.state) }}</span>
          <div class="min-w-0 flex-1">
            <div class="text-gray-800 dark:text-zinc-100">{{ t('ssh.test.ssh', { host: ssh.host }) }}</div>
            <div v-if="sshStep.detail && !sshFailure" class="text-[11.5px] text-gray-500 dark:text-zinc-400">{{ sshStep.detail }}</div>
            <template v-if="sshFailure">
              <div class="mt-1 text-red-600 dark:text-red-400">{{ sshErrorText(sshFailure) }}</div>
              <div v-if="sshFailure.error && sshFailure.code !== 'unknown-host'" class="mt-1 font-mono text-[11px] text-gray-500 dark:text-zinc-400 break-words">{{ sshFailure.error }}</div>
              <div v-if="sshFailure.code === 'unknown-host'" class="mt-2 rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2.5">
                <div class="text-[12px] text-gray-600 dark:text-zinc-300">{{ t('ssh.trustIntro') }}</div>
                <div v-for="f in sshFailure.fingerprints ?? []" :key="f" class="mt-1 font-mono text-[11.5px] text-gray-800 dark:text-zinc-100 break-all select-text">{{ f }}</div>
                <div v-if="!(sshFailure.fingerprints ?? []).length" class="mt-1 text-[11.5px] text-gray-500">{{ t('ssh.noFingerprint') }}</div>
                <button type="button" :class="btnSecondary" class="mt-2" :disabled="trusting" @click="trust">{{ trusting ? t('ssh.trusting') : t('ssh.trust') }}</button>
              </div>
              <details v-else-if="sshFailure.error" class="mt-1">
                <summary class="text-[11.5px] text-gray-500 cursor-pointer">{{ t('ssh.details') }}</summary>
                <pre class="mt-1 font-mono text-[11px] text-gray-500 whitespace-pre-wrap break-words select-text">{{ sshFailure.error }}</pre>
              </details>
            </template>
          </div>
        </div>
        <div v-if="pgStep.state !== 'idle'" class="flex items-start gap-2">
          <span class="mt-0.5 font-mono text-[11px] w-4" :class="stepClass(pgStep.state)">{{ stepMark(pgStep.state) }}</span>
          <div class="min-w-0 flex-1">
            <div class="text-gray-800 dark:text-zinc-100">{{ t('ssh.test.postgres', { target: `${ssh.remoteHost}:${ssh.remotePort}` }) }}</div>
            <div v-if="pgStep.detail" class="text-[11.5px] break-words" :class="pgStep.state === 'error' ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-zinc-400'">{{ pgStep.detail }}</div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

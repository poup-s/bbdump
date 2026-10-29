<script setup lang="ts">
/**
 * The local server of MySQL, MariaDB or MongoDB, in the "On this computer" mode of the add
 * dialogs: what runs on the port, and the one next step (install, start, an account). Ready
 * when bbdump can create a database on it.
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';
import { manifestFor } from '../../../shared/engines/manifests';
import FormField from './ui/FormField.vue';
import { btnPrimary, btnSecondary, inputClass, monoInputClass } from './ui/classes';

type LocalEngine = 'mysql' | 'mariadb' | 'mongodb';
interface LocalServerState {
  engine: LocalEngine; port: number; os: 'macos' | 'linux' | 'windows';
  running: boolean; answering?: LocalEngine; version?: string; installed: boolean;
  account: 'ready' | 'needed' | 'unknown'; user?: string; canCreateAccount: boolean;
  canInstall: boolean; canStart: boolean; installCommand: string;
}

const props = defineProps<{ engine: LocalEngine }>();
const port = defineModel<number>('port', { required: true });
/** The engine that answers, once bbdump can create a database on it (else null) */
const ready = defineModel<LocalEngine | null>('ready', { default: null });

const { t } = useI18n();
const { addToast } = useToast();
const state = ref<LocalServerState | null>(null);
const checking = ref(false);
const busy = ref<'install' | 'start' | 'account' | 'create-account' | null>(null);
const progressLine = ref('');
const account = ref({ user: props.engine === 'mongodb' ? 'admin' : 'root', password: '' });
const accountError = ref('');

const label = (engine?: string) => manifestFor(engine ?? props.engine)?.label ?? engine ?? props.engine;
const sameFamily = computed(() => !state.value?.answering || (props.engine === 'mongodb') === (state.value.answering === 'mongodb'));

const check = async () => {
  checking.value = true;
  try {
    state.value = await ipcRenderer.invoke('local-engine-state', props.engine, port.value) as LocalServerState;
  } catch {
    state.value = null;
  } finally {
    checking.value = false;
  }
};

watch(state, value => {
  ready.value = value?.running && value.account === 'ready' && sameFamily.value ? (value.answering ?? props.engine) : null;
});
let portTimer: ReturnType<typeof setTimeout> | null = null;
watch(port, () => {
  if (portTimer) clearTimeout(portTimer);
  portTimer = setTimeout(check, 400);
});

const onProgress = (_: unknown, payload: { engine: string; line: string }) => {
  if (payload?.engine === props.engine && payload.line) progressLine.value = payload.line.slice(0, 160);
};
let unsubscribe: (() => void) | null = null;
onMounted(() => {
  // The preload wraps the listener: it gives back how to remove it
  unsubscribe = ipcRenderer.on('local-engine-progress', onProgress) as unknown as () => void;
  check();
});
onUnmounted(() => {
  unsubscribe?.();
  if (portTimer) clearTimeout(portTimer);
});

const run = async (kind: 'install' | 'start', channel: string) => {
  busy.value = kind;
  progressLine.value = '';
  try {
    const result = await ipcRenderer.invoke(channel, props.engine) as { success: boolean; error?: string };
    if (!result.success) addToast(t(kind === 'install' ? 'localServer.installFailed' : 'localServer.startFailed', { engine: label() }), 'error', { detail: result.error });
    else addToast(t(kind === 'install' ? 'localServer.installed' : 'localServer.started', { engine: label() }), 'success');
  } finally {
    busy.value = null;
    progressLine.value = '';
    await check();
  }
};

const saveAccount = async () => {
  accountError.value = '';
  if (!account.value.user.trim()) {
    accountError.value = t('dbModal.required');
    return;
  }
  busy.value = 'account';
  try {
    const result = await ipcRenderer.invoke('local-engine-save-account', props.engine, port.value, account.value.user.trim(), account.value.password) as { success: boolean; error?: string };
    if (!result.success) accountError.value = result.error || t('localServer.accountRefused');
    else {
      account.value.password = '';
      await check();
    }
  } finally {
    busy.value = null;
  }
};

const createAccount = async () => {
  busy.value = 'create-account';
  try {
    const result = await ipcRenderer.invoke('local-engine-create-account', props.engine, port.value) as { success: boolean; error?: string };
    if (!result.success) addToast(t('localServer.accountFailed'), 'error', { detail: result.error });
    await check();
  } finally {
    busy.value = null;
  }
};

const copyCommand = async () => {
  if (!state.value?.installCommand) return;
  try {
    await navigator.clipboard.writeText(state.value.installCommand);
    addToast(t('localServer.commandCopied'), 'success');
  } catch { /* nothing to copy to */ }
};

const tone = computed(() => {
  if (!state.value) return 'neutral';
  if (ready.value) return 'ok';
  if (state.value.running && (!state.value.answering || !sameFamily.value)) return 'error';
  return 'warn';
});
</script>

<template>
  <div
    class="rounded-xl border px-3.5 py-3 space-y-3"
    :class="{
      'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/50 dark:bg-emerald-950/20': tone === 'ok',
      'border-amber-200 dark:border-amber-900/60 bg-amber-50/50 dark:bg-amber-950/20': tone === 'warn',
      'border-red-200 dark:border-red-900/60 bg-red-50/50 dark:bg-red-950/20': tone === 'error',
      'border-gray-200 dark:border-zinc-800 bg-gray-50/70 dark:bg-zinc-800/30': tone === 'neutral',
    }"
    role="status"
  >
    <div class="flex items-start gap-3">
      <div class="min-w-0 flex-1">
        <div class="text-[13px] font-medium text-gray-900 dark:text-zinc-100">
          <template v-if="checking && !state">{{ t('localServer.checking') }}</template>
          <template v-else-if="!state">{{ t('localServer.unknown') }}</template>
          <template v-else-if="state.running && state.answering && !sameFamily">{{ t('localServer.otherEngine', { engine: label(state.answering), port: state.port }) }}</template>
          <template v-else-if="state.running && state.answering">{{ t('localServer.running', { engine: label(state.answering), version: state.version || '', port: state.port }) }}</template>
          <template v-else-if="state.running">{{ t('localServer.otherProgram', { port: state.port }) }}</template>
          <template v-else-if="state.installed">{{ t('localServer.stopped', { engine: label() }) }}</template>
          <template v-else>{{ t('localServer.notInstalled', { engine: label() }) }}</template>
        </div>
        <p class="mt-0.5 text-[11.5px] leading-relaxed text-gray-600 dark:text-zinc-400">
          <template v-if="ready && state?.answering && state.answering !== engine">{{ t('localServer.savedAs', { engine: label(state.answering) }) }}</template>
          <template v-else-if="ready && state?.user">{{ t('localServer.readyAs', { user: state.user }) }}</template>
          <template v-else-if="ready">{{ t('localServer.readyNoLogin') }}</template>
          <template v-else-if="state?.running && state.answering && sameFamily && state.account === 'needed'">{{ t(state.canCreateAccount ? 'localServer.accountCreateHint' : 'localServer.accountHint') }}</template>
          <template v-else-if="state && !state.running && !state.installed">{{ t(state.canInstall ? 'localServer.installHint' : 'localServer.manualHint', { engine: label() }) }}</template>
        </p>
      </div>
      <button type="button" :class="btnSecondary" class="shrink-0" :disabled="checking || !!busy" @click="check">{{ t('localServer.check') }}</button>
    </div>

    <!-- The next step -->
    <template v-if="state && !state.running">
      <div class="flex items-center gap-2 flex-wrap">
        <button v-if="!state.installed && state.canInstall" type="button" :class="btnPrimary" :disabled="!!busy" @click="run('install', 'local-engine-install')">
          <svg v-if="busy === 'install'" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
          {{ busy === 'install' ? t('localServer.installing') : t('localServer.install', { engine: label() }) }}
        </button>
        <button v-if="state.installed && state.canStart" type="button" :class="btnPrimary" :disabled="!!busy" @click="run('start', 'local-engine-start')">
          <svg v-if="busy === 'start'" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
          {{ busy === 'start' ? t('localServer.starting') : t('localServer.start') }}
        </button>
      </div>
      <p v-if="busy === 'install' && progressLine" class="font-mono text-[11px] text-gray-500 dark:text-zinc-400 truncate">{{ progressLine }}</p>
      <div v-if="!state.installed && !state.canInstall" class="flex items-center gap-2">
        <code class="flex-1 min-w-0 truncate font-mono text-[11px] px-2 py-1 rounded-md bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 select-all" :title="state.installCommand">{{ state.installCommand }}</code>
        <button type="button" :class="btnSecondary" class="shrink-0" @click="copyCommand">{{ t('localServer.copy') }}</button>
      </div>
    </template>

    <!-- An account bbdump keeps (encrypted) to create and reach its databases -->
    <template v-if="state?.running && state.answering && sameFamily && state.account === 'needed'">
      <button v-if="state.canCreateAccount" type="button" :class="btnPrimary" :disabled="!!busy" @click="createAccount">{{ t('localServer.createAccount') }}</button>
      <div class="grid grid-cols-2 gap-3">
        <FormField :label="t('localServer.adminUser')" for="local-admin-user" :error="accountError">
          <input id="local-admin-user" v-model="account.user" type="text" spellcheck="false" autocomplete="off" :class="monoInputClass" />
        </FormField>
        <FormField :label="t('database.password')" for="local-admin-password">
          <input id="local-admin-password" v-model="account.password" type="password" autocomplete="new-password" :class="inputClass" @keydown.enter.prevent="saveAccount" />
        </FormField>
      </div>
      <button type="button" :class="btnSecondary" :disabled="!!busy" @click="saveAccount">{{ busy === 'account' ? t('localServer.checkingAccount') : t('localServer.saveAccount') }}</button>
    </template>
  </div>
</template>

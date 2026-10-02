<script setup lang="ts">
/**
 * Add a remote database (3 steps: method, connection, backup) or edit one (rail: connection,
 * backup, schedule). Same shell and fields as the other dialogs (components/ui).
 */
import { ref, computed, watch, onMounted } from 'vue';
import { getErrorMessage } from '../utils';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';
import { Database } from '../types';
import { parsePgUrl } from '../pgUrl';
import { PROVIDERS, detectProvider, poolerAdvice, hasPasswordPlaceholder, urlSetsSsl, type CloudProvider } from '../cloudProviders';
import CronEditor from './CronEditor.vue';
import NeonPicker from './NeonPicker.vue';
import SshConnectionFields from './SshConnectionFields.vue';
import SslOptions from './SslOptions.vue';
import AppModal from './ui/AppModal.vue';
import ModalHeading from './ui/ModalHeading.vue';
import FormField from './ui/FormField.vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import SwitchRow from './ui/SwitchRow.vue';
import ChoiceCard from './ui/ChoiceCard.vue';
import { btnGhost, btnPrimary, btnSecondary, inputClass, monoInputClass, panelClass } from './ui/classes';

const MASKED_PASSWORD = '••••••••';
const TEST_TIMEOUT_MS = 12000;

const ICONS = {
  database: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4',
  globe: 'M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9',
  link: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1',
  edit: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
  eye: 'M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z',
  eyeOff: 'M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21',
  folder: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
  terminal: 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
};

const { t } = useI18n();
const { addToast } = useToast();

const isEditing = computed(() => !!store.editingDatabase);
const isLoading = ref(false);
/** Wizard (add): 0 method · 1 connection · 2 backup */
const currentStep = ref(0);
/** Edit: the section shown */
const section = ref<'connection' | 'backup' | 'schedule'>('connection');
const connectionMode = ref<'manual' | 'url' | 'ssh' | null>(null);
/** "Server via SSH": the tunnel's settings (the database fields stay in `form`) */
const emptySsh = (): NonNullable<Database['ssh']> => ({ host: '', remoteHost: 'localhost', remotePort: 5432, envFile: '', envVar: 'DATABASE_URL' });
const sshDraft = ref<NonNullable<Database['ssh']>>(emptySsh());
const connectionUrl = ref('');
/** Required fields are flagged once the user tried to go on */
const attempted = ref(false);

// Hosts with a guide to their connection URL
const guides = PROVIDERS.filter(p => p.guide);
const selectedProvider = ref<CloudProvider | null>(null);

const emptyForm = (output = ''): Database => ({
  id: '',
  name: '',
  displayName: '',
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: '',
  output,
  cron: '0 0 * * *',
  enabled: false,
  encryptBackups: false,
  verifyBackups: true,
  connectionString: '',
  ssl: false,
  sslMode: 'disable',
  sslRootCert: undefined
});

const form = ref<Database>(emptyForm());
const passwordVisible = ref(false);

onMounted(async () => {
  if (store.editingDatabase) {
    form.value = { ...store.editingDatabase };
    // The saved password never reaches the renderer (get-config masks it): empty = unchanged
    if (form.value.password === MASKED_PASSWORD) form.value.password = '';
    // Databases saved by v1.0.2 only have the boolean
    form.value.sslMode = form.value.sslMode || (form.value.ssl ? 'require' : 'disable');
    form.value.verifyBackups = form.value.verifyBackups !== false;
    form.value.cron = form.value.cron || '0 0 * * *';

    // If output path is missing (e.g. auto-imported), fallback to global default
    if (!form.value.output) {
      try {
        const defaultPath = await ipcRenderer.invoke('get-default-path');
        if (defaultPath) form.value.output = defaultPath;
      } catch (e) {
        console.error('Failed to get default path during edit', e);
      }
    }

    connectionMode.value = form.value.ssh ? 'ssh' : form.value.connectionString ? 'url' : 'manual';
    if (form.value.ssh) sshDraft.value = { ...emptySsh(), ...form.value.ssh, envVar: form.value.ssh.envVar || 'DATABASE_URL' };
    connectionUrl.value = form.value.connectionString || '';
    // Opened from the tasks page: straight to the schedule
    if (store.modalTargetSection === 'schedule') {
      section.value = 'schedule';
      store.modalTargetSection = null;
    }
  } else {
    currentStep.value = 0;
    connectionMode.value = null;
    connectionUrl.value = '';
    let defaultPath = '';
    try {
      defaultPath = await ipcRenderer.invoke('get-default-path');
    } catch (e) {
      console.error('Failed to get default path', e);
    }
    form.value = emptyForm(defaultPath);
  }
});

// --- URL --------------------------------------------------------------------

/** Fills the fields from the URL; false when it is not a usable PostgreSQL URL */
const parseConnectionUrl = (url: string) => {
  const parsed = parsePgUrl(url);
  if (!parsed || !parsed.database) return false;
  if (parsed.user) form.value.user = parsed.user;
  if (parsed.password) form.value.password = parsed.password;
  form.value.host = parsed.host;
  form.value.port = parsed.port;
  form.value.name = parsed.database;
  if (parsed.sslMode) form.value.sslMode = parsed.sslMode;
  // Cloud hosts only accept SSL: on unless the URL says otherwise (an edit keeps a stricter mode)
  else if (detectProvider(parsed.host)) { if (!isEditing.value || form.value.sslMode === 'disable') form.value.sslMode = 'require'; }
  else if (!isEditing.value) form.value.sslMode = 'disable';
  if (parsed.sslRootCert) form.value.sslRootCert = parsed.sslRootCert;
  return true;
};

const urlValid = ref(true);
watch(connectionUrl, (newUrl) => {
  if (connectionMode.value !== 'url') return;
  urlValid.value = !newUrl.trim() || parseConnectionUrl(newUrl);
  form.value.connectionString = newUrl.trim();
});

/** The host recognized from the URL, and what to tell about it */
const detectedProvider = computed(() => (connectionMode.value === 'url' && urlValid.value && connectionUrl.value.trim() ? detectProvider(form.value.host) : null));
const sslFromUrl = computed(() => urlSetsSsl(connectionUrl.value));
const pooler = computed(() => (detectedProvider.value ? poolerAdvice(connectionUrl.value.trim(), form.value.host, form.value.port) : null));
const placeholderPassword = computed(() => connectionMode.value === 'url' && hasPasswordPlaceholder(connectionUrl.value));
const guideSteps = (provider: CloudProvider) => [1, 2, 3].map(n => t(`dbModal.guide.${provider.id}.step${n}`));
const openDashboard = (provider: CloudProvider) => { if (provider.dashboardUrl) window.open(provider.dashboardUrl, '_blank'); };

/** A database picked with the Neon API key: its URL, and a name when none was typed */
const neonConnected = ref(false);
let neonName = '';
let neonUri = '';
const onNeonPick = (uri: string, label: string) => {
  connectionUrl.value = uri;
  neonUri = uri;
  // A name typed by the user stays; the one suggested for the previous pick follows the new one
  const current = form.value.displayName?.trim() ?? '';
  if (!current || current === neonName) form.value.displayName = label;
  neonName = label;
};
const onNeonUnpick = () => {
  if (connectionUrl.value === neonUri) connectionUrl.value = '';
  if (form.value.displayName === neonName) form.value.displayName = '';
  neonUri = neonName = '';
};

const pasteFailed = ref(false);
/** Reads the clipboard only on this click */
const pasteUrl = async () => {
  pasteFailed.value = false;
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text) connectionUrl.value = text;
  } catch {
    pasteFailed.value = true;
  }
};

// --- Validation ---------------------------------------------------------------

const connectionErrors = computed(() => {
  const errors: Record<string, string> = {};
  if (connectionMode.value === 'url') {
    if (!connectionUrl.value.trim()) errors.url = t('dbModal.required');
    else if (!urlValid.value) errors.url = t('dbModal.urlInvalid');
  } else if (connectionMode.value === 'ssh') {
    if (!sshDraft.value.host?.trim()) errors.sshHost = t('dbModal.required');
    if (!form.value.name?.trim()) errors.name = t('dbModal.required');
    if (!form.value.user?.trim()) errors.user = t('dbModal.required');
    // Empty means PostgreSQL's default (5432)
    const remotePort = Number(sshDraft.value.remotePort) || 5432;
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) errors.remotePort = t('dbModal.portInvalid');
  } else {
    if (!form.value.name?.trim()) errors.name = t('dbModal.required');
    if (!form.value.host?.trim()) errors.host = t('dbModal.required');
    if (!form.value.user?.trim()) errors.user = t('dbModal.required');
    if (!form.value.port || form.value.port < 1 || form.value.port > 65535) errors.port = t('dbModal.portInvalid');
  }
  return errors;
});
const backupErrors = computed(() => {
  const errors: Record<string, string> = {};
  if (!form.value.output?.trim()) errors.output = t('dbModal.required');
  return errors;
});
const shownError = (errors: Record<string, string>, key: string) => (attempted.value ? errors[key] : undefined);
const connectionValid = computed(() => Object.keys(connectionErrors.value).length === 0);
const backupValid = computed(() => Object.keys(backupErrors.value).length === 0);

// --- Navigation ---------------------------------------------------------------

const steps = computed(() => [t('dbModal.steps.method'), t('dbModal.steps.connection'), t('dbModal.steps.backup')]);
const sections = computed(() => [
  { id: 'connection', label: t('dbModal.sections.connection'), attention: attempted.value && !connectionValid.value },
  { id: 'backup', label: t('dbModal.sections.backup'), attention: attempted.value && !backupValid.value },
  { id: 'schedule', label: t('dbModal.sections.schedule') },
]);

const modalRef = ref<InstanceType<typeof AppModal> | null>(null);

const selectMode = (mode: 'url' | 'manual' | 'ssh') => {
  connectionMode.value = mode;
  selectedProvider.value = null;
  if (mode === 'url') connectionUrl.value = '';
  if (mode === 'ssh') {
    // New databases default to localhost / postgres: not what a server's database is
    form.value.user = '';
    form.value.name = '';
  }
};

/** The tunnel's settings as saved: empty optional values left out */
const cleanSsh = (): NonNullable<Database['ssh']> => {
  const d = sshDraft.value;
  return {
    host: d.host.trim(),
    user: typeof d.user === 'string' && d.user.trim() ? d.user.trim() : undefined,
    port: typeof d.port === 'number' && d.port > 0 ? d.port : undefined,
    remoteHost: d.remoteHost?.trim() || 'localhost',
    remotePort: Number(d.remotePort) || 5432,
    envFile: d.envFile?.trim() || undefined,
    envVar: d.envVar?.trim() || undefined,
  };
};

const selectProvider = (provider: CloudProvider) => {
  selectedProvider.value = provider;
  connectionMode.value = 'url';
  connectionUrl.value = '';
  goToStep(1);
};

const goToStep = (step: number) => {
  currentStep.value = step;
  attempted.value = false;
  modalRef.value?.focusBody();
};

const nextStep = () => {
  if (currentStep.value === 0) {
    if (!connectionMode.value) {
      addToast(t('dbModal.pickMethod'), 'warning');
      return;
    }
    goToStep(1);
  } else if (currentStep.value === 1) {
    if (!connectionValid.value) {
      attempted.value = true;
      return;
    }
    form.value.connectionString = connectionMode.value === 'url' ? connectionUrl.value.trim() : undefined;
    goToStep(2);
  }
};

const previousStep = () => {
  if (currentStep.value > 0) goToStep(currentStep.value - 1);
};

const submit = () => {
  if (!isEditing.value && currentStep.value < 2) nextStep();
  else save();
};

// --- Connection test --------------------------------------------------------------

const test = ref<{ status: 'idle' | 'testing' | 'ok' | 'error'; version?: string; tables?: number; error?: string }>({ status: 'idle' });

// Any change to what the test used makes its result stale
watch(
  () => [connectionMode.value, connectionUrl.value, form.value.host, form.value.port, form.value.user, form.value.password, form.value.name, form.value.sslMode, form.value.sslRootCert],
  () => { if (test.value.status !== 'testing') test.value = { status: 'idle' }; },
);

const testConnection = async () => {
  if (!connectionValid.value) {
    attempted.value = true;
    return;
  }
  test.value = { status: 'testing' };
  try {
    const result = await Promise.race([
      ipcRenderer.invoke('test-database-connection', {
        id: isEditing.value ? store.editingDatabase!.id : undefined,
        host: form.value.host,
        port: form.value.port,
        user: form.value.user,
        password: form.value.password,
        database: form.value.name,
        connectionString: connectionMode.value === 'url' ? connectionUrl.value.trim() : undefined,
        sslMode: form.value.sslMode,
        sslRootCert: form.value.sslRootCert,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(t('dbModal.testTimeout'))), TEST_TIMEOUT_MS)),
    ]) as { version: string; tables: number };
    test.value = { status: 'ok', version: result.version, tables: result.tables };
  } catch (error) {
    test.value = { status: 'error', error: getErrorMessage(error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
  }
};

// --- Save -------------------------------------------------------------------------

const selectOutput = async () => {
  const path = await ipcRenderer.invoke('select-directory');
  if (path) form.value.output = path;
};

const save = async () => {
  if (!connectionValid.value || !backupValid.value) {
    attempted.value = true;
    if (isEditing.value) section.value = !connectionValid.value ? 'connection' : 'backup';
    else if (!connectionValid.value) goToStep(1);
    addToast(t('dbModal.fillHighlighted'), 'warning');
    return;
  }

  if (connectionMode.value === 'url') form.value.connectionString = connectionUrl.value.trim();
  else form.value.connectionString = undefined;

  // Check for duplicates
  if (!isEditing.value) {
    const duplicate = store.databases.find(db =>
      (db.host === form.value.host && db.port === form.value.port && db.name === form.value.name) ||
      (connectionMode.value === 'url' && db.connectionString && db.connectionString === form.value.connectionString)
    );
    if (duplicate) {
      addToast(t('toasts.databaseExists'), 'warning');
      return;
    }
  }

  isLoading.value = true;
  try {
    const dbData: Database = {
      id: form.value.id,
      name: form.value.name,
      displayName: form.value.displayName,
      host: form.value.host,
      port: form.value.port,
      user: form.value.user,
      // Empty while editing: the saved password is kept by the main process
      password: form.value.password,
      output: form.value.output,
      cron: form.value.cron,
      enabled: form.value.enabled,
      encryptBackups: form.value.encryptBackups,
      retentionCount: form.value.retentionCount && form.value.retentionCount > 0 ? form.value.retentionCount : undefined,
      verifyBackups: form.value.verifyBackups !== false,
      connectionString: connectionMode.value === 'ssh' ? undefined : form.value.connectionString,
      // Through SSH, host / port are the server and the remote port (see config.d.ts)
      ssh: connectionMode.value === 'ssh' ? cleanSsh() : undefined,
      // `ssl` kept in sync for versions that only know the boolean
      ssl: ['require', 'verify-ca', 'verify-full'].includes(form.value.sslMode || 'disable'),
      sslMode: form.value.sslMode,
      sslRootCert: form.value.sslMode === 'disable' ? undefined : form.value.sslRootCert
    };

    if (isEditing.value) {
      await ipcRenderer.invoke('update-database', store.editingDatabase!.id, dbData);
      addToast(t('toasts.databaseUpdated'), 'success');
    } else {
      await ipcRenderer.invoke('add-database', dbData);
      addToast(t('toasts.databaseAdded'), 'success');
    }

    const config = await ipcRenderer.invoke('get-config');
    store.databases = config.databases;
    if (!isEditing.value) {
      // Highlight the database that was just added
      const newDb = store.databases.find(d => d.name === dbData.name && d.host === dbData.host && d.port === dbData.port)
        ?? store.databases.find(d => d.name === dbData.name);
      if (newDb) {
        store.newlyAddedDbId = newDb.id;
        setTimeout(() => { store.newlyAddedDbId = null; }, 2000);
      }
    }
    isLoading.value = false;
    close();
  } catch (error) {
    addToast(t('toasts.databaseSaveError'), 'error', { detail: getErrorMessage(error) });
  } finally {
    isLoading.value = false;
  }
};

const close = () => {
  if (isLoading.value) return;
  store.showDatabaseModal = false;
  store.editingDatabase = null;
  store.modalTargetSection = null;
  currentStep.value = 0;
  connectionMode.value = null;
};

// What is shown
const showMethod = computed(() => !isEditing.value && currentStep.value === 0);
const showConnection = computed(() => isEditing.value ? section.value === 'connection' : currentStep.value === 1);
const showBackup = computed(() => isEditing.value ? section.value === 'backup' : currentStep.value === 2);
const showSchedule = computed(() => isEditing.value ? section.value === 'schedule' : currentStep.value === 2);

const title = computed(() => isEditing.value ? t('dbModal.editTitle') : t('dbModal.addTitle'));
const meta = computed(() => isEditing.value ? `${form.value.host}:${form.value.port}` : `${currentStep.value + 1} / 3`);
const modeOptions = computed(() => [
  { value: 'url' as const, label: t('database.modeUrl'), icon: ICONS.link },
  { value: 'manual' as const, label: t('database.modeManual'), icon: ICONS.edit },
  { value: 'ssh' as const, label: t('ssh.modeShort'), icon: ICONS.terminal },
]);
const parsedPreview = computed(() => connectionMode.value === 'url' && connectionUrl.value.trim() && urlValid.value);
</script>

<template>
  <AppModal
    ref="modalRef"
    :title="title"
    :icon="isEditing ? ICONS.database : ICONS.globe"
    :meta="meta"
    :steps="isEditing ? [] : steps"
    :step="currentStep"
    :sections="isEditing ? sections : []"
    :section="section"
    :width="isEditing ? 'lg' : 'md'"
    :busy="isLoading"
    :close-label="t('common.cancel')"
    @update:section="section = $event as typeof section"
    @close="close"
    @submit="submit"
  >
    <!-- Step 1 (add): how to connect -->
    <template v-if="showMethod">
      <ModalHeading :eyebrow="t('dbModal.sections.connection')" :title="t('dbModal.method.title')" :subtitle="t('dbModal.method.subtitle')" />
      <div role="radiogroup" class="space-y-2">
        <ChoiceCard
          :title="t('dbModal.method.urlTitle')"
          :description="t('dbModal.method.urlDesc')"
          :icon="ICONS.link"
          :selected="connectionMode === 'url' && !selectedProvider"
          @select="selectMode('url')"
        />
        <ChoiceCard
          :title="t('dbModal.method.manualTitle')"
          :description="t('dbModal.method.manualDesc')"
          :icon="ICONS.edit"
          :selected="connectionMode === 'manual'"
          @select="selectMode('manual')"
        />
        <ChoiceCard
          :title="t('ssh.methodTitle')"
          :description="t('ssh.methodDesc')"
          :icon="ICONS.terminal"
          :selected="connectionMode === 'ssh'"
          @select="selectMode('ssh')"
        />
      </div>
      <div class="mt-5">
        <div class="font-mono text-[10px] uppercase tracking-[0.16em] text-gray-400 dark:text-zinc-500 mb-2">{{ t('dbModal.method.guides') }}</div>
        <div class="grid grid-cols-2 gap-2">
          <button
            v-for="provider in guides"
            :key="provider.id"
            type="button"
            class="flex items-center gap-2 px-3 h-9 rounded-lg border border-gray-200 dark:border-zinc-800 hover:border-gray-300 dark:hover:border-zinc-700 bg-white dark:bg-zinc-900 text-[13px] text-gray-700 dark:text-zinc-200 transition-colors"
            @click="selectProvider(provider)"
          >
            <span class="w-2.5 h-2.5 rounded-full shrink-0" :style="{ backgroundColor: provider.color }" />
            {{ provider.name }}
            <svg class="w-3.5 h-3.5 ml-auto text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>
    </template>

    <!-- Connection -->
    <template v-if="showConnection">
      <ModalHeading
        :eyebrow="t('dbModal.sections.connection')"
        :title="isEditing ? (form.displayName || form.name) : selectedProvider ? selectedProvider.name : connectionMode === 'url' ? t('dbModal.connection.titleUrl') : connectionMode === 'ssh' ? t('ssh.title') : t('dbModal.connection.titleManual')"
        :subtitle="t('dbModal.connection.subtitle')"
      />

      <div class="space-y-4">
        <SegmentedControl v-if="isEditing" v-model="connectionMode" :options="modeOptions" :label="t('dbModal.sections.connection')" />

        <!-- URL -->
        <template v-if="connectionMode === 'url'">
          <NeonPicker v-if="selectedProvider?.id === 'neon' && !isEditing" @pick="onNeonPick" @unpick="onNeonUnpick" @connected="neonConnected = $event" />
          <div v-if="selectedProvider && !isEditing && !(selectedProvider.id === 'neon' && neonConnected)" :class="panelClass" class="px-3.5 py-3">
            <ol class="space-y-1.5 text-[12.5px] text-gray-600 dark:text-zinc-300">
              <li v-for="(step, i) in guideSteps(selectedProvider)" :key="i" class="flex gap-2.5">
                <span class="w-[18px] h-[18px] shrink-0 rounded-full grid place-items-center font-mono text-[10px] text-white" :style="{ backgroundColor: selectedProvider.color }">{{ i + 1 }}</span>
                <span class="leading-[18px]">{{ step }}</span>
              </li>
            </ol>
            <button type="button" :class="btnSecondary" class="mt-3" @click="openDashboard(selectedProvider)">
              {{ t('dbModal.guide.openDashboard', { provider: selectedProvider.name }) }}
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
            </button>
          </div>
          <FormField :label="t('database.connectionUrlLabel')" for="db-url" required :error="shownError(connectionErrors, 'url') || (!urlValid ? t('dbModal.urlInvalid') : undefined)" :hint="isEditing ? t('dbModal.urlPasswordKept') : 'postgresql://user:password@host:5432/db?sslmode=require'">
            <div class="flex gap-2">
              <input
                id="db-url"
                v-model="connectionUrl"
                type="text"
                spellcheck="false"
                autocomplete="off"
                :class="monoInputClass"
                class="min-w-0 flex-1"
                :placeholder="selectedProvider?.placeholder ?? t('database.urlPlaceholder')"
              />
              <button type="button" :class="btnSecondary" class="shrink-0" @click="pasteUrl">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                {{ t('dbModal.connection.paste') }}
              </button>
            </div>
          </FormField>
          <p v-if="pasteFailed" class="-mt-2 text-[11.5px] text-gray-500 dark:text-zinc-400">{{ t('dbModal.connection.pasteFailed') }}</p>
          <div v-if="placeholderPassword" role="alert" class="px-3 py-2.5 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 text-[12.5px] text-amber-800 dark:text-amber-300">
            {{ t('dbModal.connection.placeholderPassword') }}
          </div>
          <div v-if="pooler" role="alert" class="px-3.5 py-3 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30">
            <div class="text-[13px] font-medium text-amber-900 dark:text-amber-200">{{ t(`dbModal.connection.pooler.${pooler.provider}Title`) }}</div>
            <p class="mt-1 text-[12.5px] text-amber-800 dark:text-amber-300/90">{{ t(`dbModal.connection.pooler.${pooler.provider}Body`) }}</p>
            <button type="button" :class="btnSecondary" class="mt-2.5" @click="connectionUrl = pooler.fixedUrl">{{ t(`dbModal.connection.pooler.${pooler.provider}Fix`) }}</button>
          </div>
          <div v-if="parsedPreview" :class="panelClass" class="px-3 py-2.5">
            <div class="flex items-center gap-2 text-[11px] text-gray-500 dark:text-zinc-400 mb-1.5">
              {{ t('dbModal.connection.parsed') }}
              <span v-if="detectedProvider" class="ml-auto inline-flex items-center gap-1.5 text-gray-700 dark:text-zinc-200">
                <span class="w-2 h-2 rounded-full" :style="{ backgroundColor: detectedProvider.color }" />
                {{ t('dbModal.connection.detected', { provider: detectedProvider.name }) }}
              </span>
            </div>
            <div class="flex flex-wrap gap-1.5 font-mono text-[11px]">
              <span class="px-2 py-0.5 rounded-md bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700">{{ form.host }}</span>
              <span class="px-2 py-0.5 rounded-md bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700">{{ form.port }}</span>
              <span class="px-2 py-0.5 rounded-md bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700">{{ form.user }}</span>
              <span class="px-2 py-0.5 rounded-md bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700">{{ form.name }}</span>
              <span
                class="px-2 py-0.5 rounded-md border"
                :class="form.sslMode !== 'disable'
                  ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-400'
                  : 'bg-white dark:bg-zinc-900 border-gray-200 dark:border-zinc-700'"
              >SSL {{ form.sslMode }}</span>
            </div>
          </div>
          <p v-if="parsedPreview && detectedProvider && !sslFromUrl && !isEditing" class="-mt-2 text-[11.5px] text-gray-500 dark:text-zinc-400">{{ t('dbModal.connection.sslForced', { provider: detectedProvider.name }) }}</p>
          <FormField :label="t('database.displayName')" for="db-display-url" :optional="t('common.optional')">
            <input id="db-display-url" v-model="form.displayName" type="text" :class="inputClass" :placeholder="t('database.displayNamePlaceholder')" />
          </FormField>
          <SslOptions v-if="isEditing" v-model:ssl-mode="form.sslMode" v-model:ssl-root-cert="form.sslRootCert" />
        </template>

        <!-- Manual -->
        <template v-else-if="connectionMode === 'manual'">
          <div class="grid grid-cols-2 gap-3">
            <FormField :label="t('database.name')" for="db-name" required :error="shownError(connectionErrors, 'name')" :hint="isEditing ? t('dbModal.nameLocked') : undefined">
              <input id="db-name" v-model="form.name" type="text" spellcheck="false" :class="monoInputClass" :placeholder="t('database.namePlaceholder')" :disabled="isEditing" />
            </FormField>
            <FormField :label="t('database.displayName')" for="db-display" :optional="t('common.optional')">
              <input id="db-display" v-model="form.displayName" type="text" :class="inputClass" :placeholder="t('database.displayNamePlaceholder')" />
            </FormField>
          </div>
          <div class="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <FormField :label="t('database.host')" for="db-host" required :error="shownError(connectionErrors, 'host')">
              <input id="db-host" v-model="form.host" type="text" spellcheck="false" :class="monoInputClass" placeholder="localhost" />
            </FormField>
            <FormField :label="t('database.port')" for="db-port" required :error="shownError(connectionErrors, 'port')">
              <input id="db-port" v-model.number="form.port" type="number" min="1" max="65535" :class="monoInputClass" placeholder="5432" />
            </FormField>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <FormField :label="t('database.user')" for="db-user" required :error="shownError(connectionErrors, 'user')">
              <input id="db-user" v-model="form.user" type="text" spellcheck="false" autocomplete="off" :class="monoInputClass" placeholder="postgres" />
            </FormField>
            <FormField :label="t('database.password')" for="db-password" :optional="isEditing ? undefined : t('common.optional')">
              <div class="relative">
                <input
                  id="db-password"
                  v-model="form.password"
                  :type="passwordVisible ? 'text' : 'password'"
                  autocomplete="new-password"
                  :class="inputClass"
                  class="pr-9"
                  :placeholder="isEditing ? t('dbModal.passwordUnchanged') : ''"
                />
                <button
                  type="button"
                  class="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-md flex items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-zinc-200"
                  :aria-label="passwordVisible ? t('dbModal.hidePassword') : t('dbModal.showPassword')"
                  @click="passwordVisible = !passwordVisible"
                >
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" :d="passwordVisible ? ICONS.eyeOff : ICONS.eye" />
                  </svg>
                </button>
              </div>
            </FormField>
          </div>
          <SslOptions v-model:ssl-mode="form.sslMode" v-model:ssl-root-cert="form.sslRootCert" />
        </template>

        <!-- Server via SSH (its own test: SSH, then PostgreSQL through the tunnel) -->
        <SshConnectionFields
          v-if="connectionMode === 'ssh'"
          v-model:form="form"
          v-model:ssh="sshDraft"
          :editing="isEditing"
          :database-id="store.editingDatabase?.id"
          :attempted="attempted"
        />

        <!-- Connection test -->
        <div v-if="connectionMode && connectionMode !== 'ssh'" class="flex items-center gap-3 pt-1 min-h-9">
          <button type="button" :class="btnSecondary" :disabled="test.status === 'testing'" @click="testConnection">
            <svg v-if="test.status === 'testing'" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {{ test.status === 'testing' ? t('dbModal.testing') : test.status === 'idle' ? t('dbModal.test') : t('dbModal.testAgain') }}
          </button>
          <span v-if="test.status === 'ok'" class="flex items-center gap-1.5 text-[12px] text-emerald-600 dark:text-emerald-400" role="status">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            {{ t('dbModal.testOk', { version: test.version, tables: test.tables }) }}
          </span>
          <span v-else-if="test.status === 'error'" class="flex items-start gap-1.5 text-[12px] text-red-600 dark:text-red-400 min-w-0" role="alert">
            <span class="w-1.5 h-1.5 mt-1.5 rounded-full bg-red-500 shrink-0" />
            <span class="break-words">{{ test.error }}</span>
          </span>
        </div>
      </div>
    </template>

    <!-- Backup -->
    <template v-if="showBackup">
      <ModalHeading :eyebrow="t('dbModal.sections.backup')" :title="t('dbModal.backup.title')" :subtitle="t('dbModal.backup.subtitle')" />
      <div class="space-y-4">
        <FormField :label="t('database.output')" for="db-output" required :error="shownError(backupErrors, 'output')">
          <div class="flex gap-2">
            <input id="db-output" v-model="form.output" type="text" readonly :class="monoInputClass" class="cursor-default" />
            <button type="button" :class="btnSecondary" class="shrink-0" @click="selectOutput">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" :d="ICONS.folder" />
              </svg>
              {{ t('common.browse') }}
            </button>
          </div>
        </FormField>
        <div class="grid grid-cols-2 gap-3">
          <FormField :label="t('database.retentionCount')" for="db-retention" :hint="t('database.retentionHint')">
            <input id="db-retention" v-model.number="form.retentionCount" type="number" min="1" :class="inputClass" :placeholder="t('database.retentionAll')" />
          </FormField>
        </div>
        <SwitchRow v-model="form.encryptBackups" :title="t('database.wizard.encryptBackups')" :description="t('database.wizard.encryptBackupsDesc')" />
        <SwitchRow v-model="form.verifyBackups" :title="t('database.verifyBackups')" :description="t('database.verifyBackupsHint')" />
      </div>
    </template>

    <!-- Schedule -->
    <template v-if="showSchedule">
      <div :class="isEditing ? '' : 'mt-6 pt-5 border-t border-gray-100 dark:border-zinc-800'">
        <ModalHeading :eyebrow="t('dbModal.sections.schedule')" :title="t('dbModal.schedule.title')" :subtitle="t('dbModal.schedule.subtitle')" />
        <div class="space-y-4">
          <SwitchRow v-model="form.enabled" :title="t('dbModal.schedule.toggle')" :description="t('dbModal.schedule.toggleDesc')" />
          <div v-if="form.enabled">
            <FormField :label="t('database.cron')">
              <CronEditor v-model="form.cron!" />
            </FormField>
          </div>
        </div>
      </div>
    </template>

    <template #footer>
      <button v-if="!isEditing && currentStep > 0" type="button" :class="btnGhost" :disabled="isLoading" @click="previousStep">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        {{ t('database.wizard.previous') }}
      </button>
      <button v-else type="button" :class="btnGhost" :disabled="isLoading" @click="close">{{ t('common.cancel') }}</button>
      <span class="flex-1" />
      <span class="hidden sm:inline text-[11px] text-gray-400 dark:text-zinc-500"><kbd class="font-mono">↵</kbd> Enter</span>
      <button
        v-if="!isEditing && currentStep < 2"
        type="button"
        :class="btnPrimary"
        :disabled="currentStep === 0 && !connectionMode"
        @click="nextStep"
      >
        {{ t('database.wizard.next') }}
      </button>
      <button v-else type="button" :class="btnPrimary" :disabled="isLoading" @click="save">
        <svg v-if="isLoading" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        {{ isEditing ? t('common.save') : t('database.wizard.finish') }}
      </button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
/**
 * Add or edit a MongoDB database: by URL (mongodb:// or mongodb+srv://) or field by
 * field, then its backups (folder, retention, encryption, schedule). Same shell and fields as
 * the PostgreSQL dialog: add in two steps, edit with a rail.
 */
import { ref, computed, watch, onMounted } from 'vue';
import { getErrorMessage } from '../utils';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';
import type { Database, SslMode } from '../types';
import { MONGO_DEFAULT_PORT, parseMongoUri } from '../../../shared/engines/mongoUri';
import SslOptions from './SslOptions.vue';
import SshConnectionFields from './SshConnectionFields.vue';
import CronEditor from './CronEditor.vue';
import AppModal from './ui/AppModal.vue';
import ModalHeading from './ui/ModalHeading.vue';
import FormField from './ui/FormField.vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import SwitchRow from './ui/SwitchRow.vue';
import { btnGhost, btnPrimary, btnSecondary, inputClass, monoInputClass } from './ui/classes';

const MASKED_PASSWORD = '••••••••';
const TEST_TIMEOUT_MS = 15000;
const ICONS = {
  terminal: 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  leaf: 'M12 21c-4-3-6-7.5-6-11.5C6 6 8.7 3 12 3s6 3 6 6.5C18 13.5 16 18 12 21zm0 0V8',
  link: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1',
  edit: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
  folder: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
  eye: 'M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z',
  eyeOff: 'M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21',
};

const { t } = useI18n();
const { addToast } = useToast();

const isEditing = computed(() => !!store.editingDatabase);
const isLoading = ref(false);
const attempted = ref(false);
/** Add: 0 connection · 1 backup */
const step = ref(0);
/** Edit: the section shown */
const section = ref<'connection' | 'backup' | 'schedule'>('connection');
const mode = ref<'url' | 'manual' | 'ssh' | null>('url');
/** Server via SSH: the tunnel's settings, and the database as the shared SSH fields edit it */
const emptySsh = (): NonNullable<Database['ssh']> => ({ host: '', remoteHost: 'localhost', remotePort: MONGO_DEFAULT_PORT, envFile: '', envVar: 'MONGODB_URI' });
const sshDraft = ref<NonNullable<Database['ssh']>>(emptySsh());
const sshForm = ref({ name: '', user: '', password: '', displayName: '', host: '', port: MONGO_DEFAULT_PORT, sslMode: 'disable' as SslMode } as unknown as Database);
const sshAuthSource = ref('admin');
const url = ref('');
const passwordVisible = ref(false);
const form = ref({
  displayName: '',
  name: '',
  host: 'localhost',
  port: MONGO_DEFAULT_PORT,
  user: '',
  password: '',
  authSource: 'admin',
  sslMode: 'disable' as SslMode,
  sslRootCert: undefined as string | undefined,
});
/** Backups: the same settings as a PostgreSQL database */
const backup = ref({
  output: '',
  retentionCount: undefined as number | undefined,
  encryptBackups: false,
  verifyBackups: true,
  enabled: false,
  cron: '0 0 * * *',
});

onMounted(async () => {
  const db = store.editingDatabase;
  if (db) {
    mode.value = db.ssh ? 'ssh' : db.connectionString ? 'url' : 'manual';
    if (db.ssh) {
      sshDraft.value = { ...emptySsh(), ...db.ssh, envVar: db.ssh.envVar || 'MONGODB_URI' };
      sshForm.value = { ...sshForm.value, name: db.name, user: db.user || '', password: '', displayName: db.displayName || '', host: db.host, port: db.port, sslMode: db.sslMode || 'disable' };
      sshAuthSource.value = db.mongo?.authSource || 'admin';
    }
    url.value = db.connectionString || '';
    form.value = {
      displayName: db.displayName || '',
      name: db.name,
      host: db.host,
      port: db.port || MONGO_DEFAULT_PORT,
      user: db.user || '',
      // The saved password never reaches the renderer: empty = unchanged
      password: db.password === MASKED_PASSWORD ? '' : db.password || '',
      authSource: db.mongo?.authSource || 'admin',
      sslMode: db.sslMode || 'disable',
      sslRootCert: db.sslRootCert,
    };
    backup.value = {
      output: db.output || '',
      retentionCount: db.retentionCount,
      encryptBackups: !!db.encryptBackups,
      verifyBackups: db.verifyBackups !== false,
      enabled: !!db.enabled,
      cron: db.cron || '0 0 * * *',
    };
    // Opened from the tasks page: straight to the schedule
    if (store.modalTargetSection === 'schedule') {
      section.value = 'schedule';
      store.modalTargetSection = null;
    }
  }
  if (!backup.value.output) {
    try { backup.value.output = await ipcRenderer.invoke('get-default-path'); } catch { /* chosen below */ }
  }
});

// --- URL --------------------------------------------------------------------------------

const parsed = computed(() => (mode.value === 'url' && url.value.trim() ? parseMongoUri(url.value) : null));
/** The URL names no database: the name field asks for it */
const needsName = computed(() => mode.value === 'url' && !!parsed.value && !parsed.value.database);

const errors = computed(() => {
  const found: Record<string, string> = {};
  if (mode.value === 'url') {
    if (!url.value.trim()) found.url = t('dbModal.required');
    else if (!parsed.value) found.url = t('mongoModal.urlInvalid');
    else if (needsName.value && !form.value.name.trim()) found.name = t('mongoModal.urlNoDatabase');
  } else if (mode.value === 'ssh') {
    if (!sshDraft.value.host?.trim()) found.sshHost = t('dbModal.required');
    if (!sshForm.value.name?.trim()) found.name = t('dbModal.required');
    const remotePort = Number(sshDraft.value.remotePort) || MONGO_DEFAULT_PORT;
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) found.remotePort = t('dbModal.portInvalid');
  } else {
    if (!form.value.name.trim()) found.name = t('dbModal.required');
    if (!form.value.host.trim()) found.host = t('dbModal.required');
    if (!form.value.port || form.value.port < 1 || form.value.port > 65535) found.port = t('dbModal.portInvalid');
  }
  return found;
});
const backupErrors = computed(() => {
  const found: Record<string, string> = {};
  if (!backup.value.output?.trim()) found.output = t('dbModal.required');
  return found;
});
const valid = computed(() => Object.keys(errors.value).length === 0);
const backupValid = computed(() => Object.keys(backupErrors.value).length === 0);
const shown = (key: string) => (attempted.value ? errors.value[key] ?? backupErrors.value[key] : undefined);

/** The tunnel's settings as saved: empty optional values left out */
const cleanSsh = (): NonNullable<Database['ssh']> => {
  const d = sshDraft.value;
  return {
    host: d.host.trim(),
    user: typeof d.user === 'string' && d.user.trim() ? d.user.trim() : undefined,
    port: typeof d.port === 'number' && d.port > 0 ? d.port : undefined,
    remoteHost: d.remoteHost?.trim() || 'localhost',
    remotePort: Number(d.remotePort) || MONGO_DEFAULT_PORT,
    envFile: d.envFile?.trim() || undefined,
    envVar: d.envVar?.trim() || undefined,
  };
};

/** What the main process gets, for the test and for saving */
const connectionFields = () => {
  if (mode.value === 'ssh') {
    // As for PostgreSQL: host / port keep the server and the remote port, the tunnel does the rest
    const user = (sshForm.value.user || '').trim();
    return {
      connectionString: undefined,
      host: sshForm.value.host || sshDraft.value.host.trim(),
      port: Number(sshDraft.value.remotePort) || MONGO_DEFAULT_PORT,
      user,
      password: sshForm.value.password || '',
      name: (sshForm.value.name || '').trim(),
      mongo: user ? { authSource: sshAuthSource.value.trim() || 'admin' } : undefined,
      sslMode: (sshForm.value.sslMode || 'disable') as SslMode,
      sslRootCert: undefined,
    };
  }
  if (mode.value === 'url' && parsed.value) {
    const first = parsed.value.hosts[0];
    return {
      connectionString: url.value.trim(),
      host: first.host,
      port: first.port ?? MONGO_DEFAULT_PORT,
      user: parsed.value.username ?? '',
      // In the URL (taken out and encrypted when saved), or the saved one when editing
      password: '',
      name: parsed.value.database || form.value.name.trim(),
      mongo: undefined,
      sslMode: 'disable' as SslMode,
      sslRootCert: undefined,
    };
  }
  return {
    connectionString: undefined,
    host: form.value.host.trim(),
    port: form.value.port,
    user: form.value.user.trim(),
    password: form.value.password,
    name: form.value.name.trim(),
    mongo: form.value.user.trim() ? { authSource: form.value.authSource.trim() || 'admin' } : undefined,
    sslMode: form.value.sslMode,
    sslRootCert: form.value.sslMode === 'disable' ? undefined : form.value.sslRootCert,
  };
};

// --- Connection test ---------------------------------------------------------------------

const test = ref<{ status: 'idle' | 'testing' | 'ok' | 'error'; version?: string; collections?: number; error?: string }>({ status: 'idle' });
watch(() => [mode.value, url.value, form.value], () => { if (test.value.status !== 'testing') test.value = { status: 'idle' }; }, { deep: true });

const testConnection = async () => {
  if (!valid.value) {
    attempted.value = true;
    return;
  }
  const fields = connectionFields();
  test.value = { status: 'testing' };
  try {
    const result = await Promise.race([
      ipcRenderer.invoke('test-database-connection', {
        id: store.editingDatabase?.id,
        engine: 'mongodb',
        host: fields.host,
        port: fields.port,
        user: fields.user,
        password: fields.password,
        database: fields.name,
        connectionString: fields.connectionString,
        sslMode: fields.sslMode,
        sslRootCert: fields.sslRootCert,
        mongo: fields.mongo,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(t('dbModal.testTimeout'))), TEST_TIMEOUT_MS)),
    ]) as { version: string; tables: number };
    test.value = { status: 'ok', version: result.version, collections: result.tables };
  } catch (error) {
    test.value = { status: 'error', error: getErrorMessage(error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
  }
};

// --- Navigation --------------------------------------------------------------------------

const steps = computed(() => [t('dbModal.steps.connection'), t('dbModal.steps.backup')]);
const sections = computed(() => [
  { id: 'connection', label: t('dbModal.sections.connection'), attention: attempted.value && !valid.value },
  { id: 'backup', label: t('dbModal.sections.backup'), attention: attempted.value && !backupValid.value },
  { id: 'schedule', label: t('dbModal.sections.schedule') },
]);
const showConnection = computed(() => (isEditing.value ? section.value === 'connection' : step.value === 0));
const showBackup = computed(() => (isEditing.value ? section.value === 'backup' : step.value === 1));
const showSchedule = computed(() => (isEditing.value ? section.value === 'schedule' : step.value === 1));

const next = () => {
  if (!valid.value) {
    attempted.value = true;
    return;
  }
  attempted.value = false;
  step.value = 1;
};
const submit = () => (!isEditing.value && step.value === 0 ? next() : save());

const selectOutput = async () => {
  const folder = await ipcRenderer.invoke('select-directory');
  if (folder) backup.value.output = folder;
};

// --- Save ------------------------------------------------------------------------------

const save = async () => {
  if (!valid.value || !backupValid.value) {
    attempted.value = true;
    if (isEditing.value) section.value = !valid.value ? 'connection' : 'backup';
    else if (!valid.value) step.value = 0;
    addToast(t('dbModal.fillHighlighted'), 'warning');
    return;
  }
  const fields = connectionFields();
  if (!isEditing.value && store.databases.some(db => db.engine === 'mongodb' && db.host === fields.host && db.port === fields.port && db.name === fields.name)) {
    addToast(t('toasts.databaseExists'), 'warning');
    return;
  }
  isLoading.value = true;
  try {
    const dbData: Database = {
      id: store.editingDatabase?.id ?? '',
      engine: 'mongodb',
      name: fields.name,
      displayName: (mode.value === 'ssh' ? sshForm.value.displayName : form.value.displayName)?.trim() || undefined,
      host: fields.host,
      port: fields.port,
      user: fields.user,
      // Empty while editing: the saved password is kept by the main process
      password: fields.password,
      connectionString: fields.connectionString,
      mongo: fields.mongo,
      ssh: mode.value === 'ssh' ? cleanSsh() : undefined,
      ssl: ['require', 'verify-ca', 'verify-full'].includes(fields.sslMode),
      sslMode: fields.sslMode,
      sslRootCert: fields.sslRootCert,
      output: backup.value.output,
      cron: backup.value.cron,
      enabled: backup.value.enabled,
      encryptBackups: backup.value.encryptBackups,
      verifyBackups: backup.value.verifyBackups,
      retentionCount: backup.value.retentionCount && backup.value.retentionCount > 0 ? backup.value.retentionCount : undefined,
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
      const added = store.databases.find(d => d.engine === 'mongodb' && d.name === dbData.name && d.host === dbData.host && d.port === dbData.port);
      if (added) {
        store.newlyAddedDbId = added.id;
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
  store.databaseModalEngine = null;
  store.modalTargetSection = null;
};

const modeOptions = computed(() => [
  { value: 'url' as const, label: t('database.modeUrl'), icon: ICONS.link },
  { value: 'manual' as const, label: t('database.modeManual'), icon: ICONS.edit },
  { value: 'ssh' as const, label: t('ssh.modeShort'), icon: ICONS.terminal },
]);
const title = computed(() => (isEditing.value ? t('mongoModal.editTitle') : t('mongoModal.addTitle')));
const meta = computed(() => (isEditing.value ? 'MongoDB' : `MongoDB · ${step.value + 1} / 2`));
</script>

<template>
  <AppModal
    :title="title"
    :icon="ICONS.leaf"
    :meta="meta"
    :steps="isEditing ? [] : steps"
    :step="step"
    :sections="isEditing ? sections : []"
    :section="section"
    :width="isEditing ? 'lg' : 'md'"
    :busy="isLoading"
    :close-label="t('common.cancel')"
    @update:section="section = $event as typeof section"
    @close="close"
    @submit="submit"
  >
    <!-- Connection -->
    <template v-if="showConnection">
      <ModalHeading
        :eyebrow="t('dbModal.sections.connection')"
        :title="isEditing ? (form.displayName || form.name) : 'MongoDB'"
        :subtitle="t('dbModal.connection.subtitle')"
      />

      <div class="space-y-4">
        <SegmentedControl v-model="mode" :options="modeOptions" :label="t('dbModal.sections.connection')" />

        <!-- URL -->
        <template v-if="mode === 'url'">
          <FormField
            :label="t('database.connectionUrlLabel')"
            for="mongo-url"
            required
            :error="shown('url')"
            :hint="isEditing ? t('dbModal.urlPasswordKept') : 'mongodb+srv://user:password@cluster0.example.mongodb.net/mydb'"
          >
            <input id="mongo-url" v-model="url" type="text" spellcheck="false" autocomplete="off" :class="monoInputClass" placeholder="mongodb://localhost:27017/mydb" />
          </FormField>
          <FormField v-if="needsName" :label="t('database.name')" for="mongo-name" required :error="shown('name')">
            <input id="mongo-name" v-model="form.name" type="text" spellcheck="false" :class="monoInputClass" :placeholder="t('database.namePlaceholder')" :disabled="isEditing" />
          </FormField>
          <FormField :label="t('database.displayName')" for="mongo-display" :optional="t('common.optional')">
            <input id="mongo-display" v-model="form.displayName" type="text" :class="inputClass" :placeholder="t('database.displayNamePlaceholder')" />
          </FormField>
        </template>

        <!-- Server via SSH: its own test, SSH then MongoDB through the tunnel -->
        <SshConnectionFields
          v-else-if="mode === 'ssh'"
          v-model:form="sshForm"
          v-model:ssh="sshDraft"
          v-model:auth-source="sshAuthSource"
          engine="mongodb"
          :editing="isEditing"
          :database-id="store.editingDatabase?.id"
          :attempted="attempted"
        />

        <!-- Field by field -->
        <template v-else>
          <div class="grid grid-cols-2 gap-3">
            <FormField :label="t('database.name')" for="mongo-name" required :error="shown('name')" :hint="isEditing ? t('dbModal.nameLocked') : undefined">
              <input id="mongo-name" v-model="form.name" type="text" spellcheck="false" :class="monoInputClass" :placeholder="t('database.namePlaceholder')" :disabled="isEditing" />
            </FormField>
            <FormField :label="t('database.displayName')" for="mongo-display" :optional="t('common.optional')">
              <input id="mongo-display" v-model="form.displayName" type="text" :class="inputClass" :placeholder="t('database.displayNamePlaceholder')" />
            </FormField>
          </div>
          <div class="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <FormField :label="t('database.host')" for="mongo-host" required :error="shown('host')">
              <input id="mongo-host" v-model="form.host" type="text" spellcheck="false" :class="monoInputClass" placeholder="localhost" />
            </FormField>
            <FormField :label="t('database.port')" for="mongo-port" required :error="shown('port')">
              <input id="mongo-port" v-model.number="form.port" type="number" min="1" max="65535" :class="monoInputClass" placeholder="27017" />
            </FormField>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <FormField :label="t('database.user')" for="mongo-user" :optional="t('common.optional')">
              <input id="mongo-user" v-model="form.user" type="text" spellcheck="false" autocomplete="off" :class="monoInputClass" />
            </FormField>
            <FormField :label="t('database.password')" for="mongo-password" :optional="isEditing ? undefined : t('common.optional')">
              <div class="relative">
                <input
                  id="mongo-password"
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
          <FormField v-if="form.user.trim()" :label="t('mongoModal.authSource')" for="mongo-auth" :hint="t('mongoModal.authSourceHint')">
            <input id="mongo-auth" v-model="form.authSource" type="text" spellcheck="false" :class="monoInputClass" placeholder="admin" />
          </FormField>
          <SslOptions v-model:ssl-mode="form.sslMode" v-model:ssl-root-cert="form.sslRootCert" />
        </template>

        <!-- Connection test -->
        <div v-if="mode !== 'ssh'" class="flex items-center gap-3 pt-1 min-h-9">
          <button type="button" :class="btnSecondary" :disabled="test.status === 'testing'" @click="testConnection">
            <svg v-if="test.status === 'testing'" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {{ test.status === 'testing' ? t('dbModal.testing') : test.status === 'idle' ? t('dbModal.test') : t('dbModal.testAgain') }}
          </button>
          <span v-if="test.status === 'ok'" class="flex items-center gap-1.5 text-[12px] text-emerald-600 dark:text-emerald-400" role="status">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            {{ t('mongoModal.testOk', { version: test.version, collections: test.collections }) }}
          </span>
          <span v-else-if="test.status === 'error'" class="flex items-start gap-1.5 text-[12px] text-red-600 dark:text-red-400 min-w-0" role="alert">
            <span class="w-1.5 h-1.5 mt-1.5 rounded-full bg-red-500 shrink-0" />
            <span class="break-words">{{ test.error }}</span>
          </span>
        </div>
      </div>
    </template>

    <!-- Backup: the same settings as for PostgreSQL -->
    <template v-if="showBackup">
      <ModalHeading :eyebrow="t('dbModal.sections.backup')" :title="t('dbModal.backup.title')" :subtitle="t('mongoModal.backupSubtitle')" />
      <div class="space-y-4">
        <FormField :label="t('database.output')" for="mongo-output" required :error="shown('output')">
          <div class="flex gap-2">
            <input id="mongo-output" v-model="backup.output" type="text" readonly :class="monoInputClass" class="cursor-default" />
            <button type="button" :class="btnSecondary" class="shrink-0" @click="selectOutput">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" :d="ICONS.folder" />
              </svg>
              {{ t('common.browse') }}
            </button>
          </div>
        </FormField>
        <div class="grid grid-cols-2 gap-3">
          <FormField :label="t('database.retentionCount')" for="mongo-retention" :hint="t('database.retentionHint')">
            <input id="mongo-retention" v-model.number="backup.retentionCount" type="number" min="1" :class="inputClass" :placeholder="t('database.retentionAll')" />
          </FormField>
        </div>
        <SwitchRow v-model="backup.encryptBackups" :title="t('database.wizard.encryptBackups')" :description="t('database.wizard.encryptBackupsDesc')" />
        <SwitchRow v-model="backup.verifyBackups" :title="t('database.verifyBackups')" :description="t('mongoModal.verifyHint')" />
      </div>
    </template>

    <!-- Schedule -->
    <template v-if="showSchedule">
      <div :class="isEditing ? '' : 'mt-6 pt-5 border-t border-gray-100 dark:border-zinc-800'">
        <ModalHeading :eyebrow="t('dbModal.sections.schedule')" :title="t('dbModal.schedule.title')" :subtitle="t('dbModal.schedule.subtitle')" />
        <div class="space-y-4">
          <SwitchRow v-model="backup.enabled" :title="t('dbModal.schedule.toggle')" :description="t('dbModal.schedule.toggleDesc')" />
          <div v-if="backup.enabled">
            <FormField :label="t('database.cron')">
              <CronEditor v-model="backup.cron" />
            </FormField>
          </div>
        </div>
      </div>
    </template>

    <template #footer>
      <button v-if="!isEditing && step > 0" type="button" :class="btnGhost" :disabled="isLoading" @click="step = 0">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        {{ t('database.wizard.previous') }}
      </button>
      <button v-else type="button" :class="btnGhost" :disabled="isLoading" @click="close">{{ t('common.cancel') }}</button>
      <span class="flex-1" />
      <button v-if="!isEditing && step === 0" type="button" :class="btnPrimary" @click="next">{{ t('database.wizard.next') }}</button>
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

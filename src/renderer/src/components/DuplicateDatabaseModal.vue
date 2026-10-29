<script setup lang="ts">
/**
 * Copy a database into a new local one (backup → create → restore), in the shared dialog shell.
 * Anonymized: schema only, then the rows streamed with personal data replaced (no backup kept).
 * MySQL / MariaDB: a new database on the source's server or on the server of another saved
 * database of the same engine; SQLite: a new file. bbdump copies those itself (no dump tools).
 */
import { ref, computed, onMounted } from 'vue';
import { getErrorMessage } from '../utils';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';
import { Database } from '../types';
import { store } from '../store';
import { engineOf } from '../../../shared/engines/features';
import { isMysqlFamily } from '../../../shared/engines/manifests';
import AppModal from './ui/AppModal.vue';
import ModalHeading from './ui/ModalHeading.vue';
import FormField from './ui/FormField.vue';
import SwitchRow from './ui/SwitchRow.vue';
import AnonymizeModal from './AnonymizeModal.vue';
import type { AnonymizeChoices } from '../anonymize';
import { btnGhost, btnPrimary, btnSecondary, inputClass, monoInputClass, panelClass } from './ui/classes';

const ICON_COPY = 'M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2';
const STEPS = ['backup', 'creating', 'restoring', 'complete'];
const ANONYMIZED_STEPS = ['schema', 'creating', 'copying', 'complete'];
const SQL_STEPS = ['creating', 'copying', 'complete'];

const props = defineProps<{
  modelValue: boolean;
  sourceDb: Database | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'success', newDbName: string, newDbId?: string): void;
}>();

const { t } = useI18n();
const { addToast } = useToast();

const duplicateForm = ref({ name: '', password: '', port: 5432 });
const isDuplicating = ref(false);
const duplicateProgress = ref<{ step: string; message: string; progress: number } | null>(null);
const attempted = ref(false);
/** Names taken in bbdump or on the local server */
const existingNames = ref(new Set<string>());
const anonymizeOn = ref(false);
const anonymizeChoices = ref<AnonymizeChoices | null>(null);
const showAnonymize = ref(false);
/** MySQL, MariaDB, SQLite: copied by bbdump itself */
const sqlEngine = computed(() => ['mysql', 'mariadb', 'sqlite'].includes(engineOf(props.sourceDb)));
const isSqlite = computed(() => engineOf(props.sourceDb) === 'sqlite');
const familyOf = (db: Database) => (isMysqlFamily(engineOf(db)) ? 'mysql' : engineOf(db));
const sqlForm = ref({ serverOf: '', file: '' });
/** Servers a MySQL / MariaDB copy can go to: the source's, then those of other saved databases of its engine */
const servers = computed(() => {
  const source = props.sourceDb;
  if (!source || isSqlite.value) return [];
  const where = (d: Database) => (d.ssh ? `${d.ssh.host} (SSH)` : `${d.host}:${d.port}`);
  const seen = new Set<string>();
  return [source, ...store.databases.filter(d => d.id !== source.id && familyOf(d) === familyOf(source))]
    .filter(d => {
      const key = `${d.ssh?.host ?? ''}|${d.host}|${d.port}|${d.user}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(d => ({ id: d.id, label: d.id === source.id ? t('databases.duplicateSameServer', { where: where(d) }) : `${d.masked ? '••••••••' : d.displayName || d.name} · ${where(d)}` }));
});
const chosenServer = computed(() => store.databases.find(d => d.id === (sqlForm.value.serverOf || props.sourceDb?.id)) ?? props.sourceDb);
const fileName = (file: string) => file.split(/[\\/]/).pop() || file;

const chooseFile = async () => {
  const file = await ipcRenderer.invoke('select-sqlite-copy-path', sqlForm.value.file || undefined) as string | null;
  if (file) sqlForm.value.file = file;
};

const steps = computed(() => (sqlEngine.value ? SQL_STEPS : anonymizeOn.value ? ANONYMIZED_STEPS : STEPS));

const currentStepIndex = computed(() => {
  if (!duplicateProgress.value) return 0;
  return Math.max(0, steps.value.indexOf(duplicateProgress.value.step));
});
const stepLabels = computed(() => steps.value.map(step => t(`databases.duplicateSteps.${sqlEngine.value && step === 'copying' && !anonymizeOn.value ? 'copyRows' : step}`)));
const anonymizeSummary = computed(() => {
  const choices = anonymizeChoices.value;
  return choices ? t('anonymize.chosen', { columns: choices.columns.length, tables: choices.emptyTables.length }) : '';
});

const confirmAnonymize = (choices: AnonymizeChoices) => {
  anonymizeChoices.value = choices;
  showAnonymize.value = false;
};

const sourceLabel = computed(() => (props.sourceDb ? (props.sourceDb.masked ? '••••••••' : (props.sourceDb.displayName || props.sourceDb.name)) : ''));
const sourceWhere = computed(() => {
  const db = props.sourceDb;
  if (!db) return '';
  if (engineOf(db) === 'sqlite') return fileName(db.sqlite?.path ?? db.name);
  return `${db.ssh ? `${db.ssh.host} (SSH)` : `${db.host}:${db.port}`} · ${db.name}`;
});
/** Where the copy goes, under its name */
const targetWhere = computed(() => {
  if (!sqlEngine.value) return `localhost:${duplicateForm.value.port}`;
  if (isSqlite.value) return t('databases.duplicateNewFile');
  const db = chosenServer.value;
  return db ? (db.ssh ? `${db.ssh.host} (SSH)` : `${db.host}:${db.port}`) : '';
});

interface MissingExtension { name: string; installable: boolean; command: string | null }
/** Extensions of the source the local server lacks: what depends on them would not be copied */
const missingExt = ref<MissingExtension[]>([]);
const installingExt = ref<string | null>(null);
const extError = ref('');

const checkExtensions = async () => {
  if (!props.sourceDb || sqlEngine.value) return;
  try {
    const result = await ipcRenderer.invoke('duplicate-check-extensions', props.sourceDb.id, duplicateForm.value.port);
    missingExt.value = result?.missing ?? [];
  } catch {
    missingExt.value = [];
  }
};

const installExtension = async (name: string) => {
  installingExt.value = name;
  extError.value = '';
  try {
    const result = await ipcRenderer.invoke('install-extension-package', 'postgres', name, duplicateForm.value.port);
    if (!result?.success) extError.value = result?.error || t('databases.duplicateExtInstallError');
    else addToast(t('databases.duplicateExtInstalled', { name }), 'success');
  } catch (error) {
    extError.value = getErrorMessage(error);
  } finally {
    installingExt.value = null;
    await checkExtensions();
    // Installed, yet the server still cannot create it: the package targets another PostgreSQL version
    if (!extError.value && missingExt.value.some(e => e.name === name)) extError.value = t('databases.duplicateExtNotSeen', { name });
  }
};

/**
 * pg_restore lines said plainly: the missing extensions once, the tables that could not be
 * created (a type of a missing extension…) by name; the other lines as they are.
 */
const explainWarnings = (lines: string[]) => {
  const missing = new Set<string>();
  const lost = new Set<string>();
  const rest: string[] = [];
  for (const line of lines) {
    const ext = /extension "([^"]+)" (is not available|does not exist)/.exec(line);
    // pg_restore, or the anonymized copy ("schema.table: not created by the schema restore…")
    const table = /relation "([^"]+)" does not exist/.exec(line) ?? /^(\S+): not created by the schema restore/.exec(line);
    if (ext) missing.add(ext[1]);
    else if (table) lost.add(table[1].replace(/^public\./, ''));
    else if (!(missing.size && /type "[^"]+" does not exist/.test(line))) rest.push(line);
  }
  return [
    ...(missing.size ? [t('databases.duplicateExtWarning', { names: [...missing].join(', ') })] : []),
    ...(lost.size ? [t('databases.duplicateLostTables', { tables: [...lost].join(', ') })] : []),
    ...rest,
  ];
};

onMounted(async () => {
  if (!props.sourceDb) return;
  if (sqlEngine.value) {
    const source = props.sourceDb;
    if (isSqlite.value) {
      // "<file>-copy.sqlite" next to the source
      const file = source.sqlite?.path ?? '';
      const ext = /\.[^.\\/]+$/.exec(file)?.[0] ?? '.sqlite';
      sqlForm.value.file = file ? `${file.slice(0, file.length - ext.length)}-copy${ext}` : '';
    } else {
      sqlForm.value.serverOf = source.id;
      const names = new Set(store.databases.map(d => d.name));
      const baseName = `${source.name}_copy`;
      let candidate = baseName;
      for (let counter = 2; names.has(candidate); counter++) candidate = `${baseName}_${counter}`;
      duplicateForm.value.name = candidate;
    }
    return;
  }
  const names = new Set(store.databases.map(d => d.name));
  try {
    const result = await ipcRenderer.invoke('get-postgres-config');
    (result?.databases || []).forEach((d: { name: string }) => names.add(d.name));
  } catch (e) {
    console.error('Failed to fetch physical databases for name check', e);
  }
  existingNames.value = names;
  checkExtensions();

  // First free "<name>_copy", "<name>_copy_2"…
  const baseName = `${props.sourceDb.name}_copy`;
  let candidate = baseName;
  for (let counter = 2; names.has(candidate); counter++) candidate = `${baseName}_${counter}`;
  duplicateForm.value.name = candidate;
});

const nameError = computed(() => {
  if (isSqlite.value) return undefined;
  const name = duplicateForm.value.name.trim();
  if (sqlEngine.value) {
    if (!name) return attempted.value ? t('databases.duplicateNameRequired') : undefined;
    if (!/^[A-Za-z_][A-Za-z0-9_$]{0,63}$/.test(name)) return t('databases.duplicateNameInvalid');
    // The same name on the chosen server (as bbdump knows it)
    const server = chosenServer.value;
    if (server && store.databases.some(d => familyOf(d) === familyOf(server) && d.host === server.host && d.port === server.port && d.name === name)) return t('createDatabase.errors.nameExists');
    return undefined;
  }
  if (!name) return attempted.value ? t('databases.duplicateNameRequired') : undefined;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return t('databases.duplicateNameInvalid');
  if (existingNames.value.has(name)) return t('createDatabase.errors.nameExists');
  return undefined;
});
const fileError = computed(() => {
  if (!isSqlite.value) return undefined;
  const file = sqlForm.value.file.trim();
  if (!file) return attempted.value ? t('databases.duplicateFileRequired') : undefined;
  if (!/\.(sqlite3?|db3?|s3db|sl3)$/i.test(file)) return t('databases.duplicateFileExtension');
  if (file === props.sourceDb?.sqlite?.path) return t('databases.duplicateFileSame');
  return undefined;
});
const portError = computed(() => {
  if (sqlEngine.value) return undefined;
  const port = duplicateForm.value.port;
  return !port || port < 1024 || port > 65535 ? t('createDatabase.errors.portInvalid') : undefined;
});

const closeModal = () => {
  if (isDuplicating.value) return;
  emit('update:modelValue', false);
};

const duplicateToLocal = async () => {
  if (!props.sourceDb || isDuplicating.value) return;
  attempted.value = true;
  if (nameError.value || portError.value || fileError.value) return;
  // The data to anonymize is chosen before anything starts
  if (anonymizeOn.value && !anonymizeChoices.value) {
    showAnonymize.value = true;
    return;
  }

  const formName = isSqlite.value ? fileName(sqlForm.value.file.trim()) : duplicateForm.value.name.trim();
  isDuplicating.value = true;
  duplicateProgress.value = sqlEngine.value
    ? { step: 'creating', message: t('databases.duplicateStepCreating'), progress: 0 }
    : anonymizeOn.value
    ? { step: 'schema', message: t('databases.duplicateStepSchema'), progress: 0 }
    : { step: 'backup', message: t('databases.duplicateStepBackup'), progress: 0 };

  const progressHandler = (_event: unknown, progress: { step: string; message: string; progress: number }) => {
    duplicateProgress.value = progress;
  };
  ipcRenderer.on('duplicate-progress', progressHandler);

  try {
    const sourceDb = props.sourceDb;
    // Plain objects: reactive proxies cannot cross IPC
    const anonymize = anonymizeOn.value && anonymizeChoices.value ? JSON.parse(JSON.stringify(anonymizeChoices.value)) : undefined;
    if (sqlEngine.value) {
      const result = await ipcRenderer.invoke('duplicate-sql-database', isSqlite.value
        ? { sourceId: sourceDb.id, file: sqlForm.value.file.trim(), anonymize }
        : { sourceId: sourceDb.id, name: formName, serverOf: sqlForm.value.serverOf || sourceDb.id, anonymize });
      if (!result.success) {
        addToast(t('databases.duplicateError'), 'error', { detail: result.error });
        return;
      }
      isDuplicating.value = false;
      if (result.warnings?.length) addToast(t('databases.duplicateWarnings', { name: result.name, count: result.warnings.length }), 'warning', { detail: result.warnings.join('\n') });
      else addToast(t(anonymizeOn.value ? 'databases.duplicateAnonymizedSuccess' : 'databases.duplicateSuccess', { name: result.name }), 'success');
      emit('success', result.name, result.id);
      closeModal();
      return;
    }
    // The main process reads the source (and its password) from the saved config by id
    const sourceDbConfig: Partial<Database> = {
      id: sourceDb.id,
      name: sourceDb.name,
      displayName: sourceDb.displayName,
      host: sourceDb.host,
      port: sourceDb.port,
      user: sourceDb.user,
      password: '',
      encrypted: sourceDb.encrypted || false,
      encryptBackups: sourceDb.encryptBackups || false,
      cron: sourceDb.cron || '0 0 * * *',
      output: sourceDb.output || '',
      enabled: sourceDb.enabled || false,
      ssl: sourceDb.ssl || false,
      connectionString: sourceDb.connectionString,
      isLocalBbdump: sourceDb.isLocalBbdump || false
    };

    const result = await ipcRenderer.invoke('duplicate-external-to-local', {
      sourceDb: sourceDbConfig,
      targetName: formName,
      targetPassword: duplicateForm.value.password || undefined,
      targetPort: duplicateForm.value.port,
      // Plain objects: reactive proxies cannot cross IPC
      anonymize,
    });

    if (result.success) {
      isDuplicating.value = false;
      if (result.warnings?.length) {
        const explained = explainWarnings(result.warnings);
        addToast(t('databases.duplicateWarnings', { name: formName, count: explained.length }), 'warning', { detail: explained.join('\n') });
      } else {
        addToast(t(anonymizeOn.value ? 'databases.duplicateAnonymizedSuccess' : 'databases.duplicateSuccess', { name: formName }), 'success');
      }
      emit('success', formName);
      closeModal();
    } else {
      addToast(t('databases.duplicateError'), 'error', { detail: result.error });
    }
  } catch (error) {
    addToast(t('toasts.duplicateDbError'), 'error', { detail: getErrorMessage(error) });
  } finally {
    ipcRenderer.removeListener('duplicate-progress', progressHandler);
    isDuplicating.value = false;
    duplicateProgress.value = null;
  }
};
</script>

<template>
  <AppModal
    v-if="modelValue"
    :title="sqlEngine ? t('databases.duplicateSqlTitle') : t('databases.duplicateToLocalTitle')"
    :icon="ICON_COPY"
    :steps="isDuplicating ? stepLabels : []"
    :step="currentStepIndex"
    :busy="isDuplicating"
    :close-label="t('common.cancel')"
    @close="closeModal"
    @submit="duplicateToLocal"
  >
    <!-- Running: the steps are in the header bars -->
    <div v-if="isDuplicating" class="py-4" role="status" aria-live="polite">
      <ModalHeading :eyebrow="t(sqlEngine ? 'databases.duplicateSqlEyebrow' : 'databases.duplicateEyebrow')" :title="isSqlite ? fileName(sqlForm.file) : duplicateForm.name" :subtitle="sourceWhere" />
      <div class="h-[3px] rounded-full overflow-hidden bg-gray-100 dark:bg-zinc-800">
        <div class="h-full rounded-full bg-emerald-500 transition-[width] duration-500" :style="{ width: `${Math.max(4, duplicateProgress?.progress ?? 0)}%` }" />
      </div>
      <div class="mt-2 flex items-center justify-between gap-3 text-[12px]">
        <span class="text-gray-600 dark:text-zinc-400 min-w-0 break-words">{{ duplicateProgress?.message || t('databases.duplicateStepBackup') }}</span>
        <span class="font-mono text-gray-400 dark:text-zinc-500 tabular-nums">{{ duplicateProgress?.progress ?? 0 }}%</span>
      </div>
    </div>

    <template v-else>
      <ModalHeading
        :eyebrow="t(sqlEngine ? 'databases.duplicateSqlEyebrow' : 'databases.duplicateEyebrow')"
        :title="t('databases.duplicateTitle', { name: sourceLabel })"
        :subtitle="t(sqlEngine
          ? (anonymizeOn ? 'databases.duplicateSqlInfoAnonymized' : isSqlite ? 'databases.duplicateSqliteInfo' : 'databases.duplicateSqlInfo')
          : (anonymizeOn ? 'databases.duplicateInfoAnonymized' : 'databases.duplicateInfo'))"
      />
      <div class="space-y-4">
        <!-- Source → copy -->
        <div v-if="sourceDb" :class="panelClass" class="px-3.5 py-2.5 flex items-center gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-[11px] text-gray-500 dark:text-zinc-400">{{ t('databases.duplicateFrom') }}</div>
            <div class="text-[13px] font-medium text-gray-900 dark:text-zinc-100 overflow-hidden text-ellipsis whitespace-nowrap">{{ sourceLabel }}</div>
            <div class="font-mono text-[11px] text-gray-500 dark:text-zinc-500 overflow-hidden text-ellipsis whitespace-nowrap">{{ sourceWhere }}</div>
          </div>
          <svg class="w-4 h-4 shrink-0 text-gray-300 dark:text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
          <div class="min-w-0 flex-1 text-right">
            <div class="text-[11px] text-gray-500 dark:text-zinc-400">{{ t(sqlEngine ? 'databases.duplicateToCopy' : 'databases.duplicateTo') }}</div>
            <div class="font-mono text-[13px] text-emerald-700 dark:text-emerald-400 overflow-hidden text-ellipsis whitespace-nowrap">{{ (isSqlite ? fileName(sqlForm.file) : duplicateForm.name) || '—' }}</div>
            <div class="font-mono text-[11px] text-gray-500 dark:text-zinc-500 overflow-hidden text-ellipsis whitespace-nowrap">{{ targetWhere }}</div>
          </div>
        </div>

        <!-- SQLite: the new file -->
        <FormField v-if="isSqlite" :label="t('databases.duplicateFile')" for="dup-file" required :error="fileError" :hint="t('databases.duplicateFileHint')">
          <div class="flex gap-2">
            <input id="dup-file" v-model="sqlForm.file" type="text" spellcheck="false" autocomplete="off" :class="monoInputClass" placeholder="/path/to/copy.sqlite" />
            <button type="button" :class="btnSecondary" class="shrink-0" @click="chooseFile">{{ t('sqlModal.fileChoose') }}</button>
          </div>
        </FormField>
        <FormField v-else :label="t('database.name')" for="dup-name" required :error="nameError" :hint="t(sqlEngine ? 'databases.duplicateSqlNameHint' : 'createDatabase.nameHint')">
          <input id="dup-name" v-model="duplicateForm.name" type="text" spellcheck="false" autocomplete="off" :class="monoInputClass" :placeholder="t('database.namePlaceholder')" />
        </FormField>
        <!-- MySQL / MariaDB: the server of the copy -->
        <FormField v-if="sqlEngine && !isSqlite" :label="t('databases.duplicateServer')" for="dup-server" :hint="t('databases.duplicateServerHint')">
          <select id="dup-server" v-model="sqlForm.serverOf" :class="inputClass">
            <option v-for="server in servers" :key="server.id" :value="server.id">{{ server.label }}</option>
          </select>
        </FormField>
        <div v-if="!sqlEngine" class="grid grid-cols-[minmax(0,1fr)_8rem] gap-3">
          <FormField :label="t('database.password')" for="dup-password" :optional="t('common.optional')" :hint="t('createDatabase.passwordHint')">
            <input id="dup-password" v-model="duplicateForm.password" type="password" autocomplete="new-password" :class="inputClass" />
          </FormField>
          <FormField :label="t('database.port')" for="dup-port" :error="portError">
            <input id="dup-port" v-model.number="duplicateForm.port" type="number" min="1024" max="65535" :class="monoInputClass" />
          </FormField>
        </div>

        <!-- Extensions the local server lacks (e.g. postgis): install them before copying -->
        <div v-if="!sqlEngine && missingExt.length" class="rounded-xl border border-amber-300/60 dark:border-amber-800/60 bg-amber-50/60 dark:bg-amber-950/20 px-3.5 py-3" role="alert">
          <div class="text-[13px] font-medium text-amber-900 dark:text-amber-200">{{ t('databases.duplicateExtMissing', { names: missingExt.map(e => e.name).join(', ') }) }}</div>
          <p class="mt-0.5 text-[11.5px] leading-relaxed text-amber-800/90 dark:text-amber-300/80">{{ t('databases.duplicateExtHint') }}</p>
          <ul class="mt-2 space-y-1.5">
            <li v-for="ext in missingExt" :key="ext.name" class="flex items-center gap-2 text-[12px]">
              <span class="font-mono text-gray-900 dark:text-zinc-100">{{ ext.name }}</span>
              <span class="flex-1" />
              <button v-if="ext.installable" type="button" :class="btnSecondary" :disabled="!!installingExt" @click="installExtension(ext.name)">
                <svg v-if="installingExt === ext.name" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" /><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                {{ installingExt === ext.name ? t('databases.duplicateExtInstalling') : t('databases.duplicateExtInstall') }}
              </button>
              <code v-else-if="ext.command" class="font-mono text-[11px] text-gray-600 dark:text-zinc-400 select-all">{{ ext.command }}</code>
              <span v-else class="text-[11px] text-gray-500 dark:text-zinc-400">{{ t('databases.duplicateExtHosted') }}</span>
            </li>
          </ul>
          <p v-if="extError" class="mt-1.5 text-[11px] text-red-600 dark:text-red-400 break-words">{{ extError }}</p>
        </div>

        <SwitchRow v-model="anonymizeOn" :title="t('anonymize.switch')" :description="t(sqlEngine ? 'anonymize.switchHintSql' : 'anonymize.switchHint')">
          <span v-if="anonymizeOn && anonymizeChoices" class="mt-1.5 flex items-center gap-2 text-[12px]">
            <span class="text-emerald-700 dark:text-emerald-400">{{ anonymizeSummary }}</span>
            <span role="button" tabindex="0" class="underline text-gray-600 dark:text-zinc-300 hover:text-gray-900 dark:hover:text-white" @click.stop="showAnonymize = true" @keydown.enter.stop.prevent="showAnonymize = true">{{ t('anonymize.edit') }}</span>
          </span>
        </SwitchRow>
      </div>
    </template>

    <template #footer>
      <button type="button" :class="btnGhost" :disabled="isDuplicating" @click="closeModal">{{ t('common.cancel') }}</button>
      <span class="flex-1" />
      <span v-if="!isDuplicating" class="hidden sm:inline text-[11px] text-gray-400 dark:text-zinc-500"><kbd class="font-mono">↵</kbd> Enter</span>
      <button type="button" :class="btnPrimary" :disabled="isDuplicating" @click="duplicateToLocal">
        <svg v-if="isDuplicating" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        {{ anonymizeOn && !anonymizeChoices ? t('anonymize.choose') : t('databases.duplicateButton') }}
      </button>
    </template>
  </AppModal>

  <AnonymizeModal
    v-if="modelValue && showAnonymize && sourceDb"
    :source-id="sourceDb.id"
    :source-label="sourceLabel"
    :initial="anonymizeChoices"
    @close="showAnonymize = false"
    @confirm="confirmAnonymize"
  />
</template>

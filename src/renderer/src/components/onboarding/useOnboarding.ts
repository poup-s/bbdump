/**
 * Onboarding state, shared by the shell and every step (provide / inject).
 * Nothing is written to the configuration before the last step: choices are
 * collected here, then `finish()` saves them in one go.
 */
import { computed, inject, provide, reactive, type InjectionKey } from 'vue';
import type {
  SetupComponent,
  SetupEnvironment,
  SetupInstallPlan,
  SetupInstallResult,
  SetupProgress,
  UsageMode,
} from '../../../../types/setup';
import type { StackFocus } from '../3d/serverStack';
import type { PostgresDatabase, SslMode } from '../../types';
import { ipcRenderer } from '../../electron';
import { store } from '../../store';
import { getErrorMessage } from '../../utils';
import { parsePgUrl } from '../../pgUrl';
import { useI18n } from '../../composables/useI18n';

export type StepId = 'welcome' | 'mode' | 'machine' | 'databases' | 'folder' | 'ai' | 'ready';
/** The four sections of the stack the progress indicator follows. */
export type SectionId = 'you' | 'machine' | 'data' | 'ai';
/** Docker is shown but not selectable yet. */
export type SelectableMode = Exclude<UsageMode, 'docker'>;
export type Language = 'en' | 'fr';

export const STEPS: ReadonlyArray<{ id: StepId; section: SectionId | null; focus: StackFocus }> = [
  { id: 'welcome', section: null, focus: 'overview' },
  { id: 'mode', section: 'you', focus: 'top' },
  { id: 'machine', section: 'machine', focus: 'middle' },
  { id: 'databases', section: 'data', focus: 'bottom' },
  { id: 'folder', section: 'data', focus: 'bottom' },
  { id: 'ai', section: 'ai', focus: 'orbit' },
  { id: 'ready', section: null, focus: 'complete' },
];

export const SECTIONS: readonly SectionId[] = ['you', 'machine', 'data', 'ai'];

/** Databases that come with every PostgreSQL server: never offered for import. */
const SYSTEM_DATABASES = ['template0', 'template1'];

const TEST_TIMEOUT_MS = 15000;

export interface ParsedUrl {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
  sslMode?: SslMode;
  sslRootCert?: string;
}


/** postgres://user:password@host:port/database?sslmode=… (same rules as the database modal). */
export function parseConnectionUrl(url: string): ParsedUrl | null {
  const parsed = parsePgUrl(url);
  if (!parsed?.database) return null;
  return {
    user: parsed.user ?? 'postgres',
    password: parsed.password ?? '',
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    sslMode: parsed.sslMode,
    sslRootCert: parsed.sslRootCert,
  };
}

const withTimeout = <T>(promise: Promise<T>, ms: number, message: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);

function createOnboarding() {
  const { t, setLanguage } = useI18n();

  const state = reactive({
    stepIndex: 0,
    /** 1 forward, -1 back: drives the slide direction */
    direction: 1 as 1 | -1,
    language: 'en' as Language,
    mode: null as SelectableMode | null,

    env: null as SetupEnvironment | null,
    envStatus: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
    envError: '',
    /** The user chose to go on without the machine check (it could not run) */
    envSkipped: false,

    installing: null as SetupComponent | null,
    progress: null as SetupProgress | null,
    installError: null as { component: SetupComponent; message: string; manualCommand?: string; cancelled?: boolean } | null,
    /** Install handed over to a Terminal window (Homebrew): waiting for the user */
    handedOver: null as { component: SetupComponent; command?: string } | null,
    plans: {} as Partial<Record<SetupComponent, SetupInstallPlan>>,
    planErrors: {} as Partial<Record<SetupComponent, string>>,

    localDbs: [] as PostgresDatabase[],
    localStatus: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
    selectedLocal: [] as string[],

    remote: {
      url: '',
      sslMode: 'disable' as SslMode,
      sslRootCert: undefined as string | undefined,
      test: 'idle' as 'idle' | 'testing' | 'ok' | 'error',
      tables: null as number | null,
      error: '',
    },
    /** Local mode: the optional remote database form is open */
    remoteOpen: false,

    backupPath: '',
    aiConnected: [] as string[],

    finishing: false,
    finishError: '',
    /** complete-onboarding succeeded: only database imports can still fail */
    saved: false,
  });

  const step = computed(() => STEPS[state.stepIndex]);

  /** Setup IPC missing (older main process) or a failure: one readable message. */
  const describeError = (error: unknown) => {
    const message = getErrorMessage(error);
    if (/unknown channel|No handler registered/i.test(message)) return t('onboarding.errors.unavailable');
    return message || t('onboarding.errors.generic');
  };

  const selectLanguage = (lang: Language) => {
    state.language = lang;
    setLanguage(lang);
  };

  const loadEnvironment = async () => {
    state.envStatus = 'loading';
    state.envError = '';
    try {
      const env: SetupEnvironment = await ipcRenderer.invoke('setup-get-environment');
      if (!env || !env.clientTools) throw new Error(t('onboarding.errors.unavailable'));
      state.env = env;
      state.envStatus = 'ready';
      state.envSkipped = false;
      if (state.handedOver?.component === 'homebrew' && env.homebrew?.installed) state.handedOver = null;
      // Plans depend on what is installed: fetch them again when asked
      state.plans = {};
      state.planErrors = {};
    } catch (error) {
      state.envError = describeError(error);
      state.envStatus = 'error';
    }
  };

  /** First values: saved language / folder / mode when the onboarding is replayed. */
  const loadInitial = async () => {
    let language: Language = navigator.language?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
    try {
      const config = await ipcRenderer.invoke('get-config');
      // The default config already says 'en': only a finished onboarding means the user chose it
      if (config?.onboardingCompleted && (config.language === 'fr' || config.language === 'en')) language = config.language;
      if (config?.usageMode === 'local' || config?.usageMode === 'remote') state.mode = config.usageMode;
      if (config?.defaultBackupPath) state.backupPath = config.defaultBackupPath;
    } catch {
      // First run without a readable config: defaults are fine
    }
    selectLanguage(language);
    // "Add a local server" from the settings: straight to the machine check, in local mode
    if (store.onboardingEntry === 'add-local-server') {
      state.mode = 'local';
      state.direction = 1;
      state.stepIndex = STEPS.findIndex(s => s.id === 'machine');
    }
    if (!state.backupPath) {
      try {
        state.backupPath = await ipcRenderer.invoke('get-default-path');
      } catch {
        state.backupPath = '';
      }
    }
  };

  const serverReady = computed(() => {
    const server = state.env?.server;
    return !!server && server.installed && server.running && server.canConnect;
  });

  /** A local server is already here: local mode is the natural choice. */
  const recommendedMode = computed<SelectableMode>(() =>
    state.env?.supported !== false && state.env?.server.installed ? 'local' : 'remote'
  );

  const clientToolsReady = computed(() => state.envSkipped || !!state.env?.clientTools.ready);

  const remoteParsed = computed(() => (state.remote.url.trim() ? parseConnectionUrl(state.remote.url) : null));
  const remoteInvalid = computed(() => !!state.remote.url.trim() && !remoteParsed.value);
  /** Remote form in use: remote mode, or opened from local mode */
  const remoteActive = computed(() => state.mode === 'remote' || state.remoteOpen);

  const canContinue = computed(() => {
    switch (step.value.id) {
      case 'mode':
        return !!state.mode;
      case 'machine':
        if (state.env?.supported === false) return clientToolsReady.value && state.mode === 'remote';
        return clientToolsReady.value && !state.installing;
      case 'databases':
        return !(remoteActive.value && remoteInvalid.value) && state.remote.test !== 'testing';
      case 'folder':
        return !!state.backupPath;
      case 'ready':
        return !state.finishing;
      default:
        return true;
    }
  });

  const goTo = (index: number) => {
    if (index < 0 || index >= STEPS.length || index === state.stepIndex) return;
    state.direction = index > state.stepIndex ? 1 : -1;
    state.stepIndex = index;
  };
  const goToStep = (id: StepId) => goTo(STEPS.findIndex(s => s.id === id));
  const next = () => {
    if (canContinue.value) goTo(state.stepIndex + 1);
  };
  const back = () => goTo(state.stepIndex - 1);

  // --- Install / plans -----------------------------------------------------

  const getPlan = async (component: SetupComponent) => {
    if (state.plans[component]) return;
    state.planErrors = { ...state.planErrors, [component]: '' };
    try {
      const plan: SetupInstallPlan = await ipcRenderer.invoke('setup-get-plan', component);
      if (!plan?.command) throw new Error(t('onboarding.errors.unavailable'));
      state.plans = { ...state.plans, [component]: plan };
    } catch (error) {
      state.planErrors = { ...state.planErrors, [component]: describeError(error) };
    }
  };

  const install = async (component: SetupComponent) => {
    if (state.installing) return;
    state.installing = component;
    state.progress = null;
    state.installError = null;
    state.handedOver = null;
    try {
      const result: SetupInstallResult = await ipcRenderer.invoke('setup-install', component);
      if (!result?.success) {
        const cancelled = /cancel|annul|dismissed|126/i.test(result?.error || '');
        state.installError = {
          component,
          message: cancelled ? t('onboarding.machine.cancelled') : result?.error || t('onboarding.machine.installFailed'),
          manualCommand: result?.manualCommand,
          cancelled,
        };
      } else if (result.manualCommand) {
        // Started elsewhere (Homebrew opens Terminal): the user finishes there, then re-checks
        state.handedOver = { component, command: result.manualCommand };
      }
      if (result?.environment) {
        state.env = result.environment;
        state.plans = {};
      } else {
        await loadEnvironment();
      }
    } catch (error) {
      state.installError = { component, message: describeError(error) };
    } finally {
      state.installing = null;
      state.progress = null;
    }
  };

  /** Live progress from the main process; the channel may not exist (older build). */
  const listenProgress = () => {
    try {
      return ipcRenderer.on('setup-progress', (_event: unknown, progress: SetupProgress) => {
        if (progress && progress.component === state.installing) state.progress = progress;
      });
    } catch {
      return () => {};
    }
  };

  // --- Data ------------------------------------------------------------------

  const discoverLocal = async () => {
    state.localStatus = 'loading';
    try {
      const info = await ipcRenderer.invoke('get-postgres-config', state.env?.server.port ?? 5432);
      const databases: PostgresDatabase[] = (info?.databases || [])
        .filter((db: PostgresDatabase) => !SYSTEM_DATABASES.includes(db.name));
      const known = new Set(state.localDbs.map(db => db.name));
      state.localDbs = databases;
      // Pre-select new finds, keep the user's choices for the others
      state.selectedLocal = databases
        .map(db => db.name)
        .filter(name => !known.has(name) || state.selectedLocal.includes(name));
      state.localStatus = 'ready';
    } catch {
      state.localDbs = [];
      state.selectedLocal = [];
      state.localStatus = 'error';
    }
  };

  const testRemote = async () => {
    const parsed = remoteParsed.value;
    if (!parsed) return;
    state.remote.test = 'testing';
    state.remote.error = '';
    try {
      const result = await withTimeout(
        ipcRenderer.invoke('get-database-tables', {
          host: parsed.host,
          port: parsed.port,
          user: parsed.user,
          password: parsed.password,
          database: parsed.database,
          connectionString: state.remote.url.trim(),
          ssl: ['require', 'verify-ca', 'verify-full'].includes(state.remote.sslMode),
          sslMode: state.remote.sslMode,
          sslRootCert: state.remote.sslMode === 'disable' ? undefined : state.remote.sslRootCert,
        }),
        TEST_TIMEOUT_MS,
        t('onboarding.databases.testTimeout'),
      );
      state.remote.tables = Array.isArray(result?.tables) ? result.tables.length : null;
      state.remote.test = 'ok';
    } catch (error) {
      state.remote.error = describeError(error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      state.remote.test = 'error';
    }
  };

  const chooseFolder = async () => {
    try {
      const path = await ipcRenderer.invoke('select-directory');
      if (path) state.backupPath = path;
    } catch (error) {
      console.error('Folder selection failed:', error);
    }
  };

  // --- Finish ----------------------------------------------------------------

  const done = () => {
    store.usageMode = state.mode ?? 'local';
    store.language = state.language;
    store.onboardingEntry = null;
    store.onboardingCompleted = true;
  };

  /** Opened from the app (replay, add a local server): leave without saving anything. */
  const canCancel = computed(() => store.onboardingEntry !== null);
  const cancel = () => {
    if (!canCancel.value || state.finishing) return;
    setLanguage(store.language);
    store.onboardingEntry = null;
    store.onboardingCompleted = true;
  };

  const finish = async () => {
    if (state.finishing) return;
    state.finishing = true;
    state.finishError = '';
    const failures: string[] = [];
    try {
      await ipcRenderer.invoke('complete-onboarding', {
        language: state.language,
        defaultBackupPath: state.backupPath,
        usageMode: state.mode ?? 'local',
      });
      state.saved = true;

      type Known = { name: string; host: string; port: number; connectionString?: string };
      let existing: Known[] = (await ipcRenderer.invoke('get-config'))?.databases || [];
      const isLocalHost = (host: string) => ['localhost', '127.0.0.1', '::1'].includes(host);

      if (state.mode === 'local') {
        const port = state.env?.server.port ?? 5432;
        for (const name of state.selectedLocal) {
          if (existing.some(db => db.name === name && isLocalHost(db.host))) continue;
          try {
            await ipcRenderer.invoke('add-database', {
              name,
              displayName: name,
              host: 'localhost',
              port,
              // The main process swaps this for the OS user's role when it does not exist
              user: state.env?.server.role || 'postgres',
              password: '',
              output: state.backupPath,
              cron: '0 0 * * *',
              enabled: false,
              encryptBackups: false,
              ssl: false,
              encrypted: false,
              isLocalBbdump: true,
            });
          } catch (error) {
            console.error(`Failed to import ${name}:`, error);
            failures.push(name);
          }
        }
      }

      const parsed = remoteActive.value ? remoteParsed.value : null;
      if (parsed) {
        // Includes the local databases just imported (the same database pasted as a URL)
        existing = (await ipcRenderer.invoke('get-config'))?.databases || [];
        const url = state.remote.url.trim();
        const duplicate = existing.some(db =>
          db.connectionString === url
          || (db.host === parsed.host && db.port === parsed.port && db.name === parsed.database));
        if (!duplicate) {
          try {
            await ipcRenderer.invoke('add-database', {
              name: parsed.database,
              displayName: parsed.database,
              host: parsed.host,
              port: parsed.port,
              user: parsed.user,
              password: parsed.password,
              connectionString: url,
              output: state.backupPath,
              cron: '0 0 * * *',
              enabled: false,
              encryptBackups: false,
              verifyBackups: true,
              ssl: ['require', 'verify-ca', 'verify-full'].includes(state.remote.sslMode),
              sslMode: state.remote.sslMode,
              sslRootCert: state.remote.sslMode === 'disable' ? undefined : state.remote.sslRootCert,
            });
          } catch (error) {
            console.error(`Failed to add ${parsed.database}:`, error);
            failures.push(parsed.database);
          }
        }
      }

      const fresh = await ipcRenderer.invoke('get-config');
      store.databases = fresh?.databases || [];
      store.projects = fresh?.projects || [];

      if (failures.length) {
        state.finishError = t('onboarding.ready.addFailed', { names: failures.join(', ') });
        return;
      }
      done();
    } catch (error) {
      state.finishError = describeError(error);
    } finally {
      state.finishing = false;
    }
  };

  return {
    state,
    step,
    serverReady,
    recommendedMode,
    clientToolsReady,
    remoteParsed,
    remoteInvalid,
    remoteActive,
    canContinue,
    selectLanguage,
    loadInitial,
    loadEnvironment,
    goToStep,
    next,
    back,
    getPlan,
    install,
    listenProgress,
    discoverLocal,
    testRemote,
    chooseFolder,
    finish,
    done,
    canCancel,
    cancel,
  };
}

export type Onboarding = ReturnType<typeof createOnboarding>;

const KEY: InjectionKey<Onboarding> = Symbol('onboarding');

/** Creates the state (shell only) and shares it with the steps. */
export function provideOnboarding(): Onboarding {
  const onboarding = createOnboarding();
  provide(KEY, onboarding);
  return onboarding;
}

export function useOnboarding(): Onboarding {
  const onboarding = inject(KEY);
  if (!onboarding) throw new Error('useOnboarding() outside the onboarding shell');
  return onboarding;
}

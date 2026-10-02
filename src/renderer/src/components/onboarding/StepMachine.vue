<script setup lang="ts">
import { computed } from 'vue';
import type { SetupComponent, SetupTool } from '../../../../types/setup';
import { useI18n } from '../../composables/useI18n';
import { useOnboarding } from './useOnboarding';
import StepHeader from './StepHeader.vue';
import SetupRow from './SetupRow.vue';
import CommandDisclosure from './CommandDisclosure.vue';
import InstallAction from './InstallAction.vue';

const { t } = useI18n();
const { state, serverReady, loadEnvironment } = useOnboarding();

const env = computed(() => state.env);
const isMac = computed(() => env.value?.os === 'macos');
const isLinux = computed(() => env.value?.os === 'linux');
const local = computed(() => state.mode === 'local');
// The server install brings the client tools on every platform (Debian postgresql ->
// postgresql-client, Fedora/SUSE postgresql-server -> postgresql, Arch/Homebrew one package)
const toolsComeWithServer = computed(() => local.value && !env.value?.server.installed);

const machineLabel = computed(() => {
  if (!env.value) return '';
  const { os, arch, osLabel } = env.value;
  const archLabel = os === 'macos'
    ? (arch === 'arm64' ? 'Apple Silicon' : 'Intel')
    : arch === 'arm64' ? 'ARM64' : arch === 'x64' ? 'x86-64' : arch;
  return `${osLabel} · ${archLabel}`;
});

const packageManagerLabel = computed(() => {
  const id = env.value?.packageManager?.id;
  if (!id) return '';
  return { brew: 'Homebrew', apt: 'apt', dnf: 'dnf', yum: 'yum', pacman: 'pacman', zypper: 'zypper', winget: 'winget' }[id];
});

const needsHomebrew = computed(() => {
  if (!isMac.value || env.value?.homebrew?.installed) return false;
  return !env.value?.clientTools.ready || (local.value && !serverReady.value);
});

const tools = computed(() => {
  const ct = env.value?.clientTools;
  if (!ct) return [];
  return ([['pg_dump', ct.pgDump], ['psql', ct.psql], ['pg_restore', ct.pgRestore]] as [string, SetupTool][])
    .map(([name, tool]) => ({ name, ...tool }));
});

const toolsDetail = computed(() => {
  if (env.value?.clientTools.ready) {
    return tools.value.map(tool => (tool.version ? `${tool.name} ${tool.version}` : tool.name)).join(' · ');
  }
  const missing = tools.value.filter(tool => !tool.installed).map(tool => tool.name);
  return t('onboarding.machine.toolsMissing', { tools: missing.join(', ') });
});

const serverStatus = computed(() => {
  const server = env.value?.server;
  if (!server?.installed) return { status: 'missing' as const, detail: t('onboarding.machine.serverNotInstalled'), action: t('onboarding.machine.installServer') };
  const version = server.version ? `PostgreSQL ${server.version}` : 'PostgreSQL';
  if (!server.running) return { status: 'warn' as const, detail: `${version} · ${t('onboarding.machine.serverStopped')}`, action: t('onboarding.machine.startServer') };
  if (!server.canConnect) return { status: 'warn' as const, detail: `${version} · ${t('onboarding.machine.serverNoAccess')}`, action: t('onboarding.machine.fixAccess') };
  const role = server.role ? ` · ${t('onboarding.machine.role', { role: server.role })}` : '';
  return { status: 'ok' as const, detail: `${version} · ${t('onboarding.machine.serverRunning', { port: server.port })}${role}`, action: '' };
});

/** Linux: one graphical password prompt (pkexec). Say it on the button. */
const withPasswordNote = (label: string) => (isLinux.value ? `${label} · ${t('onboarding.machine.passwordOnce')}` : label);

const clientToolsLabel = computed(() =>
  withPasswordNote(isMac.value ? t('onboarding.machine.installWithBrew') : t('onboarding.machine.install')));

/** Automatic install possible here (otherwise the command is the way forward). */
const canAuto = (component: SetupComponent) => {
  if (component === 'homebrew') return true;
  if (needsHomebrew.value) return false;
  return !!env.value?.canAutoInstall;
};


const switchToRemote = () => {
  state.mode = 'remote';
};

const skipCheck = () => {
  state.envSkipped = true;
};
</script>

<template>
  <div>
    <StepHeader
      :eyebrow="t('onboarding.sections.machine')"
      :title="t('onboarding.machine.title')"
      :subtitle="local ? t('onboarding.machine.subtitleLocal') : t('onboarding.machine.subtitleRemote')"
    />

    <!-- Machine identity + re-check -->
    <div class="flex items-center justify-between gap-3 mb-4">
      <div class="min-w-0 flex items-center gap-2 text-xs text-zinc-400">
        <svg class="w-3.5 h-3.5 shrink-0 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 5h16v10H4zM8 19h8M12 15v4" />
        </svg>
        <span v-if="env" class="truncate">
          {{ machineLabel }}<span v-if="packageManagerLabel" class="text-zinc-600"> · {{ packageManagerLabel }}</span>
        </span>
        <span v-else-if="state.envStatus === 'loading'">{{ t('onboarding.machine.analyzing') }}</span>
        <span v-else>{{ t('onboarding.machine.unknown') }}</span>
      </div>
      <button
        type="button"
        class="btn-ghost !px-2.5 !py-1.5 !text-xs shrink-0"
        :disabled="state.envStatus === 'loading' || !!state.installing"
        @click="loadEnvironment"
      >
        <svg class="w-3.5 h-3.5" :class="state.envStatus === 'loading' ? 'animate-spin' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        {{ t('onboarding.recheck') }}
      </button>
    </div>

    <!-- Analysing -->
    <div v-if="state.envStatus === 'loading' && !env" class="rounded-xl border border-zinc-800 divide-y divide-zinc-800/80">
      <div v-for="i in (local ? 2 : 1)" :key="i" class="px-4 py-4 flex items-center gap-3">
        <span class="w-2 h-2 rounded-full bg-zinc-700 animate-pulse" />
        <span class="h-2.5 rounded bg-zinc-800 animate-pulse" :class="i === 1 ? 'w-40' : 'w-56'" />
      </div>
    </div>

    <!-- Analysis failed: say why, and offer a way forward -->
    <div v-else-if="state.envStatus === 'error' && !env" class="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div class="text-sm text-zinc-100">{{ t('onboarding.machine.errorTitle') }}</div>
      <p class="mt-1 text-xs text-zinc-400 break-words">{{ state.envError }}</p>
      <div class="mt-3.5 flex flex-wrap gap-2">
        <button type="button" class="btn-secondary" @click="loadEnvironment">{{ t('onboarding.retry') }}</button>
        <button v-if="!state.envSkipped" type="button" class="btn-ghost !text-xs" @click="skipCheck">{{ t('onboarding.machine.skipCheck') }}</button>
      </div>
      <p v-if="state.envSkipped" class="mt-3 text-xs text-zinc-500">{{ t('onboarding.machine.skipped') }}</p>
    </div>

    <!-- Windows (not supported yet) -->
    <div v-else-if="env && !env.supported" class="space-y-3">
      <div class="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div class="text-sm text-zinc-100">{{ t('onboarding.machine.windowsTitle') }}</div>
        <p class="mt-1 text-xs leading-relaxed text-zinc-400">{{ t('onboarding.machine.windowsDesc') }}</p>
      </div>
      <div class="rounded-xl border border-zinc-800">
        <SetupRow :title="t('onboarding.machine.clientTools')" :detail="toolsDetail" :status="env.clientTools.ready ? 'ok' : 'missing'">
          <template v-if="!env.clientTools.ready">
            <p class="text-xs text-zinc-400">{{ t('onboarding.machine.windowsNoTools') }}</p>
            <CommandDisclosure component="client-tools" />
          </template>
        </SetupRow>
      </div>
      <div v-if="env.clientTools.ready && state.mode !== 'remote'" class="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 p-4">
        <p class="text-xs text-zinc-400">{{ t('onboarding.machine.windowsRemote') }}</p>
        <button type="button" class="btn-secondary shrink-0" @click="switchToRemote">{{ t('onboarding.machine.switchToRemote') }}</button>
      </div>
    </div>

    <!-- macOS / Linux -->
    <div v-else-if="env" class="space-y-3">
      <div class="rounded-xl border border-zinc-800 divide-y divide-zinc-800/80" :class="state.envStatus === 'loading' ? 'opacity-60' : ''">
        <!-- Homebrew first on a Mac without it -->
        <SetupRow
          v-if="needsHomebrew"
          :title="t('onboarding.machine.homebrew')"
          :detail="t('onboarding.machine.homebrewDesc')"
          :status="state.installing === 'homebrew' ? 'busy' : 'missing'"
        >
          <InstallAction component="homebrew" :label="t('onboarding.machine.installHomebrew')" :automatic="true" />
        </SetupRow>

        <!-- Client tools: always needed -->
        <SetupRow
          :title="t('onboarding.machine.clientTools')"
          :detail="toolsDetail"
          :status="state.installing === 'client-tools' ? 'busy' : env.clientTools.ready ? 'ok' : 'missing'"
        >
          <template #aside>
            <span class="text-[11px] text-zinc-600">{{ t('onboarding.machine.required') }}</span>
          </template>
          <!-- Local mode with no server yet: the server packages bring the client tools
               (one install, one password prompt on Linux) -->
          <p v-if="!env.clientTools.ready && toolsComeWithServer" class="text-[11px] text-zinc-500">
            {{ t('onboarding.machine.includedWithServer') }}
          </p>
          <InstallAction
            v-else-if="!env.clientTools.ready"
            component="client-tools"
            :label="clientToolsLabel"
            :automatic="canAuto('client-tools')"
            :manual-hint="needsHomebrew ? t('onboarding.machine.homebrewFirst') : t('onboarding.machine.runInTerminal')"
            :blocked="needsHomebrew"
          />
        </SetupRow>

        <!-- Local server: only in local mode -->
        <SetupRow
          v-if="local"
          :title="t('onboarding.machine.server')"
          :detail="serverStatus.detail"
          :status="state.installing === 'server' ? 'busy' : serverStatus.status"
        >
          <template #aside>
            <span v-if="env.server.serviceName" class="font-mono text-[10px] text-zinc-600 truncate">{{ env.server.serviceName }}</span>
          </template>
          <InstallAction
            v-if="!serverReady"
            component="server"
            :label="withPasswordNote(serverStatus.action)"
            :automatic="canAuto('server')"
            :manual-hint="needsHomebrew ? t('onboarding.machine.homebrewFirst') : t('onboarding.machine.runInTerminal')"
            :blocked="needsHomebrew"
          />
        </SetupRow>
      </div>

      <!-- Local mode without a working server: a choice, not a dead end -->
      <div
        v-if="local && !serverReady && state.installing !== 'server'"
        class="flex items-start gap-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-4"
      >
        <div class="flex-1 min-w-0">
          <div class="text-sm text-zinc-100">{{ t('onboarding.machine.serverMissingTitle') }}</div>
          <p class="mt-1 text-xs leading-relaxed text-zinc-400">{{ t('onboarding.machine.serverMissingDesc') }}</p>
        </div>
        <button type="button" class="btn-secondary shrink-0" @click="switchToRemote">{{ t('onboarding.machine.switchToRemote') }}</button>
      </div>

      <p v-if="!env.clientTools.ready && !state.installing && !toolsComeWithServer" class="text-xs text-zinc-500">{{ t('onboarding.machine.toolsRequired') }}</p>
    </div>
  </div>
</template>

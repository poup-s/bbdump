<script setup lang="ts">
import { watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { useOnboarding } from './useOnboarding';
import SslOptions from '../SslOptions.vue';

const { t } = useI18n();
const { state, remoteParsed, remoteInvalid, testRemote } = useOnboarding();

// The URL's own ?sslmode= wins; any change invalidates the previous test
watch(remoteParsed, parsed => {
  if (parsed?.sslMode) state.remote.sslMode = parsed.sslMode;
  if (parsed?.sslRootCert) state.remote.sslRootCert = parsed.sslRootCert;
});
watch(
  () => [state.remote.url, state.remote.sslMode, state.remote.sslRootCert],
  () => {
    if (state.remote.test !== 'testing') {
      state.remote.test = 'idle';
      state.remote.error = '';
    }
  },
);
</script>

<template>
  <div class="space-y-4">
    <div>
      <label for="onboarding-remote-url" class="block text-xs font-medium text-zinc-400 mb-1.5">{{ t('onboarding.databases.url') }}</label>
      <input
        id="onboarding-remote-url"
        v-model="state.remote.url"
        type="text"
        autocomplete="off"
        spellcheck="false"
        :placeholder="t('onboarding.databases.urlPlaceholder')"
        class="w-full rounded-lg border bg-zinc-900/60 px-3 py-2.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 transition-colors focus:outline-none"
        :class="remoteInvalid ? 'border-red-400/50' : 'border-zinc-800 focus:border-zinc-600'"
        :aria-invalid="remoteInvalid"
        aria-describedby="onboarding-remote-url-hint"
      />
      <p id="onboarding-remote-url-hint" class="mt-1.5 text-xs" :class="remoteInvalid ? 'text-red-300/90' : 'text-zinc-500'">
        <template v-if="remoteInvalid">{{ t('onboarding.databases.urlInvalid') }}</template>
        <template v-else-if="remoteParsed">
          <span class="font-mono text-zinc-400">{{ remoteParsed.host }}:{{ remoteParsed.port }}/{{ remoteParsed.database }}</span>
          · {{ remoteParsed.user }}
        </template>
        <template v-else>{{ t('onboarding.databases.urlHint') }}</template>
      </p>
    </div>

    <div v-if="remoteParsed" class="ssl rounded-lg border border-zinc-800 bg-zinc-900/30 p-3.5">
      <SslOptions v-model:ssl-mode="state.remote.sslMode" v-model:ssl-root-cert="state.remote.sslRootCert" />
    </div>

    <div v-if="remoteParsed" class="flex flex-wrap items-center gap-3">
      <button type="button" class="btn-secondary" :disabled="state.remote.test === 'testing'" @click="testRemote">
        <span v-if="state.remote.test === 'testing'" class="w-3 h-3 rounded-full border-2 border-zinc-600 border-t-zinc-200 animate-spin" />
        {{ state.remote.test === 'testing' ? t('onboarding.databases.testing') : t('onboarding.databases.test') }}
      </button>
      <span v-if="state.remote.test === 'ok'" class="inline-flex items-center gap-1.5 text-xs text-emerald-400" role="status">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
        {{ state.remote.tables !== null ? t('onboarding.databases.testOkTables', { count: state.remote.tables }) : t('onboarding.databases.testOk') }}
      </span>
      <span v-else-if="state.remote.test === 'idle'" class="text-xs text-zinc-500">{{ t('onboarding.databases.testAdvice') }}</span>
    </div>

    <div v-if="state.remote.test === 'error'" class="rounded-lg border border-red-400/20 bg-red-400/[0.04] p-3" role="alert">
      <p class="text-xs text-red-200/90 break-words">{{ state.remote.error }}</p>
      <p class="mt-1 text-xs text-zinc-500">{{ t('onboarding.databases.testErrorHint') }}</p>
    </div>
  </div>
</template>

<style scoped>
/* SslOptions uses the app's form styles: align them with the onboarding */
.ssl :deep(label) {
  color: #a1a1aa;
  font-size: 0.75rem;
}
.ssl :deep(select) {
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
  background: rgba(24, 24, 27, 0.6);
  border-color: #27272a;
  color: #e4e4e7;
}
.ssl :deep(select:focus) {
  --tw-ring-color: rgba(16, 185, 129, 0.3);
  border-color: #52525b;
}
.ssl :deep(button) {
  border-radius: 0.5rem;
  font-size: 0.75rem;
}
</style>

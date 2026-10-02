<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '../composables/useI18n';
import { ipcRenderer } from '../electron';
import type { SslMode } from '../types';
import FormField from './ui/FormField.vue';
import { btnSecondary, selectClass } from './ui/classes';

const { t } = useI18n();

const sslMode = defineModel<SslMode>('sslMode', { default: 'disable' });
const sslRootCert = defineModel<string | undefined>('sslRootCert');

const modes: SslMode[] = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'];

const needsCertificate = computed(() => sslMode.value === 'verify-ca' || sslMode.value === 'verify-full');
const canUseCertificate = computed(() => sslMode.value !== 'disable');

const certificateName = computed(() => sslRootCert.value?.split(/[\\/]/).pop() || '');

const chooseCertificate = async () => {
  const path = await ipcRenderer.invoke('select-ssl-root-cert');
  if (path) {
    sslRootCert.value = path;
  }
};
</script>

<template>
  <div class="space-y-3">
    <FormField :label="t('database.sslMode')" for="ssl-mode">
      <select id="ssl-mode" v-model="sslMode" :class="selectClass">
        <option v-for="mode in modes" :key="mode" :value="mode">{{ mode }} — {{ t(`database.sslModes.${mode}`) }}</option>
      </select>
    </FormField>

    <FormField
      v-if="canUseCertificate"
      :label="t('database.sslRootCert')"
      :optional="needsCertificate ? undefined : t('common.optional')"
      :hint="t('database.sslRootCertHint')"
    >
      <div class="flex items-center gap-2 min-w-0">
        <button type="button" :class="btnSecondary" class="shrink-0" @click="chooseCertificate">
          {{ t('database.chooseCertificate') }}
        </button>
        <span v-if="sslRootCert" class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px] text-gray-600 dark:text-zinc-400" :title="sslRootCert">{{ certificateName }}</span>
        <button
          v-if="sslRootCert"
          type="button"
          class="shrink-0 text-[11px] text-gray-400 hover:text-red-500 transition-colors"
          @click="sslRootCert = undefined"
        >
          {{ t('database.clearCertificate') }}
        </button>
      </div>
    </FormField>
  </div>
</template>

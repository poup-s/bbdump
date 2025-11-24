<script setup lang="ts">
import { store } from '../store';
import { useI18n } from '../composables/useI18n';

const { t } = useI18n();
</script>

<template>
  <div class="h-full flex flex-col items-center justify-center text-center">
    <div class="w-32 h-32 bg-foreground text-background rounded-3xl flex items-center justify-center mb-8 shadow-2xl rotate-3 hover:rotate-0 transition-transform duration-500">
      <img src="/logo.png" alt="logo" class="w-32 h-32 rounded-3xl shadow-2xl"/>
    </div>
    
    <h1 class="text-4xl font-bold tracking-tight mb-2">bbdump</h1>
    <p class="text-xl text-gray-500 mb-8">Modern PostgreSQL Backup Manager</p>
    
    <div class="bg-white dark:bg-zinc-900 rounded-2xl p-8 border border-border shadow-sm max-w-md w-full">
      <div class="space-y-4">
        <div class="flex justify-between items-center py-2 border-b border-border">
          <span class="text-gray-500">{{ t('about.version') }}</span>
          <span class="font-mono font-medium">{{ store.appVersion }}</span>
        </div>
        <div class="flex justify-between items-center py-2 border-b border-border">
          <span class="text-gray-500">{{ t('about.author') }}</span>
          <span class="font-medium">{{ store.appAuthor }}</span>
        </div>
        <div class="flex justify-between items-center py-2 border-b border-border">
          <span class="text-gray-500">{{ t('about.license') }}</span>
          <span class="font-medium">MIT</span>
        </div>
        <div class="flex justify-between items-center py-2">
          <span class="text-gray-500">Electron</span>
          <span class="font-mono text-sm">v28.0.0</span>
        </div>
      </div>
    </div>

    <div class="mt-12 text-sm text-gray-400">
      &copy; {{ new Date().getFullYear() }} bbdump. All rights reserved.
    </div>
  </div>
</template>

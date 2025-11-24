<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { ipcRenderer } from '../electron';

const { t, setLanguage } = useI18n();

const step = ref(1); // 1: Language, 2: Path
const selectedLang = ref<'en' | 'fr'>('en');
const selectedPath = ref('');
const isLoading = ref(false);

onMounted(async () => {
  try {
    const defaultPath = await ipcRenderer.invoke('get-default-path');
    selectedPath.value = defaultPath;
  } catch (e) {
    console.error(e);
  }
});

const selectLanguage = (lang: 'en' | 'fr') => {
  selectedLang.value = lang;
  setLanguage(lang);
};

const selectPath = async () => {
  const path = await ipcRenderer.invoke('select-directory');
  if (path) {
    selectedPath.value = path;
  }
};

const nextStep = () => {
  step.value = 2;
};

const finishOnboarding = async () => {
  isLoading.value = true;
  try {
    await ipcRenderer.invoke('complete-onboarding', {
      language: selectedLang.value,
      defaultBackupPath: selectedPath.value
    });
    store.onboardingCompleted = true;
    store.language = selectedLang.value;
  } catch (error) {
    console.error('Failed to complete onboarding:', error);
  } finally {
    isLoading.value = false;
  }
};
</script>

<template>
  <div class="fixed inset-0 z-50 bg-zinc-950 text-white overflow-hidden flex flex-col items-center justify-center">
    <!-- Background Pattern -->
    <div class="absolute inset-0 z-0 opacity-20">
      <div class="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]"></div>
    </div>

    <!-- Content -->
    <div class="relative z-10 w-full max-w-lg mx-4">
      <div class="bg-zinc-900/50 backdrop-blur-xl p-8 rounded-3xl border border-white/10 shadow-2xl">
        
        <!-- Logo -->
        <div class="flex justify-center mb-8">
          <div class="w-32 h-32 bg-foreground text-background rounded-3xl flex items-center justify-center shadow-2xl rotate-3 hover:rotate-0 transition-transform duration-500 bg-white dark:bg-zinc-800">
            <img src="/logo.png" alt="logo" class="w-32 h-32 rounded-3xl shadow-2xl"/>
          </div>
        </div>

        <!-- Step 1: Language -->
        <div v-if="step === 1" class="text-center space-y-8">
          <h1 class="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-gray-400">
            Welcome to bbdump
          </h1>
          <p class="text-gray-400 text-lg">Choose your language / Choisissez votre langue</p>
          
          <div class="flex justify-center gap-6">
            <button 
              @click="selectLanguage('en')"
              :class="[
                'px-8 py-4 rounded-2xl border transition-all duration-300 flex flex-col items-center gap-2 min-w-[120px]',
                selectedLang === 'en' 
                  ? 'bg-white text-black border-white scale-105 shadow-xl shadow-white/20' 
                  : 'bg-zinc-800/50 text-gray-400 border-white/10 hover:border-white/30 hover:text-white hover:bg-zinc-800'
              ]"
            >
              <span class="text-2xl">🇺🇸</span>
              <span class="font-medium">English</span>
            </button>
            
            <button 
              @click="selectLanguage('fr')"
              :class="[
                'px-8 py-4 rounded-2xl border transition-all duration-300 flex flex-col items-center gap-2 min-w-[120px]',
                selectedLang === 'fr' 
                  ? 'bg-white text-black border-white scale-105 shadow-xl shadow-white/20' 
                  : 'bg-zinc-800/50 text-gray-400 border-white/10 hover:border-white/30 hover:text-white hover:bg-zinc-800'
              ]"
            >
              <span class="text-2xl">🇫🇷</span>
              <span class="font-medium">Français</span>
            </button>
          </div>

          <button 
            @click="nextStep"
            class="w-full py-4 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-xl font-bold text-lg hover:shadow-lg hover:shadow-indigo-500/30 transition-all active:scale-95"
          >
            Continue
          </button>
        </div>

        <!-- Step 2: Path -->
        <div v-if="step === 2" class="text-center space-y-8">
          <h1 class="text-3xl font-bold">
            {{ t('onboarding.backupLocation') || 'Backup Location' }}
          </h1>
          <p class="text-gray-400">
            {{ t('onboarding.backupLocationDesc') || 'Where should we store your database backups?' }}
          </p>
          
          <div class="bg-zinc-800/50 p-4 rounded-xl border border-white/10 flex items-center gap-3 text-left hover:border-white/20 transition-colors">
            <div class="p-2 bg-indigo-500/20 rounded-lg text-indigo-400">
              <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-xs text-gray-500 uppercase tracking-wider font-bold">Selected Path</div>
              <div class="text-sm font-mono truncate text-gray-300" :title="selectedPath">{{ selectedPath }}</div>
            </div>
            <button 
              @click="selectPath"
              class="p-2 hover:bg-white/10 rounded-lg transition-colors text-gray-400 hover:text-white"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </button>
          </div>

          <button 
            @click="finishOnboarding"
            :disabled="isLoading"
            class="w-full py-4 bg-white text-black rounded-xl font-bold text-lg hover:shadow-xl hover:shadow-white/20 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <span v-if="isLoading" class="animate-spin rounded-full h-5 w-5 border-b-2 border-black"></span>
            <span>{{ t('onboarding.getStarted') || 'Get Started' }}</span>
          </button>
        </div>

      </div>
    </div>
  </div>
</template>

<style scoped>
/* Ensure canvas takes full space */
canvas {
  width: 100% !important;
  height: 100% !important;
}
</style>

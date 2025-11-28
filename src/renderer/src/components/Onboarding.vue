<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { ipcRenderer } from '../electron';
import PrerequisitesLoader from './PrerequisitesLoader.vue';

const { t, setLanguage } = useI18n();

const step = ref(1); // 1: Language, 2: Prerequisites, 3: Path
const selectedLang = ref<'en' | 'fr'>('en');
const selectedPath = ref('');
const isLoading = ref(false);
const checkingPrerequisites = ref(false);
const prerequisites = ref<{
  pgDump: { installed: boolean; path?: string; error?: string };
  psql: { installed: boolean; path?: string; error?: string };
  homebrew: { installed: boolean; path?: string; error?: string };
  postgresServer: { installed: boolean; version?: string; hasServer?: boolean; error?: string };
} | null>(null);

const installing = ref<{
  homebrew: boolean;
  postgresql: boolean;
}>({
  homebrew: false,
  postgresql: false
});

const installProgress = ref<{ step: string; message: string; progress: number } | null>(null);

// État des accordéons
const expandedSections = ref<{
  required: boolean;
  optional: boolean;
}>({
  required: false,
  optional: false
});

// Étapes de vérification
const verificationSteps = ref<Array<{ name: string; status: 'pending' | 'checking' | 'done' | 'error' }>>([
  { name: 'pg_dump', status: 'pending' },
  { name: 'psql', status: 'pending' },
  { name: 'homebrew', status: 'pending' },
  { name: 'postgresServer', status: 'pending' }
]);

const currentStep = computed(() => {
  return verificationSteps.value.findIndex(s => s.status === 'checking' || s.status === 'pending');
});

const progressPercentage = computed(() => {
  const done = verificationSteps.value.filter(s => s.status === 'done').length;
  return (done / verificationSteps.value.length) * 100;
});

onMounted(async () => {
  try {
    const defaultPath = await ipcRenderer.invoke('get-default-path');
    selectedPath.value = defaultPath;
  } catch (e) {
    console.error(e);
  }

  // Écouter les événements de progression d'installation
  ipcRenderer.on('install-progress', (_, progress: { step: string; message: string; progress: number }) => {
    installProgress.value = progress;
  });
});

onUnmounted(() => {
  ipcRenderer.removeAllListeners('install-progress');
});

const selectLanguage = (lang: 'en' | 'fr') => {
  selectedLang.value = lang;
  setLanguage(lang);
};

const nextStep = async () => {
  if (step.value === 1) {
    step.value = 2;
    await checkPrerequisites();
  } else if (step.value === 2) {
    step.value = 3;
  }
};

const checkPrerequisites = async () => {
  checkingPrerequisites.value = true;
  
  // Réinitialiser les étapes
  verificationSteps.value.forEach(s => s.status = 'pending');
  
  try {
    // Vérifier pg_dump
    verificationSteps.value[0].status = 'checking';
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Vérifier psql
    verificationSteps.value[1].status = 'checking';
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Vérifier homebrew
    verificationSteps.value[2].status = 'checking';
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Vérifier postgresServer
    verificationSteps.value[3].status = 'checking';
    await new Promise(resolve => setTimeout(resolve, 300));
    
    const result = await ipcRenderer.invoke('check-prerequisites');
    prerequisites.value = result;
    
    // Mettre à jour les statuts
    verificationSteps.value[0].status = result.pgDump.installed ? 'done' : 'error';
    verificationSteps.value[1].status = result.psql.installed ? 'done' : 'error';
    verificationSteps.value[2].status = result.homebrew?.installed ? 'done' : 'pending';
    verificationSteps.value[3].status = result.postgresServer.installed && result.postgresServer.hasServer ? 'done' : 'pending';
    
    // Ouvrir automatiquement les sections avec des erreurs
    if (!result.pgDump.installed || !result.psql.installed) {
      expandedSections.value.required = true;
    }
    if (result.homebrew && !result.homebrew.installed) {
      expandedSections.value.optional = true;
    }
  } catch (error) {
    console.error('Failed to check prerequisites:', error);
    verificationSteps.value.forEach(s => {
      if (s.status === 'checking') s.status = 'error';
    });
  } finally {
    checkingPrerequisites.value = false;
  }
};

const selectPath = async () => {
  const path = await ipcRenderer.invoke('select-directory');
  if (path) {
    selectedPath.value = path;
  }
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

const canProceedFromPrerequisites = () => {
  if (!prerequisites.value) return false;
  return prerequisites.value.pgDump.installed && prerequisites.value.psql.installed;
};

const installHomebrew = async () => {
  if (installing.value.homebrew) return;
  
  installing.value.homebrew = true;
  installProgress.value = { step: 'starting', message: 'Starting Homebrew installation...', progress: 0 };
  expandedSections.value.optional = true;
  
  try {
    const result = await ipcRenderer.invoke('install-homebrew');
    if (result.success) {
      verificationSteps.value[2].status = 'done';
      await checkPrerequisites();
    } else {
      verificationSteps.value[2].status = 'error';
      alert(result.error || 'Failed to install Homebrew');
    }
  } catch (error: any) {
    verificationSteps.value[2].status = 'error';
    alert('Error installing Homebrew: ' + error.message);
  } finally {
    installing.value.homebrew = false;
    installProgress.value = null;
  }
};

const installPostgreSQL = async () => {
  if (installing.value.postgresql) return;
  
  installing.value.postgresql = true;
  installProgress.value = { step: 'starting', message: 'Starting PostgreSQL installation...', progress: 0 };
  expandedSections.value.required = true;
  if (prerequisites.value && !prerequisites.value.pgDump.installed) {
    verificationSteps.value[0].status = 'checking';
  }
  if (prerequisites.value && !prerequisites.value.psql.installed) {
    verificationSteps.value[1].status = 'checking';
  }
  
  try {
    const result = await ipcRenderer.invoke('install-postgresql');
    if (result.success) {
      verificationSteps.value[0].status = 'done';
      verificationSteps.value[1].status = 'done';
      verificationSteps.value[3].status = 'done';
      await checkPrerequisites();
    } else {
      verificationSteps.value[0].status = 'error';
      verificationSteps.value[1].status = 'error';
      alert(result.error || 'Failed to install PostgreSQL');
    }
  } catch (error: any) {
    verificationSteps.value[0].status = 'error';
    verificationSteps.value[1].status = 'error';
    alert('Error installing PostgreSQL: ' + error.message);
  } finally {
    installing.value.postgresql = false;
    installProgress.value = null;
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
    <div class="relative z-10 w-full max-w-lg mx-4 px-2 sm:px-4">
      <div class="bg-zinc-900/50 backdrop-blur-xl p-4 sm:p-6 md:p-8 rounded-2xl sm:rounded-3xl border border-white/10 shadow-2xl">
        
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
            {{ t('onboarding.continue') || 'Continue' }}
          </button>
        </div>

        <!-- Step 2: Prerequisites Check -->
        <div v-if="step === 2" class="space-y-4">
          <div class="text-center space-y-2">
            <h1 class="text-xl sm:text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-gray-400">
              {{ t('onboarding.prerequisitesTitle') || 'Vérification du système' }}
            </h1>
            <p class="text-gray-400 text-xs sm:text-sm">
              {{ t('onboarding.prerequisitesDesc') || 'Nous vérifions que tout est prêt pour commencer...' }}
            </p>
          </div>

          <!-- 3D Loader with Steps -->
          <div v-if="checkingPrerequisites || !prerequisites" class="relative">
            <PrerequisitesLoader />
            
            <!-- Progress Steps Overlay -->
            <div class="absolute bottom-3 left-0 right-0 px-3">
              <div class="bg-zinc-900/90 backdrop-blur-sm rounded-lg p-2.5 border border-white/10">
                <!-- Progress Bar -->
                <div class="mb-2">
                  <div class="flex justify-between items-center mb-1">
                    <span class="text-xs text-gray-400">{{ Math.round(progressPercentage) }}%</span>
                    <span class="text-xs text-gray-400">{{ verificationSteps.filter(s => s.status === 'done').length }}/{{ verificationSteps.length }}</span>
                  </div>
                  <div class="w-full h-1 bg-zinc-700 rounded-full overflow-hidden">
                    <div 
                      class="h-full bg-gradient-to-r from-indigo-500 to-purple-600 transition-all duration-300 rounded-full"
                      :style="{ width: `${progressPercentage}%` }"
                    ></div>
                  </div>
                </div>
                
                <!-- Steps List -->
                <div class="space-y-1">
                  <div 
                    v-for="(step, index) in verificationSteps" 
                    :key="step.name"
                    class="flex items-center gap-1.5 text-xs"
                  >
                    <div class="w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0"
                         :class="{
                           'bg-indigo-500/30': step.status === 'checking',
                           'bg-green-500/30': step.status === 'done',
                           'bg-orange-500/30': step.status === 'error',
                           'bg-zinc-700': step.status === 'pending'
                         }">
                      <svg v-if="step.status === 'done'" class="w-2 h-2 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                      </svg>
                      <div v-else-if="step.status === 'checking'" class="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-pulse"></div>
                      <div v-else-if="step.status === 'error'" class="w-1.5 h-1.5 bg-orange-400 rounded-full"></div>
                    </div>
                    <span class="text-gray-300 capitalize text-xs" :class="{ 'text-gray-500': step.status === 'pending' }">
                      {{ step.name === 'postgresServer' ? 'PostgreSQL Server' : step.name }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Results -->
          <div v-else-if="prerequisites" class="space-y-2">
            <!-- Success Message if all required are installed -->
            <div v-if="canProceedFromPrerequisites()" class="bg-gradient-to-r from-green-500/10 to-emerald-500/10 border border-green-500/30 rounded-lg p-3">
              <div class="flex items-center gap-2">
                <div class="w-8 h-8 rounded-lg bg-green-500/20 flex items-center justify-center shrink-0">
                  <svg class="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="font-semibold text-green-300 text-sm">{{ t('onboarding.allReady') || 'Tout est prêt !' }}</div>
                  <div class="text-xs text-green-400/80">{{ t('onboarding.allReadyDesc') || 'Vous pouvez commencer à utiliser bbdump dès maintenant.' }}</div>
                </div>
              </div>
            </div>

            <!-- Required Tools Accordion -->
            <div class="bg-zinc-800/30 rounded-lg border border-zinc-700/30 overflow-hidden">
              <button
                @click="expandedSections.required = !expandedSections.required"
                class="w-full flex items-center justify-between p-3 hover:bg-zinc-800/50 transition-colors"
              >
                <div class="flex items-center gap-2">
                  <div class="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
                       :class="prerequisites.pgDump.installed && prerequisites.psql.installed ? 'bg-green-500/20' : 'bg-orange-500/20'">
                    <svg v-if="prerequisites.pgDump.installed && prerequisites.psql.installed" class="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                    </svg>
                    <svg v-else class="w-3.5 h-3.5 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <span class="font-medium text-sm text-white">{{ t('onboarding.requiredTools') || 'Outils requis' }}</span>
                  <span class="text-xs text-gray-400 ml-2">
                    ({{ [prerequisites.pgDump.installed, prerequisites.psql.installed].filter(Boolean).length }}/2)
                  </span>
                </div>
                <svg 
                  class="w-4 h-4 text-gray-400 transition-transform duration-200"
                  :class="{ 'rotate-180': expandedSections.required }"
                  fill="none" viewBox="0 0 24 24" stroke="currentColor"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              
              <div v-show="expandedSections.required" class="border-t border-zinc-700/30 divide-y divide-zinc-700/30">
                <!-- pg_dump -->
                <div class="p-3 flex items-center justify-between gap-3">
                  <div class="flex items-center gap-2 flex-1 min-w-0">
                    <div class="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
                         :class="prerequisites.pgDump.installed ? 'bg-green-500/20' : 'bg-orange-500/20'">
                      <svg v-if="prerequisites.pgDump.installed" class="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                      </svg>
                      <svg v-else class="w-3.5 h-3.5 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="font-medium text-white text-sm">{{ t('onboarding.toolPgDump') || 'pg_dump' }}</div>
                      <div class="text-xs text-gray-400 truncate">{{ t('onboarding.prereqPgDump') || 'Pour créer des sauvegardes' }}</div>
                    </div>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <div v-if="prerequisites.pgDump.installed" class="px-2 py-1 bg-green-500/20 text-green-400 rounded text-xs font-medium">
                      {{ t('onboarding.installed') || 'Installé' }}
                    </div>
                    <button
                      v-else-if="!installing.postgresql"
                      @click="installPostgreSQL"
                      class="px-3 py-1.5 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 rounded text-xs font-medium transition-all active:scale-95 whitespace-nowrap"
                    >
                      {{ t('onboarding.install') || 'Installer' }}
                    </button>
                    <div v-else-if="installing.postgresql" class="px-3 py-1.5 bg-indigo-500/50 rounded text-xs font-medium flex items-center gap-1.5">
                      <div class="animate-spin rounded-full h-2.5 w-2.5 border-2 border-white border-t-transparent"></div>
                      <span class="hidden sm:inline text-xs">{{ installProgress?.message || t('onboarding.installing') || 'Installation...' }}</span>
                      <span class="sm:hidden text-xs">{{ t('onboarding.installing') || 'Installation...' }}</span>
                    </div>
                  </div>
                </div>

                <!-- psql -->
                <div class="p-3 flex items-center justify-between gap-3">
                  <div class="flex items-center gap-2 flex-1 min-w-0">
                    <div class="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
                         :class="prerequisites.psql.installed ? 'bg-green-500/20' : 'bg-orange-500/20'">
                      <svg v-if="prerequisites.psql.installed" class="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                      </svg>
                      <svg v-else class="w-3.5 h-3.5 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="font-medium text-white text-sm">{{ t('onboarding.toolPsql') || 'psql' }}</div>
                      <div class="text-xs text-gray-400 truncate">{{ t('onboarding.prereqPsql') || 'Pour se connecter aux bases de données' }}</div>
                    </div>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <div v-if="prerequisites.psql.installed" class="px-2 py-1 bg-green-500/20 text-green-400 rounded text-xs font-medium">
                      {{ t('onboarding.installed') || 'Installé' }}
                    </div>
                    <button
                      v-else-if="!installing.postgresql"
                      @click="installPostgreSQL"
                      class="px-3 py-1.5 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 rounded text-xs font-medium transition-all active:scale-95 whitespace-nowrap"
                    >
                      {{ t('onboarding.install') || 'Installer' }}
                    </button>
                    <div v-else-if="installing.postgresql" class="px-3 py-1.5 bg-indigo-500/50 rounded text-xs font-medium flex items-center gap-1.5">
                      <div class="animate-spin rounded-full h-2.5 w-2.5 border-2 border-white border-t-transparent"></div>
                      <span class="hidden sm:inline text-xs">{{ installProgress?.message || t('onboarding.installing') || 'Installation...' }}</span>
                      <span class="sm:hidden text-xs">{{ t('onboarding.installing') || 'Installation...' }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Optional Tools Accordion -->
            <div v-if="prerequisites.homebrew || prerequisites.postgresServer" class="bg-zinc-800/30 rounded-lg border border-zinc-700/30 overflow-hidden">
              <button
                @click="expandedSections.optional = !expandedSections.optional"
                class="w-full flex items-center justify-between p-3 hover:bg-zinc-800/50 transition-colors"
              >
                <div class="flex items-center gap-2">
                  <div class="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 bg-blue-500/10">
                    <svg class="w-3.5 h-3.5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <span class="font-medium text-sm text-gray-300">{{ t('onboarding.optionalTools') || 'Outils optionnels' }}</span>
                  <span class="text-xs text-gray-500 ml-2">({{ t('onboarding.forLocalDb') || 'pour créer des bases locales' }})</span>
                </div>
                <svg 
                  class="w-4 h-4 text-gray-400 transition-transform duration-200"
                  :class="{ 'rotate-180': expandedSections.optional }"
                  fill="none" viewBox="0 0 24 24" stroke="currentColor"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              
              <div v-show="expandedSections.optional" class="border-t border-zinc-700/30 divide-y divide-zinc-700/30">
                <!-- Homebrew (macOS only) -->
                <div v-if="prerequisites.homebrew" class="p-3 flex items-center justify-between gap-3">
                  <div class="flex items-center gap-2 flex-1 min-w-0">
                    <div class="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 bg-blue-500/10">
                      <svg v-if="prerequisites.homebrew.installed" class="w-3.5 h-3.5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                      </svg>
                      <svg v-else class="w-3.5 h-3.5 text-blue-400/60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="font-medium text-gray-300 text-sm">Homebrew</div>
                      <div class="text-xs text-gray-500 truncate">{{ t('onboarding.prereqHomebrew') || 'Gestionnaire de paquets pour macOS' }}</div>
                    </div>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <div v-if="prerequisites.homebrew.installed" class="px-2 py-1 bg-blue-500/20 text-blue-400 rounded text-xs font-medium">
                      {{ t('onboarding.installed') || 'Installé' }}
                    </div>
                    <button
                      v-else-if="!installing.homebrew"
                      @click="installHomebrew"
                      class="px-3 py-1.5 bg-zinc-700/50 hover:bg-zinc-700 rounded text-xs font-medium transition-all active:scale-95 whitespace-nowrap"
                    >
                      {{ t('onboarding.install') || 'Installer' }}
                    </button>
                    <div v-else-if="installing.homebrew" class="px-3 py-1.5 bg-zinc-700/50 rounded text-xs font-medium flex items-center gap-1.5">
                      <div class="animate-spin rounded-full h-2.5 w-2.5 border-2 border-white border-t-transparent"></div>
                      <span class="hidden sm:inline text-xs">{{ installProgress?.message || t('onboarding.installing') || 'Installation...' }}</span>
                      <span class="sm:hidden text-xs">{{ t('onboarding.installing') || 'Installation...' }}</span>
                    </div>
                  </div>
                </div>

                <!-- PostgreSQL Server -->
                <div class="p-3 flex items-center justify-between gap-3">
                  <div class="flex items-center gap-2 flex-1 min-w-0">
                    <div class="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 bg-blue-500/10">
                      <svg v-if="prerequisites.postgresServer.installed && prerequisites.postgresServer.hasServer" class="w-3.5 h-3.5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                      </svg>
                      <svg v-else class="w-3.5 h-3.5 text-blue-400/60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="font-medium text-gray-300 text-sm">PostgreSQL Server</div>
                      <div class="text-xs text-gray-500 truncate">
                        {{ t('onboarding.prereqPostgresServer') || 'Serveur de base de données local' }}
                        <span v-if="prerequisites.postgresServer.version" class="ml-1 text-blue-400">v{{ prerequisites.postgresServer.version }}</span>
                      </div>
                      <div v-if="installProgress && installing.postgresql" class="mt-1 text-xs text-indigo-400 flex items-center gap-1.5">
                        <div class="animate-spin rounded-full h-2 w-2 border border-indigo-400 border-t-transparent"></div>
                        <span class="truncate">{{ installProgress.message }}</span>
                      </div>
                    </div>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <div v-if="prerequisites.postgresServer.installed && prerequisites.postgresServer.hasServer" class="px-2 py-1 bg-blue-500/20 text-blue-400 rounded text-xs font-medium">
                      {{ t('onboarding.installed') || 'Installé' }}
                    </div>
                    <button
                      v-else-if="!installing.postgresql"
                      @click="installPostgreSQL"
                      class="px-3 py-1.5 bg-zinc-700/50 hover:bg-zinc-700 rounded text-xs font-medium transition-all active:scale-95 whitespace-nowrap"
                    >
                      {{ t('onboarding.install') || 'Installer' }}
                    </button>
                    <div v-else-if="installing.postgresql" class="px-3 py-1.5 bg-zinc-700/50 rounded text-xs font-medium flex items-center gap-1.5">
                      <div class="animate-spin rounded-full h-2.5 w-2.5 border-2 border-white border-t-transparent"></div>
                      <span class="hidden sm:inline text-xs">{{ installProgress?.message || t('onboarding.installing') || 'Installation...' }}</span>
                      <span class="sm:hidden text-xs">{{ t('onboarding.installing') || 'Installation...' }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Helpful Message if required tools missing -->
            <div v-if="!canProceedFromPrerequisites()" class="bg-gradient-to-r from-orange-500/10 to-amber-500/10 border border-orange-500/30 rounded-lg p-2.5">
              <div class="flex items-start gap-2">
                <div class="w-6 h-6 rounded-lg bg-orange-500/20 flex items-center justify-center shrink-0 mt-0.5">
                  <svg class="w-3 h-3 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-xs font-medium text-orange-300 mb-0.5">{{ t('onboarding.needToInstall') || 'Installation nécessaire' }}</div>
                  <div class="text-xs text-orange-400/80 leading-relaxed">{{ t('onboarding.needToInstallDesc') || 'Cliquez sur "Installer" pour installer automatiquement les outils manquants. C\'est rapide et simple !' }}</div>
                </div>
              </div>
            </div>
          </div>

          <div class="flex flex-col sm:flex-row gap-2 sm:gap-3 pt-2">
            <button 
              @click="step = 1"
              class="flex-1 py-2.5 sm:py-3 bg-zinc-800/50 hover:bg-zinc-800 rounded-lg sm:rounded-xl font-medium transition-all text-sm sm:text-base"
            >
              {{ t('common.back') || 'Back' }}
            </button>
            <button 
              @click="nextStep"
              :disabled="!canProceedFromPrerequisites()"
              class="flex-1 py-2.5 sm:py-3 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-lg sm:rounded-xl font-bold hover:shadow-lg hover:shadow-indigo-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-sm sm:text-base"
            >
              {{ t('onboarding.continue') || 'Continue' }}
            </button>
          </div>
        </div>

        <!-- Step 3: Path -->
        <div v-if="step === 3" class="text-center space-y-8">
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

          <div class="flex gap-3">
            <button 
              @click="step = 2"
              class="flex-1 py-3 bg-zinc-800/50 hover:bg-zinc-800 rounded-xl font-medium transition-all"
            >
              {{ t('common.back') || 'Back' }}
            </button>
            <button 
              @click="finishOnboarding"
              :disabled="isLoading"
              class="flex-1 py-3 bg-white text-black rounded-xl font-bold hover:shadow-xl hover:shadow-white/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <span v-if="isLoading" class="animate-spin rounded-full h-5 w-5 border-b-2 border-black"></span>
              <span>{{ t('onboarding.getStarted') || 'Get Started' }}</span>
            </button>
          </div>
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

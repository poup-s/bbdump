<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from '../composables/useI18n';

const { t, currentLanguage } = useI18n();

const props = defineProps<{
  modelValue: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const editMode = ref<'preset' | 'visual' | 'manual'>('preset');
const showAdvanced = ref(false);

// Presets communs
const presets = computed(() => {
  return [
    { label: t('cronEditor.presetEveryMinute'), value: '* * * * *', desc: t('cronEditor.presetDescEveryMinute') },
    { label: t('cronEditor.presetEveryHour'), value: '0 * * * *', desc: t('cronEditor.presetDescEveryHour') },
    { label: t('cronEditor.presetDaily'), value: '0 0 * * *', desc: t('cronEditor.presetDescDaily') },
    { label: t('cronEditor.presetDaily2AM'), value: '0 2 * * *', desc: t('cronEditor.presetDescDaily2AM') },
    { label: t('cronEditor.presetDaily6AM'), value: '0 6 * * *', desc: t('cronEditor.presetDescDaily6AM') },
    { label: t('cronEditor.presetDailyNoon'), value: '0 12 * * *', desc: t('cronEditor.presetDescDailyNoon') },
    { label: t('cronEditor.presetWeekly'), value: '0 0 * * 0', desc: t('cronEditor.presetDescWeekly') },
    { label: t('cronEditor.presetMonthly'), value: '0 0 1 * *', desc: t('cronEditor.presetDescMonthly') },
    { label: t('cronEditor.presetTwiceDaily'), value: '0 0,12 * * *', desc: t('cronEditor.presetDescTwiceDaily') },
    { label: t('cronEditor.presetEvery6Hours'), value: '0 */6 * * *', desc: t('cronEditor.presetDescEvery6Hours') },
    { label: t('cronEditor.presetEvery12Hours'), value: '0 */12 * * *', desc: t('cronEditor.presetDescEvery12Hours') },
    { label: t('cronEditor.presetWeekdaysOnly'), value: '0 0 * * 1-5', desc: t('cronEditor.presetDescWeekdaysOnly') },
  ];
});

// Visual editor state
const visualState = ref({
  minute: '*',
  hour: '*',
  day: '*',
  month: '*',
  dayOfWeek: '*'
});

// Parse cron expression
const parseCron = (cron: string) => {
  const parts = cron.trim().split(/\s+/);
  if (parts.length === 5) {
    return {
      minute: parts[0],
      hour: parts[1],
      day: parts[2],
      month: parts[3],
      dayOfWeek: parts[4]
    };
  }
  return { minute: '*', hour: '*', day: '*', month: '*', dayOfWeek: '*' };
};

// Human readable description
const humanReadable = computed(() => {
  const cron = props.modelValue;
  if (!cron || cron.trim() === '') return t('cronEditor.noSchedule');
  
  const preset = presets.value.find(p => p.value === cron);
  if (preset) return preset.desc;
  
  const parts = parseCron(cron);
  
  // Simple cases
  if (parts.minute === '*' && parts.hour === '*' && parts.day === '*' && parts.month === '*' && parts.dayOfWeek === '*') {
    return t('cronEditor.everyMinute');
  }
  
  if (parts.minute === '0' && parts.hour === '*' && parts.day === '*' && parts.month === '*' && parts.dayOfWeek === '*') {
    return t('cronEditor.everyHour');
  }
  
  if (parts.minute === '0' && parts.hour === '0' && parts.day === '*' && parts.month === '*' && parts.dayOfWeek === '*') {
    return t('cronEditor.everyDayAtMidnight');
  }
  
  // Build description
  let desc = '';
  
  // Time part
  if (parts.minute === '*' && parts.hour === '*') {
    desc = t('cronEditor.everyMinute');
  } else if (parts.minute === '0' && parts.hour === '*') {
    desc = t('cronEditor.everyHour');
  } else if (parts.hour.includes('/')) {
    const interval = parts.hour.split('/')[1];
    desc = t('cronEditor.everyXHours', { interval });
  } else {
    const hour = parts.hour === '*' ? '00' : parts.hour.padStart(2, '0');
    const minute = parts.minute === '*' ? '00' : parts.minute.padStart(2, '0');
    desc = t('cronEditor.atTime', { hour, minute });
  }
  
  // Day part
  if (parts.day !== '*') {
    if (parts.day.includes(',')) {
      desc += ` ${t('cronEditor.onDays', { days: parts.day })}`;
    } else if (parts.day.includes('-')) {
      desc += ` ${t('cronEditor.onDaysRange', { range: parts.day })}`;
    } else {
      desc += ` ${t('cronEditor.onDay', { day: parts.day })}`;
    }
  }
  
  // Month part
  if (parts.month !== '*') {
    if (parts.month.includes(',')) {
      desc += ` ${t('cronEditor.inMonths', { months: parts.month })}`;
    } else {
      desc += ` ${t('cronEditor.inMonth', { month: parts.month })}`;
    }
  }
  
  // Day of week part
  if (parts.dayOfWeek !== '*') {
    const dayNamesEn = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayNamesFr = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
    const dayNames = currentLanguage.value === 'fr' ? dayNamesFr : dayNamesEn;
    
    if (parts.dayOfWeek.includes(',')) {
      const days = parts.dayOfWeek.split(',').map(d => {
        const idx = parseInt(d.trim());
        return dayNames[idx] || d;
      }).join(', ');
      desc += ` ${t('cronEditor.onWeekdays', { days })}`;
    } else if (parts.dayOfWeek.includes('-')) {
      desc += ` ${t('cronEditor.onWeekdaysRange', { range: parts.dayOfWeek })}`;
    } else {
      const idx = parseInt(parts.dayOfWeek);
      desc += ` ${t('cronEditor.onWeekday', { day: dayNames[idx] || parts.dayOfWeek })}`;
    }
  }
  
  // Default fallback
  if (!desc) {
    desc = cron;
  }
  
  return desc;
});

// Watch for changes
watch(() => props.modelValue, (newVal) => {
  if (newVal) {
    const parsed = parseCron(newVal);
    visualState.value = parsed;
    
    // Check if it matches a preset
    const preset = presets.find(p => p.value === newVal);
    if (preset) {
      editMode.value = 'preset';
    } else {
      editMode.value = 'visual';
    }
  }
}, { immediate: true });

// Update cron from visual editor
const updateFromVisual = () => {
  const cron = `${visualState.value.minute} ${visualState.value.hour} ${visualState.value.day} ${visualState.value.month} ${visualState.value.dayOfWeek}`;
  emit('update:modelValue', cron);
};

// Select preset
const selectPreset = (preset: typeof presets[0]) => {
  emit('update:modelValue', preset.value);
};

// Common values for dropdowns
const hourOptions = Array.from({ length: 24 }, (_, i) => i);
const minuteOptions = [0, 15, 30, 45];
const dayOptions = Array.from({ length: 31 }, (_, i) => i + 1);
const monthOptions = Array.from({ length: 12 }, (_, i) => i + 1);
const dayOfWeekOptions = computed(() => {
  const dayNamesEn = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayNamesFr = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const dayNames = currentLanguage.value === 'fr' ? dayNamesFr : dayNamesEn;
  
  return [
    { value: '0', label: dayNames[0] },
    { value: '1', label: dayNames[1] },
    { value: '2', label: dayNames[2] },
    { value: '3', label: dayNames[3] },
    { value: '4', label: dayNames[4] },
    { value: '5', label: dayNames[5] },
    { value: '6', label: dayNames[6] },
  ];
});
</script>

<template>
  <div class="space-y-4">
    <!-- Mode selector -->
    <div class="bg-gray-100 dark:bg-zinc-800 p-1 rounded-xl flex">
      <button
        @click="editMode = 'preset'"
        :class="[
          'flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all duration-200 flex items-center justify-center gap-2',
          editMode === 'preset'
            ? 'bg-white dark:bg-zinc-700 shadow-sm text-foreground'
            : 'text-gray-500 hover:text-foreground'
        ]"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
        </svg>
        {{ t('cronEditor.preset') }}
      </button>
      <button
        @click="editMode = 'visual'"
        :class="[
          'flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all duration-200 flex items-center justify-center gap-2',
          editMode === 'visual'
            ? 'bg-white dark:bg-zinc-700 shadow-sm text-foreground'
            : 'text-gray-500 hover:text-foreground'
        ]"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
        {{ t('cronEditor.visual') }}
      </button>
      <button
        @click="editMode = 'manual'"
        :class="[
          'flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all duration-200 flex items-center justify-center gap-2',
          editMode === 'manual'
            ? 'bg-white dark:bg-zinc-700 shadow-sm text-foreground'
            : 'text-gray-500 hover:text-foreground'
        ]"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
        </svg>
        {{ t('cronEditor.manual') }}
      </button>
    </div>

    <!-- Preset mode -->
    <Transition
      enter-active-class="transition duration-300 ease-out"
      enter-from-class="opacity-0 translate-y-2"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-200 ease-in"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 -translate-y-2"
    >
      <div v-if="editMode === 'preset'" key="preset" class="space-y-3">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
          <button
            v-for="preset in presets"
            :key="preset.value"
            @click="selectPreset(preset)"
            :class="[
              'p-3 rounded-xl border-2 text-left transition-all duration-200',
              modelValue === preset.value
                ? 'border-foreground bg-foreground/5 shadow-sm'
                : 'border-border hover:border-foreground/50 hover:bg-surface'
            ]"
          >
            <div class="font-medium text-sm">{{ preset.label }}</div>
            <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">{{ preset.desc }}</div>
          </button>
        </div>
      </div>
    </Transition>

    <!-- Visual mode -->
    <Transition
      enter-active-class="transition duration-300 ease-out"
      enter-from-class="opacity-0 translate-y-2"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-200 ease-in"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 -translate-y-2"
    >
      <div v-if="editMode === 'visual'" key="visual" class="space-y-4">
        <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
          <!-- Minute -->
          <div>
            <label class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              {{ t('cronEditor.minute') }}
            </label>
            <select
              v-model="visualState.minute"
              @change="updateFromVisual"
              class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
            >
              <option value="*">{{ t('cronEditor.every') }}</option>
              <option value="0">00</option>
              <option value="15">15</option>
              <option value="30">30</option>
              <option value="45">45</option>
            </select>
          </div>

          <!-- Hour -->
          <div>
            <label class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              {{ t('cronEditor.hour') }}
            </label>
            <select
              v-model="visualState.hour"
              @change="updateFromVisual"
              class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
            >
              <option value="*">{{ t('cronEditor.every') }}</option>
              <option v-for="h in hourOptions" :key="h" :value="h.toString().padStart(2, '0')">
                {{ h.toString().padStart(2, '0') }}:00
              </option>
            </select>
          </div>

          <!-- Day -->
          <div>
            <label class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              {{ t('cronEditor.day') }}
            </label>
            <select
              v-model="visualState.day"
              @change="updateFromVisual"
              class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
            >
              <option value="*">{{ t('cronEditor.every') }}</option>
              <option v-for="d in dayOptions" :key="d" :value="d">{{ d }}</option>
            </select>
          </div>

          <!-- Month -->
          <div>
            <label class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              {{ t('cronEditor.month') }}
            </label>
            <select
              v-model="visualState.month"
              @change="updateFromVisual"
              class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
            >
              <option value="*">{{ t('cronEditor.every') }}</option>
              <option v-for="m in monthOptions" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>

          <!-- Day of week -->
          <div>
            <label class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              {{ t('cronEditor.dayOfWeek') }}
            </label>
            <select
              v-model="visualState.dayOfWeek"
              @change="updateFromVisual"
              class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
            >
              <option value="*">{{ t('cronEditor.every') }}</option>
              <option v-for="dow in dayOfWeekOptions" :key="dow.value" :value="dow.value">
                {{ dow.label }}
              </option>
            </select>
          </div>
        </div>

        <!-- Advanced options toggle -->
        <button
          @click="showAdvanced = !showAdvanced"
          class="text-xs text-gray-500 hover:text-foreground flex items-center gap-1 transition-colors"
        >
          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="showAdvanced ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7'" />
          </svg>
          {{ t('cronEditor.advancedOptions') }}
        </button>

        <!-- Advanced manual input -->
        <Transition
          enter-active-class="transition duration-200 ease-out"
          enter-from-class="opacity-0 max-h-0"
          enter-to-class="opacity-100 max-h-32"
          leave-active-class="transition duration-200 ease-in"
          leave-from-class="opacity-100 max-h-32"
          leave-to-class="opacity-0 max-h-0"
        >
          <div v-if="showAdvanced" class="space-y-2 overflow-hidden">
            <div class="grid grid-cols-5 gap-2">
              <input
                v-model="visualState.minute"
                @input="updateFromVisual"
                type="text"
                placeholder="*"
                class="bg-surface border border-border rounded-lg px-2 py-1 text-sm font-mono text-center focus:outline-none focus:ring-2 focus:ring-foreground/20"
              />
              <input
                v-model="visualState.hour"
                @input="updateFromVisual"
                type="text"
                placeholder="*"
                class="bg-surface border border-border rounded-lg px-2 py-1 text-sm font-mono text-center focus:outline-none focus:ring-2 focus:ring-foreground/20"
              />
              <input
                v-model="visualState.day"
                @input="updateFromVisual"
                type="text"
                placeholder="*"
                class="bg-surface border border-border rounded-lg px-2 py-1 text-sm font-mono text-center focus:outline-none focus:ring-2 focus:ring-foreground/20"
              />
              <input
                v-model="visualState.month"
                @input="updateFromVisual"
                type="text"
                placeholder="*"
                class="bg-surface border border-border rounded-lg px-2 py-1 text-sm font-mono text-center focus:outline-none focus:ring-2 focus:ring-foreground/20"
              />
              <input
                v-model="visualState.dayOfWeek"
                @input="updateFromVisual"
                type="text"
                placeholder="*"
                class="bg-surface border border-border rounded-lg px-2 py-1 text-sm font-mono text-center focus:outline-none focus:ring-2 focus:ring-foreground/20"
              />
            </div>
            <p class="text-xs text-gray-500 text-center">
              {{ t('cronEditor.format') }}
            </p>
          </div>
        </Transition>
      </div>
    </Transition>

    <!-- Manual mode -->
    <Transition
      enter-active-class="transition duration-300 ease-out"
      enter-from-class="opacity-0 translate-y-2"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-200 ease-in"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 -translate-y-2"
    >
      <div v-if="editMode === 'manual'" key="manual" class="space-y-2">
        <input
          :value="modelValue"
          @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
          type="text"
          class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all font-mono text-sm"
          placeholder="0 0 * * *"
        />
        <p class="text-xs text-gray-500">
          {{ t('cronEditor.format') }}
        </p>
        <p class="text-xs text-gray-500">
          {{ t('cronEditor.help') }}
        </p>
      </div>
    </Transition>

    <!-- Human readable description -->
    <div class="p-3 bg-gray-50 dark:bg-zinc-800/50 rounded-xl border border-gray-100 dark:border-zinc-700/50">
      <div class="flex items-start gap-2">
        <svg class="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div class="flex-1">
          <div class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{{ t('cronEditor.schedule') }}</div>
          <div class="text-sm text-foreground">{{ humanReadable }}</div>
          <div class="text-xs font-mono text-gray-400 mt-2">{{ modelValue || 'No schedule' }}</div>
        </div>
      </div>
    </div>
  </div>
</template>


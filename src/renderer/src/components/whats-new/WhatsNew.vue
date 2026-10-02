<script setup lang="ts">
/**
 * "What's new" tour, shown once after updating from an earlier version (and from Info).
 * Same shell as the onboarding: the stage plays screenshots of the new screens, the panel
 * explains them; the second slide lets the user act on what changes for them.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import Dashboard3DScene from '../Dashboard3DScene.vue';
import ToggleSwitch from '../ui/ToggleSwitch.vue';
import WhatsNewStage from './WhatsNewStage.vue';
import { store } from '../../store';
import { useI18n } from '../../composables/useI18n';
import { ipcRenderer } from '../../electron';
import { getErrorMessage } from '../../utils';
import { SLIDES, WHATS_NEW_VERSION, shotUrl } from '../../whatsNew';

const { t } = useI18n();
const index = ref(0);
const direction = ref(1);
const panel = ref<HTMLElement | null>(null);
const slide = computed(() => SLIDES[index.value]);
const isFirst = computed(() => index.value === 0);
const isLast = computed(() => index.value === SLIDES.length - 1);
const lang = computed<'en' | 'fr'>(() => (store.language === 'fr' ? 'fr' : 'en'));
const version = WHATS_NEW_VERSION.replace(/\.0$/, '');

// What changes for the user, with what they can do about it now
const actions = reactive({
  loaded: false,
  launchAtLogin: false,
  savingLogin: false,
  outdated: [] as { id: string; name: string }[],
  updating: false,
  updated: 0,
  error: '',
});

const loadActions = async () => {
  try {
    const [config, clients] = await Promise.all([
      ipcRenderer.invoke('get-config'),
      ipcRenderer.invoke('mcp-list-clients').catch(() => []),
    ]);
    actions.launchAtLogin = !!config?.launchAtLogin;
    actions.outdated = (clients as { id: string; name: string; state: string }[])
      .filter(c => c.state === 'outdated')
      .map(c => ({ id: c.id, name: c.name }));
  } finally {
    actions.loaded = true;
  }
};

const toggleLogin = async () => {
  actions.savingLogin = true;
  try {
    await ipcRenderer.invoke('save-settings', { launchAtLogin: !actions.launchAtLogin });
    actions.launchAtLogin = !actions.launchAtLogin;
  } catch (error) {
    actions.error = getErrorMessage(error);
  } finally {
    actions.savingLogin = false;
  }
};

const updateClients = async () => {
  actions.updating = true;
  actions.error = '';
  let done = 0;
  try {
    for (const client of actions.outdated) {
      const result = await ipcRenderer.invoke('mcp-install-client', client.id);
      if (result?.success) done++;
      else actions.error = result?.error || actions.error;
    }
  } catch (error) {
    actions.error = getErrorMessage(error);
  } finally {
    actions.updated = done;
    actions.updating = false;
  }
};

// Navigation
const focusHeading = () => nextTick(() => {
  panel.value?.querySelector<HTMLElement>('[data-step-heading]')?.focus({ preventScroll: true });
  panel.value?.querySelector('.step-body')?.scrollTo({ top: 0 });
});
const goTo = (i: number) => {
  direction.value = i >= index.value ? 1 : -1;
  index.value = Math.max(0, Math.min(SLIDES.length - 1, i));
};
const next = () => (isLast.value ? close() : goTo(index.value + 1));
const back = () => goTo(index.value - 1);

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  try {
    await ipcRenderer.invoke('whats-new-seen');
  } catch (error) {
    console.error('Could not save that the tour was seen:', getErrorMessage(error));
  }
  store.showWhatsNew = false;
};

const onKeydown = (event: KeyboardEvent) => {
  if (event.defaultPrevented || event.isComposing) return;
  const target = event.target as HTMLElement | null;
  if (event.key === 'Escape') { event.preventDefault(); close(); return; }
  if (target?.closest('button, a, input, select, textarea')) return;
  if (event.key === 'ArrowRight' || event.key === 'Enter') { event.preventDefault(); next(); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); back(); }
};

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  loadActions();
  // Fetch every screenshot now, so a slide never opens on an empty stage
  for (const s of SLIDES) {
    if (s.beats === 'scene') continue;
    for (const b of s.beats) for (const shot of [b.shot, b.overlay]) if (shot) new Image().src = shotUrl(lang.value, shot);
  }
  focusHeading();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

const POINTS = ['p1', 'p2', 'p3', 'p4'] as const;
</script>

<template>
  <div class="whats-new dark fixed inset-0 z-[200] flex flex-col lg:flex-row bg-[#09090b] text-zinc-100 overflow-hidden" role="dialog" aria-modal="true" :aria-label="t('whatsNew.badge')">
    <div class="drag absolute top-0 inset-x-0 h-10 z-10" aria-hidden="true" />

    <!-- Stage -->
    <section class="stage relative shrink-0 h-56 sm:h-72 max-h-[38vh] lg:max-h-none lg:h-auto lg:flex-1 lg:min-w-0 flex items-center justify-center overflow-hidden p-4 lg:p-10" aria-hidden="true">
      <div class="glow absolute inset-0 pointer-events-none" />
      <Transition name="stage" mode="out-in">
        <div v-if="slide.beats === 'scene'" key="scene" class="absolute inset-0">
          <Dashboard3DScene focus="overview" dark />
        </div>
        <!-- As large as the stage allows, keeping the captures' 16:10 -->
        <div v-else :key="slide.id" class="frame-fit relative">
          <WhatsNewStage :beats="slide.beats" :lang="lang" />
        </div>
      </Transition>
    </section>

    <!-- Panel -->
    <section ref="panel" class="panel relative flex flex-col min-h-0 flex-1 lg:flex-none lg:w-[440px] xl:w-[480px] border-t lg:border-t-0 lg:border-l border-white/[0.06] bg-zinc-950/70">
      <header class="shrink-0 px-6 sm:px-8 pt-5 lg:pt-12 pb-4">
        <div class="flex items-center justify-between gap-4">
          <div class="flex items-center gap-2.5">
            <img src="/logo.png" alt="" class="w-6 h-6 rounded-md" />
            <span class="text-sm font-semibold tracking-tight">bbdump</span>
            <span class="font-mono text-[10px] uppercase tracking-[0.16em] px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400">{{ t('whatsNew.badge') }}</span>
          </div>
          <button type="button" class="text-xs text-zinc-500 hover:text-zinc-200 transition-colors" @click="close">{{ t('whatsNew.skip') }}</button>
        </div>
        <ol class="mt-5 flex gap-1.5" :aria-label="t('whatsNew.progress')">
          <li v-for="(s, i) in SLIDES" :key="s.id" class="flex-1" :aria-current="i === index ? 'step' : undefined">
            <button type="button" class="block w-full py-1.5" :aria-label="`${i + 1} / ${SLIDES.length}`" @click="goTo(i)">
              <span class="block h-[3px] rounded-full transition-colors duration-300" :class="i === index ? 'bg-emerald-500' : i < index ? 'bg-zinc-500' : 'bg-zinc-800'" />
            </button>
          </li>
        </ol>
      </header>

      <div class="step-body flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-6 sm:px-8 pb-6">
        <Transition :name="direction > 0 ? 'step-forward' : 'step-back'" mode="out-in" @after-enter="focusHeading">
          <div :key="slide.id" class="pt-2">
            <div class="font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-400/80 mb-3">{{ t(`whatsNew.slides.${slide.id}.eyebrow`, { version }) }}</div>
            <h1 tabindex="-1" data-step-heading class="text-[1.6rem] leading-tight font-semibold tracking-tight text-zinc-50 outline-none">{{ t(`whatsNew.slides.${slide.id}.title`) }}</h1>
            <p class="mt-3 text-sm leading-relaxed text-zinc-400">{{ t(`whatsNew.slides.${slide.id}.body`) }}</p>

            <!-- Intro: the headlines -->
            <ul v-if="slide.id === 'intro'" class="mt-6 space-y-2.5">
              <li v-for="p in POINTS" :key="p" class="flex gap-3 text-sm text-zinc-300">
                <span class="mt-[7px] w-1.5 h-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden="true" />
                <span>{{ t(`whatsNew.slides.intro.${p}`) }}</span>
              </li>
            </ul>

            <!-- What changes: things to act on now -->
            <div v-else-if="slide.id === 'actions'" class="mt-6 space-y-2.5">
              <div class="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3.5">
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium text-zinc-100">{{ t('whatsNew.slides.actions.login') }}</div>
                  <p class="mt-1 text-[12.5px] leading-relaxed text-zinc-400">{{ t('whatsNew.slides.actions.loginHint') }}</p>
                </div>
                <ToggleSwitch class="mt-0.5" :on="actions.launchAtLogin" :disabled="!actions.loaded || actions.savingLogin" :label="t('whatsNew.slides.actions.login')" @toggle="toggleLogin" />
              </div>

              <div v-if="actions.outdated.length || actions.updated" class="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3.5">
                <div v-if="actions.updated" class="flex items-center gap-2 text-sm font-medium text-emerald-300">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  {{ t('whatsNew.slides.actions.aiDone', { count: actions.updated }) }}
                </div>
                <div v-else class="flex items-start gap-3">
                  <div class="min-w-0 flex-1">
                    <div class="text-sm font-medium text-zinc-100">{{ t('whatsNew.slides.actions.ai', { count: actions.outdated.length }) }}</div>
                    <p class="mt-1 text-[12.5px] leading-relaxed text-zinc-400">{{ actions.outdated.map(c => c.name).join(', ') }} — {{ t('whatsNew.slides.actions.aiHint') }}</p>
                  </div>
                  <button type="button" class="btn-secondary shrink-0" :disabled="actions.updating" @click="updateClients">
                    <span v-if="actions.updating" class="w-3 h-3 rounded-full border-2 border-zinc-500 border-t-zinc-100 animate-spin" />
                    {{ t('whatsNew.slides.actions.aiUpdate') }}
                  </button>
                </div>
              </div>

              <div class="rounded-xl border border-amber-500/25 bg-amber-500/[0.05] px-4 py-3.5">
                <div class="text-sm font-medium text-amber-200">{{ t('whatsNew.slides.actions.restore') }}</div>
                <p class="mt-1 text-[12.5px] leading-relaxed text-zinc-400">{{ t('whatsNew.slides.actions.restoreHint') }}</p>
              </div>

              <p v-if="actions.error" role="alert" class="text-[12.5px] text-red-400">{{ actions.error }}</p>
            </div>

            <p v-else-if="slide.id === 'explore'" class="mt-6 text-[12.5px] text-zinc-500">{{ t('whatsNew.slides.explore.again') }}</p>
          </div>
        </Transition>
      </div>

      <footer class="shrink-0 flex items-center gap-3 px-6 sm:px-8 py-4 border-t border-white/[0.06]">
        <button v-if="!isFirst" type="button" class="btn-ghost" @click="back">{{ t('whatsNew.back') }}</button>
        <span class="flex-1" />
        <span class="hidden sm:inline font-mono text-[10px] text-zinc-600 tabular-nums">{{ index + 1 }} / {{ SLIDES.length }}</span>
        <button type="button" class="btn-primary" @click="next">{{ isLast ? t('whatsNew.done') : t('whatsNew.next') }}</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.drag {
  -webkit-app-region: drag;
}
.whats-new button,
.whats-new a {
  -webkit-app-region: no-drag;
}
.stage {
  container-type: size;
}
.frame-fit {
  /* the bars below the capture take about 3rem */
  width: min(100cqw, calc((100cqh - 3rem) * 1.6));
}
.glow {
  background:
    radial-gradient(60% 55% at 50% 50%, rgba(16, 185, 129, 0.08), transparent 70%),
    radial-gradient(120% 90% at 50% 120%, rgba(255, 255, 255, 0.03), transparent 60%);
}
.btn-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  min-width: 7.5rem;
  padding: 0.55rem 1.1rem;
  border-radius: 0.6rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: #09090b;
  background: #fafafa;
  transition: background-color 0.15s ease, transform 0.15s ease;
}
.btn-primary:hover {
  background: #e4e4e7;
}
.btn-primary:active {
  transform: translateY(1px);
}
.btn-ghost {
  padding: 0.55rem 0.9rem;
  border-radius: 0.6rem;
  font-size: 0.875rem;
  color: #d4d4d8;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.btn-ghost:hover {
  background: rgba(255, 255, 255, 0.05);
  color: #fafafa;
}
.btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.75rem;
  border-radius: 0.6rem;
  font-size: 0.8125rem;
  color: #d4d4d8;
  border: 1px solid #3f3f46;
  background: rgba(24, 24, 27, 0.6);
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.btn-secondary:hover:not(:disabled) {
  border-color: #52525b;
  background: #27272a;
  color: #fafafa;
}
.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.whats-new button:focus-visible {
  outline: 2px solid rgba(16, 185, 129, 0.7);
  outline-offset: 2px;
}

.stage-enter-active,
.stage-leave-active {
  transition: opacity 0.3s ease, transform 0.35s cubic-bezier(0.2, 0.7, 0.2, 1);
}
.stage-enter-from {
  opacity: 0;
  transform: scale(0.98);
}
.stage-leave-to {
  opacity: 0;
}
.step-forward-enter-active,
.step-forward-leave-active,
.step-back-enter-active,
.step-back-leave-active {
  transition: opacity 0.22s ease, transform 0.26s cubic-bezier(0.2, 0.7, 0.2, 1);
}
.step-forward-enter-from,
.step-back-leave-to {
  opacity: 0;
  transform: translateX(18px);
}
.step-forward-leave-to,
.step-back-enter-from {
  opacity: 0;
  transform: translateX(-18px);
}
@media (prefers-reduced-motion: reduce) {
  .stage-enter-active,
  .stage-leave-active,
  .step-forward-enter-active,
  .step-forward-leave-active,
  .step-back-enter-active,
  .step-back-leave-active {
    transition: opacity 0.12s linear;
  }
  .stage-enter-from,
  .step-forward-enter-from,
  .step-forward-leave-to,
  .step-back-enter-from,
  .step-back-leave-to {
    transform: none;
  }
}
</style>

<script setup lang="ts">
/**
 * Dashboards page: the dashboards of every database, newest first, and the dialog that
 * starts a new one (a database, a name, what to see: the AI builds it). An open dashboard
 * takes the whole page (DashboardView).
 */
import { computed, onMounted, ref, watch } from 'vue';
import { store } from '../../store';
import { useI18n } from '../../composables/useI18n';
import { useToast } from '../../composables/useToast';
import { useConfirm } from '../../composables/useConfirm';
import { useFeatures } from '../../composables/useFeatures';
import { relative } from '../../timeText';
import type { Database } from '../../types';
import { useDashboards, type DashboardSummary, type DashboardTemplate } from '../../dashboards/useDashboards';
import { ipcRenderer } from '../../electron';
import { programEngine } from '../../dashboards/dashboardProgram';
import { engineOf } from '../../../../shared/engines/features';
import AppModal from '../ui/AppModal.vue';
import FormField from '../ui/FormField.vue';
import { btnPrimary, btnSecondary, inputClass, selectClass } from '../ui/classes';
import DashboardView from './DashboardView.vue';

const { t, currentLanguage } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();
const { list, create, ask, remove } = useDashboards();

const items = ref<DashboardSummary[]>([]);
const loaded = ref(false);
const now = ref(Date.now());

const dbOf = (id: string) => store.databases.find(d => d.id === id);
const { isEnabled } = useFeatures();
/** Databases a dashboard can be built on (their engine runs the AI's queries) */
const boardDatabases = computed(() => store.databases.filter(d => isEnabled(d, 'dashboards')));
const dbLabel = (db: Database | undefined) => (db ? (db.masked ? '••••••••' : db.displayName || db.name) : '');

async function load() {
  items.value = await list();
  now.value = Date.now();
  loaded.value = true;
}
onMounted(load);
// Back from a dashboard: its changes show in the list
watch(() => store.openDashboard, (open, was) => { if (!open && was) void load(); });

const visible = computed(() => items.value.filter(d => dbOf(d.databaseId)).sort((a, b) => Number(b.pinned) - Number(a.pinned)));
const ago = (iso: string) => relative(Date.parse(iso), now.value, currentLanguage.value, t);
const refreshLabel = (seconds: number) => (seconds ? t(`dashboards.auto.s${seconds}`) : '');

const openOne = (d: DashboardSummary) => { store.openDashboard = { databaseId: d.databaseId, id: d.id }; };

const deleteOne = (d: DashboardSummary) => {
  showConfirm({
    title: t('dashboards.deleteTitle'),
    message: t('dashboards.deleteMessage', { title: d.title || t('dashboards.untitled') }),
    confirmText: t('dashboards.delete'),
    type: 'danger',
    onConfirm: async () => {
      await remove(d.databaseId, d.id);
      addToast(t('dashboards.deleted'), 'success');
      await load();
    },
  });
};

// --- New dashboard ------------------------------------------------------------------------
const showNew = ref(false);
const form = ref({ databaseId: '', title: '', request: '' });
const creating = ref(false);
const canCreate = computed(() => !!form.value.databaseId && !!form.value.request.trim() && !creating.value);

const openNew = (db?: Database | null) => {
  form.value = { databaseId: db?.id ?? boardDatabases.value[0]?.id ?? '', title: '', request: '' };
  template.value = null;
  showNew.value = true;
};
// Asked from a database card
watch(() => store.newDashboardDb, db => {
  if (!db) return;
  openNew(db);
  store.newDashboardDb = null;
}, { immediate: true });

// --- Import a dashboard file: then the database it goes on ------------------------------------
const importing = ref<{ template: DashboardTemplate; databaseId: string } | null>(null);
/** The databases a file can go on: those of the engine its queries are written for */
const importDatabases = computed(() => {
  const engine = importing.value ? programEngine(importing.value.template.program ?? '') : null;
  return boardDatabases.value.filter(d => !engine || engineOf(d) === engine);
});
async function importFile() {
  const result = await ipcRenderer.invoke('dashboards-import-file');
  if (!result) return;
  if (!result.success) {
    addToast(t('dashboards.importError'), 'error', { detail: result.error });
    return;
  }
  importing.value = { template: result.dashboard, databaseId: '' };
  importing.value.databaseId = importDatabases.value[0]?.id ?? '';
}
async function acceptImport() {
  const job = importing.value;
  importing.value = null;
  if (!job?.databaseId) return;
  const db = dbOf(job.databaseId);
  const session = await create(job.databaseId, job.template.title || t('dashboards.untitled'), db?.displayName || db?.name || '', job.template);
  if (!session) {
    addToast(t('dashboards.createError'), 'error');
    return;
  }
  addToast(t('dashboards.imported'), 'success');
  store.openDashboard = { databaseId: session.dashboard.databaseId, id: session.dashboard.id };
}

/** Starting points by goal: a click fills the request (still editable), the AI adapts it to the database */
const TEMPLATES = [
  { id: 'overview', icon: 'M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z' },
  { id: 'activity', icon: 'M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941' },
  { id: 'search', icon: 'M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z' },
  { id: 'metric', icon: 'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z' },
  { id: 'ranking', icon: 'M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 002.748 1.35m8.272-6.842V4.5c0 2.108-.966 3.99-2.48 5.228m2.48-5.492a46.32 46.32 0 012.916.52 6.003 6.003 0 01-5.395 4.972m0 0a6.726 6.726 0 01-2.749 1.35m0 0a6.772 6.772 0 01-3.044 0' },
  { id: 'quality', icon: 'M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z' },
];
const template = ref<string | null>(null);
const useTemplate = (id: string) => {
  template.value = id;
  form.value.request = t(`dashboards.templates.${id}.request`);
  if (!form.value.title.trim()) form.value.title = t(`dashboards.templates.${id}.label`);
};

async function submitNew() {
  if (!canCreate.value) return;
  creating.value = true;
  try {
    const db = dbOf(form.value.databaseId);
    const request = form.value.request.trim();
    const title = form.value.title.trim() || request.slice(0, 60);
    const label = db?.displayName || db?.name || '';
    const session = await create(form.value.databaseId, title, label);
    if (!session) {
      addToast(t('dashboards.createError'), 'error');
      return;
    }
    showNew.value = false;
    store.openDashboard = { databaseId: session.dashboard.databaseId, id: session.dashboard.id };
    // The AI starts at once; the dashboard view shows it working
    void ask(session, request);
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <DashboardView
    v-if="store.openDashboard"
    :key="store.openDashboard.id"
    :database-id="store.openDashboard.databaseId"
    :dashboard-id="store.openDashboard.id"
    @close="store.openDashboard = null"
  />

  <div v-else class="h-full flex flex-col min-h-0">
    <div class="mb-5 shrink-0 flex items-end gap-4">
      <div class="flex-1 min-w-0">
        <h2 class="text-lg font-bold tracking-tight">{{ t('dashboards.title') }}</h2>
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ t('dashboards.subtitle') }}</p>
      </div>
      <button v-if="boardDatabases.length" type="button" :class="btnSecondary" @click="importFile">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" /></svg>
        {{ t('dashboards.import') }}
      </button>
      <button v-if="visible.length" type="button" :class="btnPrimary" :disabled="!boardDatabases.length" @click="openNew()">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path stroke-linecap="round" d="M12 5v14M5 12h14" /></svg>
        {{ t('dashboards.new') }}
      </button>
    </div>

    <!-- None yet: what a dashboard is, and the way to make one -->
    <div v-if="loaded && !visible.length" class="flex-1 flex flex-col items-center justify-center text-center px-6 pb-10">
      <div class="dash-hero relative w-20 h-20 mb-6 rounded-3xl flex items-end justify-center gap-1.5 pb-4 bg-emerald-500/10" aria-hidden="true">
        <span class="dash-hero-bar w-2.5 rounded-full bg-emerald-500/70" style="--h: 18px; animation-delay: 0ms" />
        <span class="dash-hero-bar w-2.5 rounded-full bg-emerald-500/80" style="--h: 34px; animation-delay: 120ms" />
        <span class="dash-hero-bar w-2.5 rounded-full bg-emerald-500" style="--h: 26px; animation-delay: 240ms" />
        <span class="dash-hero-bar w-2.5 rounded-full bg-emerald-500/60" style="--h: 40px; animation-delay: 360ms" />
      </div>
      <div class="text-[17px] font-semibold text-gray-900 dark:text-zinc-100">{{ t('dashboards.emptyTitle') }}</div>
      <p class="mt-2 max-w-md text-[13px] leading-relaxed text-gray-500 dark:text-zinc-400">{{ t('dashboards.emptyDesc') }}</p>
      <button v-if="boardDatabases.length" type="button" :class="btnPrimary" class="mt-6" @click="openNew()">{{ t('dashboards.new') }}</button>
      <p v-else class="mt-6 text-[12px] text-gray-400 dark:text-zinc-500">{{ t('dashboards.noDatabase') }}</p>
    </div>

    <div v-else class="flex-1 min-h-0 overflow-y-auto pb-6">
      <div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(260px, 1fr))">
        <div
          v-for="(d, i) in visible"
          :key="d.id"
          class="dash-card group relative text-left rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/70 px-4 pt-4 pb-3.5 cursor-pointer hover:border-emerald-300 dark:hover:border-emerald-800 hover:shadow-lg hover:shadow-emerald-500/5 transition-[border-color,box-shadow,transform] duration-200"
          :style="{ animationDelay: `${Math.min(i, 10) * 40}ms` }"
          role="button"
          tabindex="0"
          @click="openOne(d)"
          @keydown.enter.prevent="openOne(d)"
        >
          <!-- A small chart that grows on hover -->
          <div class="flex items-end gap-1 h-8 mb-3" aria-hidden="true">
            <span v-for="(h, b) in [40, 70, 55, 90, 65]" :key="b" class="dash-card-bar w-2 rounded-sm bg-emerald-500/25 group-hover:bg-emerald-500/60" :style="{ height: `${h}%`, transitionDelay: `${b * 40}ms` }" />
          </div>
          <div class="flex items-center gap-1.5 pr-6 min-w-0">
            <svg v-if="d.pinned" class="shrink-0 w-3 h-3 text-gray-400" fill="currentColor" viewBox="0 0 24 24" :aria-label="t('dashboards.pinnedBadge')"><path d="M16 3l5 5-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4 1-3z" /></svg>
            <span class="text-[14px] font-semibold text-gray-900 dark:text-zinc-100 truncate">{{ d.title || t('dashboards.untitled') }}</span>
          </div>
          <div class="mt-1 text-[11px] text-gray-500 dark:text-zinc-400 truncate">{{ dbLabel(dbOf(d.databaseId)) }}</div>
          <div class="mt-2.5 flex items-center gap-2 text-[11px] text-gray-400 dark:text-zinc-500">
            <span class="truncate">{{ t('dashboards.changed', { when: ago(d.updatedAt) }) }}</span>
            <span v-if="d.refreshSeconds" class="shrink-0 inline-flex items-center gap-1 px-1.5 py-px rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h5M20 20v-5h-5M5.6 15A7 7 0 0018 17.4M18.4 9A7 7 0 006 6.6" /></svg>
              {{ refreshLabel(d.refreshSeconds) }}
            </span>
          </div>
          <button
            type="button"
            class="absolute top-3 right-3 w-7 h-7 rounded-lg flex items-center justify-center text-gray-300 dark:text-zinc-600 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-opacity"
            :title="t('dashboards.menu.delete')"
            :aria-label="t('dashboards.menu.delete')"
            @click.stop="deleteOne(d)"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        </div>
      </div>
    </div>

    <AppModal v-if="importing" :title="t('dashboards.importTitle')" icon="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" width="sm" @close="importing = null" @submit="acceptImport">
      <p class="mb-3 text-[12px] leading-relaxed text-gray-500 dark:text-zinc-400">{{ t('dashboards.importHint', { title: importing.template.title || t('dashboards.untitled') }) }}</p>
      <FormField :label="t('dashboards.modal.database')">
        <select v-model="importing.databaseId" :class="selectClass">
          <option v-for="db in importDatabases" :key="db.id" :value="db.id">{{ dbLabel(db) }}</option>
        </select>
      </FormField>
      <p v-if="!importDatabases.length" class="mt-2 text-[12px] text-amber-700 dark:text-amber-400">{{ t('dashboards.importNoEngine') }}</p>
      <template #footer>
        <span class="flex-1" />
        <button type="button" :class="btnSecondary" @click="importing = null">{{ t('common.cancel') }}</button>
        <button type="button" :class="btnPrimary" :disabled="!importing.databaseId" @click="acceptImport">{{ t('dashboards.importConfirm') }}</button>
      </template>
    </AppModal>

    <AppModal
      v-if="showNew"
      :title="t('dashboards.modal.title')"
      icon="M4 20h16M7 16v-5m5 5V6m5 10V8"
      :busy="creating"
      @close="showNew = false"
      @submit="submitNew"
    
      width="lg">
      <div class="space-y-4">
        <FormField :label="t('dashboards.modal.database')">
          <select v-model="form.databaseId" :class="selectClass">
            <option v-for="db in boardDatabases" :key="db.id" :value="db.id">{{ dbLabel(db) }}</option>
          </select>
        </FormField>
        <FormField :label="t('dashboards.modal.name')">
          <input v-model="form.title" type="text" maxlength="120" :class="inputClass" :placeholder="t('dashboards.modal.namePlaceholder')" />
        </FormField>
        <!-- Starting points: a click fills the request, still editable -->
        <div>
          <div class="mb-1.5 text-[12px] font-medium text-gray-600 dark:text-zinc-400">{{ t('dashboards.templates.title') }}</div>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <button
              v-for="tpl in TEMPLATES"
              :key="tpl.id"
              type="button"
              class="dash-template group text-left rounded-xl border px-3 py-2.5 transition-colors"
              :class="template === tpl.id ? 'border-emerald-400 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-950/20' : 'border-gray-200 dark:border-zinc-700 hover:border-emerald-300 dark:hover:border-emerald-800'"
              :aria-pressed="template === tpl.id"
              @click="useTemplate(tpl.id)"
            >
              <svg class="dash-template-icon w-4 h-4 text-emerald-600 dark:text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" :d="tpl.icon" /></svg>
              <div class="mt-1.5 text-[12px] font-medium text-gray-900 dark:text-zinc-100">{{ t(`dashboards.templates.${tpl.id}.label`) }}</div>
              <div class="mt-0.5 text-[11px] leading-snug text-gray-500 dark:text-zinc-400">{{ t(`dashboards.templates.${tpl.id}.desc`) }}</div>
            </button>
          </div>
        </div>
        <FormField :label="t('dashboards.modal.request')">
          <textarea
            v-model="form.request"
            rows="4"
            maxlength="4000"
            :class="inputClass"
            class="!h-auto py-2 leading-relaxed resize-none"
            :placeholder="t('dashboards.modal.requestPlaceholder')"
            data-own-enter
          />
        </FormField>
      </div>
      <template #footer>
        <span class="flex-1" />
        <button type="button" :class="btnSecondary" :disabled="creating" @click="showNew = false">{{ t('common.cancel') }}</button>
        <button type="button" :class="btnPrimary" :disabled="!canCreate" @click="submitNew">{{ t('dashboards.modal.create') }}</button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.dash-card { animation: dash-rise 0.35s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.dash-template-icon { transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
.dash-template:hover .dash-template-icon { transform: scale(1.15) rotate(-6deg); }
.dash-card:hover { transform: translateY(-2px); }
.dash-card-bar { transform-origin: bottom; transition: background-color 0.25s, transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1); }
.dash-card:hover .dash-card-bar { transform: scaleY(1.15); }
@keyframes dash-rise { from { opacity: 0; transform: translateY(8px); } }

/* The empty page: four bars breathing, like data coming in */
.dash-hero-bar { height: var(--h); transform-origin: bottom; animation: dash-breathe 2.4s ease-in-out infinite both; }
@keyframes dash-breathe {
  0%, 100% { transform: scaleY(1); }
  50% { transform: scaleY(0.6); }
}
@media (prefers-reduced-motion: reduce) {
  .dash-card, .dash-hero-bar { animation: none; }
  .dash-card:hover, .dash-card:hover .dash-card-bar { transform: none; }
}
</style>

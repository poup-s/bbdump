<script setup lang="ts">
/** Create or edit a project: name, colour, databases (same shell and fields as the other dialogs). */
import { ref, computed, onMounted } from 'vue';
import { getErrorMessage } from '../utils';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';
import AppModal from './ui/AppModal.vue';
import ModalHeading from './ui/ModalHeading.vue';
import FormField from './ui/FormField.vue';
import { btnGhost, btnPrimary, inputClass } from './ui/classes';

const ICON_FOLDER = 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z';

const { t } = useI18n();
const { addToast } = useToast();

const isEditing = computed(() => !!store.editingProject);
const isLoading = ref(false);
const attempted = ref(false);
const customColorInput = ref<HTMLInputElement | null>(null);

const colors = [
  'bg-blue-500',
  'bg-indigo-500',
  'bg-purple-500',
  'bg-pink-500',
  'bg-red-500',
  'bg-orange-500',
  'bg-emerald-500',
  'bg-teal-500',
];

const form = ref({
  name: '',
  color: 'bg-blue-500',
  databaseIds: [] as string[],
});

const isCustomColor = computed(() => form.value.color.startsWith('custom:'));
const customHex = computed(() => (isCustomColor.value ? form.value.color.replace('custom:', '') : '#3b82f6'));

onMounted(() => {
  if (store.editingProject) {
    form.value = {
      name: store.editingProject.name,
      color: store.editingProject.color,
      databaseIds: [...store.editingProject.databaseIds],
    };
  }
});

const nameError = computed(() => (attempted.value && !form.value.name.trim() ? t('dbModal.required') : undefined));

/** Other project currently holding a database (checking it moves it here) */
const otherProjectOf = (dbId: string) => (store.projects || []).find(p =>
  p.id !== store.editingProject?.id && p.databaseIds.includes(dbId)) ?? null;
const dbLabel = (db: { masked?: boolean; displayName?: string; name: string }) => (db.masked ? '••••••••' : (db.displayName || db.name));

const toggleDatabase = (dbId: string) => {
  const idx = form.value.databaseIds.indexOf(dbId);
  if (idx === -1) form.value.databaseIds.push(dbId);
  else form.value.databaseIds.splice(idx, 1);
};

const onCustomColorChange = (event: Event) => {
  form.value.color = `custom:${(event.target as HTMLInputElement).value}`;
};

const close = () => {
  if (isLoading.value) return;
  store.showProjectModal = false;
  store.editingProject = null;
};

const save = async () => {
  attempted.value = true;
  if (!form.value.name.trim() || isLoading.value) return;

  isLoading.value = true;
  try {
    // Build a plain object to avoid Vue reactive proxy cloning issues with IPC
    const projectData = {
      name: form.value.name.trim(),
      color: form.value.color,
      databaseIds: [...form.value.databaseIds],
    };

    if (isEditing.value && store.editingProject) {
      await ipcRenderer.invoke('update-project', store.editingProject.id, projectData);
      addToast(t('project.updated', { name: projectData.name }), 'success');
    } else {
      await ipcRenderer.invoke('add-project', projectData);
      addToast(t('project.created', { name: projectData.name }), 'success');
    }

    const config = await ipcRenderer.invoke('get-config');
    store.projects = config.projects || [];
    isLoading.value = false;
    close();
  } catch (error) {
    addToast(t('toasts.projectSaveError'), 'error', { detail: getErrorMessage(error) });
  } finally {
    isLoading.value = false;
  }
};
</script>

<template>
  <AppModal
    :title="isEditing ? t('project.editProject') : t('project.newProject')"
    :icon="ICON_FOLDER"
    :busy="isLoading"
    :close-label="t('common.cancel')"
    @close="close"
    @submit="save"
  >
    <ModalHeading :eyebrow="t('project.eyebrow')" :title="form.name.trim() || t('project.newProject')" :subtitle="t('project.subtitle')" />

    <div class="space-y-5">
      <FormField :label="t('project.name')" for="project-name" required :error="nameError">
        <input id="project-name" v-model="form.name" type="text" :class="inputClass" :placeholder="t('project.namePlaceholder')" />
      </FormField>

      <FormField :label="t('project.color')">
        <div role="radiogroup" :aria-label="t('project.color')" class="flex flex-wrap items-center gap-2">
          <button
            v-for="color in colors"
            :key="color"
            type="button"
            role="radio"
            :aria-checked="form.color === color"
            :aria-label="color.replace('bg-', '').replace('-500', '')"
            class="w-7 h-7 rounded-full transition-transform hover:scale-110 ring-offset-2 ring-offset-white dark:ring-offset-zinc-900"
            :class="[color, form.color === color ? 'ring-2 ring-gray-900 dark:ring-zinc-100 scale-110' : '']"
            @click="form.color = color"
          />
          <!-- Custom colour -->
          <button
            type="button"
            role="radio"
            :aria-checked="isCustomColor"
            class="relative w-7 h-7 rounded-full transition-transform hover:scale-110 ring-offset-2 ring-offset-white dark:ring-offset-zinc-900 flex items-center justify-center"
            :class="isCustomColor ? 'ring-2 ring-gray-900 dark:ring-zinc-100 scale-110' : 'border border-dashed border-gray-300 dark:border-zinc-600'"
            :style="isCustomColor ? { backgroundColor: customHex } : {}"
            :title="t('project.customColor')"
            :aria-label="t('project.customColor')"
            @click="customColorInput?.click()"
          >
            <svg v-if="!isCustomColor" class="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            <input ref="customColorInput" type="color" class="absolute inset-0 opacity-0 pointer-events-none" :value="customHex" tabindex="-1" @input="onCustomColorChange" />
          </button>
        </div>
      </FormField>

      <FormField :label="t('project.selectDatabases')" :hint="store.databases.length ? t('project.moveHint') : undefined">
        <div v-if="store.databases.length" class="rounded-xl border border-gray-200 dark:border-zinc-800 divide-y divide-gray-100 dark:divide-zinc-800 max-h-56 overflow-y-auto">
          <label
            v-for="db in store.databases"
            :key="db.id"
            class="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors"
          >
            <input
              type="checkbox"
              class="w-4 h-4 rounded border-gray-300 dark:border-zinc-600 accent-emerald-500"
              :checked="form.databaseIds.includes(db.id)"
              @change="toggleDatabase(db.id)"
            />
            <span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-gray-800 dark:text-zinc-200">{{ dbLabel(db) }}</span>
            <span
              class="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium"
              :class="db.isLocalBbdump ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400' : 'bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400'"
            >{{ db.isLocalBbdump ? 'local' : 'external' }}</span>
            <span
              v-if="otherProjectOf(db.id)"
              class="shrink-0 text-[10px] text-gray-400 dark:text-zinc-500 max-w-[8rem] overflow-hidden text-ellipsis whitespace-nowrap"
              :title="t('project.inProject', { name: otherProjectOf(db.id)!.name })"
            >{{ t('project.inProject', { name: otherProjectOf(db.id)!.masked ? '••••' : otherProjectOf(db.id)!.name }) }}</span>
          </label>
        </div>
        <p v-else class="text-[12px] text-gray-400 dark:text-zinc-500">{{ t('project.noDatabases') }}</p>
      </FormField>
    </div>

    <template #footer>
      <button type="button" :class="btnGhost" :disabled="isLoading" @click="close">{{ t('project.cancel') }}</button>
      <span class="flex-1" />
      <span class="hidden sm:inline text-[11px] text-gray-400 dark:text-zinc-500"><kbd class="font-mono">↵</kbd> Enter</span>
      <button type="button" :class="btnPrimary" :disabled="isLoading" @click="save">{{ t('project.save') }}</button>
    </template>
  </AppModal>
</template>

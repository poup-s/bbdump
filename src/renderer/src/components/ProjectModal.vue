<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { getErrorMessage } from '../utils';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';

const { t } = useI18n();
const { addToast } = useToast();

const isEditing = computed(() => !!store.editingProject);
const isLoading = ref(false);

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

onMounted(() => {
  if (store.editingProject) {
    form.value = {
      name: store.editingProject.name,
      color: store.editingProject.color,
      databaseIds: [...store.editingProject.databaseIds],
    };
  }
});

const close = () => {
  store.showProjectModal = false;
  store.editingProject = null;
};

const toggleDatabase = (dbId: string) => {
  const idx = form.value.databaseIds.indexOf(dbId);
  if (idx === -1) {
    form.value.databaseIds.push(dbId);
  } else {
    form.value.databaseIds.splice(idx, 1);
  }
};

const save = async () => {
  if (!form.value.name.trim()) return;

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
      addToast(t('project.updated', { name: form.value.name }), 'success');
    } else {
      await ipcRenderer.invoke('add-project', projectData);
      addToast(t('project.created', { name: form.value.name }), 'success');
    }

    const config = await ipcRenderer.invoke('get-config');
    store.projects = config.projects || [];
    close();
  } catch (error) {
    addToast('Error saving project: ' + getErrorMessage(error), 'error');
  } finally {
    isLoading.value = false;
  }
};
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
    <div
      class="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl max-w-lg w-full border border-border overflow-hidden flex flex-col max-h-[90vh]"
      @click.stop
    >
      <!-- Header -->
      <div class="px-6 py-4 border-b border-border flex justify-between items-center bg-surface">
        <h3 class="text-xl font-bold">{{ isEditing ? t('project.editProject') : t('project.newProject') }}</h3>
        <button @click="close" class="text-gray-500 hover:text-foreground transition-colors">
          <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="p-6 overflow-y-auto space-y-6 custom-scrollbar flex-1">
        <!-- Project Name -->
        <div>
          <label class="block text-sm font-medium mb-2">{{ t('project.name') }}</label>
          <input
            v-model="form.name"
            type="text"
            :placeholder="t('project.namePlaceholder')"
            class="w-full px-4 py-2.5 rounded-xl border border-border bg-white dark:bg-zinc-800 text-foreground focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
          />
        </div>

        <!-- Color Picker -->
        <div>
          <label class="block text-sm font-medium mb-2">{{ t('project.color') }}</label>
          <div class="flex gap-2 flex-wrap">
            <button
              v-for="color in colors"
              :key="color"
              @click="form.color = color"
              class="w-8 h-8 rounded-full transition-all duration-200 hover:scale-110"
              :class="[
                color,
                form.color === color
                  ? 'ring-2 ring-offset-2 ring-offset-white dark:ring-offset-zinc-900 ring-gray-900 dark:ring-white scale-110'
                  : 'opacity-60 hover:opacity-100'
              ]"
            />
          </div>
        </div>

        <!-- Database Selection -->
        <div>
          <label class="block text-sm font-medium mb-2">{{ t('project.selectDatabases') }}</label>
          <div class="space-y-1 max-h-60 overflow-y-auto custom-scrollbar border border-border rounded-xl p-2">
            <label
              v-for="db in store.databases"
              :key="db.id"
              class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface cursor-pointer transition-colors"
            >
              <input
                type="checkbox"
                :checked="form.databaseIds.includes(db.id)"
                @change="toggleDatabase(db.id)"
                class="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-sm font-medium truncate">{{ db.displayName || db.name }}</span>
                <span v-if="db.isLocalBbdump" class="text-[10px] px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 rounded-md shrink-0">
                  local
                </span>
                <span v-else class="text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-500 rounded-md shrink-0">
                  {{ db.host }}
                </span>
              </div>
            </label>
            <div v-if="store.databases.length === 0" class="text-center py-4 text-sm text-gray-400">
              {{ t('project.noDatabases') }}
            </div>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="px-6 py-4 border-t border-border flex justify-end gap-3 bg-surface">
        <button
          @click="close"
          class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-xl transition-colors"
        >
          {{ t('project.cancel') }}
        </button>
        <button
          @click="save"
          :disabled="!form.name.trim() || isLoading"
          class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ t('project.save') }}
        </button>
      </div>
    </div>
  </div>
</template>

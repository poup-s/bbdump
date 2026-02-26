<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from '../composables/useI18n';
import { Database, Project } from '../types';
import DatabaseCardCompact from './DatabaseCardCompact.vue';

const props = defineProps<{
  project: Project;
  databases: Database[];
  dbSizes?: Record<string, number | null>;
}>();

const emit = defineEmits<{
  (e: 'edit', project: Project): void;
  (e: 'delete', project: Project): void;
  (e: 'toggle-project-mask', project: Project): void;
  (e: 'move-db-to-project', databaseId: string, targetProjectId: string): void;
  (e: 'backup', db: Database): void;
  (e: 'view', db: Database): void;
  (e: 'duplicate', db: Database): void;
  (e: 'edit-db', db: Database): void;
  (e: 'delete-db', db: Database): void;
  (e: 'disconnect', db: Database): void;
  (e: 'copy-url', db: Database): void;
  (e: 'addons', db: Database): void;
  (e: 'toggle-mask', db: Database): void;
}>();

const { t } = useI18n();
const collapsed = ref(props.project.collapsed || false);
const isDragOver = ref(false);

const toggle = () => {
  collapsed.value = !collapsed.value;
};

// --- Drag: project header (for reordering) ---
const onProjectDragStart = (event: DragEvent) => {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-bbdump-project', props.project.id);
};

// --- Drop zone: receive databases ---
const onDragOver = (event: DragEvent) => {
  if (!event.dataTransfer?.types.includes('application/x-bbdump-db')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  isDragOver.value = true;
};

const onDragLeave = (event: DragEvent) => {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const { clientX, clientY } = event;
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    isDragOver.value = false;
  }
};

const onDrop = (event: DragEvent) => {
  event.preventDefault();
  isDragOver.value = false;
  const data = event.dataTransfer?.getData('application/x-bbdump-db');
  if (!data) return;
  const { databaseId, sourceProjectId } = JSON.parse(data);
  if (sourceProjectId === props.project.id) return; // Already in this project
  emit('move-db-to-project', databaseId, props.project.id);
};
</script>

<template>
  <div
    class="mb-6 rounded-xl transition-all duration-200"
    :class="{ 'ring-2 ring-blue-400 ring-offset-2 ring-offset-white dark:ring-offset-zinc-900 bg-blue-50/50 dark:bg-blue-900/10': isDragOver }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Project Header (draggable for reorder) -->
    <div
      draggable="true"
      @dragstart.stop="onProjectDragStart"
      class="flex items-center justify-between px-4 py-3 rounded-xl cursor-grab active:cursor-grabbing select-none transition-colors hover:bg-gray-50 dark:hover:bg-zinc-800/50"
      @click="toggle"
    >
      <div class="flex items-center gap-3">
        <!-- Color dot -->
        <div class="w-3 h-3 rounded-full shrink-0" :class="project.color" />
        <!-- Name -->
        <h3 class="text-lg font-semibold text-gray-700 dark:text-gray-300">{{ project.masked ? '••••••••' : project.name }}</h3>
        <!-- DB count -->
        <span class="text-xs font-medium text-gray-500 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full">
          {{ databases.length }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <!-- Mask toggle -->
        <button
          @click.stop="emit('toggle-project-mask', project)"
          class="p-1.5 rounded-lg transition-colors"
          :class="project.masked
            ? 'text-purple-500 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20'
            : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-zinc-700'"
          :title="project.masked ? t('cardAction.unmask') : t('cardAction.mask')"
        >
          <svg v-if="project.masked" class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path fill-rule="evenodd" d="M1 12c2.028-4.152 6.192-7 11-7s8.972 2.848 11 7c-2.028 4.152-6.192 7-11 7s-8.972-2.848-11-7m11 3.5a3.5 3.5 0 1 0 0-7a3.5 3.5 0 0 0 0 7" />
          </svg>
          <svg v-else class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path fill-rule="evenodd" d="m18.922 16.8l3.17 3.17l-1.06 1.061L4.06 4.061L5.12 3l2.74 2.738A11.9 11.9 0 0 1 12 5c4.808 0 8.972 2.848 11 7a12.66 12.66 0 0 1-4.078 4.8m-8.098-8.097l4.473 4.473a3.5 3.5 0 0 0-4.474-4.474zm5.317 9.56A11.9 11.9 0 0 1 12 19c-4.808 0-8.972-2.848-11-7a12.66 12.66 0 0 1 4.078-4.8l3.625 3.624a3.5 3.5 0 0 0 4.474 4.474l2.964 2.964z" />
          </svg>
        </button>
        <!-- Edit -->
        <button
          @click.stop="emit('edit', project)"
          class="p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          :title="t('project.editProject')"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </button>
        <!-- Delete -->
        <button
          @click.stop="emit('delete', project)"
          class="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-400 hover:text-red-500 transition-colors"
          :title="t('project.deleteProject')"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
        <!-- Chevron -->
        <svg
          class="w-5 h-5 text-gray-400 transition-transform duration-200"
          :class="{ '-rotate-90': collapsed }"
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </div>
    </div>

    <!-- Collapsible Content -->
    <div
      class="overflow-hidden transition-all duration-300 ease-in-out"
      :style="{ maxHeight: collapsed ? '0px' : '2000px', opacity: collapsed ? 0 : 1 }"
    >
      <div v-if="databases.length > 0" class="flex flex-col gap-1.5 mt-3 px-1">
        <DatabaseCardCompact
          v-for="db in databases"
          :key="db.id"
          :db="db"
          :project-id="project.id"
          :size="dbSizes?.[db.id]"
          @backup="emit('backup', $event)"
          @view="emit('view', $event)"
          @duplicate="emit('duplicate', $event)"
          @edit="emit('edit-db', $event)"
          @delete="emit('delete-db', $event)"
          @disconnect="emit('disconnect', $event)"
          @copy-url="emit('copy-url', $event)"
          @addons="emit('addons', $event)"
          @toggle-mask="emit('toggle-mask', $event)"
        />
      </div>
      <div v-else class="text-center py-8 text-sm text-gray-400">
        {{ t('project.noDatabases') }}
      </div>
    </div>
  </div>
</template>

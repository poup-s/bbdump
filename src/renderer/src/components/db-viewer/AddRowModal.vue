<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { useToast } from '../../composables/useToast';
import { ipcRenderer } from '../../electron';
import { Database } from '../../types';

const props = defineProps<{
  db: Database | null;
  table: string | null;
  show: boolean;
}>();

const emit = defineEmits(['close', 'added']);

const { t } = useI18n();
const { addToast } = useToast();

const columns = ref<any[]>([]);
const formData = ref<Record<string, any>>({});
const loading = ref(false);
const submitting = ref(false);

const loadSchema = async () => {
  if (!props.db || !props.table) return;
  
  loading.value = true;
  try {
    const dbConfig = {
      name: props.db.name,
      host: props.db.host,
      port: props.db.port,
      user: props.db.user,
      password: props.db.password,
      connectionString: props.db.connectionString
    };
    
    const result = await ipcRenderer.invoke('get-table-schema', {
      db: dbConfig,
      table: props.table
    });
    
    columns.value = result.columns;
    
    // Initialize form data with defaults
    formData.value = {};
    columns.value.forEach(col => {
      if (col.column_default) {
        formData.value[col.column_name] = null; // Let DB handle defaults
      } else if (col.is_nullable === 'NO' && !col.is_primary) {
        formData.value[col.column_name] = '';
      }
    });
  } catch (err: any) {
    console.error('Error loading schema:', err);
    addToast('Error loading schema: ' + err.message, 'error');
  } finally {
    loading.value = false;
  }
};

const requiredColumns = computed(() => {
  return columns.value.filter(col => 
    col.is_nullable === 'NO' && 
    !col.is_primary && 
    !col.column_default
  );
});

const editableColumns = computed(() => {
  return columns.value.filter(col => !col.is_primary);
});

const handleSubmit = async () => {
  // Validate required fields
  const missingFields = requiredColumns.value.filter(col => 
    !formData.value[col.column_name] || 
    formData.value[col.column_name] === ''
  );
  
  if (missingFields.length > 0) {
    addToast(`Required fields missing: ${missingFields.map(f => f.column_name).join(', ')}`, 'error');
    return;
  }
  
  submitting.value = true;
  try {
    const dbConfig = {
      name: props.db!.name,
      host: props.db!.host,
      port: props.db!.port,
      user: props.db!.user,
      password: props.db!.password,
      connectionString: props.db!.connectionString
    };
    
    await ipcRenderer.invoke('insert-table-row', {
      db: dbConfig,
      table: props.table,
      rowData: formData.value
    });
    
    addToast(t('viewer.addRowSuccess'), 'success');
    emit('added');
    emit('close');
  } catch (err: any) {
    console.error('Error adding row:', err);
    addToast('Error adding row: ' + err.message, 'error');
  } finally {
    submitting.value = false;
  }
};

const getInputType = (dataType: string) => {
  if (dataType.includes('int') || dataType.includes('serial')) return 'number';
  if (dataType.includes('bool')) return 'checkbox';
  if (dataType.includes('date') || dataType.includes('timestamp')) return 'datetime-local';
  return 'text';
};

// Watch for modal opening and load schema
watch(() => props.show, (newVal) => {
  if (newVal) {
    loadSchema();
  } else {
    // Reset form when closing
    columns.value = [];
    formData.value = {};
  }
});
</script>

<template>
  <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
    <div class="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden border border-white/10 ring-1 ring-black/5">
      <!-- Header -->
      <div class="px-6 py-4 border-b border-gray-200 dark:border-zinc-800 flex justify-between items-center bg-gray-50/50 dark:bg-zinc-900/50 backdrop-blur-xl">
        <div>
          <h3 class="text-lg font-bold text-gray-900 dark:text-white">{{ t('viewer.addRowTitle') }}</h3>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{{ table }}</p>
        </div>
        <button 
          @click="emit('close')" 
          class="p-2 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all duration-200"
        >
          <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Body -->
      <div class="flex-1 overflow-y-auto p-6">
        <div v-if="loading" class="flex items-center justify-center py-12">
          <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
        </div>

        <div v-else class="space-y-4">
          <div v-for="col in editableColumns" :key="col.column_name" class="space-y-1.5">
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {{ col.column_name }}
              <span v-if="col.is_nullable === 'NO' && !col.column_default" class="text-red-500">*</span>
              <span class="text-xs text-gray-400 dark:text-gray-500 font-normal ml-2">{{ col.data_type }}</span>
            </label>
            
            <input
              v-if="getInputType(col.data_type) !== 'checkbox'"
              v-model="formData[col.column_name]"
              :type="getInputType(col.data_type)"
              :placeholder="col.column_default || `Enter ${col.column_name}`"
              :required="col.is_nullable === 'NO' && !col.column_default"
              class="w-full px-3 py-2 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all placeholder-gray-400 dark:placeholder-gray-500 text-gray-900 dark:text-white"
            />
            
            <div v-else class="flex items-center">
              <input
                v-model="formData[col.column_name]"
                type="checkbox"
                class="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
              />
              <label class="ml-2 text-sm text-gray-600 dark:text-gray-400">{{ col.column_name }}</label>
            </div>
            
            <p v-if="col.column_default" class="text-xs text-gray-500 dark:text-gray-400">
              Default: {{ col.column_default }}
            </p>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="px-6 py-4 border-t border-gray-200 dark:border-zinc-800 flex justify-end gap-3 bg-gray-50/50 dark:bg-zinc-900/50">
        <button
          @click="emit('close')"
          :disabled="submitting"
          class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
        >
          {{ t('viewer.cancel') }}
        </button>
        <button
          @click="handleSubmit"
          :disabled="submitting || loading"
          class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors shadow-lg shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          <svg v-if="submitting" class="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          {{ t('viewer.addRow') }}
        </button>
      </div>
    </div>
  </div>
</template>

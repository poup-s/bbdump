<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { useToast } from '../../composables/useToast';
import { ipcRenderer } from '../../electron';
import { buildDbConfig, Database } from '../../types';

const props = defineProps<{
  db: Database | null;
}>();

const { t } = useI18n();
const { addToast } = useToast();

// Schema data
interface SchemaColumn {
  table_name: string;
  column_name: string;
  data_type: string;
}
interface SchemaFK {
  source_table: string;
  source_column: string;
  target_table: string;
  target_column: string;
}

const allTables = ref<string[]>([]);
const allColumns = ref<SchemaColumn[]>([]);
const allForeignKeys = ref<SchemaFK[]>([]);
const schemaLoaded = ref(false);

// Block types
type BlockType = 'select' | 'from' | 'join' | 'where' | 'groupBy' | 'orderBy' | 'limit';

interface SelectBlock {
  type: 'select';
  columns: string[]; // ['*'] or ['table.col', ...]
  distinct: boolean;
}

interface FromBlock {
  type: 'from';
  table: string;
}

interface JoinBlock {
  type: 'join';
  joinType: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL';
  table: string;
  onLeft: string;
  onRight: string;
}

interface WhereCondition {
  column: string;
  operator: string;
  value: string;
  connector: 'AND' | 'OR';
}

interface WhereBlock {
  type: 'where';
  conditions: WhereCondition[];
}

interface GroupByBlock {
  type: 'groupBy';
  columns: string[];
}

interface OrderByBlock {
  type: 'orderBy';
  columns: { column: string; direction: 'ASC' | 'DESC' }[];
}

interface LimitBlock {
  type: 'limit';
  value: number;
}

type Block = SelectBlock | FromBlock | JoinBlock | WhereBlock | GroupByBlock | OrderByBlock | LimitBlock;

// State
const blocks = ref<Block[]>([
  { type: 'select', columns: ['*'], distinct: false },
  { type: 'from', table: '' },
  { type: 'limit', value: 100 }
]);

const rawMode = ref(false);
const rawSql = ref('');

const isExecuting = ref(false);
const resultRows = ref<any[]>([]);
const resultFields = ref<string[]>([]);
const resultDuration = ref(0);
const resultTruncated = ref(false);
const resultRowCount = ref(0);
const hasResults = ref(false);
const queryError = ref<string | null>(null);
const showAddMenu = ref(false);

// Query history
const queryHistory = ref<{ sql: string; duration: number; rowCount: number; timestamp: number }[]>([]);
const showHistory = ref(false);

// Derived
const fromTable = computed(() => {
  const fromBlock = blocks.value.find(b => b.type === 'from') as FromBlock | undefined;
  return fromBlock?.table || '';
});

const joinTables = computed(() => {
  return blocks.value.filter(b => b.type === 'join').map(b => (b as JoinBlock).table);
});

const activeTables = computed(() => {
  const tables = [fromTable.value, ...joinTables.value].filter(Boolean);
  return [...new Set(tables)];
});

const activeColumns = computed(() => {
  if (activeTables.value.length === 0) return [];
  return allColumns.value.filter(c => activeTables.value.includes(c.table_name));
});

const columnOptions = computed(() => {
  if (activeTables.value.length <= 1) {
    return activeColumns.value.map(c => c.column_name);
  }
  return activeColumns.value.map(c => `${c.table_name}.${c.column_name}`);
});

const availableBlockTypes = computed(() => {
  const existing = new Set(blocks.value.map(b => b.type));
  const types: { type: BlockType; label: string }[] = [];
  if (!existing.has('where')) types.push({ type: 'where', label: 'WHERE' });
  types.push({ type: 'join', label: 'JOIN' }); // can have multiple
  if (!existing.has('groupBy')) types.push({ type: 'groupBy', label: 'GROUP BY' });
  if (!existing.has('orderBy')) types.push({ type: 'orderBy', label: 'ORDER BY' });
  if (!existing.has('limit')) types.push({ type: 'limit', label: 'LIMIT' });
  return types;
});

// FK suggestions for JOINs
const getFkSuggestions = (joinTable: string) => {
  if (!fromTable.value || !joinTable) return [];
  const suggestions: { left: string; right: string }[] = [];
  for (const fk of allForeignKeys.value) {
    if (fk.source_table === fromTable.value && fk.target_table === joinTable) {
      suggestions.push({ left: `${fk.source_table}.${fk.source_column}`, right: `${fk.target_table}.${fk.target_column}` });
    }
    if (fk.source_table === joinTable && fk.target_table === fromTable.value) {
      suggestions.push({ left: `${fk.target_table}.${fk.target_column}`, right: `${fk.source_table}.${fk.source_column}` });
    }
  }
  return suggestions;
};

// Build SQL
const generatedSql = computed(() => {
  const selectBlock = blocks.value.find(b => b.type === 'select') as SelectBlock | undefined;
  const fromBlock = blocks.value.find(b => b.type === 'from') as FromBlock | undefined;
  const joinBlocks = blocks.value.filter(b => b.type === 'join') as JoinBlock[];
  const whereBlock = blocks.value.find(b => b.type === 'where') as WhereBlock | undefined;
  const groupByBlock = blocks.value.find(b => b.type === 'groupBy') as GroupByBlock | undefined;
  const orderByBlock = blocks.value.find(b => b.type === 'orderBy') as OrderByBlock | undefined;
  const limitBlock = blocks.value.find(b => b.type === 'limit') as LimitBlock | undefined;

  if (!fromBlock?.table) return '';

  const parts: string[] = [];

  // SELECT
  const distinct = selectBlock?.distinct ? 'DISTINCT ' : '';
  const cols = selectBlock?.columns?.length ? selectBlock.columns.join(', ') : '*';
  parts.push(`SELECT ${distinct}${cols}`);

  // FROM
  parts.push(`FROM "${fromBlock.table}"`);

  // JOINs
  for (const join of joinBlocks) {
    if (join.table && join.onLeft && join.onRight) {
      parts.push(`${join.joinType} JOIN "${join.table}" ON ${join.onLeft} = ${join.onRight}`);
    }
  }

  // WHERE
  if (whereBlock?.conditions.length) {
    const validConditions = whereBlock.conditions.filter(c => c.column && c.operator);
    if (validConditions.length > 0) {
      const whereParts = validConditions.map((c, i) => {
        const prefix = i > 0 ? `${c.connector} ` : '';
        if (c.operator === 'IS NULL' || c.operator === 'IS NOT NULL') {
          return `${prefix}${c.column} ${c.operator}`;
        }
        const val = c.value;
        // Detect if value looks like a number
        const isNum = val !== '' && !isNaN(Number(val));
        const quotedVal = isNum ? val : `'${val.replace(/'/g, "''")}'`;
        return `${prefix}${c.column} ${c.operator} ${quotedVal}`;
      });
      parts.push(`WHERE ${whereParts.join(' ')}`);
    }
  }

  // GROUP BY
  if (groupByBlock?.columns.length) {
    parts.push(`GROUP BY ${groupByBlock.columns.join(', ')}`);
  }

  // ORDER BY
  if (orderByBlock?.columns.length) {
    const orderParts = orderByBlock.columns
      .filter(c => c.column)
      .map(c => `${c.column} ${c.direction}`);
    if (orderParts.length) parts.push(`ORDER BY ${orderParts.join(', ')}`);
  }

  // LIMIT
  if (limitBlock) {
    parts.push(`LIMIT ${limitBlock.value}`);
  }

  return parts.join('\n');
});

const activeSql = computed(() => rawMode.value ? rawSql.value.trim() : generatedSql.value);

// Actions
const loadSchema = async () => {
  if (!props.db) return;
  try {
    const result = await ipcRenderer.invoke('get-db-full-schema', { db: buildDbConfig(props.db) });
    allTables.value = result.tables.map((t: any) => t.name);
    allColumns.value = result.columns;
    allForeignKeys.value = result.foreignKeys;
    schemaLoaded.value = true;
  } catch (err: any) {
    console.error('Failed to load schema:', err);
  }
};

const addBlock = (type: BlockType) => {
  showAddMenu.value = false;
  const limitIdx = blocks.value.findIndex(b => b.type === 'limit');

  let newBlock: Block;
  switch (type) {
    case 'join':
      newBlock = { type: 'join', joinType: 'LEFT', table: '', onLeft: '', onRight: '' };
      break;
    case 'where':
      newBlock = { type: 'where', conditions: [{ column: '', operator: '=', value: '', connector: 'AND' }] };
      break;
    case 'groupBy':
      newBlock = { type: 'groupBy', columns: [] };
      break;
    case 'orderBy':
      newBlock = { type: 'orderBy', columns: [{ column: '', direction: 'ASC' }] };
      break;
    case 'limit':
      newBlock = { type: 'limit', value: 100 };
      break;
    default:
      return;
  }

  if (limitIdx >= 0) {
    blocks.value.splice(limitIdx, 0, newBlock);
  } else {
    blocks.value.push(newBlock);
  }
};

const removeBlock = (index: number) => {
  const block = blocks.value[index];
  if (block.type === 'select' || block.type === 'from') return;
  blocks.value.splice(index, 1);
};

const addSelectColumn = () => {
  const selectBlock = blocks.value.find(b => b.type === 'select') as SelectBlock;
  if (!selectBlock) return;
  if (selectBlock.columns.length === 1 && selectBlock.columns[0] === '*') {
    selectBlock.columns = [''];
  } else {
    selectBlock.columns.push('');
  }
};

const removeSelectColumn = (idx: number) => {
  const selectBlock = blocks.value.find(b => b.type === 'select') as SelectBlock;
  if (!selectBlock) return;
  selectBlock.columns.splice(idx, 1);
  if (selectBlock.columns.length === 0) selectBlock.columns = ['*'];
};

const addWhereCondition = (block: WhereBlock) => {
  block.conditions.push({ column: '', operator: '=', value: '', connector: 'AND' });
};

const removeWhereCondition = (block: WhereBlock, idx: number) => {
  block.conditions.splice(idx, 1);
  if (block.conditions.length === 0) {
    const blockIdx = blocks.value.indexOf(block);
    if (blockIdx >= 0) blocks.value.splice(blockIdx, 1);
  }
};

const addOrderByColumn = (block: OrderByBlock) => {
  block.columns.push({ column: '', direction: 'ASC' });
};

const removeOrderByColumn = (block: OrderByBlock, idx: number) => {
  block.columns.splice(idx, 1);
  if (block.columns.length === 0) {
    const blockIdx = blocks.value.indexOf(block);
    if (blockIdx >= 0) blocks.value.splice(blockIdx, 1);
  }
};

const executeQuery = async () => {
  const sql = activeSql.value;
  if (!props.db || !sql) return;
  isExecuting.value = true;
  queryError.value = null;
  hasResults.value = false;

  try {
    const result = await ipcRenderer.invoke('execute-sql', {
      db: buildDbConfig(props.db),
      sql,
      maxRows: 5000,
      timeoutMs: 60000
    });

    resultRows.value = result.rows;
    resultFields.value = result.fields;
    resultDuration.value = result.duration;
    resultTruncated.value = result.truncated;
    resultRowCount.value = result.rowCount ?? result.rows.length;
    hasResults.value = true;

    queryHistory.value.unshift({
      sql,
      duration: result.duration,
      rowCount: result.rowCount ?? result.rows.length,
      timestamp: Date.now()
    });
    if (queryHistory.value.length > 20) queryHistory.value.pop();
  } catch (err: any) {
    queryError.value = err.message || 'Query failed';
  } finally {
    isExecuting.value = false;
  }
};

const exportCSV = () => {
  if (resultRows.value.length === 0 || resultFields.value.length === 0) return;

  const escape = (val: any) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  const header = resultFields.value.map(escape).join(',');
  const rows = resultRows.value.map(row =>
    resultFields.value.map(f => escape(row[f])).join(',')
  );
  const csv = [header, ...rows].join('\n');

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `query_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  addToast(t('viewer.exportSuccess', { count: resultRows.value.length, filename: a.download }), 'success');
};

const handleJoinTableChange = (join: JoinBlock) => {
  const suggestions = getFkSuggestions(join.table);
  if (suggestions.length > 0) {
    join.onLeft = suggestions[0].left;
    join.onRight = suggestions[0].right;
  }
};

const resetBlocks = () => {
  blocks.value = [
    { type: 'select', columns: ['*'], distinct: false },
    { type: 'from', table: '' },
    { type: 'limit', value: 100 }
  ];
  hasResults.value = false;
  queryError.value = null;
  resultRows.value = [];
  resultFields.value = [];
};

const loadFromHistory = (entry: { sql: string }) => {
  showHistory.value = false;
  if (rawMode.value) {
    rawSql.value = entry.sql;
  } else {
    navigator.clipboard.writeText(entry.sql);
    addToast(t('viewer.sqlHistoryCopied'), 'info');
  }
};

const toggleRawMode = () => {
  if (!rawMode.value && generatedSql.value) {
    rawSql.value = generatedSql.value;
  }
  rawMode.value = !rawMode.value;
};

const operators = ['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'ILIKE', 'IN', 'IS NULL', 'IS NOT NULL'];

// When FROM table changes, reset columns that reference the old table
watch(fromTable, () => {
  const selectBlock = blocks.value.find(b => b.type === 'select') as SelectBlock | undefined;
  if (selectBlock && selectBlock.columns[0] !== '*') {
    selectBlock.columns = ['*'];
  }
});

onMounted(() => {
  loadSchema();
});
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- Header -->
    <div class="px-4 py-2.5 border-b border-gray-200 dark:border-zinc-800 bg-gray-50/50 dark:bg-surface/30 flex items-center justify-between shrink-0">
      <div class="flex items-center gap-2">
        <div class="w-6 h-6 rounded-lg bg-violet-500/10 text-violet-500 flex items-center justify-center">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>
        <h3 class="text-sm font-bold text-gray-900 dark:text-white">{{ t('viewer.sqlBuilder') }}</h3>
        <!-- Info icon -->
        <div class="relative group/info">
          <div class="p-0.5 rounded-full text-gray-300 dark:text-gray-600 group-hover/info:text-violet-500 dark:group-hover/info:text-violet-400 transition-colors cursor-help">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div class="absolute left-0 top-full mt-1.5 w-64 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-xl shadow-xl z-20 p-3 space-y-2 opacity-0 invisible group-hover/info:opacity-100 group-hover/info:visible translate-y-1 group-hover/info:translate-y-0 transition-all duration-150 pointer-events-none group-hover/info:pointer-events-auto">
            <div class="flex items-center gap-1.5 mb-1">
              <svg class="w-3.5 h-3.5 text-emerald-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              <span class="text-[11px] font-bold text-gray-900 dark:text-white">{{ t('viewer.sqlSafetyTitle') }}</span>
            </div>
            <ul class="space-y-1.5">
              <li class="flex items-start gap-1.5 text-[11px] text-gray-600 dark:text-gray-400">
                <span class="text-emerald-500 mt-px shrink-0">&#10003;</span>
                <span>{{ t('viewer.sqlSafetyReadOnly') }}</span>
              </li>
              <li class="flex items-start gap-1.5 text-[11px] text-gray-600 dark:text-gray-400">
                <span class="text-emerald-500 mt-px shrink-0">&#10003;</span>
                <span>{{ t('viewer.sqlSafetyTimeout') }}</span>
              </li>
              <li class="flex items-start gap-1.5 text-[11px] text-gray-600 dark:text-gray-400">
                <span class="text-emerald-500 mt-px shrink-0">&#10003;</span>
                <span>{{ t('viewer.sqlSafetyLimit') }}</span>
              </li>
              <li class="flex items-start gap-1.5 text-[11px] text-gray-600 dark:text-gray-400">
                <span class="text-emerald-500 mt-px shrink-0">&#10003;</span>
                <span>{{ t('viewer.sqlSafetyRollback') }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <!-- Raw SQL toggle -->
        <label class="flex items-center gap-2 cursor-pointer select-none">
          <span class="text-[11px] font-medium" :class="rawMode ? 'text-violet-600 dark:text-violet-400' : 'text-gray-400'">SQL</span>
          <button
            @click="toggleRawMode"
            class="relative w-8 h-[18px] rounded-full transition-colors duration-200"
            :class="rawMode ? 'bg-violet-500' : 'bg-gray-300 dark:bg-zinc-600'"
          >
            <span
              class="absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform duration-200"
              :class="rawMode ? 'translate-x-[14px]' : 'translate-x-0'"
            ></span>
          </button>
        </label>
        <div class="w-px h-4 bg-gray-200 dark:bg-zinc-700"></div>
        <!-- History -->
        <button
          @click="showHistory = !showHistory"
          class="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors relative"
          :title="t('viewer.sqlHistory')"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span v-if="queryHistory.length > 0" class="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-violet-500 text-white text-[8px] font-bold rounded-full flex items-center justify-center">
            {{ queryHistory.length }}
          </span>
        </button>
        <!-- Reset -->
        <button
          @click="resetBlocks"
          class="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
          :title="t('viewer.sqlReset')"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Body -->
    <div class="flex-1 flex overflow-hidden">
      <!-- Left Panel -->
      <div
        :class="rawMode ? 'flex-1' : 'w-[420px]'"
        class="shrink-0 border-r border-gray-200 dark:border-zinc-800 flex flex-col overflow-hidden bg-gray-50 dark:bg-transparent"
      >
        <!-- Raw SQL mode -->
        <template v-if="rawMode">
          <div class="flex-1 flex flex-col overflow-hidden">
            <textarea
              v-model="rawSql"
              class="flex-1 w-full p-4 bg-zinc-900 dark:bg-black/50 text-emerald-400 font-mono text-[13px] leading-relaxed resize-none focus:outline-none placeholder-gray-600"
              :placeholder="t('viewer.sqlRawPlaceholder')"
              spellcheck="false"
              @keydown.meta.enter="executeQuery"
              @keydown.ctrl.enter="executeQuery"
            ></textarea>
          </div>
          <!-- Execute bar (raw) -->
          <div class="p-3 border-t border-gray-200 dark:border-zinc-800 bg-gray-50/50 dark:bg-surface/30 shrink-0">
            <button
              @click="executeQuery"
              :disabled="!activeSql || isExecuting"
              class="w-full py-2 bg-violet-600 hover:bg-violet-700 disabled:bg-gray-300 dark:disabled:bg-zinc-700 text-white rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-2 shadow-lg shadow-violet-500/20 disabled:shadow-none"
            >
              <svg v-if="isExecuting" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <svg v-else class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {{ isExecuting ? t('viewer.sqlExecuting') : t('viewer.sqlExecute') }}
              <span class="text-[10px] opacity-60 ml-1">⌘↵</span>
            </button>
          </div>
        </template>

        <!-- Block builder mode -->
        <template v-else>
        <div class="flex-1 overflow-y-auto p-3 space-y-2">
          <!-- Blocks -->
          <div
            v-for="(block, idx) in blocks"
            :key="idx"
            class="rounded-xl border-2 transition-all duration-200 shadow-sm"
            :class="{
              'border-blue-300 dark:border-blue-800/50 bg-blue-50 dark:bg-blue-500/5': block.type === 'select',
              'border-emerald-300 dark:border-emerald-800/50 bg-emerald-50 dark:bg-emerald-500/5': block.type === 'from',
              'border-purple-300 dark:border-purple-800/50 bg-purple-50 dark:bg-purple-500/5': block.type === 'join',
              'border-amber-300 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-500/5': block.type === 'where',
              'border-cyan-300 dark:border-cyan-800/50 bg-cyan-50 dark:bg-cyan-500/5': block.type === 'groupBy',
              'border-pink-300 dark:border-pink-800/50 bg-pink-50 dark:bg-pink-500/5': block.type === 'orderBy',
              'border-gray-300 dark:border-zinc-700 bg-gray-100 dark:bg-zinc-800/30': block.type === 'limit',
            }"
          >
            <!-- Block header -->
            <div class="flex items-center justify-between px-3 py-1.5">
              <span
                class="text-[10px] font-bold uppercase tracking-wider"
                :class="{
                  'text-blue-600 dark:text-blue-400': block.type === 'select',
                  'text-emerald-600 dark:text-emerald-400': block.type === 'from',
                  'text-purple-600 dark:text-purple-400': block.type === 'join',
                  'text-amber-600 dark:text-amber-400': block.type === 'where',
                  'text-cyan-600 dark:text-cyan-400': block.type === 'groupBy',
                  'text-pink-600 dark:text-pink-400': block.type === 'orderBy',
                  'text-gray-500 dark:text-gray-400': block.type === 'limit',
                }"
              >
                {{ block.type === 'groupBy' ? 'GROUP BY' : block.type === 'orderBy' ? 'ORDER BY' : block.type === 'join' ? (block as JoinBlock).joinType + ' JOIN' : block.type.toUpperCase() }}
              </span>
              <button
                v-if="block.type !== 'select' && block.type !== 'from'"
                @click="removeBlock(idx)"
                class="p-0.5 rounded text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 transition-colors"
              >
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <!-- Block content -->
            <div class="px-3 pb-2.5">
              <!-- SELECT block -->
              <template v-if="block.type === 'select'">
                <div class="space-y-1.5">
                  <label class="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                    <input type="checkbox" v-model="(block as SelectBlock).distinct" class="w-3 h-3 rounded border-gray-300 dark:border-zinc-600 text-blue-500" />
                    DISTINCT
                  </label>
                  <div v-for="(col, ci) in (block as SelectBlock).columns" :key="ci" class="flex items-center gap-1.5">
                    <select
                      :value="col"
                      @change="(block as SelectBlock).columns[ci] = ($event.target as HTMLSelectElement).value"
                      class="flex-1 text-xs bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500/30 shadow-sm"
                    >
                      <option value="*">*</option>
                      <option v-for="c in columnOptions" :key="c" :value="c">{{ c }}</option>
                    </select>
                    <button
                      v-if="(block as SelectBlock).columns.length > 1"
                      @click="removeSelectColumn(ci)"
                      class="p-0.5 text-gray-300 dark:text-gray-600 hover:text-red-500 transition-colors shrink-0"
                    >
                      <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <button
                    @click="addSelectColumn"
                    class="text-[11px] text-blue-500 hover:text-blue-600 font-medium flex items-center gap-0.5"
                  >
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                    </svg>
                    {{ t('viewer.sqlAddColumn') }}
                  </button>
                </div>
              </template>

              <!-- FROM block -->
              <template v-if="block.type === 'from'">
                <select
                  v-model="(block as FromBlock).table"
                  class="w-full text-xs bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 shadow-sm"
                >
                  <option value="" disabled>{{ t('viewer.sqlSelectTable') }}</option>
                  <option v-for="table in allTables" :key="table" :value="table">{{ table }}</option>
                </select>
              </template>

              <!-- JOIN block -->
              <template v-if="block.type === 'join'">
                <div class="space-y-1.5">
                  <div class="flex items-center gap-1.5">
                    <select
                      v-model="(block as JoinBlock).joinType"
                      class="text-xs bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-purple-500/30 shadow-sm w-24"
                    >
                      <option value="INNER">INNER</option>
                      <option value="LEFT">LEFT</option>
                      <option value="RIGHT">RIGHT</option>
                      <option value="FULL">FULL</option>
                    </select>
                    <select
                      v-model="(block as JoinBlock).table"
                      @change="handleJoinTableChange(block as JoinBlock)"
                      class="flex-1 text-xs bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-purple-500/30 shadow-sm"
                    >
                      <option value="" disabled>{{ t('viewer.sqlSelectTable') }}</option>
                      <option v-for="table in allTables.filter(t => t !== fromTable)" :key="table" :value="table">{{ table }}</option>
                    </select>
                  </div>
                  <div class="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                    <span class="font-medium shrink-0">ON</span>
                    <input
                      v-model="(block as JoinBlock).onLeft"
                      type="text"
                      :placeholder="t('viewer.sqlLeftColumn')"
                      class="flex-1 text-xs bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-purple-500/30 shadow-sm"
                    />
                    <span>=</span>
                    <input
                      v-model="(block as JoinBlock).onRight"
                      type="text"
                      :placeholder="t('viewer.sqlRightColumn')"
                      class="flex-1 text-xs bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-purple-500/30 shadow-sm"
                    />
                  </div>
                  <!-- FK suggestions -->
                  <div v-if="(block as JoinBlock).table && getFkSuggestions((block as JoinBlock).table).length > 0" class="flex flex-wrap gap-1">
                    <button
                      v-for="(fk, fi) in getFkSuggestions((block as JoinBlock).table)"
                      :key="fi"
                      @click="(block as JoinBlock).onLeft = fk.left; (block as JoinBlock).onRight = fk.right"
                      class="text-[10px] px-1.5 py-0.5 bg-purple-100 dark:bg-purple-500/10 text-purple-600 dark:text-purple-400 rounded-md hover:bg-purple-200 dark:hover:bg-purple-500/20 transition-colors"
                    >
                      {{ fk.left }} = {{ fk.right }}
                    </button>
                  </div>
                </div>
              </template>

              <!-- WHERE block -->
              <template v-if="block.type === 'where'">
                <div class="space-y-1.5">
                  <div v-for="(cond, ci) in (block as WhereBlock).conditions" :key="ci" class="flex items-center gap-1">
                    <select
                      v-if="ci > 0"
                      v-model="cond.connector"
                      class="text-[10px] bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 rounded px-1.5 py-1 focus:outline-none w-14 font-bold shadow-sm"
                    >
                      <option value="AND">AND</option>
                      <option value="OR">OR</option>
                    </select>
                    <select
                      v-model="cond.column"
                      class="flex-1 text-xs bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-500/30 shadow-sm min-w-0"
                    >
                      <option value="" disabled>{{ t('viewer.column') }}</option>
                      <option v-for="c in columnOptions" :key="c" :value="c">{{ c }}</option>
                    </select>
                    <select
                      v-model="cond.operator"
                      class="text-xs bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 rounded-lg px-1.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-500/30 shadow-sm w-24"
                    >
                      <option v-for="op in operators" :key="op" :value="op">{{ op }}</option>
                    </select>
                    <input
                      v-if="cond.operator !== 'IS NULL' && cond.operator !== 'IS NOT NULL'"
                      v-model="cond.value"
                      type="text"
                      :placeholder="t('viewer.sqlValue')"
                      class="flex-1 text-xs bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-amber-500/30 shadow-sm min-w-0"
                    />
                    <button
                      @click="removeWhereCondition(block as WhereBlock, ci)"
                      class="p-0.5 text-gray-300 dark:text-gray-600 hover:text-red-500 transition-colors shrink-0"
                    >
                      <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <button
                    @click="addWhereCondition(block as WhereBlock)"
                    class="text-[11px] text-amber-500 hover:text-amber-600 font-medium flex items-center gap-0.5"
                  >
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                    </svg>
                    {{ t('viewer.sqlAddCondition') }}
                  </button>
                </div>
              </template>

              <!-- GROUP BY block -->
              <template v-if="block.type === 'groupBy'">
                <div class="flex flex-wrap gap-1.5">
                  <select
                    multiple
                    :value="(block as GroupByBlock).columns"
                    @change="(block as GroupByBlock).columns = [...($event.target as HTMLSelectElement).selectedOptions].map(o => o.value)"
                    class="w-full text-xs bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-cyan-500/30 shadow-sm h-20"
                  >
                    <option v-for="c in columnOptions" :key="c" :value="c">{{ c }}</option>
                  </select>
                </div>
              </template>

              <!-- ORDER BY block -->
              <template v-if="block.type === 'orderBy'">
                <div class="space-y-1.5">
                  <div v-for="(col, ci) in (block as OrderByBlock).columns" :key="ci" class="flex items-center gap-1.5">
                    <select
                      v-model="col.column"
                      class="flex-1 text-xs bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-pink-500/30 shadow-sm"
                    >
                      <option value="" disabled>{{ t('viewer.column') }}</option>
                      <option v-for="c in columnOptions" :key="c" :value="c">{{ c }}</option>
                    </select>
                    <button
                      @click="col.direction = col.direction === 'ASC' ? 'DESC' : 'ASC'"
                      class="text-[10px] font-bold px-2 py-1.5 rounded-lg border transition-colors"
                      :class="col.direction === 'ASC'
                        ? 'bg-pink-50 dark:bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-200 dark:border-pink-800'
                        : 'bg-pink-100 dark:bg-pink-500/20 text-pink-700 dark:text-pink-300 border-pink-300 dark:border-pink-700'"
                    >
                      {{ col.direction }}
                    </button>
                    <button
                      @click="removeOrderByColumn(block as OrderByBlock, ci)"
                      class="p-0.5 text-gray-300 dark:text-gray-600 hover:text-red-500 transition-colors shrink-0"
                    >
                      <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <button
                    @click="addOrderByColumn(block as OrderByBlock)"
                    class="text-[11px] text-pink-500 hover:text-pink-600 font-medium flex items-center gap-0.5"
                  >
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                    </svg>
                    {{ t('viewer.sqlAddColumn') }}
                  </button>
                </div>
              </template>

              <!-- LIMIT block -->
              <template v-if="block.type === 'limit'">
                <div class="flex items-center gap-2">
                  <input
                    v-model.number="(block as LimitBlock).value"
                    type="number"
                    min="1"
                    max="10000"
                    class="w-24 text-xs bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-gray-400/30 shadow-sm"
                  />
                  <div class="flex gap-1">
                    <button
                      v-for="preset in [25, 50, 100, 500]"
                      :key="preset"
                      @click="(block as LimitBlock).value = preset"
                      class="text-[10px] px-1.5 py-0.5 rounded transition-colors"
                      :class="(block as LimitBlock).value === preset
                        ? 'bg-gray-200 dark:bg-zinc-700 text-gray-800 dark:text-gray-200 font-bold'
                        : 'bg-gray-100 dark:bg-zinc-800 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'"
                    >
                      {{ preset }}
                    </button>
                  </div>
                </div>
              </template>
            </div>
          </div>

          <!-- Add block button -->
          <div class="relative">
            <button
              @click="showAddMenu = !showAddMenu"
              :disabled="!fromTable"
              class="w-full py-2 border-2 border-dashed border-gray-300 dark:border-zinc-700 rounded-xl text-xs font-medium text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-400 dark:hover:border-zinc-600 hover:bg-white dark:hover:bg-zinc-800/50 transition-colors flex items-center justify-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
              </svg>
              {{ t('viewer.sqlAddBlock') }}
            </button>

            <!-- Add menu -->
            <Transition
              enter-active-class="transition duration-100 ease-out"
              enter-from-class="opacity-0 scale-95"
              enter-to-class="opacity-100 scale-100"
              leave-active-class="transition duration-75 ease-in"
              leave-from-class="opacity-100 scale-100"
              leave-to-class="opacity-0 scale-95"
            >
              <div
                v-if="showAddMenu"
                class="absolute left-0 right-0 top-full mt-1 bg-white dark:bg-zinc-800 rounded-lg border border-gray-200 dark:border-zinc-700 shadow-lg z-10 py-1"
              >
                <button
                  v-for="bt in availableBlockTypes"
                  :key="bt.type"
                  @click="addBlock(bt.type)"
                  class="w-full px-3 py-1.5 text-left text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-zinc-700/50 transition-colors"
                >
                  {{ bt.label }}
                </button>
              </div>
            </Transition>
            <div v-if="showAddMenu" class="fixed inset-0 z-0" @click="showAddMenu = false"></div>
          </div>
        </div>

        <!-- Execute bar -->
        <div class="p-3 border-t border-gray-200 dark:border-zinc-800 bg-gray-50/50 dark:bg-surface/30 shrink-0">
          <button
            @click="executeQuery"
            :disabled="!generatedSql || isExecuting"
            class="w-full py-2 bg-violet-600 hover:bg-violet-700 disabled:bg-gray-300 dark:disabled:bg-zinc-700 text-white rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-2 shadow-lg shadow-violet-500/20 disabled:shadow-none"
          >
            <svg v-if="isExecuting" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <svg v-else class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {{ isExecuting ? t('viewer.sqlExecuting') : t('viewer.sqlExecute') }}
          </button>
        </div>
        </template>
      </div>

      <!-- Right side: SQL preview + Results -->
      <div class="flex-1 flex flex-col overflow-hidden">
        <!-- SQL Preview (block mode only) -->
        <div v-if="!rawMode" class="shrink-0 border-b border-gray-200 dark:border-zinc-800 bg-zinc-900 dark:bg-black/50">
          <div class="flex items-center justify-between px-3 py-1.5">
            <span class="text-[10px] font-bold uppercase tracking-wider text-gray-500">SQL</span>
            <button
              v-if="generatedSql"
              @click="navigator.clipboard.writeText(generatedSql); addToast(t('viewer.queryCopied'), 'success')"
              class="text-[10px] text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1"
            >
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              {{ t('viewer.copySql') }}
            </button>
          </div>
          <pre class="px-3 pb-2.5 text-[11px] font-mono text-emerald-400 leading-relaxed whitespace-pre-wrap max-h-32 overflow-y-auto">{{ generatedSql || t('viewer.sqlPlaceholder') }}</pre>
        </div>

        <!-- Results area -->
        <div class="flex-1 overflow-hidden flex flex-col">
          <!-- Error -->
          <div v-if="queryError" class="m-3 p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl">
            <div class="flex items-start gap-2">
              <svg class="w-4 h-4 text-red-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div>
                <p class="text-xs font-bold text-red-700 dark:text-red-400">{{ t('viewer.sqlError') }}</p>
                <p class="text-[11px] text-red-600 dark:text-red-400/80 mt-0.5 font-mono">{{ queryError }}</p>
              </div>
            </div>
          </div>

          <!-- Results table -->
          <template v-if="hasResults && !queryError">
            <!-- Stats bar -->
            <div class="px-3 py-1.5 border-b border-gray-200 dark:border-zinc-800 flex items-center gap-3 text-[11px] text-gray-500 dark:text-gray-400 shrink-0 bg-gray-50/50 dark:bg-surface/30">
              <span class="flex items-center gap-1">
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                </svg>
                {{ resultRows.length }}{{ resultTruncated ? '+' : '' }} {{ t('viewer.sqlRows') }}
              </span>
              <span class="flex items-center gap-1">
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {{ resultDuration }}ms
              </span>
              <span v-if="resultTruncated" class="text-amber-500 font-medium">
                {{ t('viewer.sqlTruncated') }}
              </span>
              <div class="flex-1"></div>
              <button
                @click="exportCSV"
                class="flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
              >
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                {{ t('viewer.exportCSV') }}
              </button>
            </div>

            <!-- Table -->
            <div class="flex-1 overflow-auto">
              <table class="w-full text-left border-separate border-spacing-0">
                <thead class="sticky top-0 z-10">
                  <tr>
                    <th class="px-3 py-2 text-[10px] font-bold text-gray-400 uppercase tracking-wider bg-white dark:bg-zinc-900 border-b border-gray-200 dark:border-zinc-800 whitespace-nowrap">#</th>
                    <th
                      v-for="field in resultFields"
                      :key="field"
                      class="px-3 py-2 text-[10px] font-bold text-gray-400 uppercase tracking-wider bg-white dark:bg-zinc-900 border-b border-gray-200 dark:border-zinc-800 whitespace-nowrap"
                    >
                      {{ field }}
                    </th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-100 dark:divide-zinc-800/50">
                  <tr
                    v-for="(row, ri) in resultRows"
                    :key="ri"
                    class="hover:bg-gray-50 dark:hover:bg-zinc-800/30 transition-colors"
                  >
                    <td class="px-3 py-1.5 text-[10px] text-gray-300 dark:text-gray-600 font-mono tabular-nums">{{ ri + 1 }}</td>
                    <td
                      v-for="field in resultFields"
                      :key="field"
                      class="px-3 py-1.5 text-xs text-gray-700 dark:text-gray-300 max-w-[300px] truncate font-mono"
                      :title="String(row[field] ?? '')"
                    >
                      <span v-if="row[field] === null" class="text-gray-300 dark:text-gray-600 italic">NULL</span>
                      <span v-else-if="typeof row[field] === 'boolean'" :class="row[field] ? 'text-emerald-600' : 'text-gray-400'">{{ row[field] }}</span>
                      <span v-else>{{ String(row[field]) }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>

          <!-- Empty state -->
          <div v-if="!hasResults && !queryError" class="flex-1 flex flex-col items-center justify-center text-center p-8">
            <div class="w-16 h-16 bg-gray-100 dark:bg-zinc-800 rounded-full flex items-center justify-center mb-4">
              <svg class="w-8 h-8 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <p class="text-sm font-medium text-gray-500 dark:text-gray-400">{{ t('viewer.sqlEmptyTitle') }}</p>
            <p class="text-xs text-gray-400 dark:text-gray-500 mt-1 max-w-xs">{{ t('viewer.sqlEmptyDesc') }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- History Panel -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0 translate-y-4"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 translate-y-4"
    >
      <div v-if="showHistory" class="absolute bottom-0 left-0 right-0 bg-white dark:bg-zinc-900 border-t border-gray-200 dark:border-zinc-800 shadow-2xl rounded-t-2xl z-20 max-h-64 overflow-hidden flex flex-col">
        <div class="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-zinc-800 shrink-0">
          <span class="text-xs font-bold text-gray-900 dark:text-white">{{ t('viewer.sqlHistory') }}</span>
          <button @click="showHistory = false" class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded transition-colors">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div class="overflow-y-auto flex-1">
          <div v-if="queryHistory.length === 0" class="p-4 text-center text-xs text-gray-400">
            {{ t('viewer.sqlNoHistory') }}
          </div>
          <button
            v-for="(entry, i) in queryHistory"
            :key="i"
            @click="loadFromHistory(entry)"
            class="w-full text-left px-4 py-2 hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors border-b border-gray-100 dark:border-zinc-800/50 last:border-0"
          >
            <pre class="text-[10px] font-mono text-gray-600 dark:text-gray-400 truncate">{{ entry.sql }}</pre>
            <div class="flex items-center gap-2 mt-0.5 text-[10px] text-gray-400">
              <span>{{ entry.rowCount }} rows</span>
              <span>{{ entry.duration }}ms</span>
              <span>{{ new Date(entry.timestamp).toLocaleTimeString() }}</span>
            </div>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

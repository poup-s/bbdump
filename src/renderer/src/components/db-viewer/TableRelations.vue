<script setup lang="ts">
import { ref, watch, onMounted, markRaw, nextTick } from 'vue';
import { getErrorMessage } from '../../utils';
import { VueFlow, useVueFlow, type Node, type Edge } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { ipcRenderer } from '../../electron';
import { Database, buildDbConfig, type FullSchema, type SchemaForeignKey, type SchemaTable, type SchemaColumn, type SchemaPrimaryKey, type TableNodeData } from '../../types';
import { useI18n } from '../../composables/useI18n';
import TableNode from './TableNode.vue';
import dagre from 'dagre';
import { DEFAULT_SCHEMA, tableId, displayTableName } from './schemaNames';

import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';

const props = withDefaults(defineProps<{
  db: Database | null;
  schema?: string;
  table: string | null;
}>(), {
  schema: DEFAULT_SCHEMA
});

const { t } = useI18n();
const { fitView } = useVueFlow({ id: 'relations-flow' });
const nodes = ref<Node<TableNodeData>[]>([]);
const edges = ref<Edge[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const hasRelations = ref(true);

const nodeTypes = {
  table: markRaw(TableNode),
};

const layoutNodes = (nodesToLayout: Node<TableNodeData>[], edgesToLayout: Edge[]) => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  dagreGraph.setGraph({
    rankdir: 'LR',
    nodesep: 80,
    ranksep: 180,
    marginx: 50,
    marginy: 50
  });

  nodesToLayout.forEach((node) => {
    const height = 60 + ((node.data?.columns.length ?? 0) * 32);
    dagreGraph.setNode(node.id, { width: 280, height });
  });

  edgesToLayout.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  return nodesToLayout.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - nodeWithPosition.width / 2,
        y: nodeWithPosition.y - nodeWithPosition.height / 2,
      },
    };
  });
};

const loadRelationsGraph = async () => {
  if (!props.db || !props.table) return;

  loading.value = true;
  error.value = null;

  try {
    const dbConfig = buildDbConfig(props.db);
    const schema: FullSchema = await ipcRenderer.invoke('get-db-full-schema', { db: dbConfig, schema: props.schema });

    // Tables are identified by schema + name: the same name may exist in several schemas
    const currentId = tableId(props.schema, props.table);
    const sourceId = (fk: SchemaForeignKey) => tableId(fk.source_schema, fk.source_table);
    const targetId = (fk: SchemaForeignKey) => tableId(fk.target_schema, fk.target_table);

    // Collect the selected table + directly connected tables
    const connectedTables = new Set<string>([currentId]);

    // Outgoing FKs: this table → other tables
    const outgoingFks = schema.foreignKeys.filter((fk) => sourceId(fk) === currentId);
    outgoingFks.forEach((fk) => connectedTables.add(targetId(fk)));

    // Incoming FKs: other tables → this table
    const incomingFks = schema.foreignKeys.filter((fk) => targetId(fk) === currentId);
    incomingFks.forEach((fk) => connectedTables.add(sourceId(fk)));

    // De-duplicate (a self-referencing FK is both outgoing and incoming)
    const seenConstraints = new Set<string>();
    const uniqueFks = [...outgoingFks, ...incomingFks].filter(fk => {
      const key = `${sourceId(fk)}|${fk.constraint_name}|${fk.source_column}`;
      if (seenConstraints.has(key)) return false;
      seenConstraints.add(key);
      return true;
    });

    hasRelations.value = uniqueFks.length > 0;

    if (!hasRelations.value) {
      nodes.value = [];
      edges.value = [];
      loading.value = false;
      return;
    }

    // Build nodes for connected tables only
    const rawNodes = schema.tables
      .filter((table: SchemaTable) => connectedTables.has(tableId(table.schema, table.name)))
      .map((table: SchemaTable): Node<TableNodeData> => {
        const id = tableId(table.schema, table.name);
        const tableColumns = schema.columns.filter((c: SchemaColumn) => c.table_schema === table.schema && c.table_name === table.name);
        const tablePks = schema.primaryKeys
          .filter((pk: SchemaPrimaryKey) => pk.table_schema === table.schema && pk.table_name === table.name)
          .map((pk: SchemaPrimaryKey) => pk.column_name);

        return {
          id,
          type: 'table',
          position: { x: 0, y: 0 },
          class: id === currentId ? 'highlighted-node' : '',
          data: {
            label: displayTableName(table.schema, table.name, props.schema),
            schema: table.schema,
            table: table.name,
            columns: tableColumns,
            primaryKeys: tablePks
          }
        };
      });

    // Build edges
    const rawEdges = uniqueFks.map((fk: SchemaForeignKey, index: number): Edge => ({
      id: `e-${sourceId(fk)}-${fk.constraint_name}-${index}`,
      source: targetId(fk),
      target: sourceId(fk),
      sourceHandle: `source-${fk.target_column}`,
      targetHandle: `target-${fk.source_column}`,
      animated: true,
      style: { stroke: '#3b82f6', strokeWidth: 2 },
      label: `${fk.source_column} → ${fk.target_column}`,
      labelStyle: { fill: '#94a3b8', fontSize: 10, fontWeight: 500 }
    }));

    nodes.value = layoutNodes(rawNodes, rawEdges);
    edges.value = rawEdges;

    // The view is centered once Vue Flow has measured the nodes (see onNodesInitialized)
  } catch (err) {
    console.error('Error loading relations graph:', err);
    error.value = getErrorMessage(err) || t('viewer.relationsLoadError');
  } finally {
    loading.value = false;
  }
};

// Fit the view each time a (re)loaded graph has been measured
const onNodesInitialized = () => {
  fitView({ padding: 0.3 });
};

const triggerLayout = async () => {
  nodes.value = layoutNodes(nodes.value, edges.value);
  await nextTick();
  fitView({ padding: 0.3, duration: 800 });
};

watch(() => [props.schema, props.table], () => {
  loadRelationsGraph();
});

onMounted(() => {
  loadRelationsGraph();
});
</script>

<template>
  <div class="h-full w-full relative bg-gray-50 dark:bg-zinc-950 rounded-lg overflow-hidden">
    <!-- Loading -->
    <div v-if="loading" class="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm">
      <div class="w-10 h-10 border-3 border-blue-500 border-t-transparent rounded-full animate-spin mb-3"></div>
      <p class="text-xs text-gray-500 dark:text-gray-400 font-medium">{{ t('viewer.schemaLoading') }}</p>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="absolute inset-0 z-10 flex flex-col items-center justify-center p-8 text-center">
      <div class="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl max-w-md">
        <p class="text-sm text-red-600 dark:text-red-400 mb-3">{{ error }}</p>
        <button @click="loadRelationsGraph" class="px-3 py-1.5 bg-red-600 text-white rounded-lg hover:bg-red-700 text-xs transition-colors">
          {{ t('viewer.retry') }}
        </button>
      </div>
    </div>

    <!-- No Relations -->
    <div v-else-if="!hasRelations" class="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
      <div class="w-14 h-14 bg-gray-100 dark:bg-zinc-800 rounded-full flex items-center justify-center mb-3 text-gray-400">
        <svg class="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
      </div>
      <h3 class="text-sm font-semibold text-gray-900 dark:text-white mb-1">{{ t('viewer.noRelations') }}</h3>
      <p class="text-[10px] text-gray-500 dark:text-gray-400 font-mono">{{ table }}</p>
    </div>

    <!-- Graph -->
    <VueFlow
      v-if="!loading && !error && hasRelations"
      id="relations-flow"
      v-model:nodes="nodes"
      v-model:edges="edges"
      :node-types="(nodeTypes as any)"
      :default-viewport="{ x: 50, y: 50, zoom: 0.8 }"
      :min-zoom="0.1"
      :max-zoom="4"
      fit-view-on-init
      class="h-full w-full"
      @nodes-initialized="onNodesInitialized"
    >
      <Background pattern-color="#aaa" :gap="20" />
      <Controls />

      <template #panel-top-right>
        <div class="m-2 flex gap-1.5">
          <button
            @click="triggerLayout"
            class="px-2.5 py-1.5 bg-blue-600 text-white rounded-lg shadow-lg hover:bg-blue-700 transition-all flex items-center gap-1.5 text-xs font-medium"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            {{ t('viewer.magicLayout') }}
          </button>
          <button
            @click="loadRelationsGraph"
            class="p-1.5 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-white/10 rounded-lg shadow-lg hover:bg-gray-50 dark:hover:bg-zinc-700 transition-all"
          >
            <svg class="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </template>
    </VueFlow>
  </div>
</template>

<style>
/* Highlight the selected table node */
.highlighted-node > div {
  box-shadow: 0 0 0 3px #3b82f6, 0 25px 50px -12px rgba(59, 130, 246, 0.25) !important;
}

.vue-flow__node-table {
  padding: 0;
  border: none;
  background: transparent;
}

#relations-flow .vue-flow__edge-path {
  stroke-dasharray: 5;
  stroke-dashoffset: 0;
  animation: relations-dash 1s linear infinite;
}

@keyframes relations-dash {
  from { stroke-dashoffset: 10; }
  to { stroke-dashoffset: 0; }
}

#relations-flow .vue-flow__controls {
  display: flex !important;
  flex-direction: column !important;
  gap: 4px !important;
  padding: 8px !important;
  background: white !important;
  border: 1px solid #e5e7eb !important;
  border-radius: 12px !important;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1) !important;
}

.dark #relations-flow .vue-flow__controls {
  background: #18181b !important;
  border-color: rgba(255, 255, 255, 0.1) !important;
}

#relations-flow .vue-flow__controls-button {
  border: none !important;
  background: transparent !important;
  color: #6b7280 !important;
  border-radius: 6px !important;
}

#relations-flow .vue-flow__controls-button:hover {
  background: #f3f4f6 !important;
  color: #111827 !important;
}

.dark #relations-flow .vue-flow__controls-button:hover {
  background: rgba(255, 255, 255, 0.05) !important;
  color: white !important;
}
</style>

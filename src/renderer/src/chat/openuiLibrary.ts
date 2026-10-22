/**
 * What the AI can show in the database chat, as OpenUI components: tables, key figures,
 * bar and line charts, the SQL it ran, notes. The prompt the AI gets is generated from
 * these definitions (OpenUI Lang). Everything here runs in the window: OpenUI sends no
 * telemetry from a browser page, and the page's CSP blocks any outside request anyway.
 */
import { h, type VNode } from 'vue';
import { z } from 'zod/v4';
import { createLibrary, defineComponent as defineUi, type ComponentRenderProps } from '@openuidev/vue-lang';
import { useI18n } from '../composables/useI18n';

type Cell = string | number | boolean | null;
export type Render<P> = (p: ComponentRenderProps<P>) => VNode;

export const fmt = (value: unknown): string => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return String(value);
};

export const muted = 'text-gray-500 dark:text-zinc-400';
export const card = 'rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900';

const renderStack: Render<{ children: unknown[] }> = ({ props, renderNode }) =>
  h('div', { class: 'space-y-3' }, (props.children ?? []).map(child => renderNode(child)) as VNode[]);

export const renderHeading: Render<{ text: string }> = ({ props }) =>
  h('h3', { class: 'text-[13px] font-semibold text-gray-900 dark:text-zinc-100' }, props.text);

export const renderText: Render<{ text: string }> = ({ props }) =>
  h('p', { class: 'text-[13px] leading-relaxed text-gray-700 dark:text-zinc-300 whitespace-pre-wrap' }, props.text);

export const renderStats: Render<{ items: Array<{ label: string; value: string | number; hint?: string }> }> = ({ props }) =>
  h('div', { class: 'grid gap-2', style: { gridTemplateColumns: `repeat(${Math.min(4, Math.max(1, props.items?.length ?? 1))}, minmax(0, 1fr))` } },
    (props.items ?? []).map(item => h('div', { class: `chat-stat ${card} px-3 py-2.5 min-w-0` }, [
      h('div', { class: `text-[11px] truncate ${muted}` }, item.label),
      h('div', { class: 'mt-0.5 text-[18px] font-semibold tabular-nums text-gray-900 dark:text-zinc-100 truncate' }, fmt(item.value)),
      item.hint ? h('div', { class: `text-[11px] truncate ${muted}` }, item.hint) : null,
    ])));

/**
 * Rows as arrays (the chat) or as objects keyed by column (a dashboard's live query);
 * labels, when given, are shown instead of the column names
 */
export const renderTable: Render<{ columns: string[]; rows: Array<Cell[] | Record<string, unknown>>; caption?: string; labels?: string[] }> = ({ props }) => {
  const columns = props.columns ?? [];
  const rows = (props.rows ?? []).map(row => (Array.isArray(row) ? row : columns.map(c => (row as Record<string, unknown> | null)?.[c] as Cell)));
  const numeric = columns.map((_, i) => rows.length > 0 && rows.every(r => r[i] === null || r[i] === undefined || typeof r[i] === 'number'));
  return h('div', { class: `${card} overflow-hidden` }, [
    props.caption ? h('div', { class: `px-3 py-2 text-[11px] border-b border-gray-100 dark:border-zinc-800 ${muted}` }, props.caption) : null,
    h('div', { class: 'max-h-80 overflow-auto' }, h('table', { class: 'w-full text-[12px] border-collapse' }, [
      h('thead', { class: 'sticky top-0 bg-gray-50 dark:bg-zinc-800/80' }, h('tr', columns.map((c, i) =>
        h('th', { class: `px-3 py-1.5 font-medium whitespace-nowrap ${numeric[i] ? 'text-right' : 'text-left'} ${muted}` }, props.labels?.[i] || c)))),
      h('tbody', rows.map(row => h('tr', { class: 'border-t border-gray-100 dark:border-zinc-800' }, columns.map((_, i) =>
        h('td', {
          class: `px-3 py-1.5 align-top ${numeric[i] ? 'text-right tabular-nums' : ''} ${row[i] === null || row[i] === undefined ? 'text-gray-300 dark:text-zinc-600 italic' : 'text-gray-800 dark:text-zinc-200'}`,
        }, fmt(row[i])))))),
    ])),
  ]);
};

export const chartFrame = (title: string | undefined, body: VNode | VNode[]) =>
  h('div', { class: `${card} px-3 py-2.5` }, [title ? h('div', { class: 'mb-2 text-[12px] font-medium text-gray-800 dark:text-zinc-200' }, title) : null, body]);

export const renderBarChart: Render<{ labels: string[]; values: number[]; title?: string; unit?: string }> = ({ props }) => {
  const values = (props.values ?? []).map(v => Number(v) || 0);
  const max = Math.max(1, ...values.map(Math.abs));
  // One grid for every bar: the tracks have the same width, whatever the length of each value
  return chartFrame(props.title, h('div', { class: 'grid items-center gap-x-2 gap-y-1.5', style: { gridTemplateColumns: 'minmax(0, 9rem) minmax(0, 1fr) auto' } }, (props.labels ?? []).flatMap((label, i) => [
    h('div', { class: `text-[11px] truncate ${muted}`, title: String(label) }, String(label)),
    h('div', { class: 'h-3.5 rounded bg-gray-100 dark:bg-zinc-800 overflow-hidden' },
      h('div', { class: 'chat-bar h-full rounded bg-emerald-500/80', style: { width: `${(Math.abs(values[i] ?? 0) / max) * 100}%`, animationDelay: `${i * 50}ms` } })),
    h('div', { class: 'text-[11px] text-right tabular-nums text-gray-700 dark:text-zinc-300' }, `${fmt(values[i])}${props.unit ? ` ${props.unit}` : ''}`),
  ])));
};

export const renderLineChart: Render<{ labels: string[]; values: number[]; title?: string; unit?: string }> = ({ props }) => {
  const values = (props.values ?? []).map(v => Number(v) || 0);
  const labels = props.labels ?? [];
  if (values.length < 2) return renderBarChart({ props, renderNode: () => null });
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 300},${90 - ((v - min) / span) * 80}`).join(' ');
  const unit = props.unit ? ` ${props.unit}` : '';
  return chartFrame(props.title, [
    h('div', { class: `flex justify-between text-[10px] tabular-nums ${muted}` }, [h('span', `max ${fmt(max)}${unit}`), h('span', `min ${fmt(min)}${unit}`)]),
    h('svg', { viewBox: '0 0 300 100', preserveAspectRatio: 'none', class: 'w-full h-28 text-emerald-500', role: 'img', 'aria-label': props.title || 'chart' }, [
      h('polyline', { class: 'chat-line', points, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }),
    ]),
    h('div', { class: `flex justify-between text-[10px] ${muted}` }, [h('span', labels[0] ?? ''), h('span', labels[labels.length - 1] ?? '')]),
  ]);
};

/** The SQL behind an answer: folded, for whoever wants to see it */
export const sqlDetails = (query: string) =>
  h('details', { class: 'chat-sql group' }, [
    h('summary', { class: 'inline-flex items-center gap-1.5 cursor-pointer select-none list-none text-[11px] text-gray-400 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300' }, [
      h('svg', { class: 'chat-sql-chevron w-3 h-3 transition-transform', fill: 'none', viewBox: '0 0 24 24', stroke: 'currentColor', 'stroke-width': 2.5 },
        [h('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M9 5l7 7-7 7' })]),
      useI18n().t('chat.showSql'),
    ]),
    h('pre', { class: 'mt-1.5 rounded-lg bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 px-3 py-2 font-mono text-[11px] text-gray-700 dark:text-zinc-300 overflow-x-auto whitespace-pre-wrap' }, query),
  ]);

const renderSql: Render<{ query: string }> = ({ props }) => sqlDetails(props.query);

export const renderNote: Render<{ text: string; tone?: 'info' | 'warning' }> = ({ props }) =>
  h('p', {
    class: props.tone === 'warning'
      ? 'rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300'
      : 'rounded-lg border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-800/40 px-3 py-2 text-[12px] text-gray-600 dark:text-zinc-300',
  }, props.text);

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const chatLibrary = createLibrary({
  root: 'Stack',
  components: [
    defineUi({ name: 'Stack', description: 'Vertical list of blocks: the root of every answer', props: z.object({ children: z.array(z.any()) }), component: renderStack }),
    defineUi({ name: 'Heading', description: 'A short title', props: z.object({ text: z.string() }), component: renderHeading }),
    defineUi({ name: 'Text', description: 'A paragraph of plain text', props: z.object({ text: z.string() }), component: renderText }),
    defineUi({
      name: 'Stats',
      description: '1 to 4 key figures side by side (a count, a total, an average…)',
      props: z.object({ items: z.array(z.object({ label: z.string(), value: z.union([z.string(), z.number()]), hint: z.string().optional() })) }),
      component: renderStats,
    }),
    defineUi({
      name: 'Table',
      description: 'Rows of data (at most 50 rows); numbers as numbers, missing values as null',
      props: z.object({ columns: z.array(z.string()), rows: z.array(z.array(cell)), caption: z.string().optional() }),
      component: renderTable,
    }),
    defineUi({
      name: 'BarChart',
      description: 'Compares a value across categories (at most 20 bars)',
      props: z.object({ labels: z.array(z.string()), values: z.array(z.number()), title: z.string().optional(), unit: z.string().optional() }),
      component: renderBarChart,
    }),
    defineUi({
      name: 'LineChart',
      description: 'A value over time, labels in time order',
      props: z.object({ labels: z.array(z.string()), values: z.array(z.number()), title: z.string().optional(), unit: z.string().optional() }),
      component: renderLineChart,
    }),
    defineUi({ name: 'Sql', description: 'The main SQL query behind the answer (shown folded)', props: z.object({ query: z.string() }), component: renderSql }),
    defineUi({
      name: 'Note',
      description: 'A remark: a limit of the data, a caveat',
      props: z.object({ text: z.string(), tone: z.enum(['info', 'warning']).optional() }),
      component: renderNote,
    }),
  ],
});

const EXAMPLE = `root = Stack([title, figures, chart, rows, query])
title = Heading("Orders by city")
figures = Stats([{label: "Orders", value: 4}, {label: "Total", value: 545.5, hint: "EUR"}])
chart = BarChart(["Lyon", "Paris"], [245.5, 300], "Total by city", "EUR")
rows = Table(["City", "Orders", "Total"], [["Lyon", 3, 245.5], ["Paris", 1, 300]])
query = Sql("SELECT city, count(*), sum(total) FROM orders JOIN customers ON customers.id = orders.customer_id GROUP BY city")`;

/** Everything the AI is told: who it is, what it may do, and how to show data */
export function chatSystemPrompt(database: string): string {
  const preamble = [
    `You are the assistant built into bbdump, a PostgreSQL desktop app. The user is chatting with you about one database: "${database}".`,
    'It is already the active connection of the bbdump MCP tools (do not call use_connection or list_connections). You can only read: never claim you changed anything.',
    'Use the bbdump tools to answer: get_schema_overview first when you need the structure, then execute_query (SELECT only, add LIMIT), read_rows, count_rows, profile_table… Never invent data: only show values the tools returned.',
    'Some values may come masked by the user (starred, fakes, NULL): keep them as they are.',
    'Write every sentence in the language of the user\'s message, the short notes between tool calls included, never the language the data happens to be in. Be brief. Plain text for explanations.',
    'Whenever you show data (rows, counts, totals, comparisons, trends), put it in ONE fenced block whose language is `openui`, holding an OpenUI Lang program as described below. Text outside the block is shown as is.',
  ].join('\n');
  return chatLibrary.prompt({
    preamble,
    additionalRules: [
      'Table for rows (at most 50), BarChart to compare categories, LineChart for values over time, Stats for 1 to 4 key figures, Sql for the main query you ran.',
      'Numbers must be numbers in Table, Stats, BarChart and LineChart, never strings with units.',
    ],
    examples: [EXAMPLE],
  });
}

/**
 * What a dashboard is made of, as OpenUI components: filters, key figures, tables, charts,
 * text, laid out on a 12-column grid. A dashboard holds no data: each block reads a
 * Query("sql", {query: "SELECT …"}) that bbdump runs (read only) when the dashboard opens, on
 * every refresh and when a filter changes. The AI writes the program; the user can also change
 * each block by hand from its menu (DashboardView provides what the blocks need).
 */
import { computed, defineComponent, h, inject, ref, watch, type InjectionKey, type PropType, type Ref, type VNode } from 'vue';
import { z } from 'zod/v4';
import { createLibrary, defineComponent as defineUi, useOpenUI, type RenderNodeResult } from '@openuidev/vue-lang';
import { useI18n } from '../composables/useI18n';
import { markdownLite, type Inline } from '../chat/markdownLite';
import { PERIODS } from './dashboardProgram';
import { MONGO_EXAMPLE, MONGO_EXAMPLE_LINKED, MONGO_TOOL } from './mongoDashboard';
import { DUCKDB_EXAMPLE, DUCKDB_EXAMPLE_LINKED, DUCKDB_TOOL, MYSQL_EXAMPLE, MYSQL_EXAMPLE_LINKED, MYSQL_TOOL, SQLITE_EXAMPLE, SQLITE_EXAMPLE_LINKED, SQLITE_TOOL, SQLSERVER_EXAMPLE, SQLSERVER_EXAMPLE_LINKED, SQLSERVER_TOOL } from './sqlDashboard';
import { change, formatLabel, formatValue } from './valueFormat';

type Render<P> = (p: { props: P; renderNode: (value: unknown) => RenderNodeResult }) => VNode;
/** An evaluated block of the program (named blocks carry their statement's name) */
interface BlockNode { type: 'element'; statementId?: string; typeName: string; props: Record<string, unknown> }

/** span: columns out of 12; height: pixels chosen by the user (none: as tall as its content) */
export interface BlockLayout { span?: number; hidden?: boolean; height?: number }
export interface BlockInfo { title: string | null; types: string[]; queries: number; slowMs: number | null; failed: boolean; splittable: boolean }

/** What DashboardView gives the blocks */
export interface DashboardContext {
  /** Bumped to run every query again */
  tick: Ref<number>;
  queryIds: () => string[];
  layout: (id: string) => BlockLayout;
  showHidden: Ref<boolean>;
  editable: Ref<boolean>;
  /** The block being dragged, and where it would land */
  dragging: Ref<string | null>;
  dropHint: Ref<{ id: string; side: 'before' | 'after'; vertical: boolean } | null>;
  info: (id: string) => BlockInfo;
  action: (id: string, key: string, payload?: unknown) => void;
  filters: {
    period: Ref<{ preset: string; from?: string; to?: string }>;
    values: Ref<Record<string, string | null>>;
    /** What the chip of a value picked in a table shows (an email rather than an id) */
    labels: Ref<Record<string, string>>;
    setPeriod: (period: { preset: string; from?: string; to?: string }) => void;
    setValue: (name: string, value: string | null, label?: string) => void;
  };
}
export const DASHBOARD_CONTEXT: InjectionKey<DashboardContext> = Symbol('dashboard-context');

const lang = () => useI18n().currentLanguage.value;
const tr = (key: string, args?: Record<string, unknown>) => useI18n().t(key, args);
const muted = 'text-gray-500 dark:text-zinc-400';
const cardClass = 'dash-card-box h-full rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900';
const color = (n: number) => `var(--dash-c${(n % 8) + 1})`;

const panel = (title: string | undefined | null, body: VNode | Array<VNode | null>, extra?: VNode | null) =>
  h('div', { class: cardClass, style: { padding: 'var(--dash-pad)' } }, [
    title || extra ? h('div', { class: 'mb-2 flex items-center gap-2' }, [
      title ? h('div', { class: 'flex-1 min-w-0 truncate text-[12px] font-medium text-gray-800 dark:text-zinc-200' }, title) : h('span', { class: 'flex-1' }),
      extra ?? null,
    ]) : null,
    body,
  ]);
const empty = () => h('div', { class: `py-6 text-center text-[12px] ${muted}` }, '—');
const nums = (values: unknown[] | undefined) => (values ?? []).map(v => Number(v) || 0);
const valueText = (v: number, unit?: string, format?: string) => (format ? formatValue(v, format, lang()) : `${formatValue(v, undefined, lang())}${unit ? ` ${unit}` : ''}`);

// --- Layout -----------------------------------------------------------------------------------

const ICON = {
  ai: 'M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z',
  more: 'M6.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM12.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM18.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0z',
};
const svgIcon = (d: string, cls = 'w-3.5 h-3.5') => h('svg', { class: cls, fill: 'none', viewBox: '0 0 24 24', stroke: 'currentColor', 'stroke-width': 2, 'aria-hidden': 'true' }, [h('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d })]);

/** Columns of the grid: 60, so that 2 to 6 blocks share a line evenly */
const GRID = 60;
/** The gap between columns shrinks on a narrow canvas: 59 full gaps would be wider than the canvas */
const GRID_STYLE = { rowGap: 'var(--dash-gap)', columnGap: `min(var(--dash-gap), calc(100% / ${GRID}))`, gridTemplateColumns: `repeat(${GRID}, minmax(0, 1fr))` };
/** The column gap as drawn, in pixels */
function columnGapOf(grid: HTMLElement): number {
  const wanted = parseFloat(getComputedStyle(grid).getPropertyValue('--dash-gap')) || 0;
  return Math.min(wanted, grid.clientWidth / GRID);
}

/** A block on the grid, with its toolbar (edit with AI, menu) on hover */
const BlockFrame = defineComponent({
  props: {
    node: { type: Object as PropType<BlockNode>, required: true },
    renderNode: { type: Function as PropType<(value: unknown) => RenderNodeResult>, required: true },
    /** Default width in sixtieths of the line (blocks without a width share their row) */
    defaultUnits: { type: Number, default: GRID },
  },
  setup(p) {
    const ctx = inject(DASHBOARD_CONTEXT, null);
    const open = ref(false);
    const id = computed(() => p.node.statementId);
    const layout = computed(() => (id.value && ctx ? ctx.layout(id.value) : {}));
    const close = () => { open.value = false; window.removeEventListener('click', close); };
    const toggle = (event: MouseEvent) => {
      event.stopPropagation();
      open.value = !open.value;
      if (open.value) setTimeout(() => window.addEventListener('click', close), 0);
      else window.removeEventListener('click', close);
    };
    const act = (key: string, payload?: unknown) => { close(); if (id.value) ctx?.action(id.value, key, payload); };

    // --- Moving: the grip arms dragging; the block lands before or after the one under the pointer
    let frame: HTMLElement | null = null;
    const armed = ref(false);
    const clearDrag = () => {
      armed.value = false;
      if (ctx) { ctx.dragging.value = null; ctx.dropHint.value = null; }
    };
    const onDragStart = (e: DragEvent) => {
      if (!armed.value || !id.value || !ctx) { e.preventDefault(); return; }
      e.dataTransfer?.setData('text/plain', id.value);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      ctx.dragging.value = id.value;
      close();
    };
    const onDragOver = (e: DragEvent) => {
      if (!ctx?.dragging.value || !id.value || ctx.dragging.value === id.value || !frame) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const rect = frame.getBoundingClientRect();
      const wide = rect.width > (frame.parentElement?.clientWidth ?? rect.width) * 0.8;
      const side = (wide ? e.clientY < rect.top + rect.height / 2 : e.clientX < rect.left + rect.width / 2) ? 'before' : 'after';
      const hint = ctx.dropHint.value;
      if (hint?.id !== id.value || hint.side !== side || hint.vertical !== wide) ctx.dropHint.value = { id: id.value, side, vertical: wide };
    };
    const onDrop = (e: DragEvent) => {
      if (!ctx?.dragging.value || !id.value) return;
      e.preventDefault();
      const source = ctx.dragging.value;
      const side = ctx.dropHint.value?.id === id.value ? ctx.dropHint.value.side : 'after';
      clearDrag();
      if (source !== id.value) ctx.action(source, 'moveTo', { target: id.value, side });
    };

    // --- Resizing: the corner snaps the width to the 12 columns, the height is free
    const preview = ref<{ span: number; height?: number } | null>(null);
    const onResizeStart = (e: PointerEvent) => {
      if (!frame || !id.value) return;
      e.preventDefault();
      e.stopPropagation();
      const grid = frame.parentElement;
      const gap = grid ? columnGapOf(grid) : 0;
      const column = ((grid?.clientWidth ?? frame.clientWidth) + gap) / 12;
      const start = { x: e.clientX, y: e.clientY, width: frame.getBoundingClientRect().width, height: frame.getBoundingClientRect().height };
      let vertical = false;
      const move = (ev: PointerEvent) => {
        // A height is set only once the pointer really went up or down: widening keeps the automatic height
        if (Math.abs(ev.clientY - start.y) > 6) vertical = true;
        preview.value = {
          span: Math.min(12, Math.max(2, Math.round((start.width + (ev.clientX - start.x) + gap) / column))),
          height: vertical ? Math.max(80, Math.round(start.height + (ev.clientY - start.y))) : layout.value.height,
        };
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        document.body.classList.remove('dash-resizing');
        if (preview.value) act('resize', { span: preview.value.span, height: preview.value.height });
        preview.value = null;
      };
      document.body.classList.add('dash-resizing');
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };

    return () => {
      const hidden = !!layout.value.hidden;
      if (hidden && !ctx?.showHidden.value) return null;
      // Widths chosen by the user count in twelfths; the grid has 60 columns so that rows share evenly
      const chosen = preview.value?.span ?? layout.value.span;
      const span = chosen ? Math.min(GRID, Math.max(10, Math.min(12, Math.max(2, chosen)) * 5)) : p.defaultUnits;
      const height = preview.value?.height ?? layout.value.height;
      const content = p.renderNode(p.node) as VNode;
      const isContainer = p.node.typeName === 'Row' || p.node.typeName === 'Filters';
      if (!id.value || !ctx || isContainer) {
        return h('div', { class: 'dash-block min-w-0', style: { gridColumn: `span ${span} / span ${span}` } }, content);
      }
      const info = ctx.info(id.value);
      const item = (key: string, label: string, payload?: unknown, danger = false) => h('button', {
        type: 'button', role: 'menuitem',
        class: `w-full text-left px-3 py-1.5 text-[12px] rounded-md ${danger ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30' : 'text-gray-700 dark:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800'}`,
        onClick: (e: MouseEvent) => { e.stopPropagation(); act(key, payload); },
      }, label);
      const sep = () => h('div', { class: 'my-1 h-px bg-gray-100 dark:bg-zinc-800' });
      const sectionTitle = (text: string) => h('div', { class: 'px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-gray-400 dark:text-zinc-500' }, text);
      const spans: Array<[number, string]> = [[2, '⅙'], [3, '¼'], [4, '⅓'], [6, '½'], [8, '⅔'], [12, tr('dashboards.block.full')]];
      const menu = open.value ? h('div', {
        class: 'dash-menu absolute right-0 top-8 z-30 w-56 rounded-xl border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl p-1',
        role: 'menu', onClick: (e: MouseEvent) => e.stopPropagation(),
      }, [
        item('ai', tr('dashboards.block.ai')),
        info.queries ? item('explain', tr('dashboards.block.explain')) : null,
        info.title !== null ? item('rename', tr('dashboards.block.rename')) : null,
        info.queries ? item('sql', tr('dashboards.block.sql')) : null,
        info.splittable ? item('split', tr('dashboards.block.split')) : null,
        info.types.length ? sectionTitle(tr('dashboards.block.type')) : null,
        info.types.length ? h('div', { class: 'px-2 pb-1 flex flex-wrap gap-1' }, info.types.map(t => h('button', {
          type: 'button', class: 'px-2 py-0.5 rounded-md text-[11px] border border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-zinc-300 hover:text-gray-900 dark:hover:text-zinc-100',
          onClick: (e: MouseEvent) => { e.stopPropagation(); act('type', t); },
        }, tr(`dashboards.types.${t}`)))) : null,
        sectionTitle(tr('dashboards.block.width')),
        h('div', { class: 'px-2 pb-1 flex gap-1' }, spans.map(([value, label]) => h('button', {
          type: 'button',
          class: `flex-1 py-0.5 rounded-md text-[11px] border ${(layout.value.span ?? 0) === value ? 'border-gray-900 dark:border-zinc-100 text-gray-900 dark:text-zinc-100' : 'border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-zinc-300'}`,
          onClick: (e: MouseEvent) => { e.stopPropagation(); act('span', value); },
        }, label))),
        sep(),
        item('up', tr('dashboards.block.up')),
        item('down', tr('dashboards.block.down')),
        info.queries ? item('xlsx', tr('dashboards.block.xlsx')) : null,
        info.queries ? item('copy', tr('dashboards.block.copy')) : null,
        info.queries ? item('csv', tr('dashboards.block.csv')) : null,
        item('duplicate', tr('dashboards.block.duplicate')),
        item(hidden ? 'show' : 'hide', hidden ? tr('dashboards.block.show') : tr('dashboards.block.hide')),
        sep(),
        item('delete', tr('dashboards.block.delete'), undefined, true),
      ]) : null;
      const toolButton = 'w-6 h-6 rounded-md flex items-center justify-center text-gray-500 hover:text-gray-900 dark:hover:text-zinc-100 hover:bg-gray-100 dark:hover:bg-zinc-800';
      const grip = h('button', {
        type: 'button', class: `${toolButton} cursor-grab active:cursor-grabbing`, title: tr('dashboards.block.drag'), 'aria-label': tr('dashboards.block.drag'),
        onPointerdown: () => {
          armed.value = true;
          // Released anywhere without dragging: the block is no longer draggable
          window.addEventListener('pointerup', () => { if (!ctx.dragging.value) armed.value = false; }, { once: true });
        },
        // Keyboard: the arrows move the block within its row or the dashboard
        onKeydown: (e: KeyboardEvent) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); act('up'); }
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); act('down'); }
        },
      }, h('svg', { class: 'w-3.5 h-3.5', viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' },
        [[9, 6], [15, 6], [9, 12], [15, 12], [9, 18], [15, 18]].map(([cx, cy]) => h('circle', { cx, cy, r: 1.6 }))));
      const toolbar = ctx.editable.value ? h('div', {
        class: `dash-tools absolute top-2 right-2 z-20 flex items-center gap-0.5 rounded-lg border border-gray-200 dark:border-zinc-700 bg-white/95 dark:bg-zinc-900/95 shadow-sm p-0.5 ${open.value ? 'opacity-100' : 'opacity-0 group-hover/block:opacity-100 focus-within:opacity-100'} transition-opacity`,
      }, [
        grip,
        info.slowMs ? h('span', { class: 'px-1.5 text-[10px] tabular-nums text-amber-600 dark:text-amber-400', title: tr('dashboards.block.slow') }, `${(info.slowMs / 1000).toFixed(1)} s`) : null,
        info.queries ? h('button', { type: 'button', class: `${toolButton} text-[12px] font-semibold`, title: tr('dashboards.block.explain'), 'aria-label': tr('dashboards.block.explain'), onClick: (e: MouseEvent) => { e.stopPropagation(); act('explain'); } }, '?') : null,
        h('button', { type: 'button', class: toolButton, title: tr('dashboards.block.ai'), 'aria-label': tr('dashboards.block.ai'), onClick: (e: MouseEvent) => { e.stopPropagation(); act('ai'); } }, svgIcon(ICON.ai)),
        h('button', { type: 'button', class: toolButton, title: tr('dashboards.block.menu'), 'aria-label': tr('dashboards.block.menu'), 'aria-expanded': open.value, onClick: toggle }, svgIcon(ICON.more)),
        menu,
      ]) : null;
      const hint = ctx.dropHint.value?.id === id.value ? ctx.dropHint.value : null;
      const dropBar = hint ? h('div', {
        class: 'dash-drop absolute z-30 rounded-full pointer-events-none',
        style: hint.vertical
          ? { left: 0, right: 0, height: '3px', [hint.side === 'before' ? 'top' : 'bottom']: '-8px', background: 'var(--dash-c1)' }
          : { top: 0, bottom: 0, width: '3px', [hint.side === 'before' ? 'left' : 'right']: '-8px', background: 'var(--dash-c1)' },
      }) : null;
      const resizer = ctx.editable.value ? h('div', {
        class: 'dash-resize absolute -right-1 -bottom-1 z-20 w-4 h-4 cursor-nwse-resize opacity-0 group-hover/block:opacity-100 transition-opacity',
        title: tr('dashboards.block.resize'), role: 'separator', 'aria-label': tr('dashboards.block.resize'),
        onPointerdown: onResizeStart,
        onDblclick: (e: MouseEvent) => { e.stopPropagation(); act('resize', { reset: true }); },
      }, h('svg', { class: 'w-4 h-4 text-gray-400', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'aria-hidden': 'true' }, [
        h('path', { d: 'M14 6L6 14M14 10l-4 4', 'stroke-linecap': 'round' }),
      ])) : null;
      const sized = height ? { height: `${height}px`, '--dash-chart-h': `${Math.max(48, height - 96)}px`, '--dash-table-h': `${Math.max(60, height - 84)}px` } : {};
      return h('div', {
        ref: (el: unknown) => { frame = el as HTMLElement | null; },
        class: `dash-block group/block relative min-w-0 ${hidden ? 'opacity-40' : ''} ${height ? 'dash-sized' : ''} ${ctx.dragging.value === id.value ? 'opacity-40' : ''} ${preview.value ? 'dash-previewing' : ''}`,
        style: { gridColumn: `span ${span} / span ${span}`, ...sized },
        'data-block': id.value,
        draggable: armed.value,
        onDragstart: onDragStart,
        onDragover: onDragOver,
        onDrop,
        onDragend: clearDrag,
      }, [content, toolbar, resizer, dropBar]);
    };
  },
});

const frames = (children: unknown[], renderNode: (value: unknown) => RenderNodeResult, defaultUnits: number) =>
  children.map((child, i) => (child && typeof child === 'object' && (child as BlockNode).type === 'element'
    ? h(BlockFrame, { key: (child as BlockNode).statementId ?? i, node: child as BlockNode, renderNode, defaultUnits })
    : (renderNode(child) as VNode)));

/** The root: a 12-column grid; on each refresh it runs every query again (data stays meanwhile) */
const DashboardRoot = defineComponent({
  props: {
    props: { type: Object as PropType<{ children: any[] }>, required: true }, // eslint-disable-line @typescript-eslint/no-explicit-any -- OpenUI's own prop type
    renderNode: { type: Function as PropType<(value: unknown) => RenderNodeResult>, required: true },
  },
  setup(p) {
    const openui = useOpenUI();
    const ctx = inject(DASHBOARD_CONTEXT, null);
    if (ctx) {
      watch(ctx.tick, () => {
        const steps = ctx.queryIds().map(statementId => ({ type: 'run', refType: 'query', statementId }));
        // Run steps are not in the public action type: the renderer reads them all the same
        if (steps.length) openui.triggerAction('', undefined, { steps } as never);
      });
    }
    return () => h('div', { class: 'dash-root dash-grid grid', style: GRID_STYLE }, frames(p.props.children ?? [], p.renderNode, GRID));
  },
});

/** Blocks side by side: those the user did not size share what the others leave */
const RowBlock = defineComponent({
  props: {
    props: { type: Object as PropType<{ children: any[] }>, required: true }, // eslint-disable-line @typescript-eslint/no-explicit-any -- OpenUI's own prop type
    renderNode: { type: Function as PropType<(value: unknown) => RenderNodeResult>, required: true },
  },
  setup(p) {
    const ctx = inject(DASHBOARD_CONTEXT, null);
    return () => {
      const children = (p.props.children ?? []) as BlockNode[];
      const layoutOf = (c: BlockNode) => (c?.statementId && ctx ? ctx.layout(c.statementId) : {});
      const shown = children.filter(c => !layoutOf(c).hidden || ctx?.showHidden.value);
      const sized = shown.filter(c => layoutOf(c).span);
      const taken = sized.reduce((sum, c) => sum + Math.min(12, Math.max(2, layoutOf(c).span ?? 0)) * 5, 0);
      const free = shown.length - sized.length;
      const share = free ? Math.max(10, Math.floor((taken < GRID ? GRID - taken : GRID) / free)) : GRID;
      return h('div', { class: 'dash-grid grid', style: GRID_STYLE }, frames(children, p.renderNode, share));
    };
  },
});

// --- Filters ----------------------------------------------------------------------------------

/** The filter bar; a value picked by clicking a table row shows as a chip that clears it */
const FiltersBar = defineComponent({
  props: {
    props: { type: Object as PropType<{ children: any[] }>, required: true }, // eslint-disable-line @typescript-eslint/no-explicit-any -- OpenUI's own prop type
    renderNode: { type: Function as PropType<(value: unknown) => RenderNodeResult>, required: true },
  },
  setup(p) {
    const ctx = inject(DASHBOARD_CONTEXT, null);
    return () => {
      const children = (p.props.children ?? []) as BlockNode[];
      const controlled = new Set(children.map(c => c?.props?.name).filter((n): n is string => typeof n === 'string'));
      const picked = Object.entries(ctx?.filters.values.value ?? {}).filter(([name, value]) => value !== null && value !== '' && !controlled.has(name));
      return h('div', { class: 'dash-filters flex flex-wrap items-end gap-3' }, [
        ...children.map(c => p.renderNode(c) as VNode),
        ...picked.map(([name, value]) => h('span', { class: 'dash-chip inline-flex items-center gap-1 h-8 pl-2.5 pr-1 rounded-lg text-[12px] border text-gray-800 dark:text-zinc-100', style: { borderColor: 'var(--dash-c1)' } }, [
          h('span', { class: muted }, `${name} :`),
          h('span', { class: 'max-w-[14rem] truncate font-medium' }, ctx?.filters.labels.value[name] || formatLabel(value, lang())),
          h('button', {
            type: 'button', class: 'w-6 h-6 rounded-md flex items-center justify-center text-gray-400 hover:text-gray-900 dark:hover:text-zinc-100 hover:bg-gray-100 dark:hover:bg-zinc-800',
            title: tr('dashboards.filter.clear'), 'aria-label': tr('dashboards.filter.clear'), onClick: () => ctx?.filters.setValue(name, null),
          }, '×'),
        ])),
      ]);
    };
  },
});

const fieldClass = 'h-8 px-2.5 rounded-lg text-[12px] border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-gray-800 dark:text-zinc-200 outline-none focus:border-gray-400 dark:focus:border-zinc-500';

const PeriodFilter = defineComponent({
  props: { props: { type: Object as PropType<{ defaultPeriod?: string }>, required: true }, renderNode: { type: Function as PropType<(value: unknown) => RenderNodeResult>, required: true } },
  setup() {
    const ctx = inject(DASHBOARD_CONTEXT, null);
    return () => {
      if (!ctx) return null;
      const period = ctx.filters.period.value;
      const set = (patch: Partial<typeof period>) => ctx.filters.setPeriod({ ...period, ...patch });
      return h('div', { class: 'flex items-end gap-2' }, [
        h('label', { class: 'flex flex-col gap-1' }, [
          h('span', { class: `text-[11px] ${muted}` }, tr('dashboards.filter.period')),
          h('select', { class: `${fieldClass} pr-7 cursor-pointer`, value: period.preset, onChange: (e: Event) => set({ preset: (e.target as HTMLSelectElement).value }) },
            PERIODS.map(preset => h('option', { value: preset }, tr(`dashboards.filter.${preset}`)))),
        ]),
        period.preset === 'custom' ? h('input', { type: 'date', class: fieldClass, value: period.from ?? '', 'aria-label': tr('dashboards.filter.from'), onChange: (e: Event) => set({ from: (e.target as HTMLInputElement).value }) }) : null,
        period.preset === 'custom' ? h('input', { type: 'date', class: fieldClass, value: period.to ?? '', 'aria-label': tr('dashboards.filter.to'), onChange: (e: Event) => set({ to: (e.target as HTMLInputElement).value }) }) : null,
      ]);
    };
  },
});

/** Free text: queries match it with ILIKE '%' || {{name}} || '%' (empty: no filter) */
const SearchFilter = defineComponent({
  props: { props: { type: Object as PropType<{ name: string; label: string; placeholder?: string }>, required: true }, renderNode: { type: Function as PropType<(value: unknown) => RenderNodeResult>, required: true } },
  setup(p) {
    const ctx = inject(DASHBOARD_CONTEXT, null);
    const text = ref(ctx?.filters.values.value[p.props.name] ?? '');
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Cleared elsewhere (a chip): the field follows
    watch(() => ctx?.filters.values.value[p.props.name], value => { if ((value ?? '') !== text.value.trim()) text.value = value ?? ''; });
    const commit = () => {
      clearTimeout(timer);
      const value = text.value.trim() || null;
      if ((ctx?.filters.values.value[p.props.name] ?? null) !== value) ctx?.filters.setValue(p.props.name, value);
    };
    return () => h('label', { class: 'flex flex-col gap-1' }, [
      h('span', { class: `text-[11px] ${muted}` }, p.props.label),
      h('input', {
        type: 'search', value: text.value, placeholder: p.props.placeholder || tr('dashboards.filter.searchPlaceholder'),
        class: `${fieldClass} w-56`,
        onInput: (e: Event) => { text.value = (e.target as HTMLInputElement).value; clearTimeout(timer); timer = setTimeout(commit, 450); },
        onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') commit(); },
      }),
    ]);
  },
});

const SelectFilter = defineComponent({
  props: { props: { type: Object as PropType<{ name: string; label: string; options?: unknown[] }>, required: true }, renderNode: { type: Function as PropType<(value: unknown) => RenderNodeResult>, required: true } },
  setup(p) {
    const ctx = inject(DASHBOARD_CONTEXT, null);
    return () => {
      if (!ctx) return null;
      const name = p.props.name;
      const options = [...new Set((p.props.options ?? []).filter(o => o !== null && o !== undefined && o !== '').map(String))];
      const current = ctx.filters.values.value[name] ?? '';
      // Many values: a field that suggests them as you type
      if (options.length > 15) {
        const listId = `dash-options-${name}`;
        return h('label', { class: 'flex flex-col gap-1' }, [
          h('span', { class: `text-[11px] ${muted}` }, p.props.label),
          h('input', {
            type: 'search', list: listId, value: current, placeholder: tr('dashboards.filter.any'), class: `${fieldClass} w-56`,
            onChange: (e: Event) => {
              const value = (e.target as HTMLInputElement).value.trim();
              if (!value) ctx.filters.setValue(name, null);
              else if (options.includes(value)) ctx.filters.setValue(name, value);
            },
          }),
          h('datalist', { id: listId }, options.slice(0, 2000).map(o => h('option', { value: o }))),
        ]);
      }
      return h('label', { class: 'flex flex-col gap-1' }, [
        h('span', { class: `text-[11px] ${muted}` }, p.props.label),
        h('select', {
          class: `${fieldClass} pr-7 cursor-pointer max-w-[14rem]`, value: current,
          onChange: (e: Event) => ctx.filters.setValue(name, (e.target as HTMLSelectElement).value || null),
        }, [h('option', { value: '' }, tr('dashboards.filter.any')), ...options.map(o => h('option', { value: o }, formatLabel(o, lang())))]),
      ]);
    };
  },
});

// --- Text -------------------------------------------------------------------------------------

const renderHeading: Render<{ text: string }> = ({ props }) =>
  h('h3', { class: 'dash-heading pt-1 text-[14px] font-semibold text-gray-900 dark:text-zinc-100' }, props.text);

const renderText: Render<{ text: string }> = ({ props }) =>
  h('p', { class: 'text-[13px] leading-relaxed text-gray-600 dark:text-zinc-300 whitespace-pre-wrap' }, props.text);

const spans = (inlines: Inline[]) => inlines.map(s => (s.code
  ? h('code', { class: 'px-1 rounded bg-gray-100 dark:bg-zinc-800 font-mono text-[12px]' }, s.text)
  : s.bold ? h('strong', { class: 'font-semibold' }, s.text) : s.text));

const renderMarkdown: Render<{ text: string; title?: string }> = ({ props }) =>
  panel(props.title, h('div', { class: 'space-y-2 text-[13px] leading-relaxed text-gray-700 dark:text-zinc-300' }, markdownLite(props.text ?? '').map(md => {
    if (md.type === 'h') return h('h4', { class: 'font-semibold text-gray-900 dark:text-zinc-100' }, spans(md.inlines));
    if (md.type === 'p') return h('p', spans(md.inlines));
    if (md.type === 'code') return h('pre', { class: 'rounded-md bg-gray-50 dark:bg-zinc-950 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap' }, md.text);
    return h(md.type, { class: md.type === 'ul' ? 'list-disc pl-5 space-y-0.5' : 'list-decimal pl-5 space-y-0.5' }, md.items.map(item => h('li', spans(item))));
  })));

const renderNote: Render<{ text: string; tone?: 'info' | 'warning' }> = ({ props }) =>
  h('p', {
    class: props.tone === 'warning'
      ? 'rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300'
      : 'rounded-lg border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-800/40 px-3 py-2 text-[12px] text-gray-600 dark:text-zinc-300',
  }, props.text);

// --- Key figures --------------------------------------------------------------------------------

interface Kpi { label: string; value?: unknown; previous?: unknown; trend?: unknown[]; format?: string; hint?: string; lowerIsBetter?: boolean; goal?: unknown }

const sparkline = (values: number[]) => {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / span) * 24}`).join(' ');
  return h('svg', { viewBox: '0 0 100 30', preserveAspectRatio: 'none', class: 'mt-2 w-full h-7', 'aria-hidden': 'true' }, [
    h('polygon', { points: `0,30 ${points} 100,30`, style: { fill: color(0), opacity: 0.12 } }),
    h('polyline', { points, fill: 'none', 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round', style: { stroke: color(0) } }),
  ]);
};

const renderKpis: Render<{ items: Kpi[] }> = ({ props }) =>
  h('div', { class: 'grid', style: { gap: 'var(--dash-gap)', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))' } },
    (props.items ?? []).map(item => {
      const delta = item.previous !== undefined && item.previous !== null ? change(item.value, item.previous) : null;
      const good = delta === null ? null : (delta >= 0) !== !!item.lowerIsBetter;
      const hasGoal = item.goal !== undefined && item.goal !== null;
      return h('div', { class: `dash-stat ${cardClass} min-w-0`, style: { padding: 'var(--dash-pad)' } }, [
        h('div', { class: `text-[11px] truncate ${muted}` }, item.label),
        h('div', { class: 'mt-1 flex items-baseline gap-2 min-w-0' }, [
          h('span', { class: 'text-[22px] font-semibold tabular-nums text-gray-900 dark:text-zinc-100 truncate' }, formatValue(item.value, item.format, lang())),
          delta !== null ? h('span', {
            class: `shrink-0 text-[11px] font-medium tabular-nums ${good ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`,
            title: `${tr('dashboards.kpi.previous')} : ${formatValue(item.previous, item.format, lang())}`,
          }, `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toLocaleString(lang(), { maximumFractionDigits: 1 })} %`) : null,
        ]),
        item.hint || hasGoal ? h('div', { class: `text-[11px] truncate ${muted}` }, [
          item.hint ?? '',
          hasGoal ? `${item.hint ? ' · ' : ''}${tr('dashboards.kpi.goal', { goal: formatValue(item.goal, item.format, lang()) })}` : '',
        ].join('')) : null,
        sparkline(nums(item.trend)),
      ]);
    }));

const renderProgress: Render<{ label: string; value: unknown; goal: unknown; format?: string }> = ({ props }) => {
  const value = Number(props.value) || 0;
  const goal = Number(props.goal) || 0;
  const share = goal ? Math.max(0, Math.min(100, (value / goal) * 100)) : 0;
  return panel(props.label, [
    h('div', { class: 'flex items-baseline justify-between gap-2' }, [
      h('span', { class: 'text-[18px] font-semibold tabular-nums text-gray-900 dark:text-zinc-100' }, formatValue(props.value, props.format, lang())),
      h('span', { class: `text-[11px] tabular-nums ${muted}` }, `${Math.round(goal ? (value / goal) * 100 : 0)} % · ${formatValue(props.goal, props.format, lang())}`),
    ]),
    h('div', { class: 'mt-2 h-2 rounded-full bg-gray-100 dark:bg-zinc-800 overflow-hidden' },
      h('div', { class: 'dash-progress h-full rounded-full', style: { width: `${share}%`, background: color(0) } })),
  ]);
};

// --- Table ------------------------------------------------------------------------------------

const PAGE = 25;

/** Rows of a query: search, sort by a column, pages of 25 */
const DataTable = defineComponent({
  props: {
    props: { type: Object as PropType<{ columns: string[]; rows: unknown[]; caption?: string; labels?: string[]; formats?: string[]; select?: { filter: string; column: string; label?: string } }>, required: true },
    renderNode: { type: Function as PropType<(value: unknown) => RenderNodeResult>, required: true },
  },
  setup(p) {
    const ctx = inject(DASHBOARD_CONTEXT, null);
    const search = ref('');
    const sortBy = ref<number | null>(null);
    const desc = ref(false);
    const page = ref(0);
    const columns = computed(() => p.props.columns ?? []);
    const rows = computed(() => (p.props.rows ?? []).map(row => (Array.isArray(row) ? row : columns.value.map(c => (row as Record<string, unknown> | null)?.[c]))));
    const numeric = computed(() => columns.value.map((_, i) => rows.value.length > 0 && rows.value.every(r => r[i] === null || r[i] === undefined || typeof r[i] === 'number')));
    /** Columns shown: those whose header is not an empty label */
    const shownColumns = computed(() => columns.value.map((_, i) => i).filter(i => p.props.labels?.[i] !== ''));
    /** A click on a row sets a filter of the dashboard to one of its values (a click again clears it) */
    const selectAt = computed(() => (p.props.select && ctx ? columns.value.indexOf(p.props.select.column) : -1));
    const picked = computed(() => (p.props.select && ctx ? ctx.filters.values.value[p.props.select.filter] ?? null : null));
    const pick = (row: unknown[]) => {
      if (selectAt.value < 0 || !p.props.select || !ctx) return;
      const value = row[selectAt.value];
      if (value === null || value === undefined) return;
      const labelAt = p.props.select.label ? columns.value.indexOf(p.props.select.label) : -1;
      const label = labelAt >= 0 && row[labelAt] !== null && row[labelAt] !== undefined ? String(row[labelAt]) : undefined;
      ctx.filters.setValue(p.props.select.filter, picked.value === String(value) ? null : String(value), label);
    };
    const shown = computed(() => {
      const q = search.value.trim().toLowerCase();
      let list = q ? rows.value.filter(r => r.some(v => v !== null && v !== undefined && String(v).toLowerCase().includes(q))) : rows.value;
      if (sortBy.value !== null) {
        const i = sortBy.value;
        list = [...list].sort((a, b) => {
          const x = a[i];
          const y = b[i];
          if (x === y) return 0;
          if (x === null || x === undefined) return 1;
          if (y === null || y === undefined) return -1;
          const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), lang(), { numeric: true });
          return desc.value ? -r : r;
        });
      }
      return list;
    });
    watch(search, () => { page.value = 0; });
    const pages = computed(() => Math.max(1, Math.ceil(shown.value.length / PAGE)));
    // Fewer rows after a refresh: the last page that still exists
    watch(pages, n => { if (page.value > n - 1) page.value = n - 1; });
    const sort = (i: number) => {
      if (sortBy.value === i) desc.value = !desc.value;
      else { sortBy.value = i; desc.value = numeric.value[i]; }
    };
    return () => {
      const visible = shown.value.slice(page.value * PAGE, page.value * PAGE + PAGE);
      const searchBox = rows.value.length > 10 ? h('input', {
        type: 'search', value: search.value, placeholder: tr('dashboards.table.search'), 'aria-label': tr('dashboards.table.search'),
        class: 'h-7 w-40 min-w-[6rem] shrink px-2 rounded-md text-[11px] border border-gray-200 dark:border-zinc-700 bg-transparent outline-none focus:border-gray-400 dark:focus:border-zinc-500',
        onInput: (e: Event) => { search.value = (e.target as HTMLInputElement).value; },
      }) : null;
      return h('div', { class: `${cardClass} overflow-hidden flex flex-col` }, [
        p.props.caption || searchBox ? h('div', { class: 'flex items-center gap-2 px-3 py-2 border-b border-gray-100 dark:border-zinc-800 pr-20' }, [
          h('div', { class: 'flex-1 min-w-[5rem] truncate text-[12px] font-medium text-gray-800 dark:text-zinc-200', title: p.props.caption ?? '' }, p.props.caption ?? ''),
          searchBox,
        ]) : null,
        // A margin around the rows: the wheel there scrolls the page, not the table
        h('div', { class: 'dash-table-scroll overflow-auto mx-2 my-1.5 rounded-lg border border-gray-100 dark:border-zinc-800', style: { maxHeight: 'var(--dash-table-h)' } }, h('table', { class: 'w-full text-[12px] border-collapse' }, [
          h('thead', { class: 'sticky top-0 bg-gray-50 dark:bg-zinc-800' }, h('tr', shownColumns.value.map(i => columns.value[i]).map((c, n) => [c, shownColumns.value[n]] as const).map(([c, i]) => h('th', {
            class: `px-3 py-1.5 font-medium whitespace-nowrap cursor-pointer select-none hover:text-gray-900 dark:hover:text-zinc-100 ${numeric.value[i] ? 'text-right' : 'text-left'} ${muted}`,
            'aria-sort': sortBy.value === i ? (desc.value ? 'descending' : 'ascending') : 'none',
            onClick: () => sort(i),
          }, `${p.props.labels?.[i] || c}${sortBy.value === i ? (desc.value ? ' ↓' : ' ↑') : ''}`)))),
          h('tbody', visible.map(row => h('tr', {
            class: `border-t border-gray-100 dark:border-zinc-800 hover:bg-gray-50/70 dark:hover:bg-zinc-800/40 ${selectAt.value >= 0 ? 'cursor-pointer' : ''} ${selectAt.value >= 0 && picked.value !== null && String(row[selectAt.value]) === picked.value ? 'dash-picked' : ''}`,
            title: selectAt.value >= 0 ? tr('dashboards.table.pick') : undefined,
            onClick: selectAt.value >= 0 ? () => pick(row) : undefined,
          }, shownColumns.value.map(i => h('td', {
            class: `px-3 py-1.5 align-top ${numeric.value[i] ? 'text-right tabular-nums whitespace-nowrap' : ''} ${row[i] === null || row[i] === undefined ? 'text-gray-300 dark:text-zinc-600' : 'text-gray-800 dark:text-zinc-200'}`,
          }, formatValue(row[i], p.props.formats?.[i], lang())))))),
        ])),
        !rows.value.length ? empty() : null,
        pages.value > 1 ? h('div', { class: `flex items-center justify-end gap-2 px-3 py-1.5 border-t border-gray-100 dark:border-zinc-800 text-[11px] ${muted}` }, [
          h('span', { class: 'tabular-nums' }, tr('dashboards.table.rows', { count: shown.value.length })),
          h('button', { type: 'button', class: 'px-1.5 rounded hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-30', disabled: page.value === 0, 'aria-label': tr('dashboards.table.previous'), onClick: () => { page.value--; } }, '‹'),
          h('span', { class: 'tabular-nums' }, `${page.value + 1} / ${pages.value}`),
          h('button', { type: 'button', class: 'px-1.5 rounded hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-30', disabled: page.value >= pages.value - 1, 'aria-label': tr('dashboards.table.next'), onClick: () => { page.value++; } }, '›'),
        ]) : null,
      ]);
    };
  },
});

/** One record as a card (the row picked in a table): label and value per column */
const renderRecord: Render<{ columns: string[]; rows: unknown[]; title?: string; labels?: string[]; formats?: string[]; emptyText?: string }> = ({ props }) => {
  const columns = props.columns ?? [];
  const first = (props.rows ?? [])[0];
  if (!first) return panel(props.title, h('div', { class: `py-6 text-center text-[12px] ${muted}` }, props.emptyText || tr('dashboards.record.empty')));
  const row = Array.isArray(first) ? first : columns.map(c => (first as Record<string, unknown>)[c]);
  return panel(props.title, h('dl', { class: 'grid gap-x-4 gap-y-2', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 180px), 1fr))' } }, columns.map((c, i) => h('div', { class: 'min-w-0' }, [
    h('dt', { class: `text-[11px] truncate ${muted}` }, props.labels?.[i] || c),
    h('dd', { class: `text-[13px] break-words ${row[i] === null || row[i] === undefined ? 'text-gray-300 dark:text-zinc-600' : 'text-gray-900 dark:text-zinc-100'}` }, formatValue(row[i], props.formats?.[i], lang())),
  ]))));
};

// --- Charts -----------------------------------------------------------------------------------

interface SingleProps { labels: unknown[]; values: unknown[]; title?: string; unit?: string; format?: string }
interface Series { label: string; values: unknown[] }
interface MultiProps { labels: unknown[]; series: Series[]; title?: string; unit?: string; format?: string }

/** A chart whose categories filter the dashboard when clicked (select {filter}) */
interface Picking { current: string | null; pick: (label: unknown) => void }
const usePicking = (select: { filter: string } | undefined): (() => Picking | null) => {
  const ctx = inject(DASHBOARD_CONTEXT, null);
  return () => {
    if (!select?.filter || !ctx) return null;
    const current = ctx.filters.values.value[select.filter] ?? null;
    return {
      current,
      pick: (label: unknown) => {
        if (label === null || label === undefined) return;
        ctx.filters.setValue(select.filter, current === String(label) ? null : String(label));
      },
    };
  };
};
/** Picked category: full colour; the others fade while one is picked */
const pickedStyle = (picking: Picking | null, label: unknown) =>
  (picking?.current !== null && picking?.current !== undefined && picking.current !== String(label) ? { opacity: 0.35 } : {});

function barChart(props: SingleProps, picking: Picking | null) {
  const values = nums(props.values);
  if (!values.length) return panel(props.title, empty());
  const max = Math.max(1, ...values.map(Math.abs));
  const clickable = (label: unknown) => (picking ? { class: 'cursor-pointer', title: tr('dashboards.table.pick'), onClick: () => picking.pick(label) } : {});
  return panel(props.title, h('div', { class: 'grid items-center gap-x-2 gap-y-1.5', style: { gridTemplateColumns: 'minmax(0, 8rem) minmax(0, 1fr) auto' } }, (props.labels ?? []).flatMap((label, i) => [
    h('div', { class: `text-[11px] truncate ${muted} ${picking ? 'cursor-pointer hover:text-gray-900 dark:hover:text-zinc-100' : ''}`, title: formatLabel(label, lang()), style: pickedStyle(picking, label), onClick: picking ? () => picking.pick(label) : undefined }, formatLabel(label, lang())),
    h('div', { ...clickable(label), class: `h-3.5 rounded bg-gray-100 dark:bg-zinc-800 overflow-hidden ${picking ? 'cursor-pointer' : ''}`, title: valueText(values[i] ?? 0, props.unit, props.format), style: pickedStyle(picking, label) },
      h('div', { class: 'chat-bar h-full rounded', style: { width: `${(Math.abs(values[i] ?? 0) / max) * 100}%`, background: color(0), animationDelay: `${i * 40}ms` } })),
    h('div', { class: 'text-[11px] text-right tabular-nums text-gray-700 dark:text-zinc-300', style: pickedStyle(picking, label) }, valueText(values[i] ?? 0, props.unit, props.format)),
  ])));
}

const BarChartBlock = defineComponent({
  props: {
    props: { type: Object as PropType<SingleProps & { select?: { filter: string } }>, required: true },
    renderNode: { type: Function as PropType<(value: unknown) => RenderNodeResult>, required: true },
  },
  setup(p) {
    const picking = usePicking(p.props.select);
    return () => barChart(p.props, picking());
  },
});

const legend = (labels: string[]) => h('ul', { class: 'mt-2 flex flex-wrap gap-x-3 gap-y-1' }, labels.map((label, n) => h('li', { class: 'flex items-center gap-1.5 text-[11px]' }, [
  h('span', { class: 'w-2.5 h-2.5 rounded-sm', style: { background: color(n) } }),
  h('span', { class: muted }, label),
])));

/** Lines (optionally filled) for one or more series on one scale; hovering a point shows its values */
function lines(title: string | undefined, labels: unknown[], series: Array<{ label: string; values: number[] }>, opts: { unit?: string; format?: string; area?: boolean; legend?: boolean }) {
  const all = series.flatMap(s => s.values);
  if (labels.length < 2 || !all.length) return panel(title, empty());
  const min = Math.min(0, ...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const x = (i: number) => (i / (labels.length - 1)) * 300;
  const y = (v: number) => 92 - ((v - min) / span) * 84;
  const tip = (i: number) => `${formatLabel(labels[i], lang())}\n${series.map(s => `${s.label ? `${s.label} : ` : ''}${valueText(s.values[i] ?? 0, opts.unit, opts.format)}`).join('\n')}`;
  return panel(title, [
    h('div', { class: `flex justify-between text-[10px] tabular-nums ${muted}` }, [h('span', `max ${valueText(max, opts.unit, opts.format)}`), h('span', `min ${valueText(min, opts.unit, opts.format)}`)]),
    h('svg', { viewBox: '0 0 300 100', preserveAspectRatio: 'none', class: 'w-full', style: { height: 'var(--dash-chart-h)' }, role: 'img', 'aria-label': title || 'chart' }, [
      ...series.flatMap((s, n) => {
        const points = s.values.slice(0, labels.length).map((v, i) => `${x(i)},${y(v)}`).join(' ');
        const last = Math.min(s.values.length, labels.length) - 1;
        return [
          opts.area ? h('polygon', { points: `0,${y(min)} ${points} ${x(last)},${y(min)}`, style: { fill: color(n), opacity: series.length > 1 ? 0.12 : 0.18 } }) : null,
          h('polyline', { class: 'chat-line', points, fill: 'none', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round', style: { stroke: color(n) } }),
        ];
      }),
      ...labels.map((_, i) => h('rect', { x: x(i) - 150 / labels.length, y: 0, width: 300 / labels.length, height: 100, fill: 'transparent' }, [h('title', tip(i))])),
    ]),
    h('div', { class: `flex justify-between text-[10px] ${muted}` }, [h('span', formatLabel(labels[0], lang())), h('span', formatLabel(labels[labels.length - 1], lang()))]),
    opts.legend ? legend(series.map(s => s.label)) : null,
  ]);
}

const toSeries = (series: Series[] | undefined) => (series ?? []).slice(0, 8).map(s => ({ label: String(s?.label ?? ''), values: nums(s?.values) }));

const renderLineChart: Render<SingleProps> = ({ props }) => lines(props.title, props.labels ?? [], [{ label: '', values: nums(props.values) }], { unit: props.unit, format: props.format });
const renderAreaChart: Render<SingleProps> = ({ props }) => lines(props.title, props.labels ?? [], [{ label: '', values: nums(props.values) }], { unit: props.unit, format: props.format, area: true });
const renderMultiLine: Render<MultiProps> = ({ props }) => lines(props.title, props.labels ?? [], toSeries(props.series), { unit: props.unit, format: props.format, legend: true });

/** Columns per label, side by side (grouped) or on top of each other (stacked) */
function columnsChart(props: MultiProps, stacked: boolean) {
  const labels = props.labels ?? [];
  const series = toSeries(props.series);
  if (!labels.length || !series.length) return panel(props.title, empty());
  const totals = labels.map((_, i) => series.reduce((sum, s) => sum + Math.max(0, s.values[i] ?? 0), 0));
  const max = Math.max(1, ...(stacked ? totals : series.flatMap(s => s.values)));
  const tip = (i: number) => `${formatLabel(labels[i], lang())}\n${series.map(s => `${s.label} : ${valueText(s.values[i] ?? 0, props.unit, props.format)}`).join('\n')}`;
  return panel(props.title, [
    h('div', { class: `text-[10px] tabular-nums ${muted}` }, valueText(max, props.unit, props.format)),
    h('div', { class: 'flex items-end gap-1 border-b border-gray-100 dark:border-zinc-800', style: { height: 'var(--dash-chart-h)' } }, labels.map((_, i) => h('div', {
      class: `flex-1 min-w-0 h-full flex ${stacked ? 'flex-col-reverse' : 'items-end gap-px'}`, title: tip(i),
    }, series.map((s, n) => h('div', {
      class: `dash-column ${stacked ? 'w-full' : 'flex-1 rounded-t-sm'}`,
      style: { height: `${(Math.max(0, s.values[i] ?? 0) / max) * 100}%`, background: color(n), animationDelay: `${i * 25}ms` },
    }))))),
    h('div', { class: `flex justify-between text-[10px] ${muted}` }, [h('span', formatLabel(labels[0], lang())), h('span', formatLabel(labels[labels.length - 1], lang()))]),
    legend(series.map(s => s.label)),
  ]);
}
const renderMultiBar: Render<MultiProps> = ({ props }) => columnsChart(props, false);
const renderStackedBar: Render<MultiProps> = ({ props }) => columnsChart(props, true);

/** Shares of a whole; past 7 slices, the rest is grouped */
function donut(props: SingleProps, picking: Picking | null) {
  let slices: Array<{ label: string; raw: unknown; value: number }> = (props.labels ?? []).map((label, i) => ({ label: formatLabel(label, lang()), raw: label, value: Math.max(0, Number(props.values?.[i]) || 0) }));
  if (slices.length > 8) {
    const rest = slices.slice(7).reduce((sum, s) => sum + s.value, 0);
    slices = [...slices.slice(0, 7), { label: '…', raw: null, value: rest }];
  }
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (!total) return panel(props.title, empty());
  const r = 15.915; // circumference 100: dash lengths are percentages
  let offset = 25;
  const arcs = slices.map((s, i) => {
    const share = (s.value / total) * 100;
    const arc = h('circle', {
      cx: 21, cy: 21, r, fill: 'none', 'stroke-width': 6, 'stroke-dasharray': `${share} ${100 - share}`, 'stroke-dashoffset': offset,
      class: picking && s.raw !== null ? 'cursor-pointer' : '', style: { stroke: color(i), ...pickedStyle(picking, s.raw) },
      onClick: picking && s.raw !== null ? () => picking.pick(s.raw) : undefined,
    },
      [h('title', `${s.label} : ${valueText(s.value, props.unit, props.format)}`)]);
    offset -= share;
    return arc;
  });
  return panel(props.title, h('div', { class: 'flex items-center gap-4' }, [
    h('svg', { viewBox: '0 0 42 42', class: 'dash-donut w-28 h-28 shrink-0', role: 'img', 'aria-label': props.title || 'chart' }, [
      h('circle', { cx: 21, cy: 21, r, fill: 'none', stroke: 'currentColor', 'stroke-width': 6, class: 'text-gray-100 dark:text-zinc-800' }),
      ...arcs,
    ]),
    h('ul', { class: 'min-w-0 flex-1 space-y-1' }, slices.map((s, i) => h('li', {
      class: `flex items-center gap-2 text-[11px] ${picking && s.raw !== null ? 'cursor-pointer' : ''}`, style: pickedStyle(picking, s.raw),
      onClick: picking && s.raw !== null ? () => picking.pick(s.raw) : undefined,
    }, [
      h('span', { class: 'w-2 h-2 rounded-full shrink-0', style: { background: color(i) } }),
      h('span', { class: `flex-1 truncate ${muted}`, title: s.label }, s.label),
      h('span', { class: 'tabular-nums text-gray-700 dark:text-zinc-300' }, `${Math.round((s.value / total) * 100)} %`),
    ]))),
  ]));
}

const DonutBlock = defineComponent({
  props: {
    props: { type: Object as PropType<SingleProps & { select?: { filter: string } }>, required: true },
    renderNode: { type: Function as PropType<(value: unknown) => RenderNodeResult>, required: true },
  },
  setup(p) {
    const picking = usePicking(p.props.select);
    return () => donut(p.props, picking());
  },
});

/** Activity by day as a calendar: one column per week, darker on busier days */
const renderHeatmap: Render<{ days: unknown[]; values: unknown[]; title?: string; unit?: string }> = ({ props }) => {
  const byDay = new Map<string, number>();
  (props.days ?? []).forEach((d, i) => { if (typeof d === 'string') byDay.set(d.slice(0, 10), Number(props.values?.[i]) || 0); });
  if (!byDay.size) return panel(props.title, empty());
  const sorted = [...byDay.keys()].sort();
  const end = new Date(`${sorted[sorted.length - 1]}T00:00:00`);
  const day = new Date(`${sorted[0]}T00:00:00`);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7)); // back to Monday
  const max = Math.max(1, ...byDay.values());
  const pad = (n: number) => String(n).padStart(2, '0');
  const weeks: VNode[] = [];
  while (day <= end && weeks.length < 60) {
    const cells: VNode[] = [];
    for (let i = 0; i < 7; i++) {
      const key = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
      const v = byDay.get(key) ?? 0;
      cells.push(h('div', {
        class: `w-full aspect-square rounded-[2px] ${v ? '' : 'bg-gray-100 dark:bg-zinc-800'}`,
        style: v ? { background: color(0), opacity: 0.25 + 0.75 * (v / max) } : undefined,
        title: `${formatLabel(key, lang())} : ${v.toLocaleString(lang())}${props.unit ? ` ${props.unit}` : ''}`,
      }));
      day.setDate(day.getDate() + 1);
    }
    weeks.push(h('div', { class: 'flex-1 min-w-[6px] max-w-[22px] flex flex-col gap-[2px]' }, cells));
  }
  return panel(props.title, h('div', { class: 'flex gap-[2px] overflow-x-auto' }, weeks));
};

// --- Library ----------------------------------------------------------------------------------

const any = z.any();
const anyArray = z.array(z.any());
const series = z.array(z.object({ label: z.string(), values: anyArray }));
const fmt = z.string().optional();
// One schema object per component: OpenUI tells components apart by their schema
// select: categories that filter the dashboard when clicked (bars and donut; kept, unused, when the type changes)
const single = () => z.object({ labels: anyArray, values: anyArray, title: z.string().optional(), unit: z.string().optional(), format: fmt, select: z.object({ filter: z.string() }).optional() });
const multi = () => z.object({ labels: anyArray, series, title: z.string().optional(), unit: z.string().optional(), format: fmt });

export const dashboardLibrary = createLibrary({
  root: 'Dashboard',
  components: [
    defineUi({ name: 'Dashboard', description: 'The root: blocks on a 12-column grid, top to bottom (each block full width unless in a Row)', props: z.object({ children: anyArray }), component: DashboardRoot }),
    defineUi({ name: 'Row', description: 'Blocks side by side (2 to 4); the user can resize them', props: z.object({ children: anyArray }), component: RowBlock }),
    defineUi({ name: 'Filters', description: 'The filter bar, at the top: Filters([PeriodFilter("30d"), SelectFilter(…)])', props: z.object({ children: anyArray }), component: FiltersBar }),
    defineUi({ name: 'PeriodFilter', description: 'A period the user picks; queries use {{from}} and {{to}} (timestamps). defaultPeriod: 7d, 30d, 90d, 12m, ytd, all', props: z.object({ defaultPeriod: z.string().optional() }), component: PeriodFilter }),
    defineUi({ name: 'SearchFilter', description: 'Text the user types; queries use ({{name}} IS NULL OR col ILIKE \'%\' || {{name}} || \'%\'): SearchFilter("q", "Search", "Name or email")', props: z.object({ name: z.string(), label: z.string(), placeholder: z.string().optional() }), component: SearchFilter }),
    defineUi({ name: 'SelectFilter', description: 'A value to filter on; queries use {{name}} (text, NULL for all): SelectFilter("city", "City", cities.rows.value)', props: z.object({ name: z.string(), label: z.string(), options: anyArray.optional() }), component: SelectFilter }),
    defineUi({ name: 'Heading', description: 'A section title', props: z.object({ text: z.string() }), component: renderHeading }),
    defineUi({ name: 'Text', description: 'A short paragraph', props: z.object({ text: z.string() }), component: renderText }),
    defineUi({ name: 'Markdown', description: 'Formatted text in a card (paragraphs, # titles, lists, **bold**): Markdown(text, title?)', props: z.object({ text: z.string(), title: z.string().optional() }), component: renderMarkdown }),
    defineUi({ name: 'Note', description: 'A remark: a limit of the data, a caveat', props: z.object({ text: z.string(), tone: z.enum(['info', 'warning']).optional() }), component: renderNote }),
    defineUi({
      name: 'Kpis',
      description: 'Key figures (2 to 5). Item: {label, value, previous?, trend?, format?, hint?, lowerIsBetter?, goal?}; previous gives the change in %, trend (an array) a sparkline',
      props: z.object({ items: z.array(z.object({ label: z.string(), value: any, previous: any.optional(), trend: anyArray.optional(), format: fmt, hint: z.string().optional(), lowerIsBetter: z.boolean().optional(), goal: any.optional() })) }),
      component: renderKpis,
    }),
    defineUi({ name: 'Progress', description: 'A value toward a goal: Progress(label, value, goal, format?)', props: z.object({ label: z.string(), value: any, goal: any, format: fmt }), component: renderProgress }),
    defineUi({
      name: 'Table',
      description: 'Rows of a query (search, sort, pages): Table(q.columns, q.rows, caption?, labels?, formats?, select?) — labels: headers in the user\'s language; formats: one per column; select {filter, column, label?}: a click on a row sets the filter {{filter}} to that column\'s value, label names the column shown in the filter chip (the other blocks follow); an empty label "" hides a column',
      props: z.object({ columns: z.array(z.string()), rows: anyArray, caption: z.string().optional(), labels: z.array(z.string()).optional(), formats: z.array(z.string()).optional(), select: z.object({ filter: z.string(), column: z.string(), label: z.string().optional() }).optional() }),
      component: DataTable,
    }),
    defineUi({
      name: 'Record',
      description: 'The details of ONE record (e.g. the user picked in a Table), as a card: Record(q.columns, q.rows, title?, labels?, formats?, emptyText?) — shows the first row, emptyText while nothing is picked',
      props: z.object({ columns: z.array(z.string()), rows: anyArray, title: z.string().optional(), labels: z.array(z.string()).optional(), formats: z.array(z.string()).optional(), emptyText: z.string().optional() }),
      component: renderRecord,
    }),
    defineUi({ name: 'BarChart', description: 'A value across categories (at most 20): BarChart(q.rows.label, q.rows.value, title?, unit?, format?, select?) — select {filter}: a click on a bar sets {{filter}} to its label', props: single(), component: BarChartBlock }),
    defineUi({ name: 'LineChart', description: 'A value over time: LineChart(q.rows.day, q.rows.value, title?, unit?, format?)', props: single(), component: renderLineChart }),
    defineUi({ name: 'AreaChart', description: 'Like LineChart, filled: a volume over time', props: single(), component: renderAreaChart }),
    defineUi({ name: 'DonutChart', description: 'Shares of a whole (at most 8 slices): DonutChart(q.rows.label, q.rows.value, title?, unit?, format?, select?) — select {filter}: a click on a slice sets {{filter}} to its label', props: single(), component: DonutBlock }),
    defineUi({
      name: 'MultiLineChart',
      description: 'Several values of the same unit over time (one scale), one colour each with a legend: MultiLineChart(q.rows.week, [{label: "Photos", values: q.rows.photos}, {label: "Logins", values: q.rows.logins}], title?, unit?, format?)',
      props: multi(),
      component: renderMultiLine,
    }),
    defineUi({ name: 'MultiBarChart', description: 'Columns side by side per label, one colour per series (same arguments as MultiLineChart)', props: multi(), component: renderMultiBar }),
    defineUi({ name: 'StackedBarChart', description: 'Columns stacked per label: the parts of a total over time (same arguments as MultiLineChart)', props: multi(), component: renderStackedBar }),
    defineUi({ name: 'Heatmap', description: 'Activity by day as a calendar: Heatmap(q.rows.day, q.rows.value, title?, unit?) — days as dates', props: z.object({ days: anyArray, values: anyArray, title: z.string().optional(), unit: z.string().optional() }), component: renderHeatmap }),
  ],
});

/** The only tool a dashboard's queries may use: a read-only SELECT run by bbdump */
export const SQL_TOOL = {
  name: 'sql',
  description: 'Runs one read-only SELECT on the database and returns its columns and rows (rows are objects keyed by column alias). At most 1000 rows, 30 s. Filter placeholders {{from}}, {{to}} and {{name}} are bound by bbdump.',
  inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'One SELECT statement' } }, required: ['query'] },
  outputSchema: { type: 'object', properties: { columns: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'object' } } } },
  annotations: { readOnlyHint: true },
};

const EXAMPLE_LINKED = `root = Dashboard([filters, people, profile, orders])
users = Query("sql", {query: "SELECT u.id, u.name, u.email, u.created_at FROM users u WHERE ({{q}} IS NULL OR u.name ILIKE '%' || {{q}} || '%' OR u.email ILIKE '%' || {{q}} || '%') ORDER BY u.created_at DESC LIMIT 50"}, {columns: [], rows: []})
picked = Query("sql", {query: "SELECT u.name, u.email, u.phone, u.created_at, (SELECT count(*)::int FROM orders o WHERE o.user_id = u.id) AS orders FROM users u WHERE u.id::text = {{user}}"}, {columns: [], rows: []})
theirOrders = Query("sql", {query: "SELECT o.id, o.status, o.total::float8 AS total, o.created_at FROM orders o WHERE ({{user}} IS NULL OR o.user_id::text = {{user}}) ORDER BY o.created_at DESC LIMIT 50"}, {columns: [], rows: []})
filters = Filters([SearchFilter("q", "Search", "Name or email")])
people = Table(users.columns, users.rows, "Users (click one)", ["", "Name", "Email", "Signed up"], ["text", "text", "text", "date"], {filter: "user", column: "id", label: "email"})
profile = Record(picked.columns, picked.rows, "Picked user", ["Name", "Email", "Phone", "Signed up", "Orders"], ["text", "text", "text", "date", "integer"], "Click a user to see the details")
orders = Table(theirOrders.columns, theirOrders.rows, "Orders", ["Order", "Status", "Total", "Date"], ["integer", "text", "money:EUR", "datetime"])`;

const EXAMPLE = `root = Dashboard([filters, figures, charts, latest])
cities = Query("sql", {query: "SELECT DISTINCT city AS value FROM customers ORDER BY 1 LIMIT 100"}, {columns: [], rows: []})
totals = Query("sql", {query: "SELECT count(*)::int AS orders, coalesce(sum(o.total), 0)::float8 AS revenue, (SELECT coalesce(sum(p.total), 0)::float8 FROM orders p JOIN customers pc ON pc.id = p.customer_id WHERE p.created_at >= {{from}} - ({{to}} - {{from}}) AND p.created_at < {{from}} AND ({{city}} IS NULL OR pc.city = {{city}})) AS revenue_before FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.created_at >= {{from}} AND o.created_at < {{to}} AND ({{city}} IS NULL OR c.city = {{city}})"}, {columns: [], rows: []})
perWeek = Query("sql", {query: "SELECT date_trunc('week', o.created_at)::date AS week, count(*) FILTER (WHERE o.status = 'paid')::int AS paid, count(*) FILTER (WHERE o.status = 'cancelled')::int AS cancelled FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.created_at >= {{from}} AND o.created_at < {{to}} AND ({{city}} IS NULL OR c.city = {{city}}) GROUP BY 1 ORDER BY 1"}, {columns: [], rows: []})
recent = Query("sql", {query: "SELECT o.id, c.name, o.status, o.total::float8 AS total, o.created_at FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ({{city}} IS NULL OR c.city = {{city}}) ORDER BY o.created_at DESC LIMIT 50"}, {columns: [], rows: []})
filters = Filters([PeriodFilter("30d"), SelectFilter("city", "City", cities.rows.value)])
figures = Row([ordersKpi, revenueKpi])
ordersKpi = Kpis([{label: "Orders", value: @First(totals.rows.orders), format: "integer"}])
revenueKpi = Kpis([{label: "Revenue", value: @First(totals.rows.revenue), previous: @First(totals.rows.revenue_before), format: "money:EUR"}])
charts = Row([weekChart, goodToKnow])
weekChart = StackedBarChart(perWeek.rows.week, [{label: "Paid", values: perWeek.rows.paid}, {label: "Cancelled", values: perWeek.rows.cancelled}], "Orders per week")
goodToKnow = Markdown("**Cancelled** orders are refunded within 7 days.", "Good to know")
latest = Table(recent.columns, recent.rows, "Latest orders", ["Order", "Customer", "Status", "Total", "Date"], ["integer", "text", "text", "money:EUR", "datetime"])`;


const LANGUAGE_NAMES: Record<string, string> = { en: 'English', fr: 'French' };

/** How a PostgreSQL dashboard reads its data */
const SQL_RULES = {
  app: 'a PostgreSQL desktop app',
  learn: 'Learn the schema with get_schema_overview, then test every SELECT with check_query before putting it in the dashboard (it returns the columns and the row count, no values). Use execute_query only when you must see values (e.g. the distinct values of a status column).',
  query: 'Query("sql", {query: "SELECT …"}, {columns: [], rows: []})',
  rules: [
    'SQL: one SELECT per Query, no semicolon, with LIMIT for lists (50 rows for tables, 20 bars at most). Cast counts and sums with ::int or ::float8. Return dates and timestamps as they are (no to_char): bbdump formats them in the user\'s language. Group by time with date_trunc(…)::date.',
    'Keep queries light: they run on every refresh. Prefer one query per block, aggregate in SQL, avoid scanning big tables without a date condition.',
    'Filters: when the user wants to filter (a period, a category), add Filters([…]) at the top and use the placeholders in EVERY relevant query: created_at >= {{from}} AND created_at < {{to}} for the period, ({{name}} IS NULL OR col = {{name}}) for a SelectFilter. bbdump binds them as parameters, as text: compare ids with col::text = {{name}}. Do not use $variables, Select, Input, forms, buttons or the Query refresh interval.',
    'Search: to find people or things by typing, use SearchFilter (never a SelectFilter of hundreds of emails): ({{q}} IS NULL OR name ILIKE \'%\' || {{q}} || \'%\' OR email ILIKE …).',
    'Linked blocks (master and detail): when the user wants to look at one record and what belongs to it, list the records in a Table with select {filter: "x", column: "id", label: "email"} (hide the id column with an empty label ""); a click sets {{x}}. Show the record with Record (its query returns the row WHERE id::text = {{x}}, nothing while {{x}} is NULL) and filter the related blocks with ({{x}} IS NULL OR fk::text = {{x}}). Do not filter the list itself by {{x}}, so the user can pick another one.',
    'Charts by category (BarChart, DonutChart) can drive the dashboard too: give them select {filter: "status"} and filter the other blocks with ({{status}} IS NULL OR col = {{status}}), the chart itself staying unfiltered.',
    'When asked to explain a block, answer in plain words for someone who does not know SQL: what is counted, what is left out, the period, the tables it comes from. No SQL, no code, no change to the dashboard.',
    'Column aliases in charts and Kpis are plucked (q.rows.alias): simple lowercase ascii aliases. Table headers in the user\'s language go in labels; formats (money:EUR, percent, integer, duration, bytes, date, datetime, text) in formats.',
  ],
  tool: SQL_TOOL,
  examples: [EXAMPLE, EXAMPLE_LINKED],
};

/** How a MongoDB dashboard reads its data */
const MONGO_RULES = {
  app: 'a database desktop app; this database is MongoDB',
  learn: 'Learn the collections with mongo_list_collections and mongo_describe_collection (fields from a sample, their types), then test every pipeline with mongo_aggregate (limit 5, placeholders replaced by real values) before putting it in the dashboard. Only the mongo_* tools work on this database.',
  query: 'Query("mongo", {query: "{\\"collection\\": \\"orders\\", \\"pipeline\\": [ … ]}"}, {columns: [], rows: []})',
  rules: [
    'Queries: the query is a JSON text {"collection": "…", "pipeline": [stages]}, written inside the OpenUI string with its quotes escaped (\\"), as in the examples. Read only: $out, $merge, $where, $function and $accumulator are refused. Join collections with $lookup.',
    'End every pipeline with $project giving flat fields with simple lowercase ascii names (no nested objects or arrays: they show as JSON), _id: 0 unless you need it. Write every field as an expression ("status": "$status", never "status": 1): the columns then come in the order you write them, which Table labels and formats follow. Ids as text with {"$toString": "$_id"}. Use $limit for lists (50 rows for tables, 20 bars at most). Return dates as dates (no $dateToString): bbdump formats them in the user\'s language. Group by time with {"$dateTrunc": {"date": "$field", "unit": "week"}}.',
    'Keep pipelines light: they run on every refresh. $match first (on indexed fields when you can), one pipeline per block, avoid reading a whole big collection without a date condition.',
    'Filters: when the user wants to filter (a period, a category), add Filters([…]) at the top and use the placeholders in EVERY relevant pipeline, always as whole JSON strings: {"$match": {"created_at": {"$gte": "{{from}}", "$lt": "{{to}}"}}} for the period (bbdump puts dates there), {"$match": {"$expr": {"$or": [{"$eq": ["{{name}}", null]}, {"$eq": ["$field", "{{name}}"]}]}}} for a SelectFilter (null means all). Values are text: compare ids and numbers with {"$toString": "$field"}. Do not use $variables, Select, Input, forms, buttons or the Query refresh interval.',
    'Search: to find people or things by typing, use SearchFilter (never a SelectFilter of hundreds of emails) with {"$regex": "(?i){{q}}"} on each field searched (inside a longer string bbdump inserts the text escaped, and nothing when the search is empty).',
    'Linked blocks (master and detail): when the user wants to look at one record and what belongs to it, list the records in a Table with select {filter: "x", column: "id", label: "email"} (id from {"$toString": "$_id"}, hidden with an empty label ""); a click sets {{x}}. Show the record with Record (its pipeline matches {"$expr": {"$eq": [{"$toString": "$_id"}, "{{x}}"]}}, nothing while {{x}} is null) and filter the related blocks with {"$expr": {"$or": [{"$eq": ["{{x}}", null]}, {"$eq": [{"$toString": "$fk"}, "{{x}}"]}]}}. Do not filter the list itself by {{x}}, so the user can pick another one.',
    'Charts by category (BarChart, DonutChart) can drive the dashboard too: give them select {filter: "status"} and filter the other blocks on "{{status}}" the same way, the chart itself staying unfiltered.',
    'When asked to explain a block, answer in plain words for someone who does not know MongoDB: what is counted, what is left out, the period, the collections it comes from. No pipeline, no code, no change to the dashboard.',
    'Field names in charts and Kpis are plucked (q.rows.name): the $project names. Table headers in the user\'s language go in labels; formats (money:EUR, percent, integer, duration, bytes, date, datetime, text) in formats.',
  ],
  tool: MONGO_TOOL,
  examples: [MONGO_EXAMPLE, MONGO_EXAMPLE_LINKED],
};

/**
 * How a MySQL / MariaDB, SQLite or DuckDB dashboard reads its data: the same rules as
 * PostgreSQL, in the engine's dialect, through the sql_* tools
 */
function dialectRules(dialect: 'mysql' | 'sqlite' | 'duckdb' | 'sqlserver') {
  const mysql = dialect === 'mysql';
  const duckdb = dialect === 'duckdb';
  const sqlserver = dialect === 'sqlserver';
  const product = mysql ? 'MySQL / MariaDB' : duckdb ? 'DuckDB' : sqlserver ? 'SQL Server' : 'SQLite';
  return {
    app: `a database desktop app; this database is ${product}`,
    learn: `Learn the schema with sql_schema_overview (or sql_describe_table), then test every SELECT with sql_query (limit 5, the placeholders replaced by real values) before putting it in the dashboard. Only the sql_* tools work on this database; write ${product} SQL.`,
    query: `Query("${dialect}", {query: "SELECT …"}, {columns: [], rows: []})`,
    rules: [
      sqlserver
        ? 'SQL: one SELECT per Query, no semicolon. SQL Server has no LIMIT: TOP (50) for tables, TOP (20) bars at most, right after SELECT. Quote names with [brackets] when needed. Conditional counts with SUM(CASE WHEN condition THEN 1 ELSE 0 END). GROUP BY repeats the expression (an alias of the SELECT cannot be used there). Return dates and timestamps as they are, except grouped ones, as text: by day CONVERT(char(10), col, 23), by week CONVERT(char(10), DATEADD(day, -(DATEDIFF(day, \'19000101\', col) % 7), CAST(col AS date)), 23), by month CONVERT(char(7), col, 23). Compare dates with CAST({{from}} AS datetime2). No ILIKE (LIKE ignores case with the usual collations), strings joined with +, CAST(x AS int / decimal(12,2) / nvarchar(100)), booleans are bit (0 / 1).'
        : duckdb
        ? 'SQL: one SELECT per Query, no semicolon, with LIMIT for lists (50 rows for tables, 20 bars at most). Quote names with "double quotes" when needed. Conditional counts with count(*) FILTER (WHERE condition). Return dates and timestamps as they are (no strftime for display): bbdump formats them in the user\'s language. Group by day with CAST(col AS DATE), by week with CAST(date_trunc(\'week\', col) AS DATE), by month with CAST(date_trunc(\'month\', col) AS DATE). ILIKE and :: casts work. Files cannot be read (read_csv, read_parquet… are refused): only the tables of the database.'
        : mysql
        ? 'SQL: one SELECT per Query, no semicolon, with LIMIT for lists (50 rows for tables, 20 bars at most). Quote names with `backticks` when needed. Conditional counts with SUM(condition). Return dates and timestamps as they are (no DATE_FORMAT for display): bbdump formats them in the user\'s language. Group by day with DATE(col), by week with DATE(col - INTERVAL WEEKDAY(col) DAY), by month with DATE_FORMAT(col, \'%Y-%m-01\'). No ILIKE, no :: casts (CAST(x AS SIGNED / DECIMAL(12,2) / CHAR)).'
        : 'SQL: one SELECT per Query, no semicolon, with LIMIT for lists (50 rows for tables, 20 bars at most). Quote names with "double quotes" when needed. Conditional counts with SUM(condition). Dates are text (ISO 8601, "2026-10-28 09:30:00") or numbers: return them as they are, bbdump formats them. Group by day with date(col), by week with date(col, \'weekday 0\', \'-6 days\'), by month with strftime(\'%Y-%m-01\', col); a UNIX time: date(col, \'unixepoch\'). No ILIKE, no :: casts (CAST(x AS INTEGER / REAL / TEXT)). Booleans are 0 / 1.',
      'Keep queries light: they run on every refresh. Prefer one query per block, aggregate in SQL, avoid scanning big tables without a date condition.',
      `Filters: when the user wants to filter (a period, a category), add Filters([…]) at the top and use the placeholders in EVERY relevant query: ${sqlserver ? 'created_at >= CAST({{from}} AS datetime2) AND created_at < CAST({{to}} AS datetime2)' : 'created_at >= {{from}} AND created_at < {{to}}'} for the period (bbdump binds UTC date texts "YYYY-MM-DD HH:MM:SS"), ({{name}} IS NULL OR col = {{name}}) for a SelectFilter. bbdump binds them as ? parameters, as text (compared with numbers or dates, ${mysql ? 'MySQL' : duckdb ? 'DuckDB' : sqlserver ? 'SQL Server' : 'SQLite'} converts them). Do not use $variables, Select, Input, forms, buttons or the Query refresh interval.`,
      sqlserver
        ? 'Search: to find people or things by typing, use SearchFilter (never a SelectFilter of hundreds of emails): ({{q}} IS NULL OR name LIKE \'%\' + {{q}} + \'%\' OR email LIKE …); LIKE ignores case with the usual collations.'
        : duckdb
        ? 'Search: to find people or things by typing, use SearchFilter (never a SelectFilter of hundreds of emails): ({{q}} IS NULL OR name ILIKE \'%\' || {{q}} || \'%\' OR email ILIKE …).'
        : mysql
        ? 'Search: to find people or things by typing, use SearchFilter (never a SelectFilter of hundreds of emails): ({{q}} IS NULL OR name LIKE CONCAT(\'%\', {{q}}, \'%\') OR email LIKE …); LIKE ignores case.'
        : 'Search: to find people or things by typing, use SearchFilter (never a SelectFilter of hundreds of emails): ({{q}} IS NULL OR name LIKE \'%\' || {{q}} || \'%\' OR email LIKE …); LIKE ignores the case of ASCII letters.',
      'Linked blocks (master and detail): when the user wants to look at one record and what belongs to it, list the records in a Table with select {filter: "x", column: "id", label: "email"} (hide the id column with an empty label ""); a click sets {{x}}. Show the record with Record (its query returns the row WHERE id = {{x}}, nothing while {{x}} is NULL) and filter the related blocks with ({{x}} IS NULL OR fk = {{x}}). Do not filter the list itself by {{x}}, so the user can pick another one.',
      'Charts by category (BarChart, DonutChart) can drive the dashboard too: give them select {filter: "status"} and filter the other blocks with ({{status}} IS NULL OR col = {{status}}), the chart itself staying unfiltered.',
      'When asked to explain a block, answer in plain words for someone who does not know SQL: what is counted, what is left out, the period, the tables it comes from. No SQL, no code, no change to the dashboard.',
      'Column aliases in charts and Kpis are plucked (q.rows.alias): simple lowercase ascii aliases. Table headers in the user\'s language go in labels; formats (money:EUR, percent, integer, duration, bytes, date, datetime, text) in formats.',
    ],
    tool: mysql ? MYSQL_TOOL : duckdb ? DUCKDB_TOOL : sqlserver ? SQLSERVER_TOOL : SQLITE_TOOL,
    examples: mysql ? [MYSQL_EXAMPLE, MYSQL_EXAMPLE_LINKED] : duckdb ? [DUCKDB_EXAMPLE, DUCKDB_EXAMPLE_LINKED] : sqlserver ? [SQLSERVER_EXAMPLE, SQLSERVER_EXAMPLE_LINKED] : [SQLITE_EXAMPLE, SQLITE_EXAMPLE_LINKED],
  };
}

/** The rules of a database's engine */
function rulesFor(engine: string) {
  if (engine === 'mongodb') return MONGO_RULES;
  if (engine === 'mysql' || engine === 'mariadb') return dialectRules('mysql');
  if (engine === 'sqlite') return dialectRules('sqlite');
  if (engine === 'duckdb') return dialectRules('duckdb');
  if (engine === 'sqlserver') return dialectRules('sqlserver');
  return SQL_RULES;
}

/** What the AI is told: who it is, how a dashboard gets its data, how to edit one */
export function dashboardSystemPrompt(database: string, engine = 'postgresql'): string {
  const language = LANGUAGE_NAMES[lang()] ?? 'English';
  const how = rulesFor(engine);
  const preamble = [
    `You are the assistant built into bbdump, ${how.app}. You build and edit a live dashboard for one database: "${database}".`,
    'It is already the active connection of the bbdump MCP tools (do not call use_connection or list_connections). You can only read: never claim you changed the data.',
    how.learn,
    `The dashboard holds NO data: every value comes from ${how.query}, which bbdump runs each time the dashboard opens or refreshes, or when a filter changes. Never copy values you read into the program.`,
    'The dashboard shows the real data to the user. The anonymization of what you read applies to you only: never mention it in the dashboard.',
    'Each message gives you the current program (or says the dashboard is empty) and the request, sometimes aimed at one block.',
    `Language: write every sentence in ${language}, the language of the app, unless the request is clearly written in another one: the short notes between tool calls, and the labels and titles of the dashboard, included. Never switch to the language the data or the schema happen to be in. In French, address the user with "tu". Be brief: one or two sentences about what you did.`,
  ].join('\n');
  return dashboardLibrary.prompt({
    preamble,
    tools: [how.tool],
    editMode: true,
    inlineMode: true,
    toolExamples: how.examples,
    additionalRules: [
      'Query defaults are always exactly {columns: [], rows: []}: no sample data.',
      ...how.rules,
      'Key figures: one Kpis block per figure, side by side in a Row (figures = Row([ordersKpi, revenueKpi])), so the user can move and resize each one.',
      'Key figures: add previous (the same measure over the previous period, with the same filters) when it helps, format, and trend (a short series) for the main ones. Several values over time: MultiLineChart, MultiBarChart or StackedBarChart, never several charts or a table instead, as long as they share a unit (all money, all counts…).',
      'One chart has one scale: values of different units or sizes (revenue in € and a number of orders, a total and a rate) go in separate charts side by side in a Row, never in the same chart, where the small one would be flat.',
      'A request the components cannot do exactly: build the closest thing, then say in one sentence what differs. Do not refuse.',
      'An empty dashboard: write the whole program in one ```openui-lang block. An existing one: output only the changed or new statements, keeping the names of the blocks (the user\'s layout is attached to them).',
      `End every answer with up to 3 short next steps the user may want, written as requests in the same language as your notes (${language} unless the request is in another one), in a \`\`\`suggestions block (one per line). When you need the user to choose, ask the question and put the choices there instead. If the request is only a question, answer in text without code.`,
    ],
  });
}

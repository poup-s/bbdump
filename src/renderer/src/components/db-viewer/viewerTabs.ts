/**
 * Table tabs of the database viewer. Each tab keeps its sub-view and its grid state
 * (search, page, sort). Tabs live in memory for the session; the open tabs, their view
 * and sort are also remembered per database in localStorage. Search text is not written
 * to disk: it can hold personal data (emails, names) typed by the user.
 */
export type ViewerSubTab = 'data' | 'relations' | 'schema';

export interface ViewerTabState {
  search: string;
  page: number;
  pageSize: number;
  sortBy: string | null;
  sortOrder: 'asc' | 'desc';
}

export interface ViewerTab {
  key: string;
  schema: string;
  table: string;
  view: ViewerSubTab;
  state: ViewerTabState | null;
  /** Preview tab (single click): replaced by the next table opened, until it is used */
  preview: boolean;
}

export interface ViewerTabSession {
  tabs: ViewerTab[];
  active: string | null;
}

export const MAX_TABS = 10;

/** Unique for any schema / table names (both may contain dots or quotes) */
export const tabKey = (schema: string, table: string) => JSON.stringify([schema, table]);

const SUB_TABS: readonly ViewerSubTab[] = ['data', 'relations', 'schema'];
const storageKey = (dbId: string) => `bbdump:viewer-tabs:${dbId}`;

/** Same session for the same database until the app quits (search included). */
const memory = new Map<string, ViewerTabSession>();

const emptySession = (): ViewerTabSession => ({ tabs: [], active: null });

function fromStorage(dbId: string): ViewerTabSession {
  try {
    const raw = localStorage.getItem(storageKey(dbId));
    if (!raw) return emptySession();
    const parsed = JSON.parse(raw) as { tabs?: unknown; active?: unknown };
    const tabs: ViewerTab[] = [];
    for (const item of Array.isArray(parsed.tabs) ? parsed.tabs.slice(0, MAX_TABS) : []) {
      const t = item as Record<string, unknown>;
      if (typeof t.schema !== 'string' || typeof t.table !== 'string') continue;
      const view = SUB_TABS.includes(t.view as ViewerSubTab) ? (t.view as ViewerSubTab) : 'data';
      const pageSize = [25, 50, 100, 200].includes(t.pageSize as number) ? (t.pageSize as number) : 50;
      tabs.push({
        key: tabKey(t.schema, t.table),
        schema: t.schema,
        table: t.table,
        view,
        preview: t.preview === true,
        state: {
          search: '',
          page: 1,
          pageSize,
          sortBy: typeof t.sortBy === 'string' ? t.sortBy : null,
          sortOrder: t.sortOrder === 'desc' ? 'desc' : 'asc',
        },
      });
    }
    const active = typeof parsed.active === 'string' && tabs.some((t) => t.key === parsed.active)
      ? parsed.active
      : tabs[0]?.key ?? null;
    return { tabs, active };
  } catch {
    return emptySession();
  }
}

export function loadTabSession(dbId: string): ViewerTabSession {
  const session = memory.get(dbId) ?? fromStorage(dbId);
  return { tabs: session.tabs.map((t) => ({ ...t, state: t.state ? { ...t.state } : null })), active: session.active };
}

export function saveTabSession(dbId: string, session: ViewerTabSession) {
  memory.set(dbId, { tabs: session.tabs.map((t) => ({ ...t, state: t.state ? { ...t.state } : null })), active: session.active });
  try {
    localStorage.setItem(storageKey(dbId), JSON.stringify({
      active: session.active,
      tabs: session.tabs.map((t) => ({
        schema: t.schema,
        table: t.table,
        view: t.view,
        preview: t.preview,
        sortBy: t.state?.sortBy ?? null,
        sortOrder: t.state?.sortOrder ?? 'asc',
        pageSize: t.state?.pageSize ?? 50,
      })),
    }));
  } catch {
    // Storage unavailable or full: the in-memory session still works
  }
}

/**
 * Opens (or focuses) a table. A preview open reuses the preview tab in place (browsing tables
 * does not pile up tabs); a pinned open keeps the tab. Over the limit, the oldest tab other
 * than the current one goes.
 */
export function openTab(
  tabs: ViewerTab[], schema: string, table: string, current: string | null, options: { preview?: boolean } = {},
): { tabs: ViewerTab[]; key: string } {
  const key = tabKey(schema, table);
  const preview = options.preview ?? false;
  if (tabs.some((t) => t.key === key)) {
    return { tabs: preview ? tabs : pinTab(tabs, key), key };
  }
  const tab: ViewerTab = { key, schema, table, view: 'data', state: null, preview };
  const previewIndex = preview ? tabs.findIndex((t) => t.preview) : -1;
  const next = previewIndex >= 0
    ? tabs.map((t, i) => (i === previewIndex ? tab : t))
    : [...tabs, tab];
  while (next.length > MAX_TABS) {
    const index = next.findIndex((t) => t.key !== current && t.key !== key);
    if (index < 0) break;
    next.splice(index, 1);
  }
  return { tabs: next, key };
}

/** The tab stays: it is no longer replaced by the next preview. */
export function pinTab(tabs: ViewerTab[], key: string): ViewerTab[] {
  return tabs.some((t) => t.key === key && t.preview)
    ? tabs.map((t) => (t.key === key ? { ...t, preview: false } : t))
    : tabs;
}

/** Closes a tab; when it was the active one, its right neighbour (else left) becomes active. */
export function closeTab(tabs: ViewerTab[], key: string, active: string | null): ViewerTabSession {
  const index = tabs.findIndex((t) => t.key === key);
  if (index < 0) return { tabs, active };
  const next = tabs.filter((t) => t.key !== key);
  if (active !== key) return { tabs: next, active };
  return { tabs: next, active: (next[index] ?? next[index - 1])?.key ?? null };
}

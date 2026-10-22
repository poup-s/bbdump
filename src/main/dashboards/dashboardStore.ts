/**
 * Dashboards made with the AI: one encrypted file per dashboard, in
 * <userData>/dashboards/<database id>/<dashboard id>.json, apart from config.json.
 * A dashboard holds SQL queries and the conversation that shaped it (what the AI read), so
 * it is encrypted like the chat history; unlike it, it is kept until deleted.
 * No Electron import: the folder and the cipher are given.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Cipher } from '../aiChat/chatHistory';

/** A previous program, to undo the AI's last changes */
export interface DashboardVersion {
  program: string;
  at: string;
}

/** The conversation that builds and edits the dashboard (continued with the tool's session) */
export interface DashboardChat {
  provider: string;
  model?: string;
  sessionId?: string;
  messages: unknown[];
}

/** Size and visibility the user gave a block (by its statement's name) */
export interface BlockLayout { span?: number; hidden?: boolean; height?: number }
export interface DashboardTheme { accent: string; density: 'comfortable' | 'compact' }
export interface DashboardFilters {
  period?: { preset: string; from?: string; to?: string };
  values?: Record<string, string | null>;
  /** What the chip of a value picked in a table shows */
  labels?: Record<string, string>;
}

export interface Dashboard {
  id: string;
  databaseId: string;
  title: string;
  /** OpenUI Lang program; its data comes from Query("sql", …) run on each refresh */
  program: string;
  /** Automatic refresh while the dashboard is open, in seconds (0: by hand) */
  refreshSeconds: number;
  createdAt: string;
  updatedAt: string;
  versions: DashboardVersion[];
  chat?: DashboardChat;
  layout?: Record<string, BlockLayout>;
  theme?: DashboardTheme;
  filters?: DashboardFilters;
  /** Shown on the home page */
  pinned?: boolean;
  /** The last results are kept (encrypted) to show the dashboard at once when it opens */
  cacheResults?: boolean;
}

export type DashboardSummary = Pick<Dashboard, 'id' | 'databaseId' | 'title' | 'refreshSeconds' | 'createdAt' | 'updatedAt'> & { empty: boolean; pinned: boolean };

export const ACCENTS = ['emerald', 'blue', 'violet', 'amber', 'rose', 'slate'];
const PERIOD_PRESETS = ['7d', '30d', '90d', '12m', 'ytd', 'all', 'custom'];
const NAME_RE = /^[A-Za-z_]\w{0,79}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function sanitizeLayout(input: unknown): Record<string, BlockLayout> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const out: Record<string, BlockLayout> = {};
  for (const [id, value] of Object.entries(input as Record<string, unknown>).slice(0, 300)) {
    if (!NAME_RE.test(id) || !value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const block: BlockLayout = {};
    if (Number.isInteger(v.span) && (v.span as number) >= 2 && (v.span as number) <= 12) block.span = v.span as number;
    if (v.hidden === true) block.hidden = true;
    if (Number.isInteger(v.height) && (v.height as number) >= 80 && (v.height as number) <= 2000) block.height = v.height as number;
    if (Object.keys(block).length) out[id] = block;
  }
  return Object.keys(out).length ? out : undefined;
}

export function sanitizeFilters(input: unknown): DashboardFilters | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const f = input as Record<string, unknown>;
  const out: DashboardFilters = {};
  const period = f.period as Record<string, unknown> | undefined;
  if (period && typeof period.preset === 'string' && PERIOD_PRESETS.includes(period.preset)) {
    out.period = { preset: period.preset };
    if (typeof period.from === 'string' && DAY_RE.test(period.from)) out.period.from = period.from;
    if (typeof period.to === 'string' && DAY_RE.test(period.to)) out.period.to = period.to;
  }
  if (f.values && typeof f.values === 'object') {
    const values: Record<string, string | null> = {};
    for (const [name, value] of Object.entries(f.values as Record<string, unknown>).slice(0, 30)) {
      if (NAME_RE.test(name) && (value === null || (typeof value === 'string' && value.length <= 500))) values[name] = value as string | null;
    }
    out.values = values;
  }
  if (f.labels && typeof f.labels === 'object') {
    const labels: Record<string, string> = {};
    for (const [name, label] of Object.entries(f.labels as Record<string, unknown>).slice(0, 30)) {
      if (NAME_RE.test(name) && typeof label === 'string' && label.length <= 200) labels[name] = label;
    }
    if (Object.keys(labels).length) out.labels = labels;
  }
  return Object.keys(out).length ? out : undefined;
}

export const MAX_VERSIONS = 10;
export const REFRESH_CHOICES = [0, 60, 300, 900, 3600];
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PROGRAM = 100_000;
const ID_RE = /^[\w-]{1,80}$/;

/** What may be saved: anything else is dropped or replaced by a safe value */
export function sanitizeDashboard(input: unknown, now: string): Dashboard | null {
  if (!input || typeof input !== 'object') return null;
  const d = input as Record<string, unknown>;
  if (typeof d.id !== 'string' || !ID_RE.test(d.id) || typeof d.databaseId !== 'string' || !ID_RE.test(d.databaseId)) return null;
  const program = typeof d.program === 'string' ? d.program : '';
  if (program.length > MAX_PROGRAM) return null;
  const refresh = Number(d.refreshSeconds);
  const versions = Array.isArray(d.versions)
    ? (d.versions as Array<Record<string, unknown>>)
      .filter(v => v && typeof v.program === 'string' && (v.program as string).length <= MAX_PROGRAM)
      .slice(-MAX_VERSIONS)
      .map(v => ({ program: v.program as string, at: typeof v.at === 'string' ? v.at : now }))
    : [];
  const chat = d.chat && typeof d.chat === 'object' ? d.chat as Record<string, unknown> : null;
  const theme = d.theme && typeof d.theme === 'object' ? d.theme as Record<string, unknown> : null;
  const layout = sanitizeLayout(d.layout);
  const filters = sanitizeFilters(d.filters);
  return {
    id: d.id,
    databaseId: d.databaseId,
    title: (typeof d.title === 'string' ? d.title : '').trim().slice(0, 120),
    program,
    refreshSeconds: REFRESH_CHOICES.includes(refresh) ? refresh : 0,
    createdAt: typeof d.createdAt === 'string' ? d.createdAt : now,
    updatedAt: now,
    versions,
    ...(layout ? { layout } : {}),
    ...(theme ? { theme: { accent: ACCENTS.includes(theme.accent as string) ? theme.accent as string : 'emerald', density: theme.density === 'compact' ? 'compact' : 'comfortable' } } : {}),
    ...(filters ? { filters } : {}),
    ...(d.pinned === true ? { pinned: true } : {}),
    ...(d.cacheResults === true ? { cacheResults: true } : {}),
    ...(chat && typeof chat.provider === 'string' && Array.isArray(chat.messages) ? {
      chat: {
        provider: chat.provider,
        ...(typeof chat.model === 'string' && chat.model ? { model: chat.model } : {}),
        ...(typeof chat.sessionId === 'string' && /^[\w.-]{1,128}$/.test(chat.sessionId) ? { sessionId: chat.sessionId } : {}),
        messages: chat.messages,
      },
    } : {}),
  };
}

export class DashboardStore {
  constructor(private root: string, private cipher: Cipher) {}

  private dir(databaseId: string): string {
    if (!ID_RE.test(databaseId)) throw new Error('Invalid database id');
    return path.join(this.root, databaseId);
  }

  private file(databaseId: string, id: string): string {
    if (!ID_RE.test(id)) throw new Error('Invalid dashboard id');
    return path.join(this.dir(databaseId), `${id}.json`);
  }

  private read(file: string): Dashboard | null {
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { v?: number; data?: string };
      if (stored.v !== 1 || typeof stored.data !== 'string') return null;
      return JSON.parse(this.cipher.decrypt(stored.data)) as Dashboard;
    } catch {
      return null;
    }
  }

  /** Every dashboard of the given databases, newest first (unreadable files are left alone) */
  list(databaseIds: string[]): DashboardSummary[] {
    const out: DashboardSummary[] = [];
    for (const databaseId of databaseIds) {
      if (!ID_RE.test(databaseId)) continue;
      let files: string[] = [];
      try {
        files = fs.readdirSync(this.dir(databaseId)).filter(f => f.endsWith('.json'));
      } catch {
        continue;
      }
      for (const name of files) {
        const d = this.read(path.join(this.dir(databaseId), name));
        if (!d) continue;
        out.push({ id: d.id, databaseId: d.databaseId, title: d.title, refreshSeconds: d.refreshSeconds, createdAt: d.createdAt, updatedAt: d.updatedAt, empty: !d.program.trim(), pinned: !!d.pinned });
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(databaseId: string, id: string): Dashboard | null {
    return this.read(this.file(databaseId, id));
  }

  save(dashboard: Dashboard): void {
    const file = this.file(dashboard.databaseId, dashboard.id);
    const previous = this.read(file);
    const next: Dashboard = { ...dashboard, createdAt: previous?.createdAt ?? dashboard.createdAt };
    const data = JSON.stringify({ v: 1, data: this.cipher.encrypt(JSON.stringify(next)) });
    if (data.length > MAX_BYTES) throw new Error('This dashboard is too large to be kept');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /** Only the filters chosen: the dashboard keeps its date of change */
  saveFilters(databaseId: string, id: string, filters: DashboardFilters | undefined): boolean {
    const d = this.get(databaseId, id);
    if (!d) return false;
    const next: Dashboard = { ...d };
    if (filters) next.filters = filters; else delete next.filters;
    this.save(next);
    return true;
  }

  delete(databaseId: string, id: string): void {
    fs.rmSync(this.file(databaseId, id), { force: true });
    fs.rmSync(this.cacheFile(databaseId, id), { force: true });
  }

  // --- Last results (only when the user asked for them) --------------------------------------

  private cacheFile(databaseId: string, id: string): string {
    return this.file(databaseId, id).replace(/\.json$/, '.cache');
  }

  getCache(databaseId: string, id: string): Record<string, unknown> | null {
    try {
      const stored = JSON.parse(fs.readFileSync(this.cacheFile(databaseId, id), 'utf8')) as { v?: number; data?: string };
      if (stored.v !== 1 || typeof stored.data !== 'string') return null;
      return JSON.parse(this.cipher.decrypt(stored.data)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  setCache(databaseId: string, id: string, results: Record<string, unknown> | null): void {
    const file = this.cacheFile(databaseId, id);
    if (!results) {
      fs.rmSync(file, { force: true });
      return;
    }
    const data = JSON.stringify({ v: 1, data: this.cipher.encrypt(JSON.stringify(results)) });
    if (data.length > MAX_BYTES) throw new Error('These results are too large to be kept');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /** Every dashboard of a database (removed from bbdump) */
  clear(databaseId: string): void {
    fs.rmSync(this.dir(databaseId), { recursive: true, force: true });
  }
}

/** A dashboard as a file: the program and its settings, no conversation and no data */
export interface DashboardFile {
  format: 'bbdump-dashboard';
  version: 1;
  title: string;
  program: string;
  refreshSeconds: number;
  layout?: Record<string, BlockLayout>;
  theme?: DashboardTheme;
  filters?: DashboardFilters;
}

export function toDashboardFile(d: Dashboard): DashboardFile {
  return {
    format: 'bbdump-dashboard', version: 1, title: d.title, program: d.program, refreshSeconds: d.refreshSeconds,
    ...(d.layout ? { layout: d.layout } : {}), ...(d.theme ? { theme: d.theme } : {}), ...(d.filters ? { filters: d.filters } : {}),
  };
}

/** A dashboard file read back (null when it is not one) */
export function fromDashboardFile(input: unknown): Omit<DashboardFile, 'format' | 'version'> | null {
  if (!input || typeof input !== 'object') return null;
  const f = input as Record<string, unknown>;
  if (f.format !== 'bbdump-dashboard' || f.version !== 1 || typeof f.program !== 'string') return null;
  const d = sanitizeDashboard({ ...f, id: 'imported', databaseId: 'imported' }, new Date().toISOString());
  if (!d) return null;
  return {
    title: d.title, program: d.program, refreshSeconds: d.refreshSeconds,
    ...(d.layout ? { layout: d.layout } : {}), ...(d.theme ? { theme: d.theme } : {}), ...(d.filters ? { filters: d.filters } : {}),
  };
}

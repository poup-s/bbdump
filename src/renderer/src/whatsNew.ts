/**
 * "What's new" tours shown once to users who update from an earlier version: every tour newer
 * than the last one seen, the newest first (from 1.0.2, the 1.2 tour then the 1.1 one).
 *
 * Each slide is a screenshot sequence ("beats"): the stage zooms on an area measured in the
 * capture (whatsNewMarks.ts), draws a ring around it and shows a label. Screenshots live in
 * public/whats-new/<lang>/<shot>.webp, captured from the demo instance in both languages.
 */
import { SHOT_MARKS, type MarkRect } from './whatsNewMarks';


/** -1, 0 or 1, comparing "major.minor.patch" versions (missing parts count as 0) */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}


export interface Beat {
  shot: string;
  /** Area of the shot to zoom on and ring (key in SHOT_MARKS) */
  mark?: string;
  /** Screenshot floating over the shot (the tray confirmation) */
  overlay?: string;
  /** Duration in ms */
  hold?: number;
}

export type SlideId = 'intro' | 'actions' | 'remote' | 'backups' | 'sync' | 'ai' | 'explore' | 'intro12' | 'anonCopy' | 'aiAnon'
  | 'intro13' | 'chat' | 'chatPrivacy' | 'chatHistory' | 'realAnon' | 'windows'
  | 'intro14' | 'dashCreate' | 'dashLive' | 'dashLayout' | 'dashShare';

export interface Slide {
  id: SlideId;
  /** 'scene': the 3D server stack; otherwise the screenshots to play */
  beats: Beat[] | 'scene';
  /** Scene slides: how many headlines (whatsNew.slides.<id>.p1…) */
  points?: number;
}

export interface Tour {
  version: string;
  /** Release date (YYYY-MM-DD), shown in the history on the Info page */
  date?: string;
  slides: Slide[];
}

const TOUR_1_4: Slide[] = [
  { id: 'intro14', beats: 'scene', points: 3 },
  {
    id: 'dashCreate',
    beats: [
      { shot: 'dash-new', mark: 'templates' },
      { shot: 'dash-new', mark: 'request' },
      { shot: 'dash-built', mark: 'steps' },
      { shot: 'dash-built', mark: 'canvas', hold: 3400 },
      { shot: 'dash-done', mark: 'suggestions' },
    ],
  },
  {
    id: 'dashLive',
    beats: [
      { shot: 'dash-filters', mark: 'filters' },
      { shot: 'dash-filters', mark: 'kpis' },
      { shot: 'dash-filters', mark: 'chart' },
      { shot: 'dash-linked', mark: 'row' },
      { shot: 'dash-linked', mark: 'record', hold: 3200 },
    ],
  },
  {
    id: 'dashLayout',
    beats: [
      { shot: 'dash-drag', mark: 'dragged' },
      { shot: 'dash-drag', mark: 'drop' },
      { shot: 'dash-resize', mark: 'resize' },
      { shot: 'dash-menu', mark: 'tools' },
      { shot: 'dash-menu', mark: 'menu', hold: 3400 },
    ],
  },
  {
    id: 'dashShare',
    beats: [
      { shot: 'dash-export', mark: 'exports', hold: 3400 },
      { shot: 'dash-export', mark: 'pin' },
    ],
  },
];

const TOUR_1_3: Slide[] = [
  { id: 'intro13', beats: 'scene', points: 3 },
  {
    id: 'chat',
    beats: [
      { shot: 'db-chat', mark: 'button' },
      { shot: 'chat-answer', mark: 'question' },
      { shot: 'chat-answer', mark: 'steps' },
      { shot: 'chat-chart', mark: 'stats' },
      { shot: 'chat-chart', mark: 'chart' },
      { shot: 'chat-chart', mark: 'table' },
    ],
  },
  {
    id: 'chatPrivacy',
    beats: [
      { shot: 'chat-answer', mark: 'badges', hold: 3400 },
      { shot: 'chat-disclose', mark: 'columns', hold: 4200 },
      { shot: 'chat-disclose', mark: 'send', hold: 3000 },
    ],
  },
  {
    id: 'chatHistory',
    beats: [
      { shot: 'chat-history', mark: 'list' },
      { shot: 'chat-history', mark: 'pin' },
      { shot: 'chat-settings', mark: 'tools', hold: 3200 },
      { shot: 'chat-settings', mark: 'model' },
      { shot: 'chat-settings', mark: 'history' },
    ],
  },
  {
    id: 'realAnon',
    beats: [
      { shot: 'anon-kinds', mark: 'kinds', hold: 3400 },
      { shot: 'anon-result', mark: 'names' },
      { shot: 'anon-result', mark: 'fakes' },
    ],
  },
  { id: 'windows', beats: 'scene', points: 3 },
];

const TOUR_1_2: Slide[] = [
  { id: 'intro12', beats: 'scene', points: 3 },
  {
    id: 'anonCopy',
    beats: [
      { shot: 'dup-anon', mark: 'switch', hold: 3200 },
      { shot: 'anon-picker', mark: 'columns' },
      { shot: 'anon-picker', mark: 'rows' },
      { shot: 'dup-anon', mark: 'summary' },
    ],
  },
  {
    id: 'aiAnon',
    beats: [
      { shot: 'ai-anon', mark: 'switch' },
      { shot: 'ai-anon', mark: 'safe', hold: 3400 },
      { shot: 'db-badge', mark: 'badge' },
      { shot: 'db-badge', overlay: 'ai-disclose', hold: 4200 },
    ],
  },
];

const TOUR_1_1: Slide[] = [
  { id: 'intro', beats: 'scene', points: 4 },
  {
    id: 'actions',
    beats: [
      { shot: 'tasks-login', mark: 'banner', hold: 3600 },
      { shot: 'tasks-login', mark: 'stats', hold: 3000 },
    ],
  },
  {
    id: 'remote',
    beats: [
      { shot: 'add-method', mark: 'ssh' },
      { shot: 'ssh-test', mark: 'env' },
      { shot: 'ssh-test', mark: 'tests' },
      { shot: 'add-method', mark: 'guides' },
      { shot: 'neon', mark: 'picker' },
      { shot: 'neon', mark: 'url' },
    ],
  },
  {
    id: 'backups',
    beats: [
      { shot: 'ssh-backup', mark: 'retention' },
      { shot: 'ssh-backup', mark: 'checks' },
      { shot: 'backups', mark: 'group' },
      { shot: 'restore', mark: 'replace' },
      { shot: 'restore', mark: 'backupFirst' },
    ],
  },
  {
    id: 'sync',
    beats: [
      { shot: 'sync-analysis', mark: 'summary' },
      { shot: 'sync-choices', mark: 'tables' },
      { shot: 'sync-choices', mark: 'anonymize' },
      { shot: 'sync-preview', mark: 'sql' },
      { shot: 'sync-preview', mark: 'backupFirst' },
    ],
  },
  {
    id: 'ai',
    beats: [
      { shot: 'ai-clients', mark: 'clients' },
      { shot: 'ai-clients', overlay: 'ai-confirm', hold: 3400 },
      { shot: 'ai-journal', mark: 'diff' },
      { shot: 'ai-journal', mark: 'undo' },
    ],
  },
  {
    id: 'explore',
    beats: [
      { shot: 'viewer-schema', mark: 'billing' },
      { shot: 'viewer-tabs', mark: 'tabs' },
      { shot: 'viewer-tabs', mark: 'counts' },
      { shot: 'extensions', mark: 'categories' },
      { shot: 'extensions', mark: 'first' },
    ],
  },
];

/** Newest first. A new tour goes on top, with its slides, texts and screenshots. */
export const TOURS: Tour[] = [
  { version: '1.4.0', date: '2026-10-22', slides: TOUR_1_4 },
  { version: '1.3.0', date: '2026-10-20', slides: TOUR_1_3 },
  { version: '1.2.0', date: '2026-10-14', slides: TOUR_1_2 },
  { version: '1.1.0', date: '2026-10-02', slides: TOUR_1_1 },
];

/** Version of the newest tour */
export const WHATS_NEW_VERSION = TOURS[0].version;

/** Every slide of every tour (checks, preloading) */
export const ALL_SLIDES: Slide[] = TOURS.flatMap(t => t.slides);

/**
 * Show the tours when the last one seen is older than the newest. Configurations without a
 * value are new: their onboarding is under way, and it shows the current version.
 */
export function shouldShowWhatsNew(seen: string | undefined | null): boolean {
  return typeof seen === 'string' && compareVersions(seen, WHATS_NEW_VERSION) < 0;
}

/**
 * The slides to play, each with its tour's version: one tour replayed from the history
 * (`replay`), else the tours newer than `seen`, else the newest.
 */
export function tourSlides(seen: string | undefined | null, replay?: string | null): Array<Slide & { version: string }> {
  const asked = replay ? TOURS.filter(t => t.version === replay) : [];
  const newer = TOURS.filter(t => typeof seen === 'string' && compareVersions(seen, t.version) < 0);
  const tours = asked.length ? asked : newer.length ? newer : TOURS.slice(0, 1);
  return tours.flatMap(t => t.slides.map(s => ({ ...s, version: t.version })));
}

export const DEFAULT_HOLD = 2800;

export const shotUrl = (lang: 'en' | 'fr', shot: string) => `./whats-new/${lang}/${shot}.webp`;

export function markOf(lang: 'en' | 'fr', beat: Beat): MarkRect | undefined {
  return beat.mark ? SHOT_MARKS[lang]?.[beat.shot]?.[beat.mark] : undefined;
}

/**
 * Camera for a mark: zoom so the area fills most of the stage (between 1 and 1.4), scaling
 * around the area's centre so it stays where it is in the capture.
 */
export function cameraFor(mark: MarkRect | undefined): { scale: number; originX: number; originY: number } {
  if (!mark) return { scale: 1, originX: 50, originY: 50 };
  const [x, y, w, h] = mark;
  const scale = Math.max(1, Math.min(1.4, 72 / w, 72 / h));
  return { scale: +scale.toFixed(3), originX: x + w / 2, originY: y + h / 2 };
}

/** Where the ring is once zoomed, in % of the stage */
export function ringFor(mark: MarkRect, scale: number): MarkRect {
  const [x, y, w, h] = mark;
  const cx = x + w / 2, cy = y + h / 2;
  return [cx - (w * scale) / 2, cy - (h * scale) / 2, w * scale, h * scale];
}

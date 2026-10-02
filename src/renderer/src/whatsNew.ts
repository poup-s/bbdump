/**
 * "What's new" tour shown once to users who update from an earlier version.
 *
 * Each slide is a screenshot sequence ("beats"): the stage zooms on an area measured in the
 * capture (whatsNewMarks.ts), draws a ring around it and shows a label. Screenshots live in
 * public/whats-new/<lang>/<shot>.webp, captured from the demo instance in both languages.
 */
import { SHOT_MARKS, type MarkRect } from './whatsNewMarks';

/** Version whose tour this is. Bump it (and the slides) when a new tour is written. */
export const WHATS_NEW_VERSION = '1.1.0';

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

/**
 * Show the tour when the last one seen is older than this tour. Configurations created by
 * 1.1 or later have no value: they started with the onboarding, which already shows all this.
 */
export function shouldShowWhatsNew(seen: string | undefined | null): boolean {
  return typeof seen === 'string' && compareVersions(seen, WHATS_NEW_VERSION) < 0;
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

export type SlideId = 'intro' | 'actions' | 'remote' | 'backups' | 'sync' | 'ai' | 'explore';

export interface Slide {
  id: SlideId;
  /** 'scene': the 3D server stack; otherwise the screenshots to play */
  beats: Beat[] | 'scene';
}

export const SLIDES: Slide[] = [
  { id: 'intro', beats: 'scene' },
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

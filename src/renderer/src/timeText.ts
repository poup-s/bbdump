/** Dates as people read them in the Tasks and Backups pages */
type T = (key: string, params?: Record<string, string | number>) => string;

const DAY = 86400000;
const startOfDay = (time: number) => { const d = new Date(time); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** "in 3 hours", "5 minutes ago", "just now" */
export function relative(time: number, now: number, lang: string, t: T): string {
  const diff = time - now;
  const abs = Math.abs(diff);
  if (abs < 45000) return t('time.now');
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'short' });
  if (abs < 3600000) return rtf.format(Math.round(diff / 60000), 'minute');
  if (abs < DAY) return rtf.format(Math.round(diff / 3600000), 'hour');
  if (abs < 30 * DAY) return rtf.format(Math.round(diff / DAY), 'day');
  return rtf.format(Math.round(diff / (30 * DAY)), 'month');
}

/** "today 02:00", "tomorrow 02:00", "Mon 6 Oct 02:00", with the year when it differs */
export function dayAndTime(time: number, now: number, lang: string, t: T): string {
  const clock = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', hour12: false }).format(time);
  const days = Math.round((startOfDay(time) - startOfDay(now)) / DAY);
  if (days === 0) return t('time.todayAt', { time: clock });
  if (days === 1) return t('time.tomorrowAt', { time: clock });
  if (days === -1) return t('time.yesterdayAt', { time: clock });
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  const date = new Intl.DateTimeFormat(lang, { weekday: 'short', day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' }).format(time);
  return `${date} ${clock}`;
}

export function formatBytes(bytes: number, lang: string): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toLocaleString(lang, { maximumFractionDigits: i === 0 ? 0 : value < 10 ? 1 : 0 })} ${units[i]}`;
}

export function formatDuration(ms: number, lang: string): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toLocaleString(lang, { maximumFractionDigits: 1 })} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

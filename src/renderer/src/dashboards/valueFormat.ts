/**
 * How a dashboard shows its values, in the user's language: numbers, money, percentages,
 * durations, sizes, dates (queries return dates as ISO text; they are formatted here, not in
 * SQL). Pure: tested without a window.
 */

/** number · integer · money:EUR · percent · duration (seconds) · bytes · date · datetime · text */
export type ValueFormat = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;

export const isIsoDate = (v: unknown) => typeof v === 'string' && ISO_DATE.test(v);
export const isIsoDateTime = (v: unknown) => typeof v === 'string' && ISO_DATETIME.test(v);

const asNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
};

const parseDate = (v: string): Date => (ISO_DATE.test(v) ? new Date(`${v}T00:00:00`) : new Date(v.replace(' ', 'T')));

function duration(seconds: number, lang: string): string {
  const s = Math.round(Math.abs(seconds));
  const sign = seconds < 0 ? '-' : '';
  if (s < 60) return `${sign}${s} s`;
  if (s < 3600) return `${sign}${Math.floor(s / 60)} min${s % 60 ? ` ${String(s % 60).padStart(2, '0')}` : ''}`;
  if (s < 86400) return `${sign}${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  const days = s / 86400;
  return `${sign}${days.toLocaleString(lang, { maximumFractionDigits: 1 })} ${lang.startsWith('fr') ? 'j' : 'd'}`;
}

function bytes(n: number, lang: string): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = Math.abs(n);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${n < 0 ? '-' : ''}${value.toLocaleString(lang, { maximumFractionDigits: i ? 1 : 0 })} ${lang.startsWith('fr') ? units[i].replace('B', 'o') : units[i]}`;
}

/** A value as shown: '—' when there is none */
export function formatValue(value: unknown, format: ValueFormat | undefined, lang: string): string {
  if (value === null || value === undefined || value === '') return '—';
  const [kind, arg] = (format ?? '').split(':');
  const n = asNumber(value);
  if (kind === 'text') return String(value);
  if (kind === 'money' && n !== null) {
    try {
      return n.toLocaleString(lang, { style: 'currency', currency: (arg || 'EUR').toUpperCase(), maximumFractionDigits: 2 });
    } catch {
      return `${n.toLocaleString(lang, { maximumFractionDigits: 2 })} ${arg ?? ''}`.trim();
    }
  }
  if (kind === 'percent' && n !== null) return `${n.toLocaleString(lang, { maximumFractionDigits: 1 })} %`;
  if (kind === 'duration' && n !== null) return duration(n, lang);
  if (kind === 'bytes' && n !== null) return bytes(n, lang);
  if (kind === 'integer' && n !== null) return Math.round(n).toLocaleString(lang);
  if (typeof value === 'string' && (kind === 'date' || kind === 'datetime' || ISO_DATE.test(value) || ISO_DATETIME.test(value))) {
    const d = parseDate(value);
    if (!Number.isNaN(d.getTime())) {
      return kind === 'date' || ISO_DATE.test(value)
        ? d.toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' })
        : d.toLocaleString(lang, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
  }
  if (typeof value === 'boolean') return value ? '✓' : '✗';
  if (n !== null && typeof value === 'number') return n.toLocaleString(lang, { maximumFractionDigits: 2 });
  return String(value);
}

/** A short axis label: dates without the year */
export function formatLabel(value: unknown, lang: string): string {
  if (typeof value === 'string' && ISO_DATE.test(value)) return parseDate(value).toLocaleDateString(lang, { day: 'numeric', month: 'short' });
  if (typeof value === 'string' && ISO_DATETIME.test(value)) return parseDate(value).toLocaleString(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return value === null || value === undefined ? '—' : String(value);
}

/** Change against a previous value, in percent (null when it cannot be computed) */
export function change(value: unknown, previous: unknown): number | null {
  const a = asNumber(value);
  const b = asNumber(previous);
  if (a === null || b === null || b === 0) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

/** Values as CSV (semicolons in French, as spreadsheets there expect) */
export function toCsv(columns: string[], rows: Array<Record<string, unknown>>, lang: string, labels?: string[]): string {
  const sep = lang.startsWith('fr') ? ';' : ',';
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const text = typeof v === 'number' && lang.startsWith('fr') ? String(v).replace('.', ',') : String(v);
    return text.includes(sep) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.map((c, i) => cell(labels?.[i] || c)).join(sep), ...rows.map(r => columns.map(c => cell(r[c])).join(sep))].join('\r\n');
}

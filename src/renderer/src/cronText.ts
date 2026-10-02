/**
 * A backup schedule in words: "Every day at 02:00", "Monday to Friday at 00:00",
 * "Every 6 hours". Null when the expression is not one of the common shapes (the page
 * then shows the expression itself).
 */
type T = (key: string, params?: Record<string, string | number>) => string;

const NUMBER = /^\d+$/;
const STEP = /^\*\/(\d+)$/;
const pad = (n: string | number) => String(n).padStart(2, '0');

/** Weekday names from the locale (0 = Sunday); 4 January 2026 is a Sunday */
const weekday = (lang: string, index: number) =>
  new Intl.DateTimeFormat(lang, { weekday: 'long' }).format(new Date(2026, 0, 4 + (index % 7)));

function dayPart(dom: string, month: string, dow: string, t: T, lang: string): string | null {
  if (month !== '*') return null;
  if (dom === '*' && dow === '*') return t('tasks.when.daily');
  if (dom !== '*' && dow !== '*') return null;
  if (dom !== '*') return NUMBER.test(dom) ? t('tasks.when.monthDay', { day: Number(dom) }) : null;
  const d = dow.toLowerCase();
  if (d === '1-5' || d === 'mon-fri') return t('tasks.when.weekdays');
  if (d === '0,6' || d === '6,0' || d === 'sat,sun' || d === 'sun,sat') return t('tasks.when.weekends');
  if (NUMBER.test(d)) return t('tasks.when.weekday', { day: weekday(lang, Number(d)) });
  if (/^\d-\d$/.test(d)) {
    const [from, to] = d.split('-').map(Number);
    return t('tasks.when.weekdayRange', { from: weekday(lang, from), to: weekday(lang, to) });
  }
  if (/^\d(,\d)+$/.test(d)) {
    return t('tasks.when.weekdayList', { days: d.split(',').map(n => weekday(lang, Number(n))).join(', ') });
  }
  return null;
}

export function describeCron(expression: string, t: T, lang: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields;
  const days = dayPart(dom, month, dow, t, lang);
  if (!days) return null;
  const daily = dom === '*' && dow === '*';

  // Repeating within the day
  let repeat: string | null = null;
  if (minute === '*' && hour === '*') repeat = t('tasks.when.everyMinute');
  else if (STEP.test(minute) && hour === '*') repeat = t('tasks.when.everyXMinutes', { n: minute.match(STEP)![1] });
  else if (NUMBER.test(minute) && hour === '*') repeat = minute === '0' ? t('tasks.when.everyHour') : t('tasks.when.everyHourAt', { minute: pad(minute) });
  else if (NUMBER.test(minute) && STEP.test(hour)) repeat = t('tasks.when.everyXHours', { n: hour.match(STEP)![1] });
  if (repeat) return daily ? repeat : `${days} · ${repeat.charAt(0).toLowerCase()}${repeat.slice(1)}`;

  // At given times
  if (!NUMBER.test(minute) || !/^\d+(,\d+)*$/.test(hour)) return null;
  const times = hour.split(',').map(h => `${pad(h)}:${pad(minute)}`);
  const time = times.length === 1 ? times[0] : t('tasks.when.and', { a: times.slice(0, -1).join(', '), b: times[times.length - 1] });
  return t('tasks.when.at', { days, time });
}

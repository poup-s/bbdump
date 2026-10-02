/**
 * Minimal cron matcher used to find the most recent scheduled time of an expression,
 * so backups missed while the app was closed can be caught up (node-cron only fires
 * forward). Supports 5 fields (or 6 with leading seconds, ignored): numbers, *, ranges,
 * steps, lists, and month/day names.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface Field {
  values: Set<number>;
  restricted: boolean; // false when the field is "*"
}

function parseField(expr: string, min: number, max: number, names?: string[]): Field {
  const values = new Set<number>();
  const toNumber = (token: string): number => {
    const lower = token.toLowerCase();
    if (names) {
      const index = names.indexOf(lower);
      if (index !== -1) return index + (names === MONTHS ? 1 : 0);
    }
    const n = parseInt(token, 10);
    if (Number.isNaN(n)) throw new Error(`Invalid cron value: ${token}`);
    return n;
  };

  for (const part of expr.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? parseInt(stepPart, 10) : 1;
    if (!step || step < 1) throw new Error(`Invalid cron step: ${part}`);

    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      start = toNumber(a);
      end = toNumber(b);
    } else {
      start = toNumber(rangePart);
      end = stepPart ? max : start;
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }

  return { values, restricted: expr !== '*' };
}

interface ParsedCron {
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;
  dayOfWeek: Field;
}

export function parseCron(expression: string): ParsedCron {
  let fields = expression.trim().split(/\s+/);
  if (fields.length === 6) fields = fields.slice(1); // drop seconds
  if (fields.length !== 5) throw new Error(`Unsupported cron expression: ${expression}`);

  const dayOfWeek = parseField(fields[4], 0, 7, DAYS);
  if (dayOfWeek.values.has(7)) dayOfWeek.values.add(0); // 7 = Sunday

  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dayOfMonth: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12, MONTHS),
    dayOfWeek,
  };
}

function matches(cron: ParsedCron, date: Date): boolean {
  if (!cron.minute.values.has(date.getMinutes())) return false;
  if (!cron.hour.values.has(date.getHours())) return false;
  if (!cron.month.values.has(date.getMonth() + 1)) return false;

  const domOk = cron.dayOfMonth.values.has(date.getDate());
  const dowOk = cron.dayOfWeek.values.has(date.getDay());
  // Standard cron: when both day fields are restricted, either one may match
  if (cron.dayOfMonth.restricted && cron.dayOfWeek.restricted) return domOk || dowOk;
  if (cron.dayOfMonth.restricted) return domOk;
  if (cron.dayOfWeek.restricted) return dowOk;
  return true;
}

/**
 * Most recent time (minute precision, local time) at or before `from` matching the
 * expression, looking back at most `maxLookbackMinutes`. Returns null if none.
 */
export function previousRun(expression: string, from: Date = new Date(), maxLookbackMinutes = 31 * 24 * 60): Date | null {
  const cron = parseCron(expression);
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  for (let i = 0; i <= maxLookbackMinutes; i++) {
    if (matches(cron, cursor)) return new Date(cursor);
    cursor.setMinutes(cursor.getMinutes() - 1);
  }
  return null;
}

/**
 * Next time (minute precision, local time) strictly after `from` matching the expression,
 * looking ahead at most `maxLookaheadDays`. Skips whole months, days and hours that cannot
 * match, so even a yearly schedule is found in a few thousand steps. Null if none.
 */
export function nextRun(expression: string, from: Date = new Date(), maxLookaheadDays = 5 * 366): Date | null {
  const cron = parseCron(expression);
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = from.getTime() + maxLookaheadDays * 86400000;
  while (cursor.getTime() <= limit) {
    if (!cron.month.values.has(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    const domOk = cron.dayOfMonth.values.has(cursor.getDate());
    const dowOk = cron.dayOfWeek.values.has(cursor.getDay());
    const dayOk = cron.dayOfMonth.restricted && cron.dayOfWeek.restricted ? domOk || dowOk
      : cron.dayOfMonth.restricted ? domOk
        : cron.dayOfWeek.restricted ? dowOk
          : true;
    if (!dayOk) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hour.values.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (matches(cron, cursor)) return new Date(cursor);
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

export interface QueryRecord {
  timestamp: string;
  tool: string;
  database: string;
  sql: string;
  duration_ms: number;
  rows_affected?: number;
  error?: string;
}

const MAX_HISTORY = 100;
const history: QueryRecord[] = [];

export function recordQuery(record: Omit<QueryRecord, 'timestamp'>): void {
  history.push({
    ...record,
    timestamp: new Date().toISOString(),
  });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

export function getHistory(limit?: number): QueryRecord[] {
  const n = limit ?? MAX_HISTORY;
  return history.slice(-n).reverse();
}

export function clearHistory(): void {
  history.length = 0;
}

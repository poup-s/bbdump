/**
 * Where a saved database lives, as the list shows it: a file on this computer (SQLite, DuckDB),
 * a database of this computer's server, one reached through SSH, or one elsewhere.
 */
export type DatabaseLocation = 'file' | 'local' | 'ssh' | 'remote';

interface Located {
  engine?: string;
  isLocalBbdump?: boolean;
  ssh?: unknown;
  sqlite?: { path: string };
  duckdb?: { path: string };
}

export function databaseLocation(db: Located): DatabaseLocation {
  if (db.engine === 'sqlite' || db.engine === 'duckdb' || db.sqlite || db.duckdb) return 'file';
  if (db.ssh) return 'ssh';
  if (db.isLocalBbdump) return 'local';
  return 'remote';
}

/** On this computer: a file or a database of the local server */
export const isOnThisComputer = (db: Located) => ['file', 'local'].includes(databaseLocation(db));

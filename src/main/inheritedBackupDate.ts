/**
 * Up to 1.1, duplicating a database gave the copy the source's `lastBackup` (the date of
 * the dump the copy was made from), although the copy itself was never backed up. The
 * copy then looked backed up, and the catch-up of missed scheduled backups skipped it.
 *
 * Two databases sharing a `lastBackup` to the millisecond can only come from that. The
 * date is kept on those that have backup files of their own and cleared on the others;
 * when none has a file left, on the first one (the source is added before its copies).
 * Clearing too much costs at most one extra catch-up backup; keeping a wrong date could
 * skip one.
 */
interface WithLastBackup { id: string; name: string; lastBackup?: string }

/** Clears inherited dates in place; returns the names of the databases fixed */
export function clearInheritedLastBackups(databases: WithLastBackup[], backupFileNames: string[]): string[] {
  const byDate = new Map<string, WithLastBackup[]>();
  for (const db of databases) {
    if (!db.lastBackup) continue;
    byDate.set(db.lastBackup, [...(byDate.get(db.lastBackup) ?? []), db]);
  }
  // "<id or name>_<date>…": the date right after, so "shop_" does not match "shop_copy_…"
  const ownFile = (file: string, prefix: string) => file.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}/.test(file.slice(prefix.length));
  const hasFiles = (db: WithLastBackup) =>
    backupFileNames.some(file => ownFile(file, `${db.id}_`) || ownFile(file, `${db.name}_`));

  const fixed: string[] = [];
  for (const group of byDate.values()) {
    if (group.length < 2) continue;
    const owners = group.filter(hasFiles);
    const keep = new Set(owners.length ? owners : [group[0]]);
    for (const db of group) {
      if (keep.has(db)) continue;
      delete db.lastBackup;
      fixed.push(db.name);
    }
  }
  return fixed;
}

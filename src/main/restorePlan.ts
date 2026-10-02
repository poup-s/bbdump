/**
 * Restoring replaces the target's content with the backup's. pg_restore alone does not:
 * into a database that already has the tables, CREATE fails ("already exists"), COPY hits
 * the primary keys and nothing is loaded, while the restore still looked successful.
 *
 * So the schemas the backup contains are emptied first, in one transaction: all of them
 * or none (a missing right or a lock leaves the database untouched). Schemas the backup
 * does not contain (Supabase's auth, storage…) are left alone.
 */

/** Object types of `pg_restore -l`, longest first so "TABLE DATA" wins over "TABLE" */
const TOC_TYPES = [
  'PUBLICATION TABLES IN SCHEMA', 'MATERIALIZED VIEW DATA', 'TEXT SEARCH CONFIGURATION', 'TEXT SEARCH DICTIONARY',
  'TEXT SEARCH TEMPLATE', 'TEXT SEARCH PARSER', 'FOREIGN DATA WRAPPER', 'DATABASE PROPERTIES', 'PROCEDURAL LANGUAGE',
  'SEQUENCE OWNED BY', 'MATERIALIZED VIEW', 'PUBLICATION TABLE', 'SUBSCRIPTION TABLE', 'CHECK CONSTRAINT',
  'OPERATOR CLASS', 'OPERATOR FAMILY', 'FOREIGN SERVER', 'FOREIGN TABLE', 'ACCESS METHOD', 'EVENT TRIGGER',
  'FK CONSTRAINT', 'SEQUENCE SET', 'USER MAPPING', 'INDEX ATTACH', 'TABLE ATTACH', 'ROW SECURITY', 'LARGE OBJECT',
  'DEFAULT ACL', 'TABLE DATA', 'BLOB DATA', 'SUBSCRIPTION', 'PUBLICATION', 'STATISTICS', 'CONSTRAINT', 'CONVERSION',
  'COLLATION', 'AGGREGATE', 'PROCEDURE', 'FUNCTION', 'OPERATOR', 'SEQUENCE', 'EXTENSION', 'DATABASE', 'TRIGGER',
  'DEFAULT', 'COMMENT', 'POLICY', 'SCHEMA', 'DOMAIN', 'SERVER', 'TABLE', 'INDEX', 'BLOBS', 'TYPE', 'VIEW', 'RULE',
  'CAST', 'ACL',
];

const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'pg_toast']);

/** The schemas that hold objects in a dump, from its `pg_restore -l` listing */
export function schemasInToc(listing: string): string[] {
  const schemas = new Set<string>();
  for (const line of listing.split(/\r?\n/)) {
    // "3435; 0 16396 TABLE DATA public orders app"
    const match = /^\s*\d+;\s+\d+\s+\d+\s+(.*)$/.exec(line);
    if (!match) continue;
    const rest = match[1];
    const type = TOC_TYPES.find(t => rest === t || rest.startsWith(`${t} `));
    if (!type) continue;
    const [namespace, tag] = rest.slice(type.length).trim().split(/\s+/);
    if (type === 'SCHEMA' && tag) schemas.add(tag);
    else if (namespace && namespace !== '-') schemas.add(namespace);
  }
  return [...schemas].filter(s => !SYSTEM_SCHEMAS.has(s) && !s.startsWith('pg_temp') && !s.startsWith('pg_toast'));
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * psql script emptying those schemas in one transaction (stops at the first error, so a
 * failure leaves everything as it was). `public` is recreated with PostgreSQL's default
 * rights, since dumps of recent versions do not create it.
 */
export function emptySchemasSql(schemas: string[]): string {
  if (!schemas.length) return '';
  const lines = [
    '\\set ON_ERROR_STOP on',
    "SET lock_timeout = '15s';",
    'BEGIN;',
    ...schemas.map(s => `DROP SCHEMA IF EXISTS ${ident(s)} CASCADE;`),
  ];
  if (schemas.includes('public')) {
    lines.push(
      'CREATE SCHEMA IF NOT EXISTS public;',
      `DO $$ BEGIN
  IF current_setting('server_version_num')::int >= 150000 THEN
    EXECUTE 'ALTER SCHEMA public OWNER TO pg_database_owner';
    EXECUTE 'GRANT USAGE ON SCHEMA public TO PUBLIC';
  ELSE
    EXECUTE 'GRANT ALL ON SCHEMA public TO PUBLIC';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;`,
    );
  }
  lines.push('COMMIT;');
  return `${lines.join('\n')}\n`;
}

/** pg_restore's error lines, to say what did not restore instead of hiding it */
export function restoreErrors(stderr: string, max = 8): { count: number; lines: string[] } {
  const lines = stderr.split(/\r?\n/).filter(l => /(^|\s)(error|erreur)\s*:/i.test(l) && !/errors ignored on restore|erreurs ignorées/i.test(l));
  return { count: lines.length, lines: lines.slice(0, max).map(l => l.replace(/^pg_restore:\s*/, '').trim()) };
}

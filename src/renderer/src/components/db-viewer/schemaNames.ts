/** Schema used when none is chosen (matches the main-process default). */
export const DEFAULT_SCHEMA = 'public';

/** Stable id for a table across schemas (Vue Flow node ids, map keys). */
export const tableId = (schema: string, table: string): string => `${schema}.${table}`;

/**
 * Label shown to the user: bare name for tables of the current schema,
 * `schema.table` for tables living in another schema.
 */
export const displayTableName = (schema: string | undefined, table: string, currentSchema: string = DEFAULT_SCHEMA): string =>
  !schema || schema === currentSchema ? table : `${schema}.${table}`;

/** Quotes a PostgreSQL identifier (doubles embedded double quotes). */
export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Schema-qualified, quoted table reference: "schema"."table". */
export const qualifiedIdent = (schema: string, table: string): string =>
  `${quoteIdent(schema)}.${quoteIdent(table)}`;

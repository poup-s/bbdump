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

/** Quotes an identifier: backticks for MySQL / MariaDB, [brackets] for SQL Server, double quotes otherwise (PostgreSQL, SQLite, DuckDB). */
export const quoteIdent = (name: string, engine = 'postgresql'): string => {
  if (engine === 'mysql' || engine === 'mariadb') return `\`${name.replace(/`/g, '``')}\``;
  if (engine === 'sqlserver') return `[${name.replace(/\]/g, ']]')}]`;
  return `"${name.replace(/"/g, '""')}"`;
};

/** Schema-qualified, quoted table reference: "schema"."table" (`database`.`table` for MySQL). */
export const qualifiedIdent = (schema: string, table: string, engine = 'postgresql'): string =>
  `${quoteIdent(schema, engine)}.${quoteIdent(table, engine)}`;

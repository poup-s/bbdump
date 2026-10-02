import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pgFormat from 'pg-format';
import { withClient, executeReadOnly, resolveSchema } from '../db.js';
import { jsonResult, errorResult, textResult, config } from '../types.js';
import { buildWhereClause, type Filter } from '../filters.js';
import { toCsv, toMarkdown } from '../sql.js';
import { READ, databaseParam, schemaParam, tableParam, filterSchema, formatParam } from './common.js';

/** Rows in the asked format, with paging info */
function rowsResult(fields: string[], rows: Record<string, unknown>[], format: 'json' | 'markdown' | 'csv', meta: Record<string, unknown>) {
  if (format === 'json') return jsonResult({ ...meta, rows });
  const body = format === 'csv' ? toCsv(fields, rows) : toMarkdown(fields, rows);
  const info = Object.entries(meta).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' · ');
  return textResult(`${info}\n\n${body}`);
}

const estimateSql = `
  SELECT c.reltuples::bigint AS estimate
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname = $1 AND n.nspname = $2`;

export function registerDataTools(server: McpServer) {
  server.registerTool(
    'read_rows',
    {
      title: 'Read rows',
      description: `Read rows from a table or view with optional filters, sorting (several columns), column selection and paging. Up to ${config.maxRows} rows per call; markdown is the most compact format to read.`,
      inputSchema: {
        table: tableParam,
        database: databaseParam,
        schema: schemaParam,
        columns: z.array(z.string()).optional().describe('Columns to return (default: all)'),
        filters: z.array(filterSchema).optional().describe('Conditions, combined with AND, e.g. [{column: "status", operator: "eq", value: "paid"}]'),
        order_by: z.array(z.object({
          column: z.string(),
          direction: z.enum(['asc', 'desc']).default('asc'),
        })).optional().describe('Sort, e.g. [{column: "created_at", direction: "desc"}]'),
        sort_by: z.string().optional().describe('Single sort column (shortcut for order_by)'),
        sort_order: z.enum(['asc', 'desc']).default('asc').describe('Direction for sort_by'),
        limit: z.number().int().min(1).max(5000).default(100).describe('Rows to return (default 100)'),
        offset: z.number().int().min(0).default(0).describe('Rows to skip, for paging'),
        format: formatParam,
      },
      annotations: READ,
    },
    async ({ table, database, schema, columns, filters, order_by, sort_by, sort_order, limit, offset, format }) => withClient(database, async (client) => {
      const nsp = resolveSchema(schema);
      const effectiveLimit = Math.min(limit, config.maxRows);
      const selectCols = columns?.length ? columns.map(c => pgFormat('%I', c)).join(', ') : '*';
      let where;
      try {
        where = buildWhereClause((filters ?? []) as Filter[]);
      } catch (err: any) {
        return errorResult(err.message);
      }
      const sorts = order_by?.length ? order_by : sort_by ? [{ column: sort_by, direction: sort_order }] : [];
      const orderClause = sorts.length
        ? ' ORDER BY ' + sorts.map(s => `${pgFormat('%I', s.column)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ')
        : '';
      const n = where.params.length;
      const sql = pgFormat('SELECT %s FROM %I.%I ', selectCols, nsp, table) + where.clause + orderClause + ` LIMIT $${n + 1} OFFSET $${n + 2}`;
      // One extra row tells whether there are more
      const result = await executeReadOnly(client, sql, [...where.params, effectiveLimit + 1, offset]);
      const hasMore = result.rows.length > effectiveLimit;
      const rows = hasMore ? result.rows.slice(0, effectiveLimit) : result.rows;

      const estimate = filters?.length ? null : (await executeReadOnly(client, estimateSql, [table, nsp])).rows[0]?.estimate;
      return rowsResult(result.fields.map(f => f.name), rows, format, {
        table: `${nsp}.${table}`,
        row_count: rows.length,
        offset,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + rows.length } : {}),
        ...(estimate !== null && estimate !== undefined && Number(estimate) >= 0 ? { total_estimate: Number(estimate) } : {}),
      });
    })
  );

  server.registerTool(
    'search_table',
    {
      title: 'Search a table',
      description: 'Find rows where ANY column contains a text (case-insensitive, every column read as text). Good for locating a value without knowing the column.',
      inputSchema: {
        table: tableParam,
        search: z.string().min(1).describe('Text to look for (partial, case-insensitive)'),
        database: databaseParam,
        schema: schemaParam,
        limit: z.number().int().min(1).max(1000).default(50).describe('Max rows (default 50)'),
        format: formatParam,
      },
      annotations: READ,
    },
    async ({ table, database, schema, search, limit, format }) => withClient(database, async (client) => {
      const nsp = resolveSchema(schema);
      const colResult = await executeReadOnly(client, `
        SELECT a.attname AS column_name
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `, [nsp, table]);
      if (colResult.rows.length === 0) return errorResult(`Table "${nsp}"."${table}" not found. Use list_tables.`);

      // Literal search: % and _ typed by the user are not wildcards
      const pattern = `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      const conditions = colResult.rows.map((r: any) => pgFormat('%I::text ILIKE $1', r.column_name)).join(' OR ');
      const sql = pgFormat('SELECT * FROM %I.%I WHERE ', nsp, table) + `(${conditions}) LIMIT $2`;
      const result = await executeReadOnly(client, sql, [pattern, limit]);

      // Which columns matched: helps the model see where the value lives
      const needle = search.toLowerCase();
      const matchedColumns = Array.from(new Set(result.rows.flatMap((row: any) =>
        Object.keys(row).filter(key => row[key] !== null && String(typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key]).toLowerCase().includes(needle)))));
      return rowsResult(result.fields.map(f => f.name), result.rows, format, {
        table: `${nsp}.${table}`,
        search_term: search,
        row_count: result.rows.length,
        matched_columns: matchedColumns,
      });
    })
  );

  server.registerTool(
    'full_text_search',
    {
      title: 'Full-text search',
      description: 'Language-aware full-text search (stemming, ranking) over text columns. The query uses web-search syntax: words, "exact phrase", OR, -excluded.',
      inputSchema: {
        table: tableParam,
        query: z.string().min(1).describe('Search, e.g. `invoice "late payment" -cancelled` or `cat OR dog`'),
        database: databaseParam,
        schema: schemaParam,
        language: z.string().default('simple').describe('Text search configuration: simple (default, no stemming), english, french, german…'),
        columns: z.array(z.string()).optional().describe('Columns to search (default: every text/varchar column)'),
        limit: z.number().int().min(1).max(1000).default(50).describe('Max rows (default 50)'),
        format: formatParam,
      },
      annotations: READ,
    },
    async ({ table, database, schema, query, language, columns, limit, format }) => withClient(database, async (client) => {
      const nsp = resolveSchema(schema);
      let searchColumns: string[];
      if (columns?.length) {
        searchColumns = columns;
      } else {
        const colResult = await executeReadOnly(client, `
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
            AND data_type IN ('text', 'character varying', 'character', 'citext')
          ORDER BY ordinal_position
        `, [nsp, table]);
        if (colResult.rows.length === 0) return errorResult(`No text columns found in "${nsp}"."${table}"`);
        searchColumns = colResult.rows.map((r: any) => r.column_name);
      }

      const document = searchColumns.map(c => pgFormat("COALESCE(%I::text, '')", c)).join(" || ' ' || ");
      const tsvector = `to_tsvector($1::regconfig, ${document})`;
      const tsquery = 'websearch_to_tsquery($1::regconfig, $2)';
      const sql = pgFormat('SELECT *, ts_rank(%s, %s) AS search_rank FROM %I.%I', tsvector, tsquery, nsp, table)
        + ` WHERE ${tsvector} @@ ${tsquery} ORDER BY search_rank DESC LIMIT $3`;
      const result = await executeReadOnly(client, sql, [language, query, limit]);
      return rowsResult(result.fields.map(f => f.name), result.rows, format, {
        table: `${nsp}.${table}`,
        query,
        language,
        searched_columns: searchColumns,
        row_count: result.rows.length,
      });
    })
  );

  server.registerTool(
    'count_rows',
    {
      title: 'Count rows',
      description: 'Count rows of a table, with optional filters. Without filters, gives the planner estimate (instant) unless exact is true.',
      inputSchema: {
        table: tableParam,
        database: databaseParam,
        schema: schemaParam,
        filters: z.array(filterSchema).optional().describe('Conditions combined with AND, e.g. [{column: "age", operator: "gt", value: 18}]'),
        exact: z.boolean().default(false).describe('Run COUNT(*) even without filters (slow on large tables)'),
      },
      annotations: READ,
    },
    async ({ table, database, schema, filters, exact }) => withClient(database, async (client) => {
      const nsp = resolveSchema(schema);
      if (!filters?.length && !exact) {
        const estimate = Number((await executeReadOnly(client, estimateSql, [table, nsp])).rows[0]?.estimate ?? -1);
        if (estimate > 0) return jsonResult({ table: `${nsp}.${table}`, count: estimate, is_estimate: true });
      }
      let where;
      try {
        where = buildWhereClause((filters ?? []) as Filter[]);
      } catch (err: any) {
        return errorResult(err.message);
      }
      const result = await executeReadOnly(client, pgFormat('SELECT count(*)::bigint AS count FROM %I.%I ', nsp, table) + where.clause, where.params);
      return jsonResult({ table: `${nsp}.${table}`, count: Number(result.rows[0].count), is_estimate: false, ...(filters?.length ? { filters } : {}) });
    })
  );
}

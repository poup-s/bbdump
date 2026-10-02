import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withClient, executeReadOnly, resolveSchema } from '../db.js';
import { jsonResult, errorResult } from '../types.js';
import { getHistory, clearHistory } from '../history.js';
import { READ, LOCAL, databaseParam, schemaParam, tableParam } from './common.js';

const SYSTEM_SCHEMAS = `('pg_catalog', 'information_schema', 'pg_toast')`;

export function registerExtraTools(server: McpServer) {
  server.registerTool(
    'list_extensions',
    {
      title: 'List extensions',
      description: 'PostgreSQL extensions of the database: installed ones (with version) and those available on the server. Extensions are installed from the bbdump app (Extensions).',
      inputSchema: {
        database: databaseParam,
        installed_only: z.boolean().default(false).describe('Only the installed extensions'),
      },
      annotations: READ,
    },
    async ({ database, installed_only }) => withClient(database, async (client) => {
      const result = await executeReadOnly(client, `
        SELECT name, default_version, installed_version, comment, (installed_version IS NOT NULL) AS is_installed
        FROM pg_available_extensions
        WHERE NOT $1::boolean OR installed_version IS NOT NULL
        ORDER BY is_installed DESC, name
      `, [installed_only]);
      return jsonResult({
        extensions: result.rows,
        installed_count: result.rows.filter((r: any) => r.is_installed).length,
        total_count: result.rows.length,
      });
    })
  );

  server.registerTool(
    'get_table_stats',
    {
      title: 'Table statistics',
      description: 'Activity statistics of a table: live/dead rows, scans (sequential vs index), inserts/updates/deletes, last (auto)vacuum and (auto)analyze.',
      inputSchema: { table: tableParam, database: databaseParam, schema: schemaParam },
      annotations: READ,
    },
    async ({ table, database, schema }) => withClient(database, async (client) => {
      const nsp = resolveSchema(schema);
      const result = await executeReadOnly(client, `
        SELECT relname AS table_name,
               n_live_tup AS live_rows, n_dead_tup AS dead_rows,
               CASE WHEN n_live_tup + n_dead_tup > 0 THEN round(100.0 * n_dead_tup / (n_live_tup + n_dead_tup), 2) ELSE 0 END AS dead_row_percent,
               seq_scan, seq_tup_read, idx_scan, idx_tup_fetch,
               n_tup_ins AS inserts, n_tup_upd AS updates, n_tup_del AS deletes, n_tup_hot_upd AS hot_updates,
               n_mod_since_analyze AS changes_since_analyze,
               last_vacuum, last_autovacuum, last_analyze, last_autoanalyze,
               vacuum_count, autovacuum_count, analyze_count, autoanalyze_count,
               pg_size_pretty(pg_total_relation_size(relid)) AS total_size
        FROM pg_stat_user_tables
        WHERE relname = $1 AND schemaname = $2
      `, [table, nsp]);
      if (result.rows.length === 0) return errorResult(`Table "${nsp}"."${table}" not found in statistics. Use list_tables.`);
      return jsonResult(result.rows[0]);
    })
  );

  server.registerTool(
    'find_column',
    {
      title: 'Find a column',
      description: 'Find columns whose name matches a pattern, across every schema (or one): where a field like "email" or "%_id" is used.',
      inputSchema: {
        column_pattern: z.string().describe('ILIKE pattern, e.g. "%email%" or "%user_id"'),
        database: databaseParam,
        schema: z.string().optional().describe('Only this schema (default: every non-system schema)'),
      },
      annotations: READ,
    },
    async ({ column_pattern, database, schema }) => withClient(database, async (client) => {
      const pattern = /[%_]/.test(column_pattern) ? column_pattern : `%${column_pattern}%`;
      const result = await executeReadOnly(client, `
        SELECT table_schema AS schema, table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE column_name ILIKE $1
          AND ($2::text IS NULL OR table_schema = $2::text)
          AND table_schema NOT IN ${SYSTEM_SCHEMAS}
        ORDER BY table_schema, table_name, ordinal_position
      `, [pattern, schema ?? null]);
      return jsonResult({ pattern, matches: result.rows, count: result.rows.length });
    })
  );

  server.registerTool(
    'list_views',
    {
      title: 'List views',
      description: 'Views and materialized views of a schema with their SQL definition.',
      inputSchema: {
        database: databaseParam,
        schema: schemaParam,
        include_definition: z.boolean().default(true).describe('Include the SQL of each view'),
      },
      annotations: READ,
    },
    async ({ database, schema, include_definition }) => withClient(database, async (client) => {
      const nsp = resolveSchema(schema);
      const result = await executeReadOnly(client, `
        SELECT c.relname AS view_name,
               CASE c.relkind WHEN 'm' THEN 'materialized view' ELSE 'view' END AS type,
               CASE WHEN $2::boolean THEN pg_get_viewdef(c.oid, true) END AS view_definition,
               obj_description(c.oid, 'pg_class') AS comment
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('v', 'm')
        ORDER BY c.relname
      `, [nsp, include_definition]);
      return jsonResult({ schema: nsp, views: result.rows, count: result.rows.length });
    })
  );

  server.registerTool(
    'list_functions',
    {
      title: 'List functions',
      description: 'Functions and procedures of a schema: arguments, return type, kind, language, security definer, comment. Extension functions are left out unless asked.',
      inputSchema: {
        database: databaseParam,
        schema: schemaParam,
        include_extensions: z.boolean().default(false).describe('Also list functions that belong to extensions'),
        include_source: z.boolean().default(false).describe('Include the function body'),
      },
      annotations: READ,
    },
    async ({ database, schema, include_extensions, include_source }) => withClient(database, async (client) => {
      const nsp = resolveSchema(schema);
      const result = await executeReadOnly(client, `
        SELECT p.proname AS name,
               pg_get_function_arguments(p.oid) AS arguments,
               pg_get_function_result(p.oid) AS return_type,
               CASE p.prokind WHEN 'f' THEN 'function' WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window' END AS kind,
               l.lanname AS language,
               p.prosecdef AS security_definer,
               obj_description(p.oid, 'pg_proc') AS comment,
               CASE WHEN $3::boolean THEN p.prosrc END AS source
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        JOIN pg_language l ON l.oid = p.prolang
        WHERE n.nspname = $1
          AND ($2::boolean OR NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'))
        ORDER BY p.proname
      `, [nsp, include_extensions, include_source]);
      return jsonResult({ schema: nsp, functions: result.rows, count: result.rows.length });
    })
  );

  server.registerTool(
    'list_active_connections',
    {
      title: 'Active connections',
      description: 'Sessions on the server: who, from where, state, what they wait on, and for how long the current query has been running. Optionally for one database or only active queries.',
      inputSchema: {
        database: z.string().optional().describe('Only sessions on this database'),
        active_only: z.boolean().default(false).describe('Only sessions running a query'),
      },
      annotations: READ,
    },
    async ({ database, active_only }) => withClient(undefined, async (client) => {
      const result = await executeReadOnly(client, `
        SELECT pid, datname AS database, usename AS username, application_name, client_addr, state,
               wait_event_type, wait_event,
               CASE WHEN state <> 'idle' THEN round(extract(epoch FROM now() - query_start)::numeric, 1) END AS query_seconds,
               round(extract(epoch FROM now() - xact_start)::numeric, 1) AS transaction_seconds,
               left(query, 500) AS query, backend_start
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'
          AND ($1::text IS NULL OR datname = $1::text)
          AND (NOT $2::boolean OR state <> 'idle')
        ORDER BY query_start NULLS LAST
      `, [database ?? null, active_only]);
      const settings = await executeReadOnly(client, `SELECT current_setting('max_connections')::int AS max_connections, (SELECT count(*)::int FROM pg_stat_activity) AS total`);
      return jsonResult({ connections: result.rows, count: result.rows.length, ...settings.rows[0] });
    })
  );

  server.registerTool(
    'list_triggers',
    {
      title: 'List triggers',
      description: 'Triggers of a table: timing, events, function, enabled state and definition.',
      inputSchema: { table: tableParam, database: databaseParam, schema: schemaParam },
      annotations: READ,
    },
    async ({ table, database, schema }) => withClient(database, async (client) => {
      const nsp = resolveSchema(schema);
      const result = await executeReadOnly(client, `
        SELECT t.tgname AS trigger_name,
               CASE t.tgenabled WHEN 'D' THEN false ELSE true END AS enabled,
               p.proname AS function_name,
               pg_get_triggerdef(t.oid, true) AS definition
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal AND c.relname = $1 AND n.nspname = $2
        ORDER BY t.tgname
      `, [table, nsp]);
      return jsonResult({ table: `${nsp}.${table}`, triggers: result.rows, count: result.rows.length });
    })
  );

  server.registerTool(
    'list_sequences',
    {
      title: 'List sequences',
      description: 'Sequences of a schema with their last value, limits and the share already used (to spot an int4 id about to run out).',
      inputSchema: { database: databaseParam, schema: schemaParam },
      annotations: READ,
    },
    async ({ database, schema }) => withClient(database, async (client) => {
      const nsp = resolveSchema(schema);
      const result = await executeReadOnly(client, `
        SELECT sequencename AS sequence_name, data_type, start_value, min_value, max_value, increment_by, cycle, last_value,
               CASE WHEN last_value IS NOT NULL AND max_value > 0
                 THEN round(100.0 * last_value / max_value, 4) END AS percent_used
        FROM pg_sequences
        WHERE schemaname = $1
        ORDER BY sequencename
      `, [nsp]);
      return jsonResult({ schema: nsp, sequences: result.rows, count: result.rows.length });
    })
  );

  server.registerTool(
    'query_history',
    {
      title: 'Query history',
      description: 'Queries and changes run through this MCP session (tool, database, SQL, duration, rows affected), newest first.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe('Number of entries (default 20)'),
        clear: z.boolean().default(false).describe('Clear the history after reading it'),
      },
      annotations: LOCAL,
    },
    async ({ limit, clear }) => {
      const records = getHistory(limit);
      if (clear) clearHistory();
      return jsonResult({ queries: records, count: records.length, cleared: clear });
    }
  );
}

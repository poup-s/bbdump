/** Diagnosis and performance: health report, index advice, locks, slow queries */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pg from 'pg';
import pgFormat from 'pg-format';
import { withClient, executeReadOnly, getActiveConnectionInfo } from '../db.js';
import { jsonResult, errorResult } from '../types.js';
import { requestConfirmation, refusalMessage } from '../confirm.js';
import { recordQuery } from '../history.js';
import { findWriteKeyword, trimStatement } from '../sql.js';
import { READ, WRITE, databaseParam } from './common.js';

type Level = 'ok' | 'info' | 'warning' | 'critical';
interface Check {
  check: string;
  level: Level;
  summary: string;
  details?: unknown[];
  advice?: string;
}

const RANK: Record<Level, number> = { critical: 0, warning: 1, info: 2, ok: 3 };

export function registerHealthTools(server: McpServer) {
  server.registerTool(
    'database_health',
    {
      title: 'Database health check',
      description: 'Health report of the database in one call, each finding with a level (critical, warning, info, ok) and advice: cache hit ratio, connection usage, long or idle-in-transaction sessions, blocked queries, tables needing VACUUM/ANALYZE, unused / duplicate / invalid indexes, tables without primary key, sequences close to their limit, transaction ID wraparound.',
      inputSchema: { database: databaseParam },
      annotations: READ,
    },
    async ({ database }) => withClient(database, async (client) => {
      const q = async (sql: string, params: unknown[] = []) => (await executeReadOnly(client, sql, params as any[], 30000)).rows;
      const checks: Check[] = [];

      const [cache] = await q(`SELECT sum(blks_hit)::float AS hit, sum(blks_read)::float AS read FROM pg_stat_database WHERE datname = current_database()`);
      const reads = Number(cache.hit) + Number(cache.read);
      if (reads > 10000) {
        const ratio = Number(cache.hit) / reads;
        checks.push({
          check: 'cache_hit_ratio',
          level: ratio < 0.9 ? 'warning' : ratio < 0.98 ? 'info' : 'ok',
          summary: `${(ratio * 100).toFixed(2)}% of reads served from memory`,
          ...(ratio < 0.98 ? { advice: 'Below ~99% on a busy database, shared_buffers may be too small or queries read too much (missing indexes).' } : {}),
        });
      }

      const [conn] = await q(`SELECT count(*)::int AS used, current_setting('max_connections')::int AS max FROM pg_stat_activity`);
      const usage = conn.used / conn.max;
      checks.push({
        check: 'connections',
        level: usage > 0.9 ? 'critical' : usage > 0.75 ? 'warning' : 'ok',
        summary: `${conn.used} of ${conn.max} connections in use`,
        ...(usage > 0.75 ? { advice: 'Close to max_connections: use a connection pooler (PgBouncer) or lower the application pool sizes.' } : {}),
      });

      const longQueries = await q(`
        SELECT pid, usename AS user, datname AS database, state, round(extract(epoch FROM now() - query_start))::int AS seconds, left(query, 200) AS query
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'
          AND ((state = 'active' AND now() - query_start > interval '5 minutes')
            OR (state LIKE 'idle in transaction%' AND now() - state_change > interval '5 minutes'))
        ORDER BY query_start`);
      checks.push({
        check: 'long_running_sessions',
        level: longQueries.length ? 'warning' : 'ok',
        summary: longQueries.length ? `${longQueries.length} session(s) running or idle in a transaction for more than 5 minutes` : 'No long-running query or transaction',
        ...(longQueries.length ? { details: longQueries, advice: 'Long transactions hold locks and stop VACUUM from cleaning up. cancel_query can stop one (after the user confirms).' } : {}),
      });

      const blocked = await q(`
        SELECT pid, pg_blocking_pids(pid) AS blocked_by, round(extract(epoch FROM now() - query_start))::int AS waiting_seconds, left(query, 200) AS query
        FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0`);
      checks.push({
        check: 'blocked_queries',
        level: blocked.length ? 'warning' : 'ok',
        summary: blocked.length ? `${blocked.length} query(ies) waiting on a lock` : 'No query waiting on a lock',
        ...(blocked.length ? { details: blocked, advice: 'list_locks shows the blocking chain.' } : {}),
      });

      const vacuum = await q(`
        SELECT schemaname AS schema, relname AS table, n_dead_tup AS dead_rows, n_live_tup AS live_rows,
               round(100.0 * n_dead_tup / greatest(n_live_tup + n_dead_tup, 1), 1) AS dead_percent,
               greatest(last_vacuum, last_autovacuum) AS last_vacuum
        FROM pg_stat_user_tables
        WHERE n_dead_tup > 10000 AND n_dead_tup > 0.2 * (n_live_tup + n_dead_tup)
        ORDER BY n_dead_tup DESC LIMIT 20`);
      checks.push({
        check: 'tables_needing_vacuum',
        level: vacuum.length ? 'warning' : 'ok',
        summary: vacuum.length ? `${vacuum.length} table(s) with more than 20% dead rows` : 'Dead rows under control',
        ...(vacuum.length ? { details: vacuum, advice: 'Run VACUUM (ANALYZE) on them (execute_write_query) and check autovacuum settings for busy tables.' } : {}),
      });

      const unanalyzed = await q(`
        SELECT schemaname AS schema, relname AS table, n_live_tup AS live_rows, n_mod_since_analyze AS changes_since_analyze
        FROM pg_stat_user_tables
        WHERE (last_analyze IS NULL AND last_autoanalyze IS NULL AND n_live_tup > 1000)
           OR n_mod_since_analyze > greatest(100000, n_live_tup)
        ORDER BY n_live_tup DESC LIMIT 20`);
      checks.push({
        check: 'stale_statistics',
        level: unanalyzed.length ? 'info' : 'ok',
        summary: unanalyzed.length ? `${unanalyzed.length} table(s) never analyzed or heavily changed since` : 'Planner statistics up to date',
        ...(unanalyzed.length ? { details: unanalyzed, advice: 'Run ANALYZE on them: stale statistics lead to bad plans.' } : {}),
      });

      const unused = await q(`
        SELECT s.schemaname AS schema, s.relname AS table, s.indexrelname AS index, pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
        FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
        WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary AND pg_relation_size(s.indexrelid) > 1024 * 1024
          AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = s.indexrelid)
        ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT 20`);
      const [statsReset] = await q(`SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()`);
      checks.push({
        check: 'unused_indexes',
        level: unused.length ? 'info' : 'ok',
        summary: unused.length ? `${unused.length} index(es) over 1 MB never used since ${statsReset?.stats_reset ?? 'the statistics reset'}` : 'No large unused index',
        ...(unused.length ? { details: unused, advice: 'They slow down writes and take space. Check replicas and rare jobs before dropping them.' } : {}),
      });

      const duplicates = await q(`
        SELECT n.nspname AS schema, t.relname AS table, array_agg(ic.relname ORDER BY ic.relname)::text[] AS indexes,
               pg_size_pretty(sum(pg_relation_size(i.indexrelid))) AS total_size
        FROM pg_index i
        JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        GROUP BY n.nspname, t.relname, i.indrelid, i.indkey::text, i.indclass::text, coalesce(pg_get_expr(i.indexprs, i.indrelid), ''), coalesce(pg_get_expr(i.indpred, i.indrelid), '')
        HAVING count(*) > 1`);
      checks.push({
        check: 'duplicate_indexes',
        level: duplicates.length ? 'warning' : 'ok',
        summary: duplicates.length ? `${duplicates.length} set(s) of identical indexes` : 'No duplicate index',
        ...(duplicates.length ? { details: duplicates, advice: 'Keep one index of each set (prefer the one backing a constraint) and drop the others.' } : {}),
      });

      const invalid = await q(`
        SELECT n.nspname AS schema, c.relname AS index, t.relname AS table
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT i.indisvalid`);
      checks.push({
        check: 'invalid_indexes',
        level: invalid.length ? 'warning' : 'ok',
        summary: invalid.length ? `${invalid.length} invalid index(es) (failed CREATE INDEX CONCURRENTLY)` : 'No invalid index',
        ...(invalid.length ? { details: invalid, advice: 'An invalid index is maintained but never used: REINDEX it or drop and recreate it.' } : {}),
      });

      const noPk = await q(`
        SELECT n.nspname AS schema, c.relname AS table, c.reltuples::bigint AS row_estimate
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
          AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conrelid = c.oid AND con.contype = 'p')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
        ORDER BY c.reltuples DESC LIMIT 30`);
      checks.push({
        check: 'tables_without_primary_key',
        level: noPk.length ? 'info' : 'ok',
        summary: noPk.length ? `${noPk.length} table(s) without primary key` : 'Every table has a primary key',
        ...(noPk.length ? { details: noPk, advice: 'Without a primary key, rows cannot be targeted reliably (and logical replication cannot update them).' } : {}),
      });

      const sequences = await q(`
        SELECT schemaname AS schema, sequencename AS sequence, data_type, last_value, max_value,
               round(100.0 * last_value / max_value, 1) AS percent_used
        FROM pg_sequences WHERE last_value IS NOT NULL AND max_value > 0 AND last_value > 0.5 * max_value
        ORDER BY last_value::float / max_value DESC`);
      checks.push({
        check: 'sequences_near_limit',
        level: sequences.some((s: any) => Number(s.percent_used) > 85) ? 'critical' : sequences.length ? 'warning' : 'ok',
        summary: sequences.length ? `${sequences.length} sequence(s) past half of their range` : 'Sequences far from their limit',
        ...(sequences.length ? { details: sequences, advice: 'Move the column (and sequence) to bigint before inserts start failing.' } : {}),
      });

      const [xid] = await q(`SELECT age(datfrozenxid)::bigint AS age FROM pg_database WHERE datname = current_database()`);
      const xidAge = Number(xid.age);
      checks.push({
        check: 'transaction_id_wraparound',
        level: xidAge > 1_500_000_000 ? 'critical' : xidAge > 500_000_000 ? 'warning' : 'ok',
        summary: `Oldest unfrozen transaction ID age: ${xidAge.toLocaleString('en-US')} (limit ~2.1 billion)`,
        ...(xidAge > 500_000_000 ? { advice: 'Autovacuum is falling behind on freezing: run VACUUM (FREEZE) on the oldest tables and check for long transactions.' } : {}),
      });

      const [size] = await q(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size, version() AS version`);
      checks.sort((a, b) => RANK[a.level] - RANK[b.level]);
      const count = (level: Level) => checks.filter(c => c.level === level).length;
      return jsonResult({
        database: database || getActiveConnectionInfo().database,
        size: size.size,
        server: size.version,
        summary: { critical: count('critical'), warning: count('warning'), info: count('info'), ok: count('ok') },
        checks,
      });
    })
  );

  server.registerTool(
    'suggest_indexes',
    {
      title: 'Suggest indexes',
      description: 'Index advice from the schema and usage statistics: foreign keys without an index on their columns (slow joins and deletes on the parent), and large tables read mostly by sequential scans. Each suggestion comes with a CREATE INDEX CONCURRENTLY statement to review.',
      inputSchema: {
        database: databaseParam,
        schema: z.string().optional().describe('Only this schema (default: every non-system schema)'),
      },
      annotations: READ,
    },
    async ({ database, schema }) => withClient(database, async (client) => {
      const fkWithoutIndex = (await executeReadOnly(client, `
        SELECT n.nspname AS schema, c.relname AS table, con.conname AS constraint,
               ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS columns,
               fc.relname AS references_table, c.reltuples::bigint AS row_estimate
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_class fc ON fc.oid = con.confrelid
        WHERE con.contype = 'f'
          AND ($1::text IS NULL OR n.nspname = $1::text)
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND NOT EXISTS (
            SELECT 1 FROM pg_index i
            WHERE i.indrelid = con.conrelid
              AND (i.indkey::int2[])[0:array_length(con.conkey, 1) - 1] @> con.conkey
              AND (i.indkey::int2[])[0:array_length(con.conkey, 1) - 1] <@ con.conkey)
        ORDER BY c.reltuples DESC
      `, [schema ?? null])).rows;

      const seqHeavy = (await executeReadOnly(client, `
        SELECT schemaname AS schema, relname AS table, seq_scan, seq_tup_read, COALESCE(idx_scan, 0) AS idx_scan,
               n_live_tup AS live_rows, pg_size_pretty(pg_relation_size(relid)) AS size,
               (seq_tup_read / greatest(seq_scan, 1))::bigint AS rows_per_seq_scan
        FROM pg_stat_user_tables
        WHERE ($1::text IS NULL OR schemaname = $1::text)
          AND pg_relation_size(relid) > 10 * 1024 * 1024
          AND seq_scan > 50 AND seq_scan > 2 * COALESCE(idx_scan, 0)
        ORDER BY seq_tup_read DESC LIMIT 15
      `, [schema ?? null])).rows;

      return jsonResult({
        foreign_keys_without_index: fkWithoutIndex.map((fk: any) => ({
          ...fk,
          suggestion: pgFormat('CREATE INDEX CONCURRENTLY %I ON %I.%I (%s);',
            `${fk.table}_${fk.columns.join('_')}_idx`.slice(0, 63), fk.schema, fk.table, fk.columns.map((col: string) => pgFormat('%I', col)).join(', ')),
        })),
        sequential_scan_heavy_tables: seqHeavy,
        next_steps: [
          'For the sequential-scan tables, find the queries that read them (get_slow_queries) and their WHERE columns.',
          'test_index checks a candidate index on a query without creating it (needs the hypopg extension).',
          'CREATE INDEX CONCURRENTLY does not lock writes; run it alone with execute_write_query (not inside other statements).',
        ],
      });
    })
  );

  server.registerTool(
    'test_index',
    {
      title: 'Test a hypothetical index',
      description: 'Compare the plan of a query without and with a candidate index, WITHOUT creating it (hypopg extension: hypothetical indexes live in this session only). Tells whether the planner would use the index and the cost change.',
      inputSchema: {
        sql: z.string().describe('Query to optimize (one SELECT)'),
        index: z.string().describe('Candidate index, e.g. "CREATE INDEX ON orders (customer_id, created_at)"'),
        database: databaseParam,
      },
      annotations: READ,
    },
    async ({ sql, index, database }) => {
      const keyword = findWriteKeyword(sql);
      if (keyword) return errorResult(`${keyword} changes the database: test_index takes a read query.`);
      if (!/^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(index) || /;\s*\S/.test(index)) {
        return errorResult('index must be one CREATE INDEX statement.');
      }
      return withClient(database, async (client) => {
        const hypopg = await executeReadOnly(client, `SELECT installed_version FROM pg_available_extensions WHERE name = 'hypopg'`);
        if (!hypopg.rows[0]?.installed_version) {
          return errorResult(hypopg.rows.length
            ? 'The hypopg extension is available but not enabled in this database: enable it from bbdump (database menu → Extensions → hypopg), then retry.'
            : 'The hypopg extension is not on this server: install it from bbdump (Extensions → hypopg; one click with Homebrew or on Linux), then retry.');
        }
        // Extended protocol: one statement only, so the query cannot smuggle a second one
        const one = (text: string, values: unknown[] = []) => client.query({ text, values, queryMode: 'extended' } as pg.QueryConfig);
        const body = trimStatement(sql);
        const plan = async () => (await one(`EXPLAIN (FORMAT JSON) ${body}`)).rows[0]['QUERY PLAN'][0].Plan;
        const indexNames = (node: any): string[] => [node['Index Name'], ...(node.Plans ?? []).flatMap(indexNames)].filter(Boolean);
        // Hypothetical indexes live in this backend only, not in the catalog
        await client.query('BEGIN READ ONLY');
        try {
          await one('SELECT hypopg_reset()');
          const before = await plan();
          const created = await one('SELECT indexname FROM hypopg_create_index($1)', [trimStatement(index)]);
          const hypoName = created.rows[0]?.indexname;
          const after = await plan();
          const used = indexNames(after).includes(hypoName);
          return jsonResult({
            index,
            used_by_planner: used,
            cost_before: before['Total Cost'],
            cost_with_index: after['Total Cost'],
            cost_change_percent: Math.round(1000 * (after['Total Cost'] - before['Total Cost']) / before['Total Cost']) / 10,
            top_node_with_index: after['Node Type'],
            verdict: used
              ? 'The planner would use this index. Create it with CREATE INDEX CONCURRENTLY (execute_write_query, confirmed in bbdump).'
              : 'The planner would NOT use this index for this query: try other columns or another order.',
          });
        } finally {
          await one('SELECT hypopg_reset()').catch(() => {});
          await client.query('ROLLBACK').catch(() => {});
        }
      });
    }
  );

  server.registerTool(
    'list_locks',
    {
      title: 'Lock waits',
      description: 'Which sessions are blocked and by whom: for each waiting query, the blocking sessions, their queries, states and how long they have been running. Empty when nothing waits.',
      inputSchema: {},
      annotations: READ,
    },
    async () => withClient(undefined, async (client) => {
      const result = await executeReadOnly(client, `
        SELECT w.pid AS waiting_pid, w.usename AS waiting_user, w.datname AS database,
               round(extract(epoch FROM now() - w.query_start))::int AS waiting_seconds,
               w.wait_event_type, left(w.query, 300) AS waiting_query,
               b.pid AS blocking_pid, b.usename AS blocking_user, b.state AS blocking_state,
               round(extract(epoch FROM now() - COALESCE(b.xact_start, b.query_start)))::int AS blocking_transaction_seconds,
               left(b.query, 300) AS blocking_query
        FROM pg_stat_activity w
        JOIN LATERAL unnest(pg_blocking_pids(w.pid)) AS bp(pid) ON true
        JOIN pg_stat_activity b ON b.pid = bp.pid
        ORDER BY waiting_seconds DESC
      `);
      return jsonResult({
        lock_waits: result.rows,
        count: result.rows.length,
        ...(result.rows.length ? { hint: 'A blocking session "idle in transaction" usually waits for its application to COMMIT. cancel_query can end it after confirmation.' } : {}),
      });
    })
  );

  server.registerTool(
    'get_slow_queries',
    {
      title: 'Slowest queries',
      description: 'Most expensive queries recorded by pg_stat_statements: total time, mean time, calls, rows, cache hit ratio. Needs the pg_stat_statements extension (bbdump: Extensions → pg_stat_statements, then restart PostgreSQL).',
      inputSchema: {
        database: databaseParam,
        order_by: z.enum(['total_time', 'mean_time', 'calls', 'rows']).default('total_time').describe('Ranking (default total_time: what costs the server the most)'),
        limit: z.number().int().min(1).max(100).default(15).describe('Number of queries (default 15)'),
        all_databases: z.boolean().default(false).describe('Include queries of every database (default: this one only)'),
      },
      annotations: READ,
    },
    async ({ database, order_by, limit, all_databases }) => withClient(database, async (client) => {
      const installed = await executeReadOnly(client, `SELECT installed_version FROM pg_available_extensions WHERE name = 'pg_stat_statements'`);
      if (!installed.rows[0]?.installed_version) {
        return errorResult('pg_stat_statements is not enabled in this database. In bbdump: database menu → Extensions → pg_stat_statements → Enable, then restart PostgreSQL from the banner.');
      }
      const orderColumn = { total_time: 'total_exec_time', mean_time: 'mean_exec_time', calls: 'calls', rows: 'rows' }[order_by];
      try {
        const result = await executeReadOnly(client, `
          SELECT left(regexp_replace(s.query, '\\s+', ' ', 'g'), 500) AS query, d.datname AS database, s.calls,
                 round(s.total_exec_time::numeric, 1) AS total_ms, round(s.mean_exec_time::numeric, 2) AS mean_ms,
                 round(s.max_exec_time::numeric, 1) AS max_ms, s.rows,
                 round(100.0 * s.shared_blks_hit / greatest(s.shared_blks_hit + s.shared_blks_read, 1), 1) AS cache_hit_percent,
                 round((100.0 * s.total_exec_time / greatest(sum(s.total_exec_time) OVER (), 1))::numeric, 1) AS percent_of_total_time
          FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid
          WHERE ($1::boolean OR d.datname = current_database()) AND s.query NOT LIKE '%bbdump-internal%'
          ORDER BY ${orderColumn} DESC
          LIMIT $2
        `, [all_databases, limit]);
        return jsonResult({ order_by, queries: result.rows, count: result.rows.length, next: 'explain_query on a query shows why it is slow.' });
      } catch (err: any) {
        if (/must be loaded via .?shared_preload_libraries/.test(err.message)) {
          return errorResult('pg_stat_statements is enabled but not loaded yet: restart PostgreSQL (bbdump shows a "Restart PostgreSQL" banner in Extensions).');
        }
        throw err;
      }
    })
  );

  server.registerTool(
    'cancel_query',
    {
      title: 'Cancel or terminate a session',
      description: 'Stop the query of a session (pg_cancel_backend) or close the session entirely (terminate: pg_terminate_backend), e.g. a query stuck for hours or a session blocking others. Confirmed by the user in the bbdump app.',
      inputSchema: {
        pid: z.number().int().positive().describe('Process id, from list_active_connections or list_locks'),
        terminate: z.boolean().default(false).describe('Close the whole session instead of cancelling its current query'),
      },
      annotations: WRITE,
    },
    async ({ pid, terminate }) => withClient(undefined, async (client) => {
      const target = await client.query(`SELECT pid, usename, datname, state, left(query, 300) AS query FROM pg_stat_activity WHERE pid = $1`, [pid]);
      if (target.rows.length === 0) return errorResult(`No session with pid ${pid} (it may have ended). Use list_active_connections.`);
      const session = target.rows[0];
      const fn = terminate ? 'pg_terminate_backend' : 'pg_cancel_backend';
      const sql = `SELECT ${fn}(${pid})`;
      const dbName = getActiveConnectionInfo().database;
      const outcome = await requestConfirmation({
        tool: 'cancel_query',
        database: session.datname ?? dbName,
        sql,
        description: `${terminate ? 'TERMINATE session' : 'CANCEL query of session'} ${pid} (${session.usename}, ${session.state}): ${session.query}`,
      });
      if (!outcome.approved) return errorResult(refusalMessage(outcome));
      const started = Date.now();
      const result = await client.query(`SELECT ${fn}($1) AS done`, [pid]);
      recordQuery({ tool: 'cancel_query', database: dbName, sql, duration_ms: Date.now() - started });
      return jsonResult({ pid, action: terminate ? 'terminate' : 'cancel', done: result.rows[0].done });
    })
  );
}

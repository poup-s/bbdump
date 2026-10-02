import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withClient, executeReadOnly, getActiveConnectionInfo } from '../db.js';
import { jsonResult, errorResult, textResult, config, MAX_TIMEOUT_MS } from '../types.js';
import { recordQuery } from '../history.js';
import { findWriteKeyword, isRowQuery, limitedQuery, toCsv, toMarkdown, trimStatement } from '../sql.js';
import { READ, databaseParam, formatParam } from './common.js';

const paramValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Total Cost'?: number;
  'Plan Rows'?: number;
  'Actual Rows'?: number;
  'Actual Total Time'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
}

/** Planned vs actual rows off by more than 10x either way */
function misestimated(node: PlanNode): boolean {
  if (node['Actual Rows'] === undefined || node['Plan Rows'] === undefined) return false;
  const actual = Math.max(node['Actual Rows'], 1);
  const planned = Math.max(node['Plan Rows'], 1);
  return actual / planned > 10 || planned / actual > 10;
}

/** What to look at first in a JSON plan: slowest nodes, sequential scans, bad estimates */
export function summarizePlan(root: { Plan: PlanNode; 'Execution Time'?: number; 'Planning Time'?: number }) {
  const nodes: PlanNode[] = [];
  const walk = (node: PlanNode) => { nodes.push(node); node.Plans?.forEach(walk); };
  walk(root.Plan);
  const analyzed = root['Execution Time'] !== undefined;
  const nodeTime = (n: PlanNode) => (n['Actual Total Time'] ?? 0) * (n['Actual Loops'] ?? 1);
  return {
    total_cost: root.Plan['Total Cost'],
    ...(analyzed ? { execution_ms: root['Execution Time'], planning_ms: root['Planning Time'] } : {}),
    sequential_scans: nodes.filter(n => n['Node Type'] === 'Seq Scan').map(n => ({
      table: n['Relation Name'],
      rows: analyzed ? n['Actual Rows'] : n['Plan Rows'],
      ...(n['Rows Removed by Filter'] ? { rows_removed_by_filter: n['Rows Removed by Filter'] } : {}),
    })),
    indexes_used: Array.from(new Set(nodes.map(n => n['Index Name']).filter(Boolean))),
    ...(analyzed
      ? {
        slowest_nodes: [...nodes].sort((a, b) => nodeTime(b) - nodeTime(a)).slice(0, 3)
          .map(n => ({ node: n['Node Type'], relation: n['Relation Name'] ?? n['Index Name'], total_ms: Math.round(nodeTime(n) * 100) / 100 })),
        row_misestimates: nodes.filter(misestimated)
          .map(n => ({ node: n['Node Type'], relation: n['Relation Name'], planned_rows: n['Plan Rows'], actual_rows: n['Actual Rows'] })),
      }
      : {}),
  };
}

export function registerQueryTools(server: McpServer) {
  server.registerTool(
    'execute_query',
    {
      title: 'Run a read-only query',
      description: `Run a read-only SQL query (SELECT, WITH, SHOW, EXPLAIN…) inside a READ ONLY transaction with a timeout. Rows are limited on the server (max_rows, at most ${config.maxRows}), so large results never load entirely. Use params for values ($1, $2…). Writes go through execute_write_query.`,
      inputSchema: {
        sql: z.string().describe('One SQL statement'),
        params: z.array(paramValue).optional().describe('Values for $1, $2… placeholders'),
        database: databaseParam,
        timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).default(60000).describe('Timeout in milliseconds (default 60000)'),
        max_rows: z.number().int().min(1).max(5000).default(1000).describe('Max rows returned (default 1000)'),
        format: formatParam,
      },
      annotations: READ,
    },
    async ({ sql, params, database, timeout_ms, max_rows, format }) => {
      // Early, clear refusal; the READ ONLY transaction is the real protection
      const keyword = findWriteKeyword(sql);
      if (keyword) {
        return errorResult(`${keyword} changes the database: this tool is read-only. Use execute_write_query (confirmed by the user in bbdump).`);
      }
      return withClient(database, async (client) => {
        const limit = Math.min(max_rows, config.maxRows);
        const startTime = Date.now();
        let result;
        let limitedOnServer = false;
        if (isRowQuery(sql)) {
          try {
            // One extra row says whether the result was cut
            result = await executeReadOnly(client, limitedQuery(sql, limit + 1), params ?? [], timeout_ms);
            limitedOnServer = true;
          } catch (err: any) {
            // Not wrappable (syntax only valid at top level): run it as is
            if (err?.code !== '42601' && err?.code !== '42P10' && err?.code !== '42702') throw err;
          }
        }
        if (!result) result = await executeReadOnly(client, trimStatement(sql), params ?? [], timeout_ms);
        const duration = Date.now() - startTime;

        const dbName = database || getActiveConnectionInfo().database;
        recordQuery({ tool: 'execute_query', database: dbName, sql, duration_ms: duration, rows_affected: result.rowCount ?? undefined });

        const truncated = result.rows.length > limit;
        const rows = truncated ? result.rows.slice(0, limit) : result.rows;
        const fields = result.fields?.map(f => f.name) || [];
        const meta = {
          row_count: rows.length,
          truncated,
          ...(truncated ? { note: `More than ${limit} rows: add a LIMIT/WHERE or raise max_rows.` } : {}),
          ...(!limitedOnServer && result.rowCount !== null ? { total_row_count: result.rowCount } : {}),
          duration_ms: duration,
        };
        if (format === 'json') return jsonResult({ ...meta, fields, rows });
        const body = format === 'csv' ? toCsv(fields, rows) : toMarkdown(fields, rows);
        return textResult(`${Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join(' · ')}\n\n${body}`);
      });
    }
  );

  server.registerTool(
    'explain_query',
    {
      title: 'Explain a query',
      description: 'Execution plan of a query with a summary of what matters: total time, sequential scans, indexes used, slowest nodes, bad row estimates. analyze runs the query (in a READ ONLY transaction) to get real timings.',
      inputSchema: {
        sql: z.string().describe('Query to analyze (one statement)'),
        params: z.array(paramValue).optional().describe('Values for $1, $2… placeholders'),
        database: databaseParam,
        analyze: z.boolean().default(true).describe('Run the query for real timings (default true; read-only)'),
        buffers: z.boolean().default(false).describe('Include buffer (cache/disk) usage'),
        format: z.enum(['text', 'json']).default('text').describe('Plan format (the summary is always included)'),
        timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).default(60000).describe('Timeout in milliseconds'),
      },
      annotations: READ,
    },
    async ({ sql, params, database, analyze, buffers, format, timeout_ms }) => {
      const keyword = findWriteKeyword(sql);
      if (keyword) return errorResult(`${keyword} changes the database: only read queries can be explained here.`);
      return withClient(database, async (client) => {
        const body = trimStatement(sql);
        const options = `ANALYZE ${analyze}, BUFFERS ${buffers && analyze}`;
        const startTime = Date.now();
        const json = await executeReadOnly(client, `EXPLAIN (${options}, FORMAT JSON) ${body}`, params ?? [], timeout_ms);
        const plan = json.rows[0]['QUERY PLAN'][0];
        const dbName = database || getActiveConnectionInfo().database;
        recordQuery({ tool: 'explain_query', database: dbName, sql, duration_ms: Date.now() - startTime });

        const summary = summarizePlan(plan);
        if (format === 'json') return jsonResult({ summary, plan });
        // A text plan reads best; with analyze, a second run would execute the query twice
        const text = analyze
          ? JSON.stringify(plan.Plan, null, 2)
          : (await executeReadOnly(client, `EXPLAIN (FORMAT TEXT) ${body}`, params ?? [], timeout_ms)).rows.map((r: any) => r['QUERY PLAN']).join('\n');
        return textResult(`Summary:\n${JSON.stringify(summary, null, 2)}\n\nPlan:\n${text}`);
      });
    }
  );
}

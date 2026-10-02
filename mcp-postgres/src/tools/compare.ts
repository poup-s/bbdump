/** Compare two databases saved in bbdump: what the target lacks (schema and rows) */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appApi } from '../confirm.js';
import { findDatabase, isBbdumpConfigured } from '../connections.js';
import { getActiveConnectionInfo } from '../db.js';
import { jsonResult, errorResult } from '../types.js';
import { READ } from './common.js';

interface SchemaChange { id: string; kind: string; object: string; sql: string[]; destructive: boolean; defaultSelected: boolean; note?: string }
interface TablePlan {
  key: string; newTable: boolean; primaryKey: string[] | null; sourceRows: number; localRows: number;
  missing: number | null; missingExact: boolean; reason?: string;
}
interface Analysis {
  source: { name: string; host: string; version: number };
  target: { name: string; host: string; version: number };
  schema: SchemaChange[];
  tables: TablePlan[];
  anonymize: Array<{ table: string; column: string; kind: string }>;
}

export function registerCompareTools(server: McpServer) {
  server.registerTool(
    'compare_databases',
    {
      title: 'Compare two databases',
      description: 'What a target database lacks compared to a source (both saved in bbdump, both only read): schema additions (schemas, enums, tables, columns, indexes, foreign keys, functions, views, triggers), destructive differences (columns or tables only in the target, type changes), and rows missing per table (by primary key). Typical use: how far a local dev copy is behind prod. To apply it, the user runs "Update from…" in bbdump.',
      inputSchema: {
        source: z.string().describe('Reference database (e.g. prod): connection id or name from list_connections'),
        target: z.string().optional().describe('Database compared to it (default: the active connection)'),
        include_sql: z.boolean().default(false).describe('Also return the SQL that would add what is missing'),
      },
      annotations: READ,
    },
    async ({ source, target, include_sql }) => {
      if (!isBbdumpConfigured()) return errorResult('Comparing needs the bbdump app: reinstall this MCP server from bbdump Settings → MCP.');
      const from = findDatabase(source);
      if (!from) return errorResult(`Connection "${source}" not found in bbdump. Use list_connections.`);
      const targetName = target || getActiveConnectionInfo().label;
      if (!targetName) return errorResult('No bbdump connection is active: pass target (see list_connections).');
      const to = findDatabase(targetName);
      if (!to) return errorResult(`Connection "${targetName}" not found in bbdump. Use list_connections.`);
      if (to.id === from.id) return errorResult('source and target are the same database.');

      try {
        const result = await appApi<{ success: boolean; error?: string; analysis?: Analysis }>(
          'POST', '/compare', { source: from.id, target: to.id }, 10 * 60 * 1000,
        );
        if (!result.success || !result.analysis) return errorResult(`Comparison failed: ${result.error ?? 'unknown error'}`);
        const a = result.analysis;

        const additions = a.schema.filter(c => !c.destructive);
        const destructive = a.schema.filter(c => c.destructive);
        const behind = a.tables.filter(t => t.primaryKey && (t.missing ?? 0) > 0);
        const missingRows = behind.reduce((n, t) => n + (t.missing ?? 0), 0);
        const approximate = behind.some(t => !t.missingExact);
        const noKey = a.tables.filter(t => !t.primaryKey).map(t => t.key);
        // The engine's notes speak of the "local" database: here the target may be remote
        const change = (c: SchemaChange) => ({
          kind: c.kind, object: c.object, ...(c.note ? { note: c.note.replace(/\blocal\b/g, 'target') } : {}), ...(include_sql ? { sql: c.sql } : {}),
        });

        const lacks = [
          additions.length ? `${additions.length} schema addition(s)` : '',
          behind.length ? `${approximate ? '~' : ''}${missingRows.toLocaleString('en-US')} row(s) in ${behind.length} table(s)` : '',
        ].filter(Boolean);
        const summary = lacks.length === 0
          ? `${a.target.name} has everything ${a.source.name} has (schema and rows${noKey.length ? '; tables without primary key are not compared' : ''}).`
          : `${a.target.name} lacks ${lacks.join(' and ')} compared to ${a.source.name}.`;

        return jsonResult({
          source: `${a.source.name} (${a.source.host}, PostgreSQL ${Math.floor(a.source.version / 10000)})`,
          target: `${a.target.name} (${a.target.host}, PostgreSQL ${Math.floor(a.target.version / 10000)})`,
          summary,
          schema_to_add: additions.map(change),
          ...(destructive.length ? { differences_not_applied_by_default: destructive.map(change) } : {}),
          rows_missing: behind.map(t => ({
            table: t.key,
            missing: t.missing,
            exact: t.missingExact,
            source_rows: t.sourceRows,
            target_rows: t.localRows,
            ...(t.newTable ? { new_table: true } : {}),
          })),
          ...(noKey.length ? { not_compared_no_primary_key: noKey } : {}),
          ...(a.anonymize.length ? { personal_data_columns: a.anonymize.map(c => `${c.table}.${c.column} (${c.kind})`) } : {}),
          next: 'To bring the target up to date: in bbdump, ⋯ menu of the target (a local database) → "Update from…" (backup first, schema additions, missing rows, optional anonymization).',
        });
      } catch (err: any) {
        return errorResult(err.message);
      }
    }
  );
}

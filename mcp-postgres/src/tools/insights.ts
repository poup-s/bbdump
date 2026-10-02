/** Understanding a database in few calls: schema overview, DDL, data profile */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pgFormat from 'pg-format';
import { withClient, executeReadOnly, resolveSchema } from '../db.js';
import { jsonResult, errorResult, textResult } from '../types.js';
import { READ, databaseParam, schemaParam, tableParam } from './common.js';

/** Tables written out in full by get_schema_overview; the rest are listed by name */
const OVERVIEW_MAX_TABLES = 150;

const humanCount = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export function registerInsightTools(server: McpServer) {
  server.registerTool(
    'get_schema_overview',
    {
      title: 'Schema overview',
      description: 'The whole schema in ONE call, as compact text: every table with row estimate, columns (type, PK, NOT NULL, default, unique), foreign keys (→ table.column), plus views and enum types. Call it first to understand a database before writing queries.',
      inputSchema: {
        database: databaseParam,
        schema: z.string().optional().describe('Only this schema (default: every non-system schema)'),
        include_columns: z.boolean().default(true).describe('false: tables and relations only (for very large schemas)'),
      },
      annotations: READ,
    },
    async ({ database, schema, include_columns }) => withClient(database, async (client) => {
      const schemaFilter = `n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%'
        AND ($1::text IS NULL OR n.nspname = $1::text)`;
      const tables = await executeReadOnly(client, `
        SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.reltuples::bigint AS estimate,
               obj_description(c.oid, 'pg_class') AS comment
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE ${schemaFilter} AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
          AND NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.objid = c.oid AND dep.deptype = 'e')
        ORDER BY n.nspname, c.relkind IN ('v', 'm'), c.relname
      `, [schema ?? null]);
      if (tables.rows.length === 0) {
        return errorResult(schema ? `No table in schema "${schema}". Use list_schemas.` : 'No user table in this database.');
      }

      const detailed = tables.rows.slice(0, OVERVIEW_MAX_TABLES);
      const oids = detailed.map((t: any) => t.oid);
      const columns = include_columns ? (await executeReadOnly(client, `
        SELECT a.attrelid AS oid, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
               pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity <> '' AS identity, a.attgenerated <> '' AS generated
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attrelid, a.attnum
      `, [oids])).rows : [];
      const constraints = (await executeReadOnly(client, `
        SELECT con.conrelid AS oid, con.contype AS type,
               ARRAY(SELECT att.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                     JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.n ORDER BY k.i)::text[] AS columns,
               CASE WHEN con.contype = 'f' THEN
                 (SELECT CASE WHEN fn.oid = sc.relnamespace THEN '' ELSE fn.nspname || '.' END || fc.relname
                  FROM pg_class fc JOIN pg_namespace fn ON fn.oid = fc.relnamespace JOIN pg_class sc ON sc.oid = con.conrelid
                  WHERE fc.oid = con.confrelid) END AS ref_table,
               ARRAY(SELECT att.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                     JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = k.n ORDER BY k.i)::text[] AS ref_columns
        FROM pg_constraint con
        WHERE con.conrelid = ANY($1::oid[]) AND con.contype IN ('p', 'f', 'u')
      `, [oids])).rows;
      const enums = (await executeReadOnly(client, `
        SELECT n.nspname AS schema, t.typname AS name, string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS labels
        FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE ${schemaFilter}
        GROUP BY n.nspname, t.typname ORDER BY 1, 2
      `, [schema ?? null])).rows;

      const lines: string[] = [];
      let currentSchema = '';
      const kindLabel: Record<string, string> = { v: 'view', m: 'materialized view', f: 'foreign table', p: 'partitioned' };
      for (const t of detailed) {
        if (t.schema !== currentSchema) {
          currentSchema = t.schema;
          const count = tables.rows.filter((r: any) => r.schema === currentSchema).length;
          lines.push(`${lines.length ? '\n' : ''}## schema ${currentSchema} (${count} relation${count > 1 ? 's' : ''})`);
        }
        const own = constraints.filter((c: any) => c.oid === t.oid);
        const pk = own.find((c: any) => c.type === 'p');
        const facts = [
          kindLabel[t.kind],
          Number(t.estimate) >= 0 && (t.kind === 'r' || t.kind === 'p' || t.kind === 'm') ? `~${humanCount(Number(t.estimate))} rows` : null,
          pk && pk.columns.length > 1 ? `PK (${pk.columns.join(', ')})` : null,
        ].filter(Boolean);
        lines.push(`\n${t.name}${facts.length ? ` [${facts.join(', ')}]` : ''}${t.comment ? ` — ${t.comment}` : ''}`);
        if (include_columns) {
          for (const col of columns.filter((c: any) => c.oid === t.oid)) {
            const parts = [col.type];
            if (pk && pk.columns.length === 1 && pk.columns[0] === col.name) parts.push('PK');
            if (col.not_null && !(pk?.columns.includes(col.name))) parts.push('NOT NULL');
            if (own.some((c: any) => c.type === 'u' && c.columns.length === 1 && c.columns[0] === col.name)) parts.push('UNIQUE');
            if (col.identity) parts.push('IDENTITY');
            else if (col.generated) parts.push(`GENERATED ${col.def}`);
            else if (/^nextval\(/.test(String(col.def))) parts.push('SERIAL');
            else if (col.def) parts.push(`DEFAULT ${String(col.def).length > 40 ? `${String(col.def).slice(0, 40)}…` : col.def}`);
            const fk = own.find((c: any) => c.type === 'f' && c.columns.length === 1 && c.columns[0] === col.name);
            if (fk) parts.push(`→ ${fk.ref_table}.${fk.ref_columns[0]}`);
            lines.push(`  ${col.name} ${parts.join(' ')}`);
          }
        }
        // Multi-column foreign keys (and every key when columns are not listed)
        for (const fk of own.filter((c: any) => c.type === 'f' && (!include_columns || c.columns.length > 1))) {
          lines.push(`  FK (${fk.columns.join(', ')}) → ${fk.ref_table}(${fk.ref_columns.join(', ')})`);
        }
      }
      const rest = tables.rows.slice(OVERVIEW_MAX_TABLES);
      if (rest.length) {
        lines.push(`\n… ${rest.length} more relations (use describe_table): ${rest.map((r: any) => `${r.schema}.${r.name}`).join(', ')}`);
      }
      if (enums.length) {
        lines.push('\n## enum types');
        for (const e of enums) lines.push(`${e.schema}.${e.name}: ${e.labels}`);
      }
      return textResult(lines.join('\n'));
    })
  );

  server.registerTool(
    'get_table_ddl',
    {
      title: 'Table DDL',
      description: 'CREATE TABLE statement of a table as it exists: columns, defaults, identity, constraints (PK, FK, unique, check), indexes, comments and triggers. Useful to write migrations or recreate the table elsewhere.',
      inputSchema: { table: tableParam, database: databaseParam, schema: schemaParam },
      annotations: READ,
    },
    async ({ table, database, schema }) => withClient(database, async (client) => {
      const nsp = resolveSchema(schema);
      const rel = await executeReadOnly(client, `
        SELECT c.oid, c.relkind, obj_description(c.oid, 'pg_class') AS comment,
               CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partition_key
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
      `, [nsp, table]);
      if (rel.rows.length === 0) return errorResult(`Table "${nsp}"."${table}" not found. Use list_tables.`);
      const { oid, relkind, comment, partition_key } = rel.rows[0];
      const qualified = pgFormat('%I.%I', nsp, table);

      if (relkind === 'v' || relkind === 'm') {
        const def = await executeReadOnly(client, 'SELECT pg_get_viewdef($1::oid, true) AS def', [oid]);
        return textResult(`CREATE ${relkind === 'm' ? 'MATERIALIZED VIEW' : 'VIEW'} ${qualified} AS\n${def.rows[0].def}`);
      }

      const columns = await executeReadOnly(client, `
        SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
               pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity AS identity, a.attgenerated AS generated,
               col_description(a.attrelid, a.attnum) AS comment,
               CASE WHEN a.attcollation <> t.typcollation AND a.attcollation <> 0 THEN (SELECT collname FROM pg_collation WHERE oid = a.attcollation) END AS collation
        FROM pg_attribute a
        JOIN pg_type t ON t.oid = a.atttypid
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `, [oid]);
      const constraints = await executeReadOnly(client, `
        SELECT conname AS name, pg_get_constraintdef(oid, true) AS def
        FROM pg_constraint WHERE conrelid = $1 AND contype IN ('p', 'u', 'f', 'c', 'x')
        ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'x' THEN 3 ELSE 4 END, conname
      `, [oid]);
      const indexes = await executeReadOnly(client, `
        SELECT pg_get_indexdef(ix.indexrelid) AS def
        FROM pg_index ix
        WHERE ix.indrelid = $1 AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = ix.indexrelid AND con.contype IN ('p', 'u', 'x'))
        ORDER BY 1
      `, [oid]);
      const triggers = await executeReadOnly(client, `SELECT pg_get_triggerdef(oid, true) AS def FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal ORDER BY tgname`, [oid]);

      const columnLines = columns.rows.map((col: any) => {
        let line = `  ${pgFormat('%I', col.name)} ${col.type}`;
        if (col.collation) line += ` COLLATE ${pgFormat('%I', col.collation)}`;
        if (col.identity) line += ` GENERATED ${col.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
        else if (col.generated === 's') line += ` GENERATED ALWAYS AS (${col.def}) STORED`;
        else if (col.def) line += ` DEFAULT ${col.def}`;
        if (col.not_null) line += ' NOT NULL';
        return line;
      });
      const constraintLines = constraints.rows.map((c: any) => `  CONSTRAINT ${pgFormat('%I', c.name)} ${c.def}`);
      const ddl = [
        `CREATE TABLE ${qualified} (`,
        [...columnLines, ...constraintLines].join(',\n'),
        `)${partition_key ? ` PARTITION BY ${partition_key}` : ''};`,
        ...indexes.rows.map((i: any) => `${i.def};`),
        ...triggers.rows.map((t: any) => `${t.def};`),
        ...(comment ? [pgFormat('COMMENT ON TABLE %s IS %L;', qualified, comment)] : []),
        ...columns.rows.filter((c: any) => c.comment).map((c: any) => pgFormat('COMMENT ON COLUMN %s.%I IS %L;', qualified, c.name, c.comment)),
      ];
      return textResult(ddl.join('\n'));
    })
  );

  server.registerTool(
    'profile_table',
    {
      title: 'Profile table data',
      description: 'What the data looks like, column by column, on a sample of rows: share of NULLs, distinct values, min/max, most frequent values. Good before writing filters, joins or data fixes.',
      inputSchema: {
        table: tableParam,
        database: databaseParam,
        schema: schemaParam,
        columns: z.array(z.string()).optional().describe('Columns to profile (default: all, up to 40)'),
        sample_rows: z.number().int().min(100).max(200000).default(10000).describe('Rows read (default 10000)'),
        top_values: z.number().int().min(0).max(20).default(5).describe('Most frequent values per column (default 5)'),
      },
      annotations: READ,
    },
    async ({ table, database, schema, columns, sample_rows, top_values }) => withClient(database, async (client) => {
      const nsp = resolveSchema(schema);
      const cols = await executeReadOnly(client, `
        SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
               EXISTS (SELECT 1 FROM pg_opclass oc JOIN pg_am am ON am.oid = oc.opcmethod
                       WHERE am.amname = 'btree' AND oc.opcintype = a.atttypid AND oc.opcdefault) AS orderable
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `, [nsp, table]);
      if (cols.rows.length === 0) return errorResult(`Table "${nsp}"."${table}" not found. Use list_tables.`);
      const wanted = columns?.length ? cols.rows.filter((c: any) => columns.includes(c.name)) : cols.rows.slice(0, 40);
      if (wanted.length === 0) return errorResult(`None of these columns exist in ${nsp}.${table}.`);

      const sample = pgFormat('(SELECT * FROM %I.%I LIMIT %s) AS s', nsp, table, sample_rows);
      const aggregates = wanted.flatMap((c: any, i: number) => [
        pgFormat('count(%I) AS %I', c.name, `n${i}`),
        pgFormat('count(DISTINCT %I::text) AS %I', c.name, `d${i}`),
        ...(c.orderable ? [pgFormat('min(%I)::text AS %I', c.name, `min${i}`), pgFormat('max(%I)::text AS %I', c.name, `max${i}`)] : []),
      ]);
      const stats = (await executeReadOnly(client, `SELECT count(*) AS total, ${aggregates.join(', ')} FROM ${sample}`, [], 60000)).rows[0];
      const total = Number(stats.total);

      const profile = [];
      for (let i = 0; i < wanted.length; i++) {
        const c = wanted[i];
        const nonNull = Number(stats[`n${i}`]);
        const distinct = Number(stats[`d${i}`]);
        let top: Array<{ value: string | null; count: number }> = [];
        if (top_values > 0 && distinct > 0 && distinct < nonNull) {
          const freq = await executeReadOnly(client, pgFormat(
            'SELECT left(%I::text, 100) AS value, count(*)::int AS count FROM %s WHERE %I IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT %s',
            c.name, sample, c.name, top_values,
          ), [], 30000);
          top = freq.rows;
        }
        profile.push({
          column: c.name,
          type: c.type,
          null_percent: total ? Math.round(1000 * (total - nonNull) / total) / 10 : 0,
          distinct_values: distinct,
          ...(distinct === nonNull && nonNull > 0 ? { all_distinct: true } : {}),
          ...(c.orderable ? { min: stats[`min${i}`], max: stats[`max${i}`] } : {}),
          ...(top.length ? { most_frequent: top } : {}),
        });
      }
      return jsonResult({ table: `${nsp}.${table}`, sampled_rows: total, columns: profile });
    })
  );
}

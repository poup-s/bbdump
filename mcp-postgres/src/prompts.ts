/** Ready-made workflows the user can pick in their AI client (MCP prompts) */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const user = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });

export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    'explore_database',
    {
      title: 'Explore a database',
      description: 'Understand a database: its tables, relations, and what the data looks like',
      argsSchema: { connection: z.string().optional().describe('bbdump connection name (default: ask / the active one)') },
    },
    ({ connection }) => user([
      `Explore the PostgreSQL database${connection ? ` "${connection}"` : ''} with the bbdump MCP tools.`,
      connection ? `1. use_connection "${connection}".` : '1. list_connections, then use_connection on the database I mean (ask me if unclear).',
      '2. get_schema_overview to see every table, column and relation.',
      '3. For the 3–5 central tables, profile_table to see what the data looks like.',
      'Then explain in plain words what this database is about, its main entities and how they relate, and anything surprising (tables without primary key, nullable foreign keys, odd values). Do not change anything.',
    ].join('\n'))
  );

  server.registerPrompt(
    'optimize_query',
    {
      title: 'Optimize a slow query',
      description: 'Find why a query is slow and how to fix it, without changing the database',
      argsSchema: { sql: z.string().describe('The slow query') },
    },
    ({ sql }) => user([
      'This query is slow:',
      '```sql', sql, '```',
      '1. explain_query (analyze true) and read the summary: sequential scans, slowest nodes, bad row estimates.',
      '2. describe_table on the tables involved (indexes, sizes).',
      '3. For each candidate index, test_index to check the planner would use it (needs hypopg; if missing, say how to enable it in bbdump).',
      '4. Propose the fix: index (CREATE INDEX CONCURRENTLY), query rewrite, or ANALYZE. Show the expected gain. Ask me before creating anything.',
    ].join('\n'))
  );

  server.registerPrompt(
    'health_check',
    {
      title: 'Database health check',
      description: 'Check the health of a database and get a prioritized to-do list',
      argsSchema: { connection: z.string().optional().describe('bbdump connection name (default: the active one)') },
    },
    ({ connection }) => user([
      connection ? `use_connection "${connection}", then run database_health.` : 'Run database_health on the active connection.',
      'Also run suggest_indexes, and get_slow_queries if pg_stat_statements is available.',
      'Give me a short report: what is fine, what needs attention (most urgent first), and for each problem the exact SQL to fix it. Do not run any change yourself.',
    ].join('\n'))
  );

  server.registerPrompt(
    'safe_change',
    {
      title: 'Make a change safely',
      description: 'Apply a data or schema change with a backup and a dry run first',
      argsSchema: { change: z.string().describe('What to change, in plain words or SQL') },
    },
    ({ change }) => user([
      `I want to make this change: ${change}`,
      '1. Look at the tables involved (describe_table) and count the rows affected (count_rows / execute_query).',
      '2. Write the SQL and show it to me with the number of rows it touches.',
      '3. create_backup of the database.',
      '4. execute_write_query with dry_run true on each statement to preview it.',
      '5. Only then run it for real with execute_write_query (bbdump will ask me to confirm), and check the result.',
    ].join('\n'))
  );
}

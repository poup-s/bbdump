import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDatabaseTools } from './tools/databases.js';
import { registerTableTools } from './tools/tables.js';
import { registerDataTools } from './tools/data.js';
import { registerQueryTools } from './tools/query.js';
import { registerSchemaTools } from './tools/schema.js';
import { registerExtraTools } from './tools/extras.js';
import { registerConnectionTools } from './tools/connections.js';
import { registerMutationTools, setClientNameSource } from './tools/mutations.js';
import { registerInsightTools } from './tools/insights.js';
import { registerHealthTools } from './tools/health.js';
import { registerBackupTools } from './tools/backups.js';
import { registerCompareTools } from './tools/compare.js';
import { registerPrompts } from './prompts.js';

export const SERVER_VERSION = '1.1.0';

/** Sent to the client at connection: how to use these tools well */
const INSTRUCTIONS = `PostgreSQL tools from bbdump.
- Start with list_connections, then use_connection on the database the user means; every tool then works on it.
- get_schema_overview gives all tables, columns and relations in one call: prefer it to many describe_table calls.
- Reads are safe (read-only transactions). Every write (insert/update/delete_rows, execute_write_query, create_database, cancel_query) waits for the user to approve it in the bbdump app; if refused, do not retry the same change.
- Each write saves an undo point when possible (rows touched, cascades included): list_changes and undo_change bring them back. For changes without one (DDL, large tables), offer create_backup first, and preview with execute_write_query dry_run.
- Prefer format "markdown" for row results you only need to read: it is much shorter than JSON.
- Performance: explain_query, database_health, suggest_indexes, test_index, get_slow_queries.
- compare_databases tells what a database lacks compared to another (e.g. a local dev copy behind prod).`;

export function createServer(): McpServer {
  const server = new McpServer({ name: 'bbdump-postgres', version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  setClientNameSource(() => server.server.getClientVersion()?.name);
  registerConnectionTools(server);
  registerDatabaseTools(server);
  registerTableTools(server);
  registerInsightTools(server);
  registerDataTools(server);
  registerQueryTools(server);
  registerSchemaTools(server);
  registerExtraTools(server);
  registerHealthTools(server);
  registerMutationTools(server);
  registerBackupTools(server);
  registerCompareTools(server);
  registerPrompts(server);

  return server;
}

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
import { chatScope, toolAllowed } from './chatScope.js';
import { mongoToolsEnabled } from './mongo/features.js';
import { savedEngine } from './connections.js';
import { registerMongoTools } from './mongo/tools.js';
import { registerMongoWriteTools } from './mongo/writes.js';
import { registerSqlTools } from './sql/tools.js';
import { registerSqlWriteTools } from './sql/writes.js';
import { isSqlEngine } from './connections.js';

export const SERVER_VERSION = '1.1.0';

/** Sent to the client at connection: how to use these tools well */
const INSTRUCTIONS = `PostgreSQL tools from bbdump.
- Start with list_connections, then use_connection on the database the user means; every tool then works on it.
- get_schema_overview gives all tables, columns and relations in one call: prefer it to many describe_table calls.
- Reads are safe (read-only transactions). Every write (insert/update/delete_rows, execute_write_query, create_database, cancel_query) waits for the user to approve it in the bbdump app; if refused, do not retry the same change.
- Each write saves an undo point when possible (rows touched, cascades included): list_changes and undo_change bring them back. For changes without one (DDL, large tables), offer create_backup first, and preview with execute_write_query dry_run.
- Prefer format "markdown" for row results you only need to read: it is much shorter than JSON.
- Performance: explain_query, database_health, suggest_indexes, test_index, get_slow_queries.
- compare_databases tells what a database lacks compared to another (e.g. a local dev copy behind prod).
- The user may mask personal data of a database: values come partly starred (****234@email.fr) or as fakes (Camille Martin, camille.martin.3f2a@example.com, XXXX…, NULL; numbers and dates with noise or rounded) and results say masked_columns. Work with them; never try to recover the real values. A result the user blocked must not be asked again.`;

/** Added when MongoDB is on in bbdump (unless the AI's access to it is turned off) */
const MONGO_INSTRUCTIONS = `
- MongoDB databases appear in list_connections with engine "mongodb". After use_connection on one, use the mongo_* tools (mongo_list_collections, mongo_describe_collection, mongo_find, mongo_count, mongo_aggregate; mongo_insert_documents, mongo_update_documents, mongo_delete_documents, confirmed in bbdump with an undo point that list_changes / undo_change use); the other tools are for PostgreSQL. Filters and pipelines are Extended JSON ({"$oid": …}, {"$date": …}).`;

/** Added with the MongoDB ones: MySQL, MariaDB, SQLite and DuckDB databases */
const SQL_INSTRUCTIONS = `
- MySQL, MariaDB, SQLite and DuckDB databases appear in list_connections with their engine. After use_connection on one, use the sql_* tools (sql_schema_overview, sql_list_tables, sql_describe_table, sql_query read-only with ? params, sql_explain; sql_insert_rows, sql_update_rows, sql_delete_rows with an undo point, sql_execute for any other change, all confirmed in bbdump); the other tools are for PostgreSQL. Write the SQL of that engine: MySQL / MariaDB quote names with \`backticks\`, SQLite and DuckDB with "double quotes"; dates are DATETIME / TEXT columns (SQLite: date(), strftime(); DuckDB: date_trunc(), strftime()). DuckDB databases are read-only here.`;

export function createServer(): McpServer {
  // The mongo_* tools are offered unless turned off in bbdump when the server starts (each call checks again)
  const mongo = mongoToolsEnabled();
  const base = mongo ? INSTRUCTIONS + MONGO_INSTRUCTIONS + SQL_INSTRUCTIONS : INSTRUCTIONS;
  const chatEngine = chatScope.databaseId ? savedEngine(chatScope.databaseId) : null;
  const chatTools = mongo && chatEngine === 'mongodb' ? ' It is a MongoDB database: use the mongo_* tools only.'
    : mongo && isSqlEngine(chatEngine ?? undefined) ? ` It is a ${chatEngine === 'sqlite' ? 'SQLite' : chatEngine === 'duckdb' ? 'DuckDB' : chatEngine === 'mariadb' ? 'MariaDB' : 'MySQL'} database: use the sql_* tools only.${chatEngine === 'duckdb' ? ' It can only be read here.' : ''}` : '';
  const instructions = chatScope.databaseId
    ? `${base}\n- This session is a chat opened in bbdump on one database: it is already the active connection${chatScope.readOnly ? ', and only reading is possible' : ''}.${chatTools}`
    : base;
  const server = new McpServer({ name: 'bbdump-postgres', version: SERVER_VERSION }, { instructions });

  // A read-only chat: the tools that change something are not even offered
  if (chatScope.readOnly) {
    const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (name: unknown, config: unknown, ...rest: unknown[]) =>
      (toolAllowed(String(name), (config as { annotations?: { readOnlyHint?: boolean } })?.annotations) ? register(name, config, ...rest) : undefined);
  }

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
  if (mongo) registerMongoTools(server);
  if (mongo && mongoToolsEnabled('mcp.write')) registerMongoWriteTools(server);
  if (mongo) registerSqlTools(server);
  if (mongo && mongoToolsEnabled('mcp.write')) registerSqlWriteTools(server);
  registerPrompts(server);

  return server;
}

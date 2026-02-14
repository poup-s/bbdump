import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDatabaseTools } from './tools/databases.js';
import { registerTableTools } from './tools/tables.js';
import { registerDataTools } from './tools/data.js';
import { registerQueryTools } from './tools/query.js';
import { registerSchemaTools } from './tools/schema.js';
import { registerExtraTools } from './tools/extras.js';
import { registerConnectionTools } from './tools/connections.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'mcp-postgres',
    version: '1.0.0',
  });

  registerConnectionTools(server);
  registerDatabaseTools(server);
  registerTableTools(server);
  registerDataTools(server);
  registerQueryTools(server);
  registerSchemaTools(server);
  registerExtraTools(server);

  return server;
}

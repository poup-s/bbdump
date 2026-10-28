#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { closeAll, setActiveConnection } from './db.js';
import { chatScope } from './chatScope.js';
import { findDatabase, getConnectionParams, getMongoTarget, savedEngine } from './connections.js';
import { useMongo } from './mongo/client.js';
import { reachThroughApp } from './tunnel.js';

/** A chat on one database: connected to it before the first call */
async function connectChatDatabase(): Promise<void> {
  if (!chatScope.databaseId) return;
  try {
    // MongoDB: only while the AI may read it (otherwise the database is not offered at all)
    if (savedEngine(chatScope.databaseId) === 'mongodb') {
      const mongo = getMongoTarget(chatScope.databaseId);
      if (!mongo) throw new Error('saved database not found');
      await useMongo(mongo.id, mongo.label, mongo.target, mongo.sshDatabaseId);
      return;
    }
    const params = getConnectionParams(chatScope.databaseId);
    if (!params) throw new Error('saved database not found');
    const saved = findDatabase(chatScope.databaseId);
    setActiveConnection(await reachThroughApp(params), saved?.displayName || saved?.name || chatScope.databaseId);
  } catch (err) {
    console.error(`Chat database not connected: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  await connectChatDatabase();
  const server = createServer();
  const transport = new StdioServerTransport();

  // Graceful shutdown
  const shutdown = async () => {
    console.error('Shutting down MCP server...');
    await closeAll();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(transport);
  console.error('MCP PostgreSQL server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

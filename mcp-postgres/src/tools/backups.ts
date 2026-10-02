/** Backups made by the bbdump app: list them, take one before a risky change */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appApi } from '../confirm.js';
import { findDatabase, isBbdumpConfigured } from '../connections.js';
import { getActiveConnectionInfo } from '../db.js';
import { jsonResult, errorResult } from '../types.js';
import { READ, LOCAL } from './common.js';

interface BackupEntry {
  filename: string;
  databaseId: string;
  database?: string;
  size: number;
  created: string;
  encrypted: boolean;
}

const human = (bytes: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
};

/** The connection a backup tool works on: the one named, else the active one (by bbdump name) */
function targetDatabase(connection?: string) {
  const name = connection || getActiveConnectionInfo().label;
  if (!name) return null;
  return findDatabase(name);
}

export function registerBackupTools(server: McpServer) {
  server.registerTool(
    'list_backups',
    {
      title: 'List backups',
      description: 'Backups made by bbdump (every backup folder), newest first: file, size, date, encryption. For one connection (default: the active one) or all.',
      inputSchema: {
        connection: z.string().optional().describe('Connection id or name from list_connections (default: the active connection)'),
        all: z.boolean().default(false).describe('Backups of every connection'),
        limit: z.number().int().min(1).max(500).default(20).describe('Number of backups (default 20)'),
      },
      annotations: READ,
    },
    async ({ connection, all, limit }) => {
      if (!isBbdumpConfigured()) return errorResult('Backups need the bbdump app: reinstall this MCP server from bbdump Settings → MCP.');
      const db = all ? null : targetDatabase(connection);
      if (!all && !db) {
        return errorResult(connection ? `Connection "${connection}" not found in bbdump.` : 'No bbdump connection is active: pass connection, or all: true.');
      }
      try {
        const query = db ? `?database=${encodeURIComponent(db.id)}` : '';
        const result = await appApi<{ backups: BackupEntry[] }>('GET', `/backups${query}`);
        const backups = result.backups.slice(0, limit);
        return jsonResult({
          connection: db ? (db.displayName || db.name) : 'all',
          backups: backups.map(b => ({ ...b, size_human: human(b.size) })),
          count: backups.length,
          total: result.backups.length,
        });
      } catch (err: any) {
        return errorResult(err.message);
      }
    }
  );

  server.registerTool(
    'create_backup',
    {
      title: 'Back up now',
      description: 'Take a backup now with bbdump (pg_dump, read back to check it; encrypted if the connection is set so). Do it before a risky change: migration, large UPDATE/DELETE, DROP. Default: the active connection. Can take minutes on a large database.',
      inputSchema: {
        connection: z.string().optional().describe('Connection id or name from list_connections (default: the active connection)'),
      },
      annotations: LOCAL,
    },
    async ({ connection }) => {
      if (!isBbdumpConfigured()) return errorResult('Backups need the bbdump app: reinstall this MCP server from bbdump Settings → MCP.');
      const db = targetDatabase(connection);
      if (!db) {
        return errorResult(connection ? `Connection "${connection}" not found in bbdump.` : 'No bbdump connection is active: pass connection (see list_connections).');
      }
      try {
        const result = await appApi<{ success: boolean; error?: string; path?: string; size?: number; duration?: number }>(
          'POST', '/backup', { database: db.id }, 60 * 60 * 1000,
        );
        if (!result.success) return errorResult(`Backup of ${db.displayName || db.name} failed: ${result.error ?? 'unknown error'}`);
        return jsonResult({
          connection: db.displayName || db.name,
          file: result.path,
          ...(result.size !== undefined ? { size: human(result.size) } : {}),
          ...(result.duration !== undefined ? { duration_seconds: Math.round(result.duration / 100) / 10 } : {}),
          note: 'The backup appears in bbdump (Backups) and can be restored from there.',
        });
      } catch (err: any) {
        return errorResult(err.message);
      }
    }
  );
}

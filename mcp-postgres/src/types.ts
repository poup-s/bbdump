import * as os from 'os';

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** isError: the client (and the model) see a failed call, not a normal answer */
export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** OS user name, like libpq: Homebrew and bbdump's Linux setup create a role with this name */
function defaultUser(): string {
  try {
    return os.userInfo().username || 'postgres';
  } catch {
    return 'postgres';
  }
}

const intEnv = (value: string | undefined, fallback: number) => {
  const parsed = parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  host: process.env.PGHOST || 'localhost',
  port: intEnv(process.env.PGPORT, 5432),
  user: process.env.PGUSER || defaultUser(),
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 'postgres',
  statementTimeout: intEnv(process.env.MCP_STATEMENT_TIMEOUT, 60000),
  maxRows: intEnv(process.env.MCP_MAX_ROWS, 5000),
};

/** Longest statement timeout a tool call may ask for (10 minutes) */
export const MAX_TIMEOUT_MS = 600000;

/**
 * A chat opened in bbdump on one database runs this server with:
 * - BBDUMP_MCP_DATABASE=<saved database id>: connected to it from the start, and no other
 *   saved database or database of the server can be reached;
 * - BBDUMP_MCP_READ_ONLY=1: only the tools that read are registered;
 * - BBDUMP_MCP_CHAT_ID: the chat, where bbdump shows its questions instead of the tray.
 * Without them (AI assistants set up by the user), nothing changes.
 */
export const chatScope = {
  databaseId: process.env.BBDUMP_MCP_DATABASE || '',
  readOnly: process.env.BBDUMP_MCP_READ_ONLY === '1',
  /** The chat's id: bbdump asks its questions (what may reach the AI) in that chat */
  chatId: process.env.BBDUMP_MCP_CHAT_ID || '',
};

/** Tools kept in read-only mode besides the read ones: none change anything */
const READ_ONLY_EXTRA = new Set(['use_connection']);

/** Whether a tool is registered: every tool, or in read-only mode only those that read */
export function toolAllowed(name: string, annotations: { readOnlyHint?: boolean } | undefined, readOnly = chatScope.readOnly): boolean {
  return !readOnly || annotations?.readOnlyHint === true || READ_ONLY_EXTRA.has(name);
}

/** Whether a saved database id can be used: any, or only the chat's one */
export function databaseAllowed(id: string, scopedId = chatScope.databaseId): boolean {
  return !scopedId || id === scopedId;
}

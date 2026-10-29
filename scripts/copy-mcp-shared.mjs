#!/usr/bin/env node
// The MCP server (mcp-postgres/) compiles on its own: the pure helpers it shares with the app
// (src/shared/engines) are copied into mcp-postgres/src/shared before each build (gitignored).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'src', 'shared', 'engines');
const to = path.join(root, 'mcp-postgres', 'src', 'shared');
const FILES = ['mongoUri.ts', 'documents.ts', 'mysqlUri.ts', 'sqlGuard.ts', 'sqliteRunner.ts', 'sqlRows.ts', 'duckdbCli.ts'];

fs.mkdirSync(to, { recursive: true });
for (const file of FILES) {
  const source = fs.readFileSync(path.join(from, file), 'utf8');
  // Node's own modules only (node:…): another file of the app would be missing in the copy
  if (/^import .* from '(?!node:)/m.test(source)) throw new Error(`${file} imports other files: the MCP copy needs pure helpers`);
  fs.writeFileSync(path.join(to, file), `// Copied from src/shared/engines/${file} by scripts/copy-mcp-shared.mjs: edit that file instead.\n${source}`);
}

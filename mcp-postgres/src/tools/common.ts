/** Parameters and annotations shared by the tools */
import { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export const databaseParam = z.string().optional()
  .describe('Database on the active server (default: the active connection\'s database)');

export const schemaParam = z.string().optional()
  .describe('Schema (default: the connection\'s schema — e.g. Prisma ?schema= — else public)');

export const tableParam = z.string().describe('Table name (without schema; use the schema parameter)');

export const filterSchema = z.object({
  column: z.string().describe('Column name'),
  operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is_null', 'is_not_null', 'in', 'between'])
    .describe('Comparison operator'),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])
    .optional()
    .describe('Value to compare (not needed for is_null/is_not_null). Use array for in/between operators.'),
});

export const formatParam = z.enum(['json', 'markdown', 'csv']).default('json')
  .describe('Result format: json (default), markdown (compact table), csv');

/** Reads the database only */
export const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
/** Changes data or schema; always confirmed by the user in the bbdump app */
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
/** Changes state outside the data (active connection, query history, backups) */
export const LOCAL: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

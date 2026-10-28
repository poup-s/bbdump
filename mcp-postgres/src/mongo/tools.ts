/**
 * MongoDB tools (reading only): collections, sampled schema and indexes, find, count and
 * aggregate. Filters and pipelines are Extended JSON ({"$oid": …}, {"$date": …}); stages that
 * write ($out, $merge) and operators that run JavaScript on the server are refused.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorResult, jsonResult, textResult, type ToolResult } from '../types.js';
import { READ } from '../tools/common.js';
import { toMarkdown } from '../sql.js';
import { MAX_PAGE_SIZE, SAMPLE_SIZE, describeSample, documentColumns, formatDocumentValue, indexInfo, pipelineProblem, serverJavaScriptIn } from '../shared/documents.js';
import { COUNT_TIMEOUT_MS, QUERY_TIMEOUT_MS, activeMongo, keepReachable, mongoDb, mongoError } from './client.js';
import { mayRevealMasked, mongoRules, protectDocuments } from './masking.js';

/** Longest text a result sends back; documents past it are left out (and said so) */
const MAX_RESULT_CHARS = 150_000;
const MAX_SAMPLE = 1000;

type Doc = Record<string, unknown>;

const collectionParam = z.string().min(1).describe('Collection (or view) name, as listed by mongo_list_collections');
const jsonObject = z.union([z.string(), z.record(z.string(), z.any())]);
const formatParam = z.enum(['json', 'markdown']).default('json')
  .describe('json (default): documents as relaxed Extended JSON. markdown: a compact table of top-level fields');

/** A collection name (never an operator, never empty) */
export function collectionName(name: string): string {
  if (!name || name.includes('\0') || name.startsWith('$') || name.startsWith('system.')) throw new Error(`Invalid collection name: ${name}`);
  return name;
}

/**
 * A filter, projection or sort given as an object or a JSON string, read as Extended JSON
 * (ObjectId, dates, decimals). Server-side JavaScript is refused.
 */
export async function readJsonObject(value: unknown, what: string): Promise<Doc> {
  if (value === undefined || value === null || value === '') return {};
  let plain: unknown = value;
  if (typeof value === 'string') {
    try {
      plain = JSON.parse(value);
    } catch (err) {
      throw new Error(`The ${what} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!plain || typeof plain !== 'object' || Array.isArray(plain)) throw new Error(`The ${what} must be a JSON object`);
  const javascript = serverJavaScriptIn(plain);
  if (javascript) throw new Error(`${javascript} runs JavaScript on the server: not allowed`);
  const { BSON } = await import('mongodb');
  return BSON.EJSON.parse(JSON.stringify(plain), { relaxed: false }) as Doc;
}

/** A pipeline given as an array or a JSON string; refused when it writes or runs JavaScript */
export async function readPipeline(value: unknown): Promise<Doc[]> {
  let plain: unknown = value;
  if (typeof value === 'string') {
    try {
      plain = JSON.parse(value);
    } catch (err) {
      throw new Error(`The pipeline is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const problem = pipelineProblem(plain);
  if (problem) throw new Error(problem);
  const { BSON } = await import('mongodb');
  return BSON.EJSON.parse(JSON.stringify(plain), { relaxed: false }) as Doc[];
}

/** Documents as relaxed Extended JSON, as many as fit in a result */
export function fitDocuments(documents: Doc[], maxChars = MAX_RESULT_CHARS): { documents: Doc[]; left_out: number } {
  let kept = documents;
  while (kept.length > 1 && JSON.stringify(kept).length > maxChars) kept = kept.slice(0, Math.ceil(kept.length * 0.8));
  return { documents: kept, left_out: documents.length - kept.length };
}

function documentsResult(documents: Doc[], format: 'json' | 'markdown', info: Doc): ToolResult {
  const fitted = fitDocuments(documents);
  const note = fitted.left_out ? { left_out: fitted.left_out, note: `${fitted.left_out} documents left out: the result was too long. Ask for fewer fields (projection) or fewer documents.` } : {};
  if (format === 'markdown') {
    const columns = documentColumns(fitted.documents);
    const rows = fitted.documents.map((doc) => Object.fromEntries(columns.map((c) => [c, c in doc ? formatDocumentValue(doc[c]) : ''])));
    const header = Object.entries({ ...info, returned: fitted.documents.length, ...note }).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
    return textResult(`${header}\n\n${fitted.documents.length ? toMarkdown(columns, rows) : '(no documents)'}`);
  }
  return jsonResult({ ...info, returned: fitted.documents.length, ...note, documents: fitted.documents });
}

async function relaxed(documents: unknown[]): Promise<Doc[]> {
  const { BSON } = await import('mongodb');
  return BSON.EJSON.serialize(documents, { relaxed: true }) as Doc[];
}

/** The input as given (object or JSON text), to look at which fields it reads */
const plainOf = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/**
 * Documents for the AI with the personal fields chosen in bbdump masked. `reads`: the
 * projection or pipeline, which may carry chosen fields under other names; a view's
 * documents come from elsewhere, so they are treated the same way.
 */
async function shownDocuments(collection: string, documents: Doc[], format: 'json' | 'markdown', info: Doc, context: { tool: string; command: string; reads: unknown }): Promise<ToolResult> {
  const active = activeMongo();
  const rules = active ? mongoRules(active.id, active.database) : null;
  if (!active || !rules) return documentsResult(documents, format, info);
  const isView = async () => !!(await mongoDb().listCollections({ name: collection }, { nameOnly: false }).toArray()).find((c) => c.type === 'view');
  const reveal = mayRevealMasked(context.reads, collection, rules) || await isView();
  const shown = await protectDocuments(documents, { databaseId: active.id, database: active.database, label: active.label, collection, tool: context.tool, command: context.command, reveal });
  if (shown.blocked) return errorResult(shown.blocked);
  return documentsResult(shown.documents, format, { ...info, ...shown.note });
}

const limitOf = (value: number | undefined, fallback: number) => Math.min(Math.max(Math.trunc(value ?? fallback), 1), MAX_PAGE_SIZE);

async function run(work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    await keepReachable();
    return await work();
  } catch (err) {
    return errorResult(mongoError(err));
  }
}

export function registerMongoTools(server: McpServer) {
  server.registerTool(
    'mongo_list_collections',
    {
      title: 'List MongoDB collections',
      description: 'MongoDB: collections and views of the active MongoDB database, with their estimated document counts. Call use_connection on a MongoDB database first.',
      inputSchema: {},
      annotations: READ,
    },
    () => run(async () => {
      const db = mongoDb();
      const listed = (await db.listCollections({}, { authorizedCollections: true }).toArray()).filter((c) => !c.name.startsWith('system.'));
      const collections = await Promise.all(listed.map(async (c) => ({
        name: c.name,
        type: c.type ?? 'collection',
        documents: c.type === 'view' ? null : await db.collection(c.name).estimatedDocumentCount({ maxTimeMS: COUNT_TIMEOUT_MS }).catch(() => null),
      })));
      collections.sort((a, b) => a.name.localeCompare(b.name));
      return jsonResult({ database: activeMongo()?.database, collections, count: collections.length });
    }),
  );

  server.registerTool(
    'mongo_describe_collection',
    {
      title: 'Describe a MongoDB collection',
      description: 'MongoDB: the fields of a collection, read from a random sample (path, share of documents that have it, types; nested fields as a.b and array items as a[].b), its indexes and its estimated size. Start here before writing a filter or a pipeline.',
      inputSchema: {
        collection: collectionParam,
        sample_size: z.number().int().min(1).max(MAX_SAMPLE).optional().describe(`Documents sampled (default ${SAMPLE_SIZE}, max ${MAX_SAMPLE})`),
      },
      annotations: READ,
    },
    ({ collection, sample_size }) => run(async () => {
      const name = collectionName(collection);
      const coll = mongoDb().collection(name);
      const total = await coll.estimatedDocumentCount({ maxTimeMS: COUNT_TIMEOUT_MS }).catch(() => null);
      const sample = await coll.aggregate([{ $sample: { size: sample_size ?? SAMPLE_SIZE } }], { maxTimeMS: QUERY_TIMEOUT_MS }).toArray();
      const indexes = await coll.indexes().catch(() => []);
      return jsonResult({
        collection: name,
        estimated_documents: total,
        sampled: sample.length,
        fields: describeSample(await relaxed(sample)),
        indexes: indexes.map((index) => indexInfo(index as Doc)),
      });
    }),
  );

  server.registerTool(
    'mongo_find',
    {
      title: 'Find MongoDB documents',
      description: 'MongoDB: documents of a collection matching a filter, with optional projection, sort and paging. Filter in MongoDB query syntax as Extended JSON, e.g. {"city": "Paris", "total": {"$gte": 100}, "createdAt": {"$gte": {"$date": "2026-01-01T00:00:00Z"}}, "_id": {"$oid": "…"}}. $where and other server JavaScript are refused.',
      inputSchema: {
        collection: collectionParam,
        filter: jsonObject.optional().describe('Query filter (object or JSON string); empty: every document'),
        projection: jsonObject.optional().describe('Fields to return, e.g. {"name": 1, "email": 1} or {"items": 0}'),
        sort: jsonObject.optional().describe('Sort, e.g. {"createdAt": -1}'),
        limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe(`Documents to return (default 20, max ${MAX_PAGE_SIZE})`),
        skip: z.number().int().min(0).optional().describe('Documents to skip (paging)'),
        format: formatParam,
      },
      annotations: READ,
    },
    ({ collection, filter, projection, sort, limit, skip, format }) => run(async () => {
      const name = collectionName(collection);
      const query = await readJsonObject(filter, 'filter');
      const fields = await readJsonObject(projection, 'projection');
      const order = await readJsonObject(sort, 'sort');
      const size = limitOf(limit, 20);
      const found = await mongoDb().collection(name).find(query, {
        projection: Object.keys(fields).length ? fields : undefined,
        sort: Object.keys(order).length ? order as Record<string, 1 | -1> : undefined,
        skip: skip ?? 0,
        limit: size + 1,
        maxTimeMS: QUERY_TIMEOUT_MS,
      }).toArray();
      return shownDocuments(name, await relaxed(found.slice(0, size)), format, {
        collection: name,
        skip: skip ?? 0,
        has_more: found.length > size,
      }, { tool: 'mongo_find', command: `db.${name}.find(${JSON.stringify(plainOf(filter) ?? {})}, ${JSON.stringify(plainOf(projection) ?? {})})`, reads: plainOf(projection) });
    }),
  );

  server.registerTool(
    'mongo_count',
    {
      title: 'Count MongoDB documents',
      description: 'MongoDB: how many documents of a collection match a filter (Extended JSON, as mongo_find). Without a filter, the collection\'s estimated count.',
      inputSchema: {
        collection: collectionParam,
        filter: jsonObject.optional().describe('Query filter (object or JSON string)'),
      },
      annotations: READ,
    },
    ({ collection, filter }) => run(async () => {
      const name = collectionName(collection);
      const query = await readJsonObject(filter, 'filter');
      const coll = mongoDb().collection(name);
      if (Object.keys(query).length === 0) {
        return jsonResult({ collection: name, count: await coll.estimatedDocumentCount({ maxTimeMS: COUNT_TIMEOUT_MS }), estimate: true });
      }
      return jsonResult({ collection: name, count: await coll.countDocuments(query, { maxTimeMS: QUERY_TIMEOUT_MS }), estimate: false });
    }),
  );

  server.registerTool(
    'mongo_aggregate',
    {
      title: 'Run a MongoDB aggregation',
      description: 'MongoDB: runs an aggregation pipeline on a collection and returns its results, e.g. [{"$match": {"status": "paid"}}, {"$group": {"_id": "$city", "total": {"$sum": "$total"}}}, {"$sort": {"total": -1}}]. Read only: $out and $merge are refused, as are $where, $function and $accumulator. Results are capped (limit).',
      inputSchema: {
        collection: collectionParam,
        pipeline: z.union([z.string(), z.array(z.record(z.string(), z.any()))]).describe('Pipeline stages (array or JSON string), Extended JSON'),
        limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe(`Results to return (default 50, max ${MAX_PAGE_SIZE})`),
        format: formatParam,
      },
      annotations: READ,
    },
    ({ collection, pipeline, limit, format }) => run(async () => {
      const name = collectionName(collection);
      const stages = await readPipeline(pipeline);
      const size = limitOf(limit, 50);
      const found = await mongoDb().collection(name)
        .aggregate([...stages, { $limit: size + 1 }], { maxTimeMS: QUERY_TIMEOUT_MS, allowDiskUse: false })
        .toArray();
      return shownDocuments(name, await relaxed(found.slice(0, size)), format, {
        collection: name,
        stages: stages.length,
        has_more: found.length > size,
      }, { tool: 'mongo_aggregate', command: `db.${name}.aggregate(${JSON.stringify(plainOf(pipeline))})`, reads: plainOf(pipeline) });
    }),
  );
}

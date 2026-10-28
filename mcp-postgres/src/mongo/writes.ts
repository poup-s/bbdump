/**
 * MongoDB changes: insert, update and delete documents. Each one is confirmed by the
 * user in bbdump first, and saves an undo point when it can: the documents before and after,
 * as canonical Extended JSON (every type comes back), in the same encrypted journal as the
 * PostgreSQL changes. The bbdump app undoes them (journal window, or undo_change).
 *
 * Without transactions (a standalone server has none), the documents are read first and the
 * change then only touches those: a document that starts matching in between is left alone.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Collection, Document } from 'mongodb';
import { errorResult, jsonResult, type ToolResult } from '../types.js';
import { WRITE } from '../tools/common.js';
import { requestConfirmation, refusalMessage } from '../confirm.js';
import { journalAvailable, writeEntry, type UndoTable } from '../journal.js';
import { currentClientName } from '../tools/mutations.js';
import { diffDocumentStates, updateProblem } from '../shared/documents.js';
import { QUERY_TIMEOUT_MS, activeMongo, keepReachable, mongoDb, mongoError } from './client.js';
import { collectionName, readJsonObject } from './tools.js';

/** Documents an undo point may hold, and their total size (canonical Extended JSON text) */
export const MAX_UNDO_DOCUMENTS = 5000;
export const MAX_UNDO_BYTES = 20 * 1024 * 1024;
const MAX_INSERT = 1000;
/** Ids sent back after a change */
const RETURNED_IDS = 50;

type Doc = Record<string, unknown>;

/** Documents as canonical Extended JSON text, the form undo points keep */
async function canonical(documents: Document[]): Promise<string[]> {
  const { BSON } = await import('mongodb');
  return documents.map((doc) => BSON.EJSON.stringify(doc, { relaxed: false }));
}

/** Readable command shown in the confirmation and the journal, e.g. db.orders.updateMany({…}, {…}) */
export function shellCommand(collection: string, method: string, args: unknown[]): string {
  const text = args.map((arg) => JSON.stringify(arg)).join(', ');
  const call = `db.${JSON.stringify(collection).slice(1, -1)}.${method}(${text})`;
  return call.length > 4000 ? `${call.slice(0, 4000)}…)` : call;
}

/** The documents a filter matches now, when an undo point can hold them; else why not */
async function capture(collection: Collection, filter: Doc): Promise<{ documents: Document[]; texts: string[] } | { reason: string; count: number }> {
  const count = await collection.countDocuments(filter, { limit: MAX_UNDO_DOCUMENTS + 1, maxTimeMS: QUERY_TIMEOUT_MS });
  if (count > MAX_UNDO_DOCUMENTS) return { reason: `more than ${MAX_UNDO_DOCUMENTS} documents`, count: await collection.countDocuments(filter, { maxTimeMS: QUERY_TIMEOUT_MS }) };
  const documents = await collection.find(filter, { maxTimeMS: QUERY_TIMEOUT_MS }).toArray();
  const texts = await canonical(documents);
  if (texts.reduce((n, t) => n + t.length, 0) > MAX_UNDO_BYTES) return { reason: 'the documents are too large to keep', count: documents.length };
  return { documents, texts };
}

const undoNote = (plan: { available: boolean; documents?: number; reason?: string }) => {
  if (!journalAvailable()) return ' · no undo point (MCP server not set up by bbdump)';
  return plan.available ? ` · undo point saved (${plan.documents} document(s))` : ` · NO undo point: ${plan.reason}`;
};

const idKey = (text: string) => JSON.stringify(JSON.parse(text)._id);

/** Records the change; returns what the tool answers about its undo */
function journal(params: { tool: string; collection: string; command: string; description: string; affected: number; tables: UndoTable[] | null; reason?: string }) {
  const active = activeMongo();
  if (!active) return {};
  const table = params.tables?.[0];
  const documents = table ? new Set([...table.before, ...table.after].map(idKey)).size : 0;
  const available = !!table && documents > 0;
  const id = writeEntry({
    engine: 'mongodb',
    client: currentClientName(),
    tool: params.tool,
    databaseId: active.id,
    connection: { label: active.label, host: active.hosts, port: active.port, database: active.database, user: active.user },
    sql: params.command,
    description: params.description,
    rowsAffected: params.affected,
    undo: {
      available,
      reason: available ? undefined : (params.reason ?? (table ? 'nothing changed' : 'not captured')),
      rows: documents,
      tables: [`${active.database}.${params.collection}`],
    },
  }, available ? params.tables : null);
  if (!id) return {};
  return {
    change_id: id,
    undo: available
      ? `Undo point saved: undo_change "${id}" (or the bbdump AI journal) restores the ${documents} document(s) touched.`
      : `No undo point: ${params.reason ?? 'nothing changed'}.`,
  };
}

const undoTable = (collection: string, before: string[], after: string[]): UndoTable[] =>
  [{ schema: activeMongo()?.database ?? '', table: collection, primaryKey: ['_id'], before, after }];

async function confirm(tool: string, collection: string, command: string, description: string): Promise<ToolResult | null> {
  const outcome = await requestConfirmation({ tool, engine: 'mongodb', database: activeMongo()?.label ?? '', table: collection, sql: command, description });
  return outcome.approved ? null : errorResult(refusalMessage(outcome));
}

async function relaxedIds(documents: Document[]): Promise<unknown[]> {
  const { BSON } = await import('mongodb');
  return documents.slice(0, RETURNED_IDS).map((doc) => BSON.EJSON.serialize(doc._id, { relaxed: true }));
}

/** A filter that must not match everything by accident */
async function targetFilter(filter: unknown, all: boolean | undefined): Promise<Doc> {
  const query = await readJsonObject(filter, 'filter');
  if (Object.keys(query).length === 0 && !all) {
    throw new Error('An empty filter matches every document: pass all_documents: true if that is what the user wants.');
  }
  return query;
}

/** The input as the user gave it, for the command shown */
const asGiven = (value: unknown) => {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

async function run(work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    await keepReachable();
    return await work();
  } catch (err) {
    return errorResult(mongoError(err));
  }
}

const jsonObject = z.union([z.string(), z.record(z.string(), z.any())]);

export function registerMongoWriteTools(server: McpServer) {
  server.registerTool(
    'mongo_insert_documents',
    {
      title: 'Insert MongoDB documents',
      description: `MongoDB: insert documents into a collection (Extended JSON: {"$oid": …}, {"$date": …}). A document without _id gets an ObjectId. Confirmed by the user in bbdump; an undo point is saved.`,
      inputSchema: {
        collection: z.string().min(1).describe('Collection name'),
        documents: z.union([z.string(), z.array(z.record(z.string(), z.any())).min(1).max(MAX_INSERT)])
          .describe(`Documents to insert (array or JSON string, at most ${MAX_INSERT})`),
      },
      annotations: WRITE,
    },
    ({ collection, documents }) => run(async () => {
      const name = collectionName(collection);
      const db = mongoDb('mcp.write');
      const { BSON, ObjectId } = await import('mongodb');
      const plain = asGiven(documents);
      if (!Array.isArray(plain) || plain.length === 0 || plain.some((d) => !d || typeof d !== 'object' || Array.isArray(d))) {
        throw new Error('documents must be a non-empty array of objects (valid JSON)');
      }
      if (plain.length > MAX_INSERT) throw new Error(`At most ${MAX_INSERT} documents per call: split them`);
      const docs = BSON.EJSON.parse(JSON.stringify(plain), { relaxed: false }) as Document[];
      // Known ids: the undo point and a partial failure both need them
      for (const doc of docs) if (doc._id === undefined) doc._id = new ObjectId();

      const description = `INSERT ${docs.length} document(s) into ${activeMongo()?.database}.${name}`;
      // The user sees the documents; the journal (stored in clear) only their number, like insert_rows' parameters
      const shown = shellCommand(name, 'insertMany', [plain]);
      const command = `db.${JSON.stringify(name).slice(1, -1)}.insertMany(/* ${docs.length} document(s) */)`;
      const refused = await confirm('mongo_insert_documents', name, shown, description + undoNote({ available: true, documents: docs.length }));
      if (refused) return refused;

      const coll = db.collection(name);
      const ids = docs.map((d) => d._id);
      // An _id already there is someone else's document (the insert fails on it): never in the undo point
      const already = new Set((await canonical(await coll.find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray())).map(idKey));
      let failure: unknown = null;
      try {
        await coll.insertMany(docs, { ordered: true });
      } catch (err) {
        failure = err;
      }
      // What is really there now (a failure part way leaves the first documents inserted)
      const found = await coll.find({ _id: { $in: ids } }).toArray();
      const texts = await canonical(found);
      const ours = found.filter((_, i) => !already.has(idKey(texts[i])));
      const oursTexts = texts.filter((t) => !already.has(idKey(t)));
      const tables = ours.length ? undoTable(name, [], oursTexts) : null;
      const journaled = journal({ tool: 'mongo_insert_documents', collection: name, command, description, affected: ours.length, tables });
      if (failure) {
        return errorResult(`${mongoError(failure)} — ${ours.length} of ${docs.length} document(s) inserted before the error${journaled.change_id ? `; undo_change "${journaled.change_id}" removes them` : ''}.`);
      }
      return jsonResult({ inserted: ours.length, collection: name, inserted_ids: await relaxedIds(ours), ...journaled });
    }),
  );

  server.registerTool(
    'mongo_update_documents',
    {
      title: 'Update MongoDB documents',
      description: `MongoDB: update every document matching a filter with update operators ({"$set": {…}}, {"$inc": {…}}, {"$unset": {…}}, {"$push": {…}}…) or an update pipeline. Whole-document replacement and server JavaScript are not offered. Confirmed by the user in bbdump; the documents are read first and an undo point is saved (up to ${MAX_UNDO_DOCUMENTS} documents).`,
      inputSchema: {
        collection: z.string().min(1).describe('Collection name'),
        filter: jsonObject.describe('Which documents (Extended JSON, as mongo_find)'),
        update: z.union([z.string(), z.record(z.string(), z.any()), z.array(z.record(z.string(), z.any()))])
          .describe('Update operators, e.g. {"$set": {"status": "paid"}}, or an update pipeline'),
        all_documents: z.boolean().optional().describe('Needed with an empty filter: update every document of the collection'),
      },
      annotations: WRITE,
    },
    ({ collection, filter, update, all_documents }) => run(async () => {
      const name = collectionName(collection);
      const db = mongoDb('mcp.write');
      const query = await targetFilter(filter, all_documents);
      let plainUpdate: unknown = update;
      if (typeof update === 'string') {
        try {
          plainUpdate = JSON.parse(update);
        } catch (err) {
          throw new Error(`The update is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const problem = updateProblem(plainUpdate);
      if (problem) throw new Error(problem);
      const { BSON } = await import('mongodb');
      const changes = BSON.EJSON.parse(JSON.stringify(plainUpdate), { relaxed: false }) as Document | Document[];

      const coll = db.collection(name);
      const captured = await capture(coll, query);
      const count = 'reason' in captured ? captured.count : captured.documents.length;
      if (count === 0) return jsonResult({ matched: 0, modified: 0, collection: name, note: 'No document matches this filter: nothing was changed.' });

      const description = `UPDATE ${count} document(s) in ${activeMongo()?.database}.${name}`;
      const command = shellCommand(name, 'updateMany', [asGiven(filter), plainUpdate]);
      const refused = await confirm('mongo_update_documents', name, command,
        description + undoNote('reason' in captured ? { available: false, reason: captured.reason } : { available: true, documents: count }));
      if (refused) return refused;

      if ('reason' in captured) {
        const result = await coll.updateMany(query, changes, { maxTimeMS: QUERY_TIMEOUT_MS });
        return jsonResult({ matched: result.matchedCount, modified: result.modifiedCount, collection: name,
          ...journal({ tool: 'mongo_update_documents', collection: name, command, description, affected: result.modifiedCount, tables: null, reason: captured.reason }) });
      }
      // Only the documents read: the undo point holds exactly what changes
      const ids = captured.documents.map((d) => d._id);
      const result = await coll.updateMany({ $and: [query, { _id: { $in: ids } }] }, changes, { maxTimeMS: QUERY_TIMEOUT_MS });
      const after = await canonical(await coll.find({ _id: { $in: ids } }).toArray());
      const diff = diffDocumentStates(captured.texts, after);
      return jsonResult({
        matched: result.matchedCount,
        modified: result.modifiedCount,
        collection: name,
        ...journal({ tool: 'mongo_update_documents', collection: name, command, description, affected: result.modifiedCount, tables: undoTable(name, diff.before, diff.after) }),
      });
    }),
  );

  server.registerTool(
    'mongo_delete_documents',
    {
      title: 'Delete MongoDB documents',
      description: `MongoDB: delete every document matching a filter (Extended JSON, as mongo_find). Confirmed by the user in bbdump; the documents are read first and an undo point is saved (up to ${MAX_UNDO_DOCUMENTS} documents).`,
      inputSchema: {
        collection: z.string().min(1).describe('Collection name'),
        filter: jsonObject.describe('Which documents'),
        all_documents: z.boolean().optional().describe('Needed with an empty filter: delete every document of the collection'),
      },
      annotations: WRITE,
    },
    ({ collection, filter, all_documents }) => run(async () => {
      const name = collectionName(collection);
      const db = mongoDb('mcp.write');
      const query = await targetFilter(filter, all_documents);
      const coll = db.collection(name);
      const captured = await capture(coll, query);
      const count = 'reason' in captured ? captured.count : captured.documents.length;
      if (count === 0) return jsonResult({ deleted: 0, collection: name, note: 'No document matches this filter: nothing was deleted.' });

      const description = `DELETE ${count} document(s) from ${activeMongo()?.database}.${name}`;
      const command = shellCommand(name, 'deleteMany', [asGiven(filter)]);
      const refused = await confirm('mongo_delete_documents', name, command,
        description + undoNote('reason' in captured ? { available: false, reason: captured.reason } : { available: true, documents: count }));
      if (refused) return refused;

      if ('reason' in captured) {
        const result = await coll.deleteMany(query, { maxTimeMS: QUERY_TIMEOUT_MS });
        return jsonResult({ deleted: result.deletedCount, collection: name,
          ...journal({ tool: 'mongo_delete_documents', collection: name, command, description, affected: result.deletedCount, tables: null, reason: captured.reason }) });
      }
      const ids = captured.documents.map((d) => d._id);
      const result = await coll.deleteMany({ $and: [query, { _id: { $in: ids } }] }, { maxTimeMS: QUERY_TIMEOUT_MS });
      // A document changed in between (no longer matching) was not deleted: not in the undo point either
      const left = new Set((await canonical(await coll.find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray())).map(idKey));
      const before = captured.texts.filter((t) => !left.has(idKey(t)));
      return jsonResult({
        deleted: result.deletedCount,
        collection: name,
        ...journal({ tool: 'mongo_delete_documents', collection: name, command, description, affected: result.deletedCount, tables: undoTable(name, before, []) }),
      });
    }),
  );
}

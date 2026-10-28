/**
 * Undo of the MongoDB changes made by AI clients (journal written by the MCP server). Each
 * collection keeps its documents before and after the change, as canonical Extended JSON
 * keyed by _id. Undoing first checks that those documents are still as the change left them
 * (else it refuses and shows which), then deletes the ones it inserted, puts back the ones it
 * deleted and reverts the ones it updated. There is no transaction across documents (a
 * standalone server has none): the check runs right before, and each write is guarded.
 */
import type { Document, Filter, MongoClient } from 'mongodb';
import { withSavedMongo } from './engines/mongodb';
import { documentKey, documentUndoCounts, formatDocumentValue } from '../shared/engines/documents';
import type { UndoConflict, UndoTable } from './aiJournal';

type Doc = Record<string, unknown>;
/** _id may be of any BSON type: not only ObjectId */
const byIds = (ids: unknown[]) => ({ _id: { $in: ids } }) as Filter<Document>;
const byId = (id: unknown) => ({ _id: id }) as Filter<Document>;

async function bson() {
    return (await import('mongodb')).BSON;
}

/** Current documents of these _ids, as canonical text, by key */
async function currentDocuments(client: MongoClient, database: string, t: UndoTable): Promise<Map<string, string>> {
    const { EJSON } = await bson();
    const ids = [...t.before, ...t.after].map(text => (EJSON.parse(text, { relaxed: false }) as Doc)._id);
    const found = await client.db(database).collection(t.table).find(byIds(ids)).toArray();
    return new Map(found.map(doc => {
        const text = EJSON.stringify(doc, { relaxed: false });
        return [documentKey(text), text];
    }));
}

/** A document for the journal window: top-level values short and readable */
async function shown(text: string): Promise<Doc> {
    const { EJSON } = await bson();
    const relaxed = EJSON.serialize(EJSON.parse(text, { relaxed: false }), { relaxed: true }) as Doc;
    return Object.fromEntries(Object.entries(relaxed).map(([key, value]) => [key, formatDocumentValue(value)]));
}

/** Documents that are no longer as the change left them */
async function findConflicts(client: MongoClient, database: string, tables: UndoTable[]): Promise<UndoConflict[]> {
    const conflicts: UndoConflict[] = [];
    for (const t of tables) {
        const now = await currentDocuments(client, database, t);
        const afterKeys = new Set(t.after.map(documentKey));
        for (const text of t.after) {
            const current = now.get(documentKey(text));
            if (current === undefined) conflicts.push({ table: `${database}.${t.table}`, kind: 'missing', row: await shown(text) });
            else if (current !== text) conflicts.push({ table: `${database}.${t.table}`, kind: 'changed', row: await shown(current) });
        }
        for (const text of t.before) {
            const key = documentKey(text);
            const current = now.get(key);
            if (!afterKeys.has(key) && current !== undefined) conflicts.push({ table: `${database}.${t.table}`, kind: 'reappeared', row: await shown(current) });
        }
        if (conflicts.length >= 20) break;
    }
    return conflicts.slice(0, 20);
}

/** What undoing does, per collection, and the documents changed since */
export async function previewMongoUndo(databaseId: string, tables: UndoTable[]) {
    return withSavedMongo(databaseId, async (client, database) => {
        const counts = [];
        for (const t of tables) {
            counts.push({
                table: `${database}.${t.table}`,
                primaryKey: ['_id'],
                ...documentUndoCounts(t.before, t.after),
                before: await Promise.all(t.before.slice(0, 20).map(shown)),
                after: await Promise.all(t.after.slice(0, 20).map(shown)),
            });
        }
        return { tables: counts, conflicts: await findConflicts(client, database, tables) };
    });
}

/** Undoes the change, or returns the conflicts that stop it */
export async function undoMongoChange(databaseId: string, tables: UndoTable[]): Promise<{ conflicts?: UndoConflict[]; restored?: Record<string, { deleted: number; restored: number; reverted: number }> }> {
    const { EJSON } = await bson();
    return withSavedMongo(databaseId, async (client, database) => {
        const conflicts = await findConflicts(client, database, tables);
        if (conflicts.length) return { conflicts };
        const restored: Record<string, { deleted: number; restored: number; reverted: number }> = {};
        for (const t of tables) {
            const collection = client.db(database).collection(t.table);
            const beforeKeys = new Set(t.before.map(documentKey));
            const afterKeys = new Set(t.after.map(documentKey));
            const stat = (restored[`${database}.${t.table}`] = { deleted: 0, restored: 0, reverted: 0 });
            // Inserted by the change: gone (checked unchanged just above)
            for (const text of t.after.filter(x => !beforeKeys.has(documentKey(x)))) {
                const { _id } = EJSON.parse(text, { relaxed: false }) as Doc;
                stat.deleted += (await collection.deleteOne(byId(_id))).deletedCount;
            }
            // Deleted by the change: back
            const back = t.before.filter(x => !afterKeys.has(documentKey(x))).map(x => EJSON.parse(x, { relaxed: false }) as Doc);
            if (back.length) stat.restored += (await collection.insertMany(back, { ordered: true })).insertedCount;
            // Updated by the change: previous version back
            for (const text of t.before.filter(x => afterKeys.has(documentKey(x)))) {
                const previous = EJSON.parse(text, { relaxed: false }) as Doc;
                stat.reverted += (await collection.replaceOne(byId(previous._id), previous)).modifiedCount;
            }
        }
        return { restored };
    });
}

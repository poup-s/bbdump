/**
 * Personal data of MongoDB databases hidden from the AI. The fields chosen in bbdump
 * (ai-masking.json: table "<database>.<collection>", column = a sampled path such as
 * customer.email or items[].sku) are replaced in every document before it leaves, with the
 * same fakes as PostgreSQL. A result that may carry a chosen field under another name (an
 * aggregation or a projection that reads it, a view) is shown to the user in bbdump first,
 * who chooses what is anonymized, or blocks it.
 */
import { appApi } from '../confirm.js';
import { chatScope } from '../chatScope.js';
import { fakeValue, readMaskingFile, type MaskKind } from '../masking.js';
import { fieldReferences, referenceReaches, replaceAtPath } from '../shared/documents.js';

type Doc = Record<string, unknown>;
export interface FieldRule { path: string; kind: MaskKind }

const KINDS: MaskKind[] = ['partial', 'email', 'phone', 'name', 'first_name', 'last_name', 'address', 'city', 'ip', 'secret', 'noise', 'month', 'year', 'null'];

/** Rules of one saved MongoDB database, by collection; null when masking is off for it */
export function mongoRulesFromFile(content: unknown, databaseId: string, database: string): Map<string, FieldRule[]> | null {
  const entry = (content as { databases?: Record<string, { enabled?: boolean; columns?: Array<{ table?: unknown; column?: unknown; kind?: unknown }> }> } | null)?.databases?.[databaseId];
  if (entry?.enabled !== true) return null;
  const rules = new Map<string, FieldRule[]>();
  const prefix = `${database}.`;
  for (const c of entry.columns ?? []) {
    if (typeof c?.table !== 'string' || typeof c.column !== 'string' || !KINDS.includes(c.kind as MaskKind) || !c.table.startsWith(prefix)) continue;
    const collection = c.table.slice(prefix.length);
    rules.set(collection, [...(rules.get(collection) ?? []), { path: c.column, kind: c.kind as MaskKind }]);
  }
  return rules;
}

export function mongoRules(databaseId: string, database: string): Map<string, FieldRule[]> | null {
  return mongoRulesFromFile(readMaskingFile(), databaseId, database);
}

/** The fake for a relaxed Extended JSON value: dates, longs and decimals read as their value */
export function fakeDocumentValue(value: unknown, kind: MaskKind): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const inner = (value as Doc)[keys[0]];
    if (keys.length === 1 && keys[0] === '$date') {
      const iso = typeof inner === 'string' ? inner : new Date(Number((inner as Doc)?.$numberLong ?? NaN)).toISOString();
      return fakeValue(iso, kind);
    }
    if (keys.length === 1 && ['$numberLong', '$numberDecimal', '$numberDouble', '$numberInt', '$oid'].includes(keys[0])) return fakeValue(String(inner), kind);
  }
  return fakeValue(value, kind);
}

/** Documents with the collection's chosen fields replaced, and the fields that were */
export function maskDocuments(documents: Doc[], rules: FieldRule[]): { documents: Doc[]; masked: string[] } {
  if (!rules.length) return { documents, masked: [] };
  return {
    documents: documents.map((doc) => rules.reduce((out, rule) => replaceAtPath(out, rule.path, (v) => fakeDocumentValue(v, rule.kind)), doc)),
    masked: rules.map((r) => r.path),
  };
}

/**
 * Whether a pipeline (or a projection) may carry chosen fields out under other names: it
 * references one (or a parent, or $$ROOT), or reads another collection that has some.
 */
export function mayRevealMasked(stages: unknown, collection: string, rules: Map<string, FieldRule[]>): boolean {
  const own = rules.get(collection) ?? [];
  const refs = fieldReferences(stages);
  if ([...refs].some((ref) => ref.startsWith('$$') || own.some((rule) => referenceReaches(ref, rule.path)))) return true;
  const other = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    for (const [key, inner] of Object.entries(value)) {
      if ((key === '$lookup' || key === '$graphLookup') && typeof (inner as Doc)?.from === 'string') other.add((inner as Doc).from as string);
      if (key === '$unionWith') other.add(typeof inner === 'string' ? inner : String((inner as Doc)?.coll ?? ''));
      walk(inner);
    }
  };
  walk(stages);
  return [...other].some((name) => (rules.get(name)?.length ?? 0) > 0);
}

const NOTE = 'Some values were masked by the user in bbdump (partly starred such as ****234@email.fr, realistic fakes such as Camille Martin or camille.martin.3f2a@example.com, XXXX…, null, numbers with ±10 % noise, dates moved by up to 30 days or rounded to the month or year). Work with them as they are: never try to find the real values.';

export interface ProtectedDocuments {
  documents: Doc[];
  blocked?: string;
  note: Doc;
}

/** A value that cannot carry personal data: a number, a boolean or an ObjectId */
const isClearValue = (v: unknown) => typeof v === 'number' || typeof v === 'boolean'
  || (!!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && '$oid' in v);

/** A value of unknown origin made safe: its text parts partly starred, its shape kept */
export function maskLeaves(value: unknown): unknown {
  if (value === null || value === undefined || isClearValue(value)) return value;
  if (Array.isArray(value)) return value.map(maskLeaves);
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    // Extended JSON wrappers ($date, $numberDecimal…) are one value
    if (keys.length === 1 && keys[0].startsWith('$')) return fakeDocumentValue(value, 'partial');
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskLeaves(v)]));
  }
  return fakeDocumentValue(value, 'partial');
}

const text = (v: unknown) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)).slice(0, 60);
const valuesOf = (docs: Doc[], name: string) => docs.map((d) => d[name]).filter((v) => v !== null && v !== undefined);

/**
 * Documents ready for the AI. Masking off: unchanged. Chosen fields are replaced; when the
 * result may carry them under other names (`reveal`), its top-level fields holding text are
 * shown to the user in bbdump, who chooses (no answer: they are all anonymized).
 */
export async function protectDocuments(
  documents: Doc[],
  context: { databaseId: string; database: string; label: string; collection: string; tool: string; command: string; reveal: boolean },
): Promise<ProtectedDocuments> {
  const rules = mongoRules(context.databaseId, context.database);
  if (!rules) return { documents, note: {} };
  const own = rules.get(context.collection) ?? [];
  const byPath = maskDocuments(documents, own);
  let out = byPath.documents;
  const masked = new Set(byPath.masked);

  if (context.reveal && out.length) {
    const names = [...new Set(out.flatMap((d) => Object.keys(d)))];
    const ruleOf = (name: string) => own.find((r) => r.path === name || r.path.startsWith(`${name}.`) || r.path.startsWith(`${name}[]`));
    const origins = names.map((name) => {
      const values = valuesOf(out, name);
      const rule = ruleOf(name);
      // _id too: an aggregation groups by any field (_id: "$customer.email")
      const origin = rule ? 'rule' as const : values.some((v) => !isClearValue(v)) ? 'unknown' as const : 'clear' as const;
      return { name, origin, source: rule ? `${context.collection}.${rule.path}` : undefined };
    });
    const unknown = origins.filter((o) => o.origin === 'unknown').map((o) => o.name);
    let toMask = new Set(unknown);
    if (unknown.length) {
      try {
        const answer = await appApi<{ approved?: boolean; mask?: unknown }>('POST', '/disclose', {
          tool: context.tool,
          ...(chatScope.chatId ? { chatId: chatScope.chatId } : {}),
          engine: 'mongodb',
          database: context.label,
          sql: context.command.slice(0, 2000),
          rows: out.length,
          columns: origins.map((o) => ({
            name: o.name, origin: o.origin, source: o.source,
            samples: valuesOf(documents, o.name).slice(0, 3).map(text),
            anonymized: valuesOf(out, o.name).slice(0, 3).map((v) => text(o.origin === 'rule' ? v : maskLeaves(v))),
          })),
        }, 65000);
        if (answer?.approved !== true) {
          return { documents: [], blocked: 'The user blocked this result in bbdump: it may contain personal data. Do not retry the same request; ask the user, or read the collection with mongo_find (its personal fields come masked).', note: {} };
        }
        if (Array.isArray(answer.mask)) toMask = new Set(answer.mask.filter((m): m is string => typeof m === 'string' && unknown.includes(m)));
      } catch {
        // bbdump not answering: the safe default (every field of unknown origin anonymized)
      }
    }
    if (toMask.size) {
      out = out.map((doc) => Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, toMask.has(k) ? maskLeaves(v) : v])));
      for (const name of toMask) masked.add(name);
    }
  }
  return { documents: out, note: masked.size ? { masked_fields: [...masked], masking: NOTE } : {} };
}

/**
 * Schema differences between a source database (e.g. prod) and a target (local copy),
 * as changes to apply to the target. Additions are selected by default; anything that
 * removes or rewrites something in the target is destructive and never selected by
 * default. Pure: catalogs in, changes out.
 */
import format from 'pg-format';
import type { Catalog, CatalogColumn, CatalogTable } from './catalog';

export type ChangeKind =
  | 'extension' | 'schema' | 'enum' | 'enum_value' | 'table' | 'column' | 'column_default'
  | 'column_nullable' | 'column_type' | 'drop_column' | 'constraint' | 'foreign_key'
  | 'index' | 'function' | 'view' | 'trigger' | 'local_only_table';

export interface SchemaChange {
  id: string;
  kind: ChangeKind;
  /** schema.object (or object.column) the change is about */
  object: string;
  sql: string[];
  destructive: boolean;
  defaultSelected: boolean;
  /** Apply order; enum values go in their own transaction (phase 2) */
  phase: number;
  /** Why it is not selected, or what may make it fail (English, for logs) */
  note?: string;
  /** The same note for the UI to translate (sync.notes.<code>), with its values */
  noteCode?: 'needs_extension' | 'added_nullable' | 'type_change' | 'fails_on_null' | 'data_lost' | 'must_satisfy' | 'local_only' | 'replaces_local';
  noteParams?: Record<string, string>;
}

export const PHASE = { extension: 0, schema: 1, enum: 2, table: 3, function: 4, constraint: 5, index: 6, foreignKey: 7, view: 8, trigger: 9, drop: 10 } as const;

const ident = (schema: string, name: string) => format('%I.%I', schema, name);

/** Sequence a column default uses (nextval('x'::regclass)), as pg_get_expr wrote it */
export function defaultSequence(def: string | null): string | null {
  const match = def ? /nextval\('((?:[^']|'')+)'::regclass\)/.exec(def) : null;
  return match ? match[1].replace(/''/g, "'") : null;
}

/** A column as written in CREATE TABLE / ADD COLUMN */
export function columnDefinition(col: CatalogColumn, withNotNull = true): string {
  let sql = `${format('%I', col.name)} ${col.type}`;
  if (col.generated && col.default) sql += ` GENERATED ALWAYS AS (${col.default}) STORED`;
  else if (col.identity) sql += ` GENERATED ${col.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
  else if (col.default) sql += ` DEFAULT ${col.default}`;
  if (withNotNull && col.notNull) sql += ' NOT NULL';
  return sql;
}

/** Sequences to create before a table or column whose defaults use them */
function sequencesFor(columns: CatalogColumn[], target: Catalog, schema: string): string[] {
  const out: string[] = [];
  for (const col of columns) {
    const seq = defaultSequence(col.default);
    if (!seq) continue;
    const qualifiedName = seq.includes('.') ? seq.replace(/"/g, '') : `${schema}.${seq.replace(/"/g, '')}`;
    if (!target.sequences.has(qualifiedName)) out.push(`CREATE SEQUENCE IF NOT EXISTS ${seq}`);
  }
  return out;
}

function ownedBy(columns: CatalogColumn[], table: CatalogTable): string[] {
  return columns.flatMap(col => {
    const seq = defaultSequence(col.default);
    return seq ? [`ALTER SEQUENCE ${seq} OWNED BY ${ident(table.schema, table.name)}.${format('%I', col.name)}`] : [];
  });
}

function createTable(table: CatalogTable, target: Catalog): string[] {
  const inline = table.constraints.filter(c => c.type !== 'f').map(c => `CONSTRAINT ${format('%I', c.name)} ${c.definition}`);
  const body = [...table.columns.map(c => columnDefinition(c)), ...inline].map(line => `  ${line}`).join(',\n');
  const sql = [
    ...sequencesFor(table.columns, target, table.schema),
    `CREATE TABLE ${ident(table.schema, table.name)} (\n${body}\n)${table.partitionKey ? ` PARTITION BY ${table.partitionKey}` : ''}`,
    ...ownedBy(table.columns, table),
  ];
  if (table.comment) sql.push(format('COMMENT ON TABLE %s IS %L', ident(table.schema, table.name), table.comment));
  return sql;
}

/** pg_get_indexdef → idempotent CREATE INDEX */
export const ifNotExists = (definition: string) =>
  definition.replace(/^CREATE (UNIQUE )?INDEX /, (_m, unique = '') => `CREATE ${unique}INDEX IF NOT EXISTS `);

export function diffSchemas(source: Catalog, target: Catalog): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const add = (change: Omit<SchemaChange, 'id' | 'defaultSelected'> & { defaultSelected?: boolean }) =>
    changes.push({ ...change, id: `${change.kind}:${change.object}`, defaultSelected: change.defaultSelected ?? !change.destructive });

  for (const ext of source.extensions) {
    if (!target.extensions.includes(ext)) {
      add({ kind: 'extension', object: ext, sql: [format('CREATE EXTENSION IF NOT EXISTS %I', ext)], destructive: false, phase: PHASE.extension, note: 'needs the extension on the local server (Extensions)', noteCode: 'needs_extension' });
    }
  }

  for (const schema of source.schemas) {
    if (!target.schemas.includes(schema)) add({ kind: 'schema', object: schema, sql: [format('CREATE SCHEMA IF NOT EXISTS %I', schema)], destructive: false, phase: PHASE.schema });
  }

  for (const [key, labels] of source.enums) {
    const [schema, name] = key.split('.');
    const local = target.enums.get(key);
    if (!local) {
      add({ kind: 'enum', object: key, sql: [`CREATE TYPE ${ident(schema, name)} AS ENUM (${labels.map(l => format('%L', l)).join(', ')})`], destructive: false, phase: PHASE.enum });
      continue;
    }
    const existing = [...local];
    labels.forEach((label, index) => {
      if (existing.includes(label)) return;
      // Same place as in the source: after the closest earlier label the target has
      const previous = labels.slice(0, index).reverse().find(l => existing.includes(l));
      const position = previous ? format(' AFTER %L', previous) : existing.length ? format(' BEFORE %L', existing[0]) : '';
      add({ kind: 'enum_value', object: `${key}.${label}`, sql: [`ALTER TYPE ${ident(schema, name)} ADD VALUE IF NOT EXISTS ${format('%L', label)}${position}`], destructive: false, phase: PHASE.enum });
      existing.splice(previous ? existing.indexOf(previous) + 1 : 0, 0, label);
    });
  }

  for (const [key, table] of source.tables) {
    const local = target.tables.get(key);
    const rel = ident(table.schema, table.name);
    if (!local) {
      add({ kind: 'table', object: key, sql: createTable(table, target), destructive: false, phase: PHASE.table });
      for (const index of table.indexes) add({ kind: 'index', object: `${key}.${index.name}`, sql: [ifNotExists(index.definition)], destructive: false, phase: PHASE.index });
      for (const fk of table.constraints.filter(c => c.type === 'f')) {
        add({ kind: 'foreign_key', object: `${key}.${fk.name}`, sql: [`ALTER TABLE ${rel} ADD CONSTRAINT ${format('%I', fk.name)} ${fk.definition}`], destructive: false, phase: PHASE.foreignKey });
      }
      for (const trigger of table.triggers) add({ kind: 'trigger', object: `${key}.${trigger.name}`, sql: [trigger.definition], destructive: false, phase: PHASE.trigger });
      continue;
    }

    for (const col of table.columns) {
      const mine = local.columns.find(c => c.name === col.name);
      const object = `${key}.${col.name}`;
      const colRef = `${rel} ALTER COLUMN ${format('%I', col.name)}`;
      if (!mine) {
        // Local rows have no value for a new NOT NULL column without default: added nullable
        const needsValue = col.notNull && !col.default && !col.identity && !col.generated;
        add({
          kind: 'column', object,
          sql: [...sequencesFor([col], target, table.schema), `ALTER TABLE ${rel} ADD COLUMN ${columnDefinition(col, !needsValue)}`, ...ownedBy([col], table)],
          destructive: false, phase: PHASE.table,
          ...(needsValue ? { note: 'added without NOT NULL: local rows have no value for it', noteCode: 'added_nullable' as const } : {}),
        });
        continue;
      }
      if (mine.type !== col.type) {
        add({ kind: 'column_type', object, sql: [`ALTER TABLE ${colRef} TYPE ${col.type} USING ${format('%I', col.name)}::${col.type}`], destructive: true, phase: PHASE.table, note: `local type ${mine.type}; converting may fail or lose precision`, noteCode: 'type_change', noteParams: { type: mine.type } });
      }
      if (!col.generated && !col.identity && !mine.identity && (mine.default ?? null) !== (col.default ?? null)) {
        add({ kind: 'column_default', object, sql: [`ALTER TABLE ${colRef} ${col.default ? `SET DEFAULT ${col.default}` : 'DROP DEFAULT'}`], destructive: false, phase: PHASE.table });
      }
      if (mine.notNull && !col.notNull) {
        add({ kind: 'column_nullable', object, sql: [`ALTER TABLE ${colRef} DROP NOT NULL`], destructive: false, phase: PHASE.table });
      } else if (!mine.notNull && col.notNull) {
        add({ kind: 'column_nullable', object, sql: [`ALTER TABLE ${colRef} SET NOT NULL`], destructive: false, defaultSelected: false, phase: PHASE.table, note: 'fails if local rows have NULL there', noteCode: 'fails_on_null' });
      }
    }
    for (const mine of local.columns) {
      if (!table.columns.some(c => c.name === mine.name)) {
        add({ kind: 'drop_column', object: `${key}.${mine.name}`, sql: [`ALTER TABLE ${rel} DROP COLUMN ${format('%I', mine.name)}`], destructive: true, phase: PHASE.drop, note: 'not in the source any more; its local data would be lost', noteCode: 'data_lost' });
      }
    }
    for (const con of table.constraints) {
      if (local.constraints.some(c => c.name === con.name)) continue;
      const fk = con.type === 'f';
      add({
        kind: fk ? 'foreign_key' : 'constraint', object: `${key}.${con.name}`,
        sql: [`ALTER TABLE ${rel} ADD CONSTRAINT ${format('%I', con.name)} ${con.definition}`],
        destructive: false, phase: fk ? PHASE.foreignKey : PHASE.constraint, note: 'fails if local rows do not satisfy it', noteCode: 'must_satisfy',
      });
    }
    for (const index of table.indexes) {
      if (!local.indexes.some(i => i.name === index.name)) add({ kind: 'index', object: `${key}.${index.name}`, sql: [ifNotExists(index.definition)], destructive: false, phase: PHASE.index });
    }
    for (const trigger of table.triggers) {
      if (!local.triggers.some(t => t.name === trigger.name)) add({ kind: 'trigger', object: `${key}.${trigger.name}`, sql: [trigger.definition], destructive: false, phase: PHASE.trigger });
    }
  }

  for (const [key, table] of target.tables) {
    if (!source.tables.has(key)) {
      add({ kind: 'local_only_table', object: key, sql: [`DROP TABLE ${ident(table.schema, table.name)}`], destructive: true, phase: PHASE.drop, note: 'only in the local database', noteCode: 'local_only' });
    }
  }

  for (const [signature, definition] of source.functions) {
    const mine = target.functions.get(signature);
    if (mine === definition) continue;
    add({ kind: 'function', object: signature, sql: [definition], destructive: false, phase: PHASE.function, ...(mine ? { note: 'replaces the local version', noteCode: 'replaces_local' as const } : {}) });
  }

  for (const [key, view] of source.views) {
    const mine = target.views.get(key);
    if (mine && mine.definition === view.definition) continue;
    const [schema, name] = key.split('.');
    if (!mine) {
      add({ kind: 'view', object: key, sql: [`CREATE ${view.materialized ? 'MATERIALIZED VIEW' : 'VIEW'} ${ident(schema, name)} AS\n${view.definition}`], destructive: false, phase: PHASE.view });
    } else if (!view.materialized) {
      add({ kind: 'view', object: key, sql: [`CREATE OR REPLACE VIEW ${ident(schema, name)} AS\n${view.definition}`], destructive: false, phase: PHASE.view, note: 'replaces the local definition', noteCode: 'replaces_local' });
    }
  }

  return changes.sort((a, b) => a.phase - b.phase);
}

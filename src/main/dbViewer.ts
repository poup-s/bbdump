import { Pool, PoolClient, QueryConfig } from 'pg';
import { getErrorMessage } from './utils';
import format from 'pg-format';
import { logger } from './logger';
import { SslMode, resolveSsl, toNodePgSsl, stripSslParams, isSslEnabled } from './sslConfig';

interface ConnectionParams {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionString?: string;
  ssl?: boolean;
  sslMode?: SslMode;
  sslRootCert?: string;
  /** host/port are a local SSH tunnel: never the Unix-socket shortcuts for localhost */
  viaTunnel?: boolean;
}

/**
 * Connection pool manager to optimize performance
 */
class ConnectionPoolManager {
  private pools: Map<string, Pool> = new Map();
  private lastAccess: Map<string, number> = new Map();
  private CLEANUP_INTERVAL = 60 * 1000; // 1 minute
  private POOL_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Clean up unused pools periodically
    this.cleanupTimer = setInterval(() => this.cleanup(), this.CLEANUP_INTERVAL);
  }

  private getKey(params: ConnectionParams): string {
    const { mode, rootCert } = resolveSsl(params);
    const sslKey = `#ssl=${mode || 'none'}:${rootCert || ''}`;
    if (params.connectionString) {
      return params.connectionString + sslKey;
    }
    return `${params.user}@${params.host}:${params.port}/${params.database}${sslKey}`;
  }

  /**
   * Gets an existing pool or creates a new one
   */
  public getPool(params: ConnectionParams): Pool {
    const key = this.getKey(params);
    this.lastAccess.set(key, Date.now());

    if (this.pools.has(key)) {
      return this.pools.get(key)!;
    }

    logger.info(`Creating new connection pool for ${params.database}`);

    const isLinux = process.platform === 'linux';
    const isLocalHost = !params.viaTunnel && (params.host === 'localhost' || params.host === '127.0.0.1');

    let poolConfig;

    const ssl = toNodePgSsl(params);

    if (params.connectionString) {
      // Strip ssl params from the connection string: pg re-parses it per client, which
      // would override the explicit ssl option below
      const cleanedConnectionString = stripSslParams(params.connectionString);
      poolConfig = {
        connectionString: cleanedConnectionString,
        ssl,
        max: 10, // Max clients in pool
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      };
    } else if (isLinux && isLocalHost && !ssl) {
      // On Linux, use Unix socket for local connections (peer auth, no password needed).
      // TCP with empty password fails with SCRAM auth on default Linux pg_hba.conf.
      poolConfig = {
        host: '/var/run/postgresql',
        port: params.port,
        user: params.user,
        password: params.password || '',
        database: params.database,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      };
    } else {
      poolConfig = {
        host: params.host,
        port: params.port,
        user: params.user,
        password: params.password,
        database: params.database,
        ssl,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      };
    }

    const pool = new Pool(poolConfig);

    // No session-level `SET search_path`: every viewer query schema-qualifies its
    // identifiers, which also keeps it working behind PgBouncer in transaction mode
    // (where session settings are not preserved between transactions).

    pool.on('error', (err) => {
      logger.error(`Unexpected error on idle client for ${key}: ${err.message}`);
    });

    this.pools.set(key, pool);
    return pool;
  }

  /**
   * Removes a pool from the cache (after an error, before re-creation with different params)
   */
  public removePool(params: ConnectionParams) {
    const key = this.getKey(params);
    this.pools.delete(key);
    this.lastAccess.delete(key);
  }

  /**
   * Ferme les pools inactifs
   */
  private async cleanup() {
    const now = Date.now();
    for (const [key, lastAccess] of this.lastAccess.entries()) {
      if (now - lastAccess > this.POOL_TIMEOUT) {
        logger.info(`Closing idle connection pool for ${key}`);
        const pool = this.pools.get(key);
        if (pool) {
          await pool.end();
          this.pools.delete(key);
          this.lastAccess.delete(key);
        }
      }
    }
  }

  /**
   * Closes all pools (on application shutdown)
   */
  public async closeAll() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const pool of this.pools.values()) {
      try {
        await pool.end();
      } catch (error) {
        logger.error(`Error closing pool: ${error}`);
      }
    }
    this.pools.clear();
    this.lastAccess.clear();
  }
}

const poolManager = new ConnectionPoolManager();

/**
 * Connection check for the database dialogs: server version and number of user tables.
 * The pool is dropped afterwards, so a wrong password is not kept around.
 */
export async function testConnection(params: ConnectionParams): Promise<{ version: string; tables: number }> {
  const client = await getClient(params);
  try {
    const result = await client.query(`
      SELECT current_setting('server_version') AS version,
             (SELECT count(*)::int FROM information_schema.tables
               WHERE table_type = 'BASE TABLE'
                 AND table_schema NOT IN ('pg_catalog', 'information_schema')) AS tables
    `);
    return { version: String(result.rows[0].version).split(' ')[0], tables: Number(result.rows[0].tables) };
  } finally {
    client.release();
    poolManager.removePool(params);
  }
}

export async function closeAllPools() {
  await poolManager.closeAll();
}

/**
 * Obtient un client du pool, avec auto-retry SSL si le serveur exige le chiffrement
 * et fallback Unix socket → TCP → /tmp socket sur Linux
 */
async function getClient(params: ConnectionParams): Promise<PoolClient> {
  const pool = poolManager.getPool(params);
  try {
    return await pool.connect();
  } catch (err) {
    // If the server requires SSL and we connected without it, retry with SSL
    if (!isSslEnabled(params) && getErrorMessage(err)?.includes('no encryption')) {
      logger.info(`Connection to ${params.database} failed without SSL, retrying with SSL...`);
      poolManager.removePool(params);
      const sslParams: ConnectionParams = { ...params, ssl: true, sslMode: 'require' };
      const sslPool = poolManager.getPool(sslParams);
      return await sslPool.connect();
    }

    // On Linux, if Unix socket failed (e.g. /var/run/postgresql doesn't exist),
    // try /tmp socket, then fall back to TCP with common passwords
    const isLinux = process.platform === 'linux';
    const isLocalHost = !params.viaTunnel && (params.host === 'localhost' || params.host === '127.0.0.1');

    if (isLinux && isLocalHost && !params.connectionString) {
      logger.info(`Connection to ${params.database} via socket failed: ${getErrorMessage(err)}, trying fallbacks...`);
      poolManager.removePool(params);

      // Try /tmp socket
      try {
        const tmpParams = { ...params, host: '/tmp' };
        const tmpPool = poolManager.getPool(tmpParams);
        return await tmpPool.connect();
      } catch {
        poolManager.removePool({ ...params, host: '/tmp' });
      }

      // Fall back to TCP with the configured password, then none (trust auth).
      // Never guess common passwords.
      const passwords = [...new Set([params.password || '', ''])];
      for (const pwd of passwords) {
        try {
          const tcpParams = { ...params, host: 'localhost', password: pwd };
          const tcpPool = poolManager.getPool(tcpParams);
          const client = await tcpPool.connect();
          logger.warn(`Connected to ${params.database} using fallback password (original password may be incorrect)`);
          return client;
        } catch {
          poolManager.removePool({ ...params, host: 'localhost', password: pwd });
        }
      }
    }

    throw err;
  }
}

/** Runs `fn` with a pooled client of these parameters, always released */
export async function withConnection<T>(params: ConnectionParams, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient(params);
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Default schema used when a caller does not send one (pre-multi-schema callers). */
export const DEFAULT_SCHEMA = 'public';

function resolveSchema(schema?: string | null): string {
  return typeof schema === 'string' && schema.length > 0 ? schema : DEFAULT_SCHEMA;
}

/**
 * SQL predicate that keeps user schemas only (drops catalogs, TOAST and temp schemas).
 * `alias` is a constant chosen in this file, never user input.
 */
function userSchemaFilter(alias: string): string {
  return `${alias}.nspname NOT IN ('pg_catalog', 'information_schema')
      AND ${alias}.nspname NOT LIKE 'pg\\_toast%'
      AND ${alias}.nspname NOT LIKE 'pg\\_temp\\_%'`;
}

/**
 * Foreign keys with schema-qualified source and target (one row per column pair).
 * Uses pg_constraint rather than information_schema so that cross-schema and
 * multi-column FKs are reported correctly.
 */
const FOREIGN_KEYS_SQL = `
  SELECT
    con.conname AS constraint_name,
    sn.nspname AS source_schema,
    sc.relname AS source_table,
    sa.attname AS source_column,
    tn.nspname AS target_schema,
    tc.relname AS target_table,
    ta.attname AS target_column
  FROM pg_constraint con
  JOIN pg_class sc ON sc.oid = con.conrelid
  JOIN pg_namespace sn ON sn.oid = sc.relnamespace
  JOIN pg_class tc ON tc.oid = con.confrelid
  JOIN pg_namespace tn ON tn.oid = tc.relnamespace
  CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, fattnum, ord)
  JOIN pg_attribute sa ON sa.attrelid = con.conrelid AND sa.attnum = k.attnum
  JOIN pg_attribute ta ON ta.attrelid = con.confrelid AND ta.attnum = k.fattnum
  WHERE con.contype = 'f'
`;

/** Tables whose size is under this threshold get an exact COUNT(*) when statistics are missing. */
const EXACT_COUNT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Lists the user schemas of the database (system, TOAST and temp schemas excluded),
 * with their table count. `public` comes first when present.
 */
export async function getDatabaseSchemas(params: ConnectionParams) {
  const client = await getClient(params);

  try {
    const result = await client.query(`
      SELECT
        n.nspname AS name,
        (SELECT count(*) FROM pg_class c
          WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p'))::int AS table_count
      FROM pg_namespace n
      WHERE ${userSchemaFilter('n')}
        AND has_schema_privilege(n.oid, 'USAGE')
      ORDER BY (n.nspname = 'public') DESC, n.nspname;
    `);
    return { schemas: result.rows as { name: string; table_count: number }[] };
  } finally {
    client.release();
  }
}

/**
 * Retrieves the list of tables of a schema.
 *
 * Row counts come from the planner statistics (pg_class.reltuples), which is instant even
 * on very large tables. An exact COUNT(*) is only run for small tables that have never been
 * analyzed (reltuples = -1) or report 0 rows. Large never-analyzed tables get row_count null.
 */
export async function getDatabaseTables(params: ConnectionParams & { schema?: string }) {
  const schema = resolveSchema(params.schema);
  const client = await getClient(params);

  try {
    const result = await client.query(`
      SELECT
        c.relname AS name,
        c.relkind,
        c.reltuples::float8 AS reltuples,
        pg_relation_size(c.oid) AS size_bytes,
        has_table_privilege(c.oid, 'SELECT') AS can_select
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')
      ORDER BY c.relname;
    `, [schema]);
    logger.info(`getDatabaseTables found ${result.rows.length} tables in schema ${schema}`);

    const tables: { name: string; row_count: number | null; row_count_estimated: boolean }[] =
      result.rows.map(r => {
        const reltuples = Number(r.reltuples);
        return {
          name: r.name,
          row_count: reltuples >= 0 ? Math.round(reltuples) : null,
          row_count_estimated: true,
        };
      });

    // Exact count only where the estimate is missing or zero and the table is small
    const toCount = result.rows
      .filter(r => r.relkind === 'r' && r.can_select && Number(r.reltuples) <= 0
        && Number(r.size_bytes) <= EXACT_COUNT_MAX_BYTES)
      .map(r => r.name as string);

    if (toCount.length > 0) {
      const countQuery = toCount
        .map(name => format('SELECT %L AS name, COUNT(*) AS row_count FROM %I.%I', name, schema, name))
        .join(' UNION ALL ');
      const countResult = await client.query(countQuery);
      const counts = new Map(countResult.rows.map(r => [r.name, parseInt(r.row_count, 10)]));
      for (const table of tables) {
        if (counts.has(table.name)) {
          table.row_count = counts.get(table.name) ?? 0;
          table.row_count_estimated = false;
        }
      }
    }

    return { schema, tables };
  } finally {
    client.release();
  }
}

/**
 * Exact row count of a single table (explicit user action; may be slow on big tables).
 */
export async function countTableRows(params: ConnectionParams & { schema?: string; table: string }) {
  const schema = resolveSchema(params.schema);
  const client = await getClient(params);

  try {
    const result = await client.query(format('SELECT COUNT(*) AS count FROM %I.%I', schema, params.table));
    return { count: parseInt(result.rows[0]?.count || '0', 10) };
  } finally {
    client.release();
  }
}

/**
 * Retrieves the schema of a table
 */
export async function getTableSchema(params: ConnectionParams & { schema?: string; table: string }) {
  const schema = resolveSchema(params.schema);
  const client = await getClient(params);

  try {
    // Retrieve columns
    const columnsQuery = `
      SELECT
        column_name,
        data_type,
        udt_schema,
        udt_name,
        is_nullable,
        column_default,
        character_maximum_length,
        numeric_precision,
        numeric_scale,
        is_identity,
        identity_generation,
        is_generated
      FROM information_schema.columns
      WHERE table_schema = $1
      AND table_name = $2
      ORDER BY ordinal_position;
    `;

    const columnsResult = await client.query(columnsQuery, [schema, params.table]);

    // Retrieve primary keys (with correct case handling)
    const pkQuery = `
      SELECT a.attname as column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
      AND c.relname = $2
      AND i.indisprimary;
    `;

    const pkResult = await client.query(pkQuery, [schema, params.table]);
    const primaryKeys = pkResult.rows.map(row => row.column_name);

    // Single-column unique indexes (other than the primary key): a duplicated row must change them
    const uniqueResult = await client.query(`
      SELECT a.attname as column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
      AND c.relname = $2
      AND i.indisunique AND NOT i.indisprimary
      AND i.indnatts = 1 AND i.indpred IS NULL;
    `, [schema, params.table]);
    const uniqueColumns = new Set(uniqueResult.rows.map(row => row.column_name));

    // Retrieve foreign keys with referenced tables (target may live in another schema)
    const fkResult = await client.query(
      `${FOREIGN_KEYS_SQL} AND sn.nspname = $1 AND sc.relname = $2 ORDER BY con.conname, k.ord;`,
      [schema, params.table]
    );
    const foreignKeys = fkResult.rows;

    // Add key information to columns
    const columns = columnsResult.rows.map(col => {
      const fkInfo = foreignKeys.find(fk => fk.source_column === col.column_name);
      return {
        ...col,
        is_primary: primaryKeys.includes(col.column_name),
        is_unique: uniqueColumns.has(col.column_name),
        is_foreign: !!fkInfo,
        foreign_key: fkInfo ? {
          schema: fkInfo.target_schema,
          table: fkInfo.target_table,
          column: fkInfo.target_column
        } : null
      };
    });

    return { schema, columns };
  } finally {
    client.release();
  }
}

/**
 * Retrieves the relations (foreign keys) of a table
 */
export async function getTableRelations(params: ConnectionParams & { schema?: string; table: string }) {
  const schema = resolveSchema(params.schema);
  const client = await getClient(params);

  try {
    const result = await client.query(
      `${FOREIGN_KEYS_SQL} AND sn.nspname = $1 AND sc.relname = $2 ORDER BY con.conname, k.ord;`,
      [schema, params.table]
    );

    return {
      relations: result.rows.map(r => ({
        constraint_name: r.constraint_name,
        column_name: r.source_column,
        foreign_table_schema: r.target_schema,
        foreign_table_name: r.target_table,
        foreign_column_name: r.target_column
      }))
    };
  } finally {
    client.release();
  }
}

/** Above this estimated size, the data grid shows the planner estimate as its total. */
const EXACT_COUNT_MAX_ROWS = 1_000_000;
/** Search results are counted up to this many matches. */
const SEARCH_COUNT_CAP = 10_000;

/**
 * Retrieves table data with LIMIT, OFFSET and optional search
 */
export async function getTableData(params: ConnectionParams & {
  schema?: string;
  table: string;
  limit: number;
  offset?: number;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}) {
  const schema = resolveSchema(params.schema);
  const client = await getClient(params);

  try {
    let query: string;
    let countQuery: string;
    let queryParams: unknown[];
    let countParams: unknown[];
    const offset = params.offset || 0;

    // Validate sort order
    const sortOrder = (params.sortOrder?.toLowerCase() === 'desc') ? 'DESC' : 'ASC';

    const orderByClause = params.sortBy ? format('ORDER BY %I %s', params.sortBy, sortOrder) : '';

    if (params.search && params.search.trim() !== '') {
      // If search is active, build a query with WHERE on all columns
      const columnsQuery = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = $1
        AND table_name = $2
        ORDER BY ordinal_position;
      `;
      const columnsResult = await client.query(columnsQuery, [schema, params.table]);
      const columns = columnsResult.rows.map(row => row.column_name);

      const whereConditionsMain = columns.map(col => format('%I::text ILIKE $3', col)).join(' OR ');
      const whereConditionsCount = columns.map(col => format('%I::text ILIKE $1', col)).join(' OR ');

      query = format('SELECT * FROM %I.%I WHERE %s %s LIMIT $1 OFFSET $2', schema, params.table, whereConditionsMain, orderByClause);
      queryParams = [params.limit, offset, `%${params.search}%`];

      // Capped: counting every match of an ILIKE over a huge table would scan all of it
      countQuery = format('SELECT COUNT(*) AS count FROM (SELECT 1 FROM %I.%I WHERE %s LIMIT %s) matches',
        schema, params.table, whereConditionsCount, SEARCH_COUNT_CAP + 1);
      countParams = [`%${params.search}%`];
    } else {
      query = format('SELECT * FROM %I.%I %s LIMIT $1 OFFSET $2', schema, params.table, orderByClause);
      queryParams = [params.limit, offset];

      countQuery = format('SELECT COUNT(*) as count FROM %I.%I', schema, params.table);
      countParams = [];
    }

    // Large tables: use the planner estimate for the unfiltered total (instant) instead
    // of a full COUNT(*) on every page load
    const estimateResult = await client.query(
      `SELECT c.reltuples::float8 AS estimate FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, params.table]
    );
    const estimate = Number(estimateResult.rows[0]?.estimate ?? -1);
    const isSearch = !!(params.search && params.search.trim() !== '');
    const useEstimate = !isSearch && estimate > EXACT_COUNT_MAX_ROWS;

    const [result, countResult] = await Promise.all([
      client.query(query, queryParams),
      useEstimate ? Promise.resolve(null) : client.query(countQuery, countParams)
    ]);

    let totalCount = useEstimate ? Math.round(estimate) : parseInt(countResult?.rows[0]?.count || '0');
    let totalIsEstimate = useEstimate;
    if (isSearch && totalCount > SEARCH_COUNT_CAP) {
      totalCount = SEARCH_COUNT_CAP;
      totalIsEstimate = true; // "at least" this many matches
    }
    // An estimate can be below the real count: keep paging while pages come back full
    const hasMore = offset + result.rows.length < totalCount
      || (totalIsEstimate && result.rows.length === params.limit);

    return {
      rows: result.rows,
      total: totalCount,
      totalIsEstimate,
      offset: offset,
      hasMore
    };
  } finally {
    client.release();
  }
}

/**
 * Retrieves a related row by foreign key (exact match on a column)
 */
export async function getFkRow(params: ConnectionParams & {
  schema?: string;
  table: string;
  column: string;
  value: unknown;
}) {
  const schema = resolveSchema(params.schema);
  const client = await getClient(params);

  try {
    const query = format('SELECT * FROM %I.%I WHERE %I = $1 LIMIT 1', schema, params.table, params.column);
    const result = await client.query(query, [params.value]);
    return { row: result.rows[0] || null };
  } finally {
    client.release();
  }
}

/**
 * Updates data in a table
 */
export async function updateTableData(params: ConnectionParams & {
  schema?: string;
  table: string;
  changes: Array<{
    rowId?: unknown;
    primaryKeyColumn?: string;
    rowData?: Record<string, unknown>;
    column: string;
    oldValue: unknown;
    newValue: unknown;
  }>;
}) {
  const schema = resolveSchema(params.schema);
  const client = await getClient(params);

  try {
    await client.query('BEGIN');

    const results = [];

    for (const change of params.changes) {
      let whereClause = '';
      let whereValues: unknown[] = [];
      let paramIndex = 1;

      if (change.rowId && change.primaryKeyColumn) {
        whereClause = format('%I = $1', change.primaryKeyColumn);
        whereValues = [change.rowId];
        paramIndex++;
      }
      else if (change.rowData) {
        const whereConditions: string[] = [];
        for (const [key, value] of Object.entries(change.rowData)) {
          if (key !== change.column) {
            if (value === null) {
              whereConditions.push(format('%I IS NULL', key));
            } else {
              whereConditions.push(format('%I = $%s', key, paramIndex));
              whereValues.push(value);
              paramIndex++;
            }
          }
        }
        whereClause = whereConditions.join(' AND ');
      } else {
        results.push({
          success: false,
          column: change.column,
          error: 'No row identifier provided'
        });
        continue;
      }

      const updateQuery = format(
        'UPDATE %I.%I SET %I = $%s WHERE %s',
        schema,
        params.table,
        change.column,
        paramIndex,
        whereClause
      );

      const values = [...whereValues, change.newValue];

      try {
        const result = await client.query(updateQuery, values);
        results.push({
          success: true,
          column: change.column,
          rowsAffected: result.rowCount
        });
      } catch (error) {
        results.push({
          success: false,
          column: change.column,
          error: getErrorMessage(error)
        });
      }
    }

    const allSuccess = results.every(r => r.success);

    if (allSuccess) {
      await client.query('COMMIT');
      return { success: true, results };
    } else {
      await client.query('ROLLBACK');
      return { success: false, results };
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw new Error(`Failed to update table data: ${getErrorMessage(error)}`);
  } finally {
    client.release();
  }
}

/**
 * Supprime une ligne d'une table
 */
export async function deleteTableRow(params: ConnectionParams & {
  schema?: string;
  table: string;
  rowId: unknown;
  primaryKeyColumn: string;
}) {
  const schema = resolveSchema(params.schema);
  const client = await getClient(params);

  try {
    const query = format('DELETE FROM %I.%I WHERE %I = $1', schema, params.table, params.primaryKeyColumn);
    const result = await client.query(query, [params.rowId]);

    return {
      success: true,
      rowsAffected: result.rowCount
    };
  } catch (error) {
    throw new Error(`Failed to delete row: ${getErrorMessage(error)}`);
  } finally {
    client.release();
  }
}

/**
 * Ajoute une nouvelle ligne dans une table
 */
export async function insertTableRow(params: ConnectionParams & {
  schema?: string;
  table: string;
  rowData: Record<string, unknown>;
}) {
  const schema = resolveSchema(params.schema);
  const client = await getClient(params);

  try {
    const columns = Object.keys(params.rowData);
    const values = Object.values(params.rowData);
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

    const query = format(
      'INSERT INTO %I.%I (%I) VALUES (%s) RETURNING *',
      schema,
      params.table,
      columns,
      placeholders
    );

    const result = await client.query(query, values);

    return {
      success: true,
      row: result.rows[0]
    };
  } catch (error) {
    throw new Error(`Failed to insert row: ${getErrorMessage(error)}`);
  } finally {
    client.release();
  }
}

/**
 * Retrieves the possible values of an ENUM type
 */
export async function getEnumValues(params: ConnectionParams & {
  typeName: string;
  /** Schema of the enum type (udt_schema); when omitted, any schema matches. */
  typeSchema?: string;
}) {
  const client = await getClient(params);

  try {
    const query = `
      SELECT e.enumlabel as value
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_enum e ON t.oid = e.enumtypid
      WHERE t.typname = $1
      AND ($2::text IS NULL OR n.nspname = $2)
      ORDER BY e.enumsortorder;
    `;

    const result = await client.query(query, [params.typeName, params.typeSchema || null]);

    return {
      values: result.rows.map(row => row.value)
    };
  } finally {
    client.release();
  }
}

/**
 * Executes a read-only SQL query with timeout and row limit
 */
export async function executeQuery(params: ConnectionParams & {
  sql: string;
  maxRows?: number;
  timeoutMs?: number;
}) {
  const client = await getClient(params);
  const maxRows = params.maxRows || 5000;
  const timeoutMs = Math.max(100, Math.min(600000, Math.floor(Number(params.timeoutMs) || 60000)));

  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);

    const startTime = Date.now();
    // Extended protocol = single statement only, so "...; COMMIT; <write>" cannot
    // escape the READ ONLY transaction.
    const result = await client.query({ text: params.sql, values: [], queryMode: 'extended' } as QueryConfig);
    const duration = Date.now() - startTime;

    await client.query('COMMIT');

    const truncated = result.rows.length > maxRows;
    const rows = truncated ? result.rows.slice(0, maxRows) : result.rows;
    const fields = result.fields?.map(f => f.name) || [];

    return {
      rows,
      fields,
      rowCount: result.rowCount,
      truncated,
      duration
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(getErrorMessage(error));
  } finally {
    client.release();
  }
}

/**
 * Executes a read-write SQL query (mutations allowed) with timeout
 */
export async function executeMutationQuery(params: ConnectionParams & {
  sql: string;
  maxRows?: number;
  timeoutMs?: number;
}) {
  const client = await getClient(params);
  const maxRows = params.maxRows || 5000;
  const timeoutMs = Math.max(100, Math.min(600000, Math.floor(Number(params.timeoutMs) || 60000)));

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);

    const startTime = Date.now();
    const result = await client.query(params.sql);
    const duration = Date.now() - startTime;

    await client.query('COMMIT');

    const truncated = result.rows.length > maxRows;
    const rows = truncated ? result.rows.slice(0, maxRows) : result.rows;
    const fields = result.fields?.map(f => f.name) || [];

    return {
      rows,
      fields,
      rowCount: result.rowCount,
      truncated,
      duration,
      command: result.command
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(getErrorMessage(error));
  } finally {
    client.release();
  }
}

/**
 * Retrieves the complete database schema (tables, columns, relations).
 *
 * Every row carries its schema (`schema`, `table_schema`, `source_schema`, `target_schema`).
 * Without `schema`, all user schemas are returned. With `schema`, the result is restricted to
 * that schema plus the tables of other schemas linked to it by a foreign key (either way).
 */
export async function getDatabaseFullSchema(params: ConnectionParams & { schema?: string }) {
  const client = await getClient(params);
  const onlySchema = typeof params.schema === 'string' && params.schema.length > 0 ? params.schema : null;

  try {
    const fkQuery = onlySchema
      ? `${FOREIGN_KEYS_SQL} AND (sn.nspname = $1 OR tn.nspname = $1) ORDER BY sn.nspname, sc.relname, con.conname, k.ord;`
      : `${FOREIGN_KEYS_SQL} AND ${userSchemaFilter('sn')} ORDER BY sn.nspname, sc.relname, con.conname, k.ord;`;
    const fkResult = await client.query(fkQuery, onlySchema ? [onlySchema] : []);
    const foreignKeys = fkResult.rows;

    // Schemas (and tables) to include
    const tableKey = (schema: string, table: string) => JSON.stringify([schema, table]);
    let schemaList: string[] | null = null;
    const linkedTables = new Set<string>();
    if (onlySchema) {
      const schemaSet = new Set<string>([onlySchema]);
      for (const fk of foreignKeys) {
        schemaSet.add(fk.source_schema);
        schemaSet.add(fk.target_schema);
        linkedTables.add(tableKey(fk.source_schema, fk.source_table));
        linkedTables.add(tableKey(fk.target_schema, fk.target_table));
      }
      schemaList = [...schemaSet];
    }

    const schemaWhere = (column: string, alias = '') => schemaList
      ? `${column} = ANY($1::text[])`
      : userSchemaFilter(alias || 'n');

    const tablesQuery = `
      SELECT n.nspname AS schema, c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
      AND ${schemaWhere('n.nspname')}
      ORDER BY n.nspname, c.relname;
    `;

    const columnsQuery = `
      SELECT
        c.table_schema,
        c.table_name,
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default
      FROM information_schema.columns c
      JOIN pg_namespace n ON n.nspname = c.table_schema
      WHERE ${schemaWhere('c.table_schema')}
      ORDER BY c.table_schema, c.table_name, c.ordinal_position;
    `;

    const pkQuery = `
      SELECT n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indisprimary
      AND ${schemaWhere('n.nspname')};
    `;

    const values = schemaList ? [schemaList] : [];
    const [tablesResult, columnsResult, pkResult] = await Promise.all([
      client.query(tablesQuery, values),
      client.query(columnsQuery, values),
      client.query(pkQuery, values)
    ]);

    const keep = (schema: string, table: string) =>
      !onlySchema || schema === onlySchema || linkedTables.has(tableKey(schema, table));

    return {
      schema: onlySchema,
      tables: tablesResult.rows.filter(r => keep(r.schema, r.name)),
      columns: columnsResult.rows.filter(r => keep(r.table_schema, r.table_name)),
      primaryKeys: pkResult.rows.filter(r => keep(r.table_schema, r.table_name)),
      foreignKeys
    };
  } finally {
    client.release();
  }
}

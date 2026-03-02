import { Pool, PoolClient } from 'pg';
import { getErrorMessage } from './utils';
import format from 'pg-format';
import { logger } from './logger';

interface ConnectionParams {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionString?: string;
  ssl?: boolean;
}

/**
 * Gestionnaire de pool de connexions pour optimiser les performances
 */
class ConnectionPoolManager {
  private pools: Map<string, Pool> = new Map();
  private lastAccess: Map<string, number> = new Map();
  private CLEANUP_INTERVAL = 60 * 1000; // 1 minute
  private POOL_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Nettoyer les pools inutilisés périodiquement
    this.cleanupTimer = setInterval(() => this.cleanup(), this.CLEANUP_INTERVAL);
  }

  /**
   * Retire le paramètre sslmode de la connection string pour éviter les conflits
   * avec l'option ssl explicite du pool (pg re-parse la string par client)
   */
  private stripSslMode(connectionString: string): string {
    try {
      const url = new URL(connectionString);
      url.searchParams.delete('sslmode');
      return url.toString();
    } catch {
      // Fallback: regex removal if URL parsing fails
      return connectionString.replace(/[?&]sslmode=[^&]*/g, (match) => {
        return match.startsWith('?') ? '?' : '';
      }).replace(/\?$/, '').replace(/\?&/, '?');
    }
  }

  private getKey(params: ConnectionParams): string {
    if (params.connectionString) {
      return params.connectionString;
    }
    return `${params.user}@${params.host}:${params.port}/${params.database}`;
  }

  /**
   * Obtient un pool existant ou en crée un nouveau
   */
  public getPool(params: ConnectionParams): Pool {
    const key = this.getKey(params);
    this.lastAccess.set(key, Date.now());

    if (this.pools.has(key)) {
      return this.pools.get(key)!;
    }

    logger.info(`Creating new connection pool for ${params.database}`);

    const isLinux = process.platform === 'linux';
    const isLocalHost = params.host === 'localhost' || params.host === '127.0.0.1';

    let poolConfig;

    if (params.connectionString) {
      const needsSsl = params.ssl || params.connectionString.includes('sslmode=');
      // Strip sslmode from connection string to avoid conflict with explicit ssl config
      // pg re-parses the connection string per client, which can override our ssl option
      const cleanedConnectionString = this.stripSslMode(params.connectionString);
      poolConfig = {
        connectionString: cleanedConnectionString,
        ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
        max: 10, // Max clients in pool
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      };
    } else if (isLinux && isLocalHost && !params.ssl) {
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
        ssl: params.ssl ? { rejectUnauthorized: false } : undefined,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      };
    }

    const pool = new Pool(poolConfig);

    // Ensure search_path is set on every new connection (PgBouncer in transaction mode
    // may reset search_path between transactions on managed databases like DigitalOcean)
    pool.on('connect', (client) => {
      client.query('SET search_path TO public');
    });

    pool.on('error', (err) => {
      logger.error(`Unexpected error on idle client for ${key}: ${err.message}`);
    });

    this.pools.set(key, pool);
    return pool;
  }

  /**
   * Supprime un pool du cache (après une erreur, avant re-création avec d'autres params)
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
   * Ferme tous les pools (à l'arrêt de l'application)
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
    if (!params.ssl && getErrorMessage(err)?.includes('no encryption')) {
      logger.info(`Connection to ${params.database} failed without SSL, retrying with SSL...`);
      poolManager.removePool(params);
      const sslParams = { ...params, ssl: true };
      const sslPool = poolManager.getPool(sslParams);
      return await sslPool.connect();
    }

    // On Linux, if Unix socket failed (e.g. /var/run/postgresql doesn't exist),
    // try /tmp socket, then fall back to TCP with common passwords
    const isLinux = process.platform === 'linux';
    const isLocalHost = params.host === 'localhost' || params.host === '127.0.0.1';

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

      // Fall back to TCP with common passwords
      const passwords = ['postgres', 'admin', 'password', ''];
      for (const pwd of passwords) {
        try {
          const tcpParams = { ...params, host: 'localhost', password: pwd };
          const tcpPool = poolManager.getPool(tcpParams);
          return await tcpPool.connect();
        } catch {
          poolManager.removePool({ ...params, host: 'localhost', password: pwd });
        }
      }
    }

    throw err;
  }
}

/**
 * Récupère la liste des tables d'une base de données de manière optimisée
 */
export async function getDatabaseTables(params: ConnectionParams) {
  const client = await getClient(params);

  try {
    // Step 1: Get table names with fast reltuples estimate
    const query = `
      SELECT
        t.table_name as name,
        COALESCE(pc.reltuples::bigint, 0) as row_count_estimate
      FROM information_schema.tables t
      LEFT JOIN pg_class pc ON pc.relname = t.table_name AND pc.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = t.table_schema)
      WHERE t.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_name;
    `;

    const result = await client.query(query);
    logger.info(`getDatabaseTables found ${result.rows.length} tables`);

    const tableNames = result.rows.map(r => r.name);
    const estimates = new Map(result.rows.map(r => [r.name, Math.max(0, parseInt(r.row_count_estimate) || 0)]));

    // Step 2: Identify tables where reltuples is missing (0 = never analyzed or truly empty)
    const needsCount = tableNames.filter(name => (estimates.get(name) || 0) <= 0);

    // Step 3: For tables without estimates, do actual COUNT(*) via UNION ALL
    const counts = new Map<string, number>();
    if (needsCount.length > 0) {
      logger.info(`reltuples unavailable for ${needsCount.length}/${tableNames.length} tables, using COUNT(*)`);
      const countParts = needsCount.map(name =>
        format('SELECT %L as name, COUNT(*) as row_count FROM %I.%I', name, 'public', name)
      );
      const countQuery = countParts.join(' UNION ALL ');
      const countResult = await client.query(countQuery);
      countResult.rows.forEach(r => counts.set(r.name, parseInt(r.row_count)));
    }

    // Merge: use reltuples when available, COUNT(*) otherwise
    const tables = tableNames.map(name => ({
      name,
      row_count: (estimates.get(name) || 0) > 0
        ? estimates.get(name)!
        : (counts.get(name) || 0)
    }));

    return { tables };
  } finally {
    client.release();
  }
}

/**
 * Récupère le schéma d'une table
 */
export async function getTableSchema(params: ConnectionParams & { table: string }) {
  const client = await getClient(params);

  try {
    // Récupérer les colonnes
    const columnsQuery = `
      SELECT
        column_name,
        data_type,
        udt_name,
        is_nullable,
        column_default,
        character_maximum_length,
        numeric_precision,
        numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = $1
      ORDER BY ordinal_position;
    `;

    const columnsResult = await client.query(columnsQuery, [params.table]);

    // Récupérer les clés primaires (avec gestion correcte de la casse)
    const pkQuery = `
      SELECT a.attname as column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = $1
      AND n.nspname = 'public'
      AND i.indisprimary;
    `;

    const pkResult = await client.query(pkQuery, [params.table]);
    const primaryKeys = pkResult.rows.map(row => row.column_name);

    // Récupérer les clés étrangères avec les tables référencées
    const fkQuery = `
      SELECT
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_name = $1
      AND tc.table_schema = 'public';
    `;

    const fkResult = await client.query(fkQuery, [params.table]);
    const foreignKeys = fkResult.rows;

    // Ajouter les informations de clés aux colonnes
    const columns = columnsResult.rows.map(col => {
      const fkInfo = foreignKeys.find(fk => fk.column_name === col.column_name);
      return {
        ...col,
        is_primary: primaryKeys.includes(col.column_name),
        is_foreign: !!fkInfo,
        foreign_key: fkInfo ? {
          table: fkInfo.foreign_table_name,
          column: fkInfo.foreign_column_name
        } : null
      };
    });

    return { columns };
  } finally {
    client.release();
  }
}

/**
 * Récupère les relations (foreign keys) d'une table
 */
export async function getTableRelations(params: ConnectionParams & { table: string }) {
  const client = await getClient(params);

  try {
    const query = `
      SELECT
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_name = $1
      AND tc.table_schema = 'public';
    `;

    const result = await client.query(query, [params.table]);

    return { relations: result.rows };
  } finally {
    client.release();
  }
}

/**
 * Récupère les données d'une table avec LIMIT, OFFSET et recherche optionnelle
 */
export async function getTableData(params: ConnectionParams & {
  table: string;
  limit: number;
  offset?: number;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}) {
  const client = await getClient(params);

  try {
    let query: string;
    let countQuery: string;
    let queryParams: any[];
    let countParams: any[];
    const offset = params.offset || 0;

    // Validate sort order
    const sortOrder = (params.sortOrder?.toLowerCase() === 'desc') ? 'DESC' : 'ASC';

    const orderByClause = params.sortBy ? format('ORDER BY %I %s', params.sortBy, sortOrder) : '';

    if (params.search && params.search.trim() !== '') {
      // Si recherche active, construire une requête avec WHERE sur toutes les colonnes
      const columnsQuery = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = $1
        ORDER BY ordinal_position;
      `;
      const columnsResult = await client.query(columnsQuery, [params.table]);
      const columns = columnsResult.rows.map(row => row.column_name);

      const whereConditionsMain = columns.map(col => format('%I::text ILIKE $3', col)).join(' OR ');
      const whereConditionsCount = columns.map(col => format('%I::text ILIKE $1', col)).join(' OR ');

      query = format('SELECT * FROM %I.%I WHERE %s %s LIMIT $1 OFFSET $2', 'public', params.table, whereConditionsMain, orderByClause);
      queryParams = [params.limit, offset, `%${params.search}%`];

      countQuery = format('SELECT COUNT(*) FROM %I.%I WHERE %s', 'public', params.table, whereConditionsCount);
      countParams = [`%${params.search}%`];
    } else {
      query = format('SELECT * FROM %I.%I %s LIMIT $1 OFFSET $2', 'public', params.table, orderByClause);
      queryParams = [params.limit, offset];

      // Use pg_class estimate for fast total count (avoids slow COUNT(*) on large tables)
      countQuery = format(
        'SELECT COALESCE(c.reltuples::bigint, 0) as count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = %L AND n.nspname = %L',
        params.table, 'public'
      );
      countParams = [];
    }

    const [result, countResult] = await Promise.all([
      client.query(query, queryParams),
      client.query(countQuery, countParams)
    ]);

    let totalCount = parseInt(countResult.rows[0]?.count || '0');
    // reltuples can return -1 for never-analyzed tables; fall back to fetched row count
    if (totalCount < 0) {
      totalCount = result.rows.length;
    }

    return {
      rows: result.rows,
      total: totalCount,
      offset: offset,
      hasMore: offset + result.rows.length < totalCount
    };
  } finally {
    client.release();
  }
}

/**
 * Récupère une ligne liée par clé étrangère (exact match sur une colonne)
 */
export async function getFkRow(params: ConnectionParams & {
  table: string;
  column: string;
  value: any;
}) {
  const client = await getClient(params);

  try {
    const query = format('SELECT * FROM %I.%I WHERE %I = $1 LIMIT 1', 'public', params.table, params.column);
    const result = await client.query(query, [params.value]);
    return { row: result.rows[0] || null };
  } finally {
    client.release();
  }
}

/**
 * Met à jour les données d'une table
 */
export async function updateTableData(params: ConnectionParams & {
  table: string;
  changes: Array<{
    rowId?: any;
    primaryKeyColumn?: string;
    rowData?: any;
    column: string;
    oldValue: any;
    newValue: any;
  }>;
}) {
  const client = await getClient(params);

  try {
    await client.query('BEGIN');

    const results = [];

    for (const change of params.changes) {
      let whereClause = '';
      let whereValues: any[] = [];
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
        'public',
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
  table: string;
  rowId: any;
  primaryKeyColumn: string;
}) {
  const client = await getClient(params);

  try {
    const query = format('DELETE FROM %I.%I WHERE %I = $1', 'public', params.table, params.primaryKeyColumn);
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
  table: string;
  rowData: any;
}) {
  const client = await getClient(params);

  try {
    const columns = Object.keys(params.rowData);
    const values = Object.values(params.rowData);
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

    const query = format(
      'INSERT INTO %I.%I (%I) VALUES (%s) RETURNING *',
      'public',
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
 * Récupère les valeurs possibles d'un type ENUM
 */
export async function getEnumValues(params: ConnectionParams & {
  typeName: string;
}) {
  const client = await getClient(params);

  try {
    const query = `
      SELECT e.enumlabel as value
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      WHERE t.typname = $1
      ORDER BY e.enumsortorder;
    `;

    const result = await client.query(query, [params.typeName]);

    return {
      values: result.rows.map(row => row.value)
    };
  } finally {
    client.release();
  }
}

/**
 * Exécute une requête SQL en lecture seule avec timeout et limite de lignes
 */
export async function executeQuery(params: ConnectionParams & {
  sql: string;
  maxRows?: number;
  timeoutMs?: number;
}) {
  const client = await getClient(params);
  const maxRows = params.maxRows || 5000;
  const timeoutMs = params.timeoutMs || 60000;

  try {
    await client.query('BEGIN READ ONLY');
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
 * Exécute une requête SQL en mode read-write (mutations autorisées) avec timeout
 */
export async function executeMutationQuery(params: ConnectionParams & {
  sql: string;
  maxRows?: number;
  timeoutMs?: number;
}) {
  const client = await getClient(params);
  const maxRows = params.maxRows || 5000;
  const timeoutMs = params.timeoutMs || 60000;

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
 * Récupère le schéma complet de la base de données (tables, colonnes, relations)
 */
export async function getDatabaseFullSchema(params: ConnectionParams) {
  const client = await getClient(params);

  try {
    const tablesQuery = `
      SELECT table_name as name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `;

    const columnsQuery = `
      SELECT
        table_name,
        column_name,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position;
    `;

    const pkQuery = `
      SELECT
        tc.table_name,
        kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = 'public';
    `;

    const fkQuery = `
      SELECT
        tc.table_name as source_table,
        kcu.column_name as source_column,
        ccu.table_name as target_table,
        ccu.column_name as target_column,
        tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public';
    `;

    const [tablesResult, columnsResult, pkResult, fkResult] = await Promise.all([
      client.query(tablesQuery),
      client.query(columnsQuery),
      client.query(pkQuery),
      client.query(fkQuery)
    ]);

    return {
      tables: tablesResult.rows,
      columns: columnsResult.rows,
      primaryKeys: pkResult.rows,
      foreignKeys: fkResult.rows
    };
  } finally {
    client.release();
  }
}

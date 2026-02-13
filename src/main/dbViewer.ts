import { Pool, PoolClient } from 'pg';
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
 * Obtient un client du pool
 */
async function getClient(params: ConnectionParams): Promise<PoolClient> {
  const pool = poolManager.getPool(params);
  return await pool.connect();
}

/**
 * Récupère la liste des tables d'une base de données de manière optimisée
 */
export async function getDatabaseTables(params: ConnectionParams) {
  const client = await getClient(params);

  try {
    // Requête optimisée : on récupère les tables et une estimation du nombre de lignes
    // via pg_class au lieu de faire un COUNT(*) sur chaque table (ce qui est très lent)
    const query = `
      SELECT
        t.table_name as name,
        (
          SELECT COUNT(*) 
          FROM information_schema.columns 
          WHERE table_name = t.table_name 
          AND table_schema = t.table_schema
        ) as column_count,
        COALESCE(pc.reltuples::bigint, 0) as row_count_estimate
      FROM information_schema.tables t
      LEFT JOIN pg_class pc ON pc.relname = t.table_name AND pc.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = t.table_schema)
      WHERE t.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_name;
    `;

    const result = await client.query(query);
    logger.info(`getDatabaseTables found ${result.rows.length} tables`);

    // On map pour garder la compatibilité avec l'interface attendue
    const tables = result.rows.map(row => ({
      name: row.name,
      column_count: parseInt(row.column_count),
      // On utilise l'estimation comme row_count pour l'affichage instantané
      // Pour une valeur exacte, il faudrait une requête séparée à la demande
      row_count: Math.max(0, parseInt(row.row_count_estimate) || 0)
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
      } catch (error: any) {
        results.push({
          success: false,
          column: change.column,
          error: error.message
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
  } catch (error: any) {
    await client.query('ROLLBACK');
    throw new Error(`Failed to update table data: ${error.message}`);
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
  } catch (error: any) {
    throw new Error(`Failed to delete row: ${error.message}`);
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
  } catch (error: any) {
    throw new Error(`Failed to insert row: ${error.message}`);
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

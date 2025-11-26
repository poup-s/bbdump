import { Client } from 'pg';
import format from 'pg-format';
import { DatabaseConfig } from '../types/config';
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
 * Crée une connexion PostgreSQL client
 */
async function createConnection(params: ConnectionParams): Promise<Client> {
  const client = new Client(
    params.connectionString
      ? {
        connectionString: params.connectionString,
        // Retirer channel_binding s'il est présent
        ssl: params.ssl || params.connectionString.includes('sslmode=require')
          ? { rejectUnauthorized: false }
          : undefined
      }
      : {
        host: params.host,
        port: params.port,
        user: params.user,
        password: params.password,
        database: params.database,
        ssl: params.ssl ? { rejectUnauthorized: false } : undefined
      }
  );

  await client.connect();
  return client;
}

/**
 * Récupère la liste des tables d'une base de données
 */
export async function getDatabaseTables(params: ConnectionParams) {
  const client = await createConnection(params);

  try {
    const query = `
      SELECT
        table_name as name,
        (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name AND table_schema = t.table_schema) as column_count
      FROM information_schema.tables t
      WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `;

    const result = await client.query(query);
    logger.info(`getDatabaseTables query result rows: ${JSON.stringify(result.rows)}`); // DEBUG LOG

    // Pour chaque table, récupérer le nombre de lignes
    const tablesWithCount = await Promise.all(
      result.rows.map(async (table) => {
        try {
          const countQuery = format('SELECT COUNT(*) as count FROM %I', table.name);
          const countResult = await client.query(countQuery);
          return {
            ...table,
            row_count: parseInt(countResult.rows[0].count)
          };
        } catch (error) {
          logger.error(`Error counting rows for table ${table.name}: ${error}`); // DEBUG LOG
          return {
            ...table,
            row_count: null
          };
        }
      })
    );

    logger.info(`getDatabaseTables returning: ${JSON.stringify(tablesWithCount)}`); // DEBUG LOG
    return { tables: tablesWithCount };
  } finally {
    await client.end();
  }
}

/**
 * Récupère le schéma d'une table
 */
export async function getTableSchema(params: ConnectionParams & { table: string }) {
  const client = await createConnection(params);

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

    // Récupérer les clés étrangères
    const fkQuery = `
      SELECT
        kcu.column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_name = $1
      AND tc.table_schema = 'public';
    `;

    const fkResult = await client.query(fkQuery, [params.table]);
    const foreignKeys = fkResult.rows.map(row => row.column_name);

    // Ajouter les informations de clés aux colonnes
    const columns = columnsResult.rows.map(col => ({
      ...col,
      is_primary: primaryKeys.includes(col.column_name),
      is_foreign: foreignKeys.includes(col.column_name)
    }));

    return { columns };
  } finally {
    await client.end();
  }
}

/**
 * Récupère les relations (foreign keys) d'une table
 */
export async function getTableRelations(params: ConnectionParams & { table: string }) {
  const client = await createConnection(params);

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
    await client.end();
  }
}

/**
 * Récupère les données d'une table avec LIMIT, OFFSET et recherche optionnelle
 */
export async function getTableData(params: ConnectionParams & { table: string; limit: number; offset?: number; search?: string }) {
  const client = await createConnection(params);

  try {
    let query: string;
    let countQuery: string;
    let queryParams: any[];
    let countParams: any[];
    const offset = params.offset || 0;

    if (params.search && params.search.trim() !== '') {
      // Si recherche active, construire une requête avec WHERE sur toutes les colonnes
      // D'abord, récupérer les colonnes de la table
      const columnsQuery = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = $1
        ORDER BY ordinal_position;
      `;
      const columnsResult = await client.query(columnsQuery, [params.table]);
      const columns = columnsResult.rows.map(row => row.column_name);

      // Construire la clause WHERE pour la requête principale
      const whereConditionsMain = columns.map(col => format('%I::text ILIKE $3', col)).join(' OR ');
      // Construire la clause WHERE pour la requête COUNT
      const whereConditionsCount = columns.map(col => format('%I::text ILIKE $1', col)).join(' OR ');

      query = format('SELECT * FROM %I WHERE %s LIMIT $1 OFFSET $2', params.table, whereConditionsMain);
      queryParams = [params.limit, offset, `%${params.search}%`];

      // Compter le total de résultats pour la recherche
      countQuery = format('SELECT COUNT(*) FROM %I WHERE %s', params.table, whereConditionsCount);
      countParams = [`%${params.search}%`];
    } else {
      // Pas de recherche, juste SELECT avec LIMIT et OFFSET
      query = format('SELECT * FROM %I LIMIT $1 OFFSET $2', params.table);
      queryParams = [params.limit, offset];

      // Compter le total de lignes dans la table
      countQuery = format('SELECT COUNT(*) FROM %I', params.table);
      countParams = [];
    }

    // Exécuter les deux requêtes en parallèle
    const [result, countResult] = await Promise.all([
      client.query(query, queryParams),
      client.query(countQuery, countParams)
    ]);

    const totalCount = parseInt(countResult.rows[0].count);

    return {
      rows: result.rows,
      total: totalCount,
      offset: offset,
      hasMore: offset + result.rows.length < totalCount
    };
  } finally {
    await client.end();
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
  const client = await createConnection(params);

  try {
    // Commencer une transaction
    await client.query('BEGIN');

    const results = [];

    for (const change of params.changes) {
      let whereClause = '';
      let whereValues: any[] = [];
      let paramIndex = 1;

      // Utiliser la clé primaire si disponible
      if (change.rowId && change.primaryKeyColumn) {
        whereClause = format('%I = $1', change.primaryKeyColumn);
        whereValues = [change.rowId];
        paramIndex++;
      }
      // Sinon, utiliser toutes les colonnes de la ligne
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

      // Construire la requête UPDATE
      // Note: paramIndex est déjà incrémenté pour la valeur à mettre à jour
      const updateQuery = format(
        'UPDATE %I SET %I = $%s WHERE %s',
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

    // Vérifier si tous les updates ont réussi
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
    await client.end();
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
  const client = await createConnection(params);

  try {
    const query = format('DELETE FROM %I WHERE %I = $1', params.table, params.primaryKeyColumn);
    const result = await client.query(query, [params.rowId]);

    return {
      success: true,
      rowsAffected: result.rowCount
    };
  } catch (error: any) {
    throw new Error(`Failed to delete row: ${error.message}`);
  } finally {
    await client.end();
  }
}

/**
 * Ajoute une nouvelle ligne dans une table
 */
export async function insertTableRow(params: ConnectionParams & {
  table: string;
  rowData: any;
}) {
  const client = await createConnection(params);

  try {
    const columns = Object.keys(params.rowData);
    const values = Object.values(params.rowData);
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

    const query = format(
      'INSERT INTO %I (%I) VALUES (%s) RETURNING *',
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
    await client.end();
  }
}

/**
 * Récupère les valeurs possibles d'un type ENUM
 */
export async function getEnumValues(params: ConnectionParams & {
  typeName: string;
}) {
  const client = await createConnection(params);

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
    await client.end();
  }
}

import { Client } from 'pg';
import { DatabaseConfig } from '../types/config';

interface ConnectionParams {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionString?: string;
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
          ssl: params.connectionString.includes('sslmode=require')
            ? { rejectUnauthorized: false }
            : undefined
        }
      : {
          host: params.host,
          port: params.port,
          user: params.user,
          password: params.password,
          database: params.database
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

    // Pour chaque table, récupérer le nombre de lignes
    const tablesWithCount = await Promise.all(
      result.rows.map(async (table) => {
        try {
          const countQuery = `SELECT COUNT(*) as count FROM "${table.name}"`;
          const countResult = await client.query(countQuery);
          return {
            ...table,
            row_count: parseInt(countResult.rows[0].count)
          };
        } catch (error) {
          return {
            ...table,
            row_count: null
          };
        }
      })
    );

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

      // Construire la clause WHERE : (col1::text ILIKE $1 OR col2::text ILIKE $1 OR ...)
      const whereConditions = columns.map(col => `"${col}"::text ILIKE $3`).join(' OR ');

      query = `SELECT * FROM "${params.table}" WHERE ${whereConditions} LIMIT $1 OFFSET $2`;
      queryParams = [params.limit, offset, `%${params.search}%`];

      // Compter le total de résultats pour la recherche
      countQuery = `SELECT COUNT(*) FROM "${params.table}" WHERE ${whereConditions}`;
      countParams = [`%${params.search}%`];
    } else {
      // Pas de recherche, juste SELECT avec LIMIT et OFFSET
      query = `SELECT * FROM "${params.table}" LIMIT $1 OFFSET $2`;
      queryParams = [params.limit, offset];

      // Compter le total de lignes dans la table
      countQuery = `SELECT COUNT(*) FROM "${params.table}"`;
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

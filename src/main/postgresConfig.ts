import { Client } from 'pg';
import { logger } from './logger';
import { checkPostgresInstalled, checkPostgresRunning } from './postgresManager';

export interface PostgresDatabase {
  name: string;
  owner: string;
  encoding: string;
  collate: string;
  ctype: string;
  size: string;
  connections?: number;
  isActive?: boolean;
}

export interface PostgresConnection {
  pid: number;
  database: string;
  username: string;
  clientAddr: string;
  state: string;
  query?: string;
  queryStart?: string;
  stateChange?: string;
}

export interface PostgresConfigInfo {
  version: string;
  port: number;
  dataDirectory?: string;
  isRunning: boolean;
  databases: PostgresDatabase[];
  activeConnections: PostgresConnection[];
}

/**
 * Crée une connexion PostgreSQL au serveur (base postgres)
 */
async function createPostgresConnection(port: number = 5432): Promise<Client> {
  // Détecter l'utilisateur PostgreSQL
  const os = await import('os');
  const currentUser = os.userInfo().username;
  const usersToTry = [currentUser, 'postgres', process.env.USER || '', process.env.USERNAME || ''];
  
  for (const user of usersToTry) {
    if (!user) continue;
    
    const passwords = ['', 'postgres', 'admin', 'password'];
    
    for (const password of passwords) {
      const client = new Client({
        host: 'localhost',
        port: port,
        user: user,
        password: password,
        database: 'postgres',
        connectionTimeoutMillis: 5000
      });

      try {
        await client.connect();
        logger.info(`Connected to PostgreSQL as ${user} on port ${port}`);
        return client;
      } catch {
        try {
          await client.end();
        } catch {
          // Ignore
        }
      }
    }
  }
  
  throw new Error(`Cannot connect to PostgreSQL server on port ${port}`);
}

/**
 * Liste toutes les bases de données PostgreSQL
 */
export async function listPostgresDatabases(port: number = 5432): Promise<PostgresDatabase[]> {
  const client = await createPostgresConnection(port);
  
  try {
    const query = `
      SELECT 
        d.datname as name,
        pg_catalog.pg_get_userbyid(d.datdba) as owner,
        pg_catalog.pg_encoding_to_char(d.encoding) as encoding,
        d.datcollate as collate,
        d.datctype as ctype,
        pg_size_pretty(pg_database_size(d.datname)) as size,
        (SELECT count(*) FROM pg_stat_activity WHERE datname = d.datname) as connections
      FROM pg_catalog.pg_database d
      WHERE d.datistemplate = false
      ORDER BY d.datname;
    `;
    
    const result = await client.query(query);
    
    return result.rows.map(row => ({
      name: row.name,
      owner: row.owner,
      encoding: row.encoding,
      collate: row.collate,
      ctype: row.ctype,
      size: row.size,
      connections: parseInt(row.connections) || 0,
      isActive: parseInt(row.connections) > 0
    }));
  } finally {
    await client.end();
  }
}

/**
 * Liste les connexions actives à PostgreSQL
 */
export async function listActiveConnections(port: number = 5432): Promise<PostgresConnection[]> {
  const client = await createPostgresConnection(port);
  
  try {
    const query = `
      SELECT 
        pid,
        datname as database,
        usename as username,
        COALESCE(host(client_addr), 'local') as client_addr,
        state,
        COALESCE(query, '') as query,
        COALESCE(query_start::text, '') as query_start,
        COALESCE(state_change::text, '') as state_change
      FROM pg_stat_activity
      WHERE datname IS NOT NULL
      ORDER BY pid;
    `;
    
    const result = await client.query(query);
    
    return result.rows.map(row => ({
      pid: parseInt(row.pid),
      database: row.database,
      username: row.username,
      clientAddr: row.client_addr,
      state: row.state,
      query: row.query || undefined,
      queryStart: row.query_start || undefined,
      stateChange: row.state_change || undefined
    }));
  } finally {
    await client.end();
  }
}

/**
 * Tue une connexion PostgreSQL par PID
 */
export async function killConnection(pid: number, port: number = 5432): Promise<{ success: boolean; error?: string }> {
  const client = await createPostgresConnection(port);
  
  try {
    // Vérifier d'abord que la connexion existe
    const checkQuery = `SELECT pid FROM pg_stat_activity WHERE pid = $1`;
    const checkResult = await client.query(checkQuery, [pid]);
    
    // Si la connexion n'existe pas, elle a peut-être déjà été fermée
    // On essaie quand même de la tuer au cas où elle existerait encore
    if (checkResult.rows.length === 0) {
      logger.warn(`Connection with PID ${pid} not found in pg_stat_activity, attempting to terminate anyway`);
    }
    
    // Utiliser pg_terminate_backend pour tuer la connexion
    // Cette fonction retourne false si le PID n'existe pas, mais ne génère pas d'erreur
    const terminateQuery = `SELECT pg_terminate_backend($1) as terminated`;
    const result = await client.query(terminateQuery, [pid]);
    
    // Vérifier le résultat
    const terminated = result.rows[0]?.terminated;
    
    if (checkResult.rows.length === 0 && !terminated) {
      // La connexion n'existait pas et n'a pas pu être tuée
      return { success: false, error: `Connection with PID ${pid} does not exist or has already been closed` };
    }
    
    if (!terminated) {
      return { success: false, error: `Failed to terminate connection with PID ${pid}` };
    }
    
    // Attendre un peu pour que PostgreSQL mette à jour ses statistiques
    await new Promise(resolve => setTimeout(resolve, 300));
    
    logger.info(`Terminated PostgreSQL connection with PID ${pid}`);
    return { success: true };
  } catch (error: any) {
    logger.error(`Error killing connection ${pid}: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    await client.end();
  }
}

/**
 * Déconnecte toutes les connexions actives d'une base de données
 */
export async function disconnectDatabase(dbName: string, port: number = 5432): Promise<{ success: boolean; error?: string; disconnectedCount?: number }> {
  const client = await createPostgresConnection(port);
  
  try {
    // Vérifier que la base existe
    const checkQuery = `SELECT 1 FROM pg_database WHERE datname = $1`;
    const checkResult = await client.query(checkQuery, [dbName]);
    
    if (checkResult.rows.length === 0) {
      return { success: false, error: `Database "${dbName}" does not exist` };
    }
    
    // Compter d'abord les connexions actives
    const countQuery = `
      SELECT count(*) as count
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `;
    const countResult = await client.query(countQuery, [dbName]);
    const connectionCount = parseInt(countResult.rows[0]?.count || '0', 10);
    
    if (connectionCount === 0) {
      logger.info(`No active connections to disconnect from database "${dbName}"`);
      return { success: true, disconnectedCount: 0 };
    }
    
    // Tuer toutes les connexions actives à cette base de données
    const terminateQuery = `
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `;
    
    await client.query(terminateQuery, [dbName]);
    
    logger.info(`Disconnected ${connectionCount} connection(s) from database "${dbName}"`);
    return { success: true, disconnectedCount: connectionCount };
  } catch (error: any) {
    logger.error(`Error disconnecting database ${dbName}: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    await client.end();
  }
}

/**
 * Supprime une base de données PostgreSQL
 */
export async function dropDatabase(dbName: string, port: number = 5432, forceDisconnect: boolean = true): Promise<{ success: boolean; error?: string }> {
  const client = await createPostgresConnection(port);
  
  try {
    // Vérifier que la base existe
    const checkQuery = `SELECT 1 FROM pg_database WHERE datname = $1`;
    const checkResult = await client.query(checkQuery, [dbName]);
    
    if (checkResult.rows.length === 0) {
      return { success: false, error: `Database "${dbName}" does not exist` };
    }
    
    // Empêcher la suppression des bases système critiques
    const systemDatabases = ['postgres', 'template0', 'template1'];
    if (systemDatabases.includes(dbName)) {
      return { success: false, error: `Cannot drop system database "${dbName}"` };
    }
    
    // Déconnecter toutes les connexions actives si demandé
    if (forceDisconnect) {
      const disconnectResult = await disconnectDatabase(dbName, port);
      if (!disconnectResult.success && disconnectResult.error && !disconnectResult.error.includes('does not exist')) {
        // Si la déconnexion échoue pour une autre raison que "n'existe pas", on continue quand même
        logger.warn(`Warning: Could not disconnect all connections before dropping database: ${disconnectResult.error}`);
      }
      // Attendre un peu pour que les connexions se terminent
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Supprimer la base de données
    const format = await import('pg-format');
    const dropQuery = format.default('DROP DATABASE %I', dbName);
    await client.query(dropQuery);
    
    logger.info(`Database "${dbName}" dropped successfully`);
    return { success: true };
  } catch (error: any) {
    logger.error(`Error dropping database ${dbName}: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    await client.end();
  }
}

/**
 * Teste la connexion à une base de données PostgreSQL et retourne les informations de connexion
 */
export async function testDatabaseConnection(
  dbName: string, 
  port: number = 5432, 
  password?: string
): Promise<{ 
  success: boolean; 
  error?: string; 
  needsPassword?: boolean;
  connectionInfo?: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
}> {
  // Détecter l'utilisateur PostgreSQL
  const os = await import('os');
  const currentUser = os.userInfo().username;
  const usersToTry = [currentUser, 'postgres', process.env.USER || '', process.env.USERNAME || ''];
  
  // Si un mot de passe est fourni, essayer avec ce mot de passe
  if (password !== undefined) {
    for (const user of usersToTry) {
      if (!user) continue;
      
      const client = new Client({
        host: 'localhost',
        port: port,
        user: user,
        password: password,
        database: dbName,
        connectionTimeoutMillis: 5000
      });

      try {
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        logger.info(`Successfully connected to database "${dbName}" as ${user}`);
        return { 
          success: true,
          connectionInfo: {
            host: 'localhost',
            port: port,
            user: user,
            password: password,
            database: dbName
          }
        };
      } catch (error: any) {
        try {
          await client.end();
        } catch {
          // Ignore
        }
        // Si c'est une erreur d'authentification, continuer avec le prochain utilisateur
        if (error.message.includes('password') || error.message.includes('authentication')) {
          continue;
        }
        // Sinon, retourner l'erreur
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Authentication failed with provided password' };
  }
  
  // Essayer sans mot de passe d'abord
  for (const user of usersToTry) {
    if (!user) continue;
    
    const client = new Client({
      host: 'localhost',
      port: port,
      user: user,
      password: '',
      database: dbName,
      connectionTimeoutMillis: 5000
    });

    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      logger.info(`Successfully connected to database "${dbName}" as ${user} (no password)`);
      return { 
        success: true,
        connectionInfo: {
          host: 'localhost',
          port: port,
          user: user,
          password: '',
          database: dbName
        }
      };
    } catch (error: any) {
      try {
        await client.end();
      } catch {
        // Ignore
      }
      
      // Si c'est une erreur d'authentification, on a besoin d'un mot de passe
      if (error.message.includes('password') || error.message.includes('authentication')) {
        return { success: false, needsPassword: true, error: 'Password required' };
      }
      
      // Autre erreur (base n'existe pas, etc.)
      return { success: false, error: error.message };
    }
  }
  
  return { success: false, needsPassword: true, error: 'Password required' };
}

/**
 * Obtient les informations de configuration PostgreSQL
 */
export async function getPostgresConfigInfo(port: number = 5432): Promise<PostgresConfigInfo> {
  try {
    // Essayer d'abord de se connecter directement à PostgreSQL
    // Si on peut se connecter, PostgreSQL est clairement installé et fonctionne
    let version: string | undefined;
    let isRunning = false;
    
    try {
      const client = await createPostgresConnection(port);
      try {
        // Obtenir la version depuis PostgreSQL directement
        const versionResult = await client.query('SELECT version()');
        const versionMatch = versionResult.rows[0]?.version?.match(/PostgreSQL (\d+\.\d+)/);
        version = versionMatch ? versionMatch[1] : undefined;
        isRunning = true;
      } finally {
        await client.end();
      }
    } catch (connectionError: any) {
      // Si la connexion échoue, vérifier si PostgreSQL est installé mais pas démarré
      const installed = await checkPostgresInstalled();
      if (!installed.installed) {
        throw new Error('PostgreSQL is not installed');
      }
      
      // PostgreSQL est installé mais pas démarré
      return {
        version: installed.version || version || 'unknown',
        port: port,
        isRunning: false,
        databases: [],
        activeConnections: []
      };
    }
    
    // Si on arrive ici, PostgreSQL est en cours d'exécution
    // Obtenir les bases de données et connexions
    const [databases, connections] = await Promise.all([
      listPostgresDatabases(port).catch(() => []),
      listActiveConnections(port).catch(() => [])
    ]);
    
    // Obtenir le répertoire de données si possible
    let dataDirectory: string | undefined;
    try {
      const client = await createPostgresConnection(port);
      try {
        const result = await client.query('SHOW data_directory');
        dataDirectory = result.rows[0]?.data_directory;
      } finally {
        await client.end();
      }
    } catch {
      // Ignore
    }
    
    // Si on n'a pas de version depuis la connexion, essayer de la récupérer autrement
    if (!version) {
      const installed = await checkPostgresInstalled();
      version = installed.version;
    }
    
    return {
      version: version || 'unknown',
      port: port,
      dataDirectory,
      isRunning: true,
      databases,
      activeConnections: connections
    };
  } catch (error: any) {
    logger.error(`Error getting PostgreSQL config info: ${error.message}`);
    throw error;
  }
}


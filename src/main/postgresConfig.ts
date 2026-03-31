import { Client } from 'pg';
import { getErrorMessage } from './utils';
import { logger } from './logger';
import { checkPostgresInstalled } from './postgresManager';

export interface PostgresDatabase {
  name: string;
  owner: string;
  encoding: string;
  collate: string;
  ctype: string;
  size: string;
  connections?: number;
  hasConnections?: boolean;
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
  binVersion?: string;
  binPath?: string;
  port: number;
  dataDirectory?: string;
  isRunning: boolean;
  databases: PostgresDatabase[];
  activeConnections: PostgresConnection[];
}

/**
 * Creates a PostgreSQL connection to the server
 */
async function createPostgresConnection(port: number = 5432, database: string = 'postgres'): Promise<Client> {
  // Detect the PostgreSQL user
  const os = await import('os');
  const currentUser = os.userInfo().username;
  const usersToTry = [currentUser, 'postgres', process.env.USER || '', process.env.USERNAME || ''];
  const isLinux = os.platform() === 'linux';

  // Helper to apply monkey-patch to a connected client
  const patchClient = (client: Client, user: string): Client => {
    logger.info(`Connected to PostgreSQL as ${user} on port ${port}`);
    const originalQuery = client.query;
    client.query = function (this: Client, queryTextOrConfig: any, values?: any, callback?: any) {
      const tag = '/* bbdump-internal */ ';
      if (typeof queryTextOrConfig === 'string') {
        if (!queryTextOrConfig.includes(tag)) {
          queryTextOrConfig = tag + queryTextOrConfig;
        }
      } else if (queryTextOrConfig && typeof queryTextOrConfig.text === 'string') {
        if (!queryTextOrConfig.text.includes(tag)) {
          queryTextOrConfig.text = tag + queryTextOrConfig.text;
        }
      }
      return (originalQuery as any).apply(this, [queryTextOrConfig, values, callback]);
    } as any;
    return client;
  };

  // On Linux, try Unix socket first (peer auth)
  if (isLinux) {
    const socketPaths = ['/var/run/postgresql', '/tmp'];
    for (const user of usersToTry) {
      if (!user) continue;
      for (const socketPath of socketPaths) {
        const client = new Client({
          host: socketPath,
          port: port,
          user: user,
          password: '',
          database: database,
          connectionTimeoutMillis: 5000,
          statement_timeout: 30000
        });
        try {
          await client.connect();
          return patchClient(client, user);
        } catch {
          try { await client.end(); } catch { /* Ignore */ }
        }
      }
    }
  }

  // TCP connections with various passwords
  for (const user of usersToTry) {
    if (!user) continue;

    const passwords = isLinux ? ['postgres', 'admin', 'password'] : ['', 'postgres', 'admin', 'password'];

    for (const pwd of passwords) {
      const client = new Client({
        host: 'localhost',
        port: port,
        user: user,
        password: pwd,
        database: database,
        connectionTimeoutMillis: 5000,
        statement_timeout: 30000
      });

      try {
        await client.connect();
        return patchClient(client, user);
      } catch {
        try { await client.end(); } catch { /* Ignore */ }
      }
    }
  }

  throw new Error(`Cannot connect to PostgreSQL server on port ${port}`);
}

/**
 * Lists all PostgreSQL databases
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
      hasConnections: parseInt(row.connections) > 0
    }));
  } finally {
    await client.end();
  }
}

/**
 * Lists active PostgreSQL connections
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
 * Kills a PostgreSQL connection by PID
 */
export async function killConnection(pid: number, port: number = 5432): Promise<{ success: boolean; error?: string }> {
  const client = await createPostgresConnection(port);

  try {
    // First check that the connection exists
    const checkQuery = `SELECT pid FROM pg_stat_activity WHERE pid = $1`;
    const checkResult = await client.query(checkQuery, [pid]);

    // If the connection doesn't exist, it may have already been closed
    // We still try to kill it in case it still exists
    if (checkResult.rows.length === 0) {
      logger.warn(`Connection with PID ${pid} not found in pg_stat_activity, attempting to terminate anyway`);
    }

    // Use pg_terminate_backend to kill the connection
    // This function returns false if the PID doesn't exist, but doesn't generate an error
    const terminateQuery = `SELECT pg_terminate_backend($1) as terminated`;
    const result = await client.query(terminateQuery, [pid]);

    // Check the result
    const terminated = result.rows[0]?.terminated;

    if (checkResult.rows.length === 0 && !terminated) {
      // The connection didn't exist and couldn't be killed
      return { success: false, error: `Connection with PID ${pid} does not exist or has already been closed` };
    }

    if (!terminated) {
      return { success: false, error: `Failed to terminate connection with PID ${pid}` };
    }

    // Wait a bit for PostgreSQL to update its statistics
    await new Promise(resolve => setTimeout(resolve, 300));

    logger.info(`Terminated PostgreSQL connection with PID ${pid}`);
    return { success: true };
  } catch (error) {
    logger.error(`Error killing connection ${pid}: ${getErrorMessage(error)}`);
    return { success: false, error: getErrorMessage(error) };
  } finally {
    await client.end();
  }
}

/**
 * Disconnects all active connections from a database
 */
export async function disconnectDatabase(dbName: string, port: number = 5432): Promise<{ success: boolean; error?: string; disconnectedCount?: number }> {
  const client = await createPostgresConnection(port);

  try {
    // Check that the database exists
    const checkQuery = `SELECT 1 FROM pg_database WHERE datname = $1`;
    const checkResult = await client.query(checkQuery, [dbName]);

    if (checkResult.rows.length === 0) {
      return { success: false, error: `Database "${dbName}" does not exist` };
    }

    // First count active connections
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

    // Kill all active connections to this database
    const terminateQuery = `
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `;

    await client.query(terminateQuery, [dbName]);

    logger.info(`Disconnected ${connectionCount} connection(s) from database "${dbName}"`);
    return { success: true, disconnectedCount: connectionCount };
  } catch (error) {
    logger.error(`Error disconnecting database ${dbName}: ${getErrorMessage(error)}`);
    return { success: false, error: getErrorMessage(error) };
  } finally {
    await client.end();
  }
}

/**
 * Drops a PostgreSQL database
 */
export async function dropDatabase(dbName: string, port: number = 5432, forceDisconnect: boolean = true): Promise<{ success: boolean; error?: string }> {
  const client = await createPostgresConnection(port);

  try {
    // Check that the database exists
    const checkQuery = `SELECT 1 FROM pg_database WHERE datname = $1`;
    const checkResult = await client.query(checkQuery, [dbName]);

    if (checkResult.rows.length === 0) {
      return { success: false, error: `Database "${dbName}" does not exist` };
    }

    // Prevent deletion of critical system databases
    const systemDatabases = ['postgres', 'template0', 'template1'];
    if (systemDatabases.includes(dbName)) {
      return { success: false, error: `Cannot drop system database "${dbName}"` };
    }

    // Disconnect all active connections if requested
    if (forceDisconnect) {
      const disconnectResult = await disconnectDatabase(dbName, port);
      if (!disconnectResult.success && disconnectResult.error && !disconnectResult.error.includes('does not exist')) {
        // If disconnection fails for a reason other than "doesn't exist", continue anyway
        logger.warn(`Warning: Could not disconnect all connections before dropping database: ${disconnectResult.error}`);
      }
      // Wait a bit for connections to terminate
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Drop the database
    const format = await import('pg-format');
    const dropQuery = format.default('DROP DATABASE %I', dbName);
    await client.query(dropQuery);

    logger.info(`Database "${dbName}" dropped successfully`);
    return { success: true };
  } catch (error) {
    logger.error(`Error dropping database ${dbName}: ${getErrorMessage(error)}`);
    return { success: false, error: getErrorMessage(error) };
  } finally {
    await client.end();
  }
}

/**
 * Tests the connection to a PostgreSQL database and returns the connection info
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
  // Detect the PostgreSQL user
  const os = await import('os');
  const currentUser = os.userInfo().username;
  const usersToTry = [currentUser, 'postgres', process.env.USER || '', process.env.USERNAME || ''];

  // If a password is provided, try with it
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
      } catch (error) {
        try {
          await client.end();
        } catch {
          // Ignore
        }
        // If it's an authentication error, try the next user
        if (getErrorMessage(error).includes('password') || getErrorMessage(error).includes('authentication')) {
          continue;
        }
        // Otherwise, return the error
        return { success: false, error: getErrorMessage(error) };
      }
    }
    return { success: false, error: 'Authentication failed with provided password' };
  }

  const isLinux = os.platform() === 'linux';

  // On Linux, try Unix socket first (peer auth)
  if (isLinux) {
    const socketPaths = ['/var/run/postgresql', '/tmp'];
    for (const user of usersToTry) {
      if (!user) continue;
      for (const socketPath of socketPaths) {
        const client = new Client({
          host: socketPath,
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
          logger.info(`Successfully connected to database "${dbName}" as ${user} via socket (no password)`);
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
        } catch (error) {
          try { await client.end(); } catch { /* Ignore */ }
          if (getErrorMessage(error).includes('does not exist') && !getErrorMessage(error).includes('role')) {
            return { success: false, error: getErrorMessage(error) };
          }
        }
      }
    }
  }

  // Essayer sans mot de passe (macOS trust auth) ou avec des mots de passe courants
  const passwordsToTry = isLinux ? ['postgres'] : [''];
  for (const user of usersToTry) {
    if (!user) continue;

    for (const pwd of passwordsToTry) {
      const client = new Client({
        host: 'localhost',
        port: port,
        user: user,
        password: pwd,
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
            password: pwd,
            database: dbName
          }
        };
      } catch (error) {
        try {
          await client.end();
        } catch {
          // Ignore
        }

        // If it's an authentication error, a password is required
        if (getErrorMessage(error).includes('password') || getErrorMessage(error).includes('authentication') || getErrorMessage(error).includes('SCRAM')) {
          return { success: false, needsPassword: true, error: 'Password required' };
        }

        // Autre erreur (base n'existe pas, etc.)
        return { success: false, error: getErrorMessage(error) };
      }
    }
  }

  return { success: false, needsPassword: true, error: 'Password required' };
}

/**
 * Obtient les informations de configuration PostgreSQL
 */
export async function getPostgresConfigInfo(port: number = 5432): Promise<PostgresConfigInfo> {
  try {
    // First try to connect directly to PostgreSQL
    // If we can connect, PostgreSQL is clearly installed and running
    let version: string | undefined;

    try {
      const client = await createPostgresConnection(port);
      try {
        // Get the version directly from PostgreSQL
        const versionResult = await client.query('SELECT version()');
        const versionMatch = versionResult.rows[0]?.version?.match(/PostgreSQL (\d+\.\d+)/);
        version = versionMatch ? versionMatch[1] : undefined;
      } finally {
        await client.end();
      }
    } catch {
      // If connection fails, check if PostgreSQL is installed but not started
      const installed = await checkPostgresInstalled();
      if (!installed.installed) {
        throw new Error('PostgreSQL is not installed');
      }

      // PostgreSQL is installed but not started
      return {
        version: installed.version || version || 'unknown',
        port: port,
        isRunning: false,
        databases: [],
        activeConnections: []
      };
    }

    // If we get here, PostgreSQL is running
    // Get databases and connections
    const [databases, connections] = await Promise.all([
      listPostgresDatabases(port).catch(() => []),
      listActiveConnections(port).catch(() => [])
    ]);

    // Get the data directory if possible
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

    // Get information about installed tools
    const installed = await checkPostgresInstalled();

    return {
      version: version || 'unknown',
      binVersion: installed.version,
      binPath: installed.path,
      port: port,
      dataDirectory,
      isRunning: true,
      databases,
      activeConnections: connections
    };
  } catch (error) {
    logger.error(`Error getting PostgreSQL config info: ${getErrorMessage(error)}`);
    throw error;
  }
}

/**
 * Lists available and installed extensions for a database
 */
export async function listPostgresExtensions(dbName: string, port: number = 5432): Promise<any[]> {
  const client = await createPostgresConnection(port, dbName);

  try {
    const query = `
      SELECT 
        name,
        default_version,
        installed_version,
        comment,
        (installed_version IS NOT NULL) as is_installed
      FROM pg_available_extensions
      ORDER BY name;
    `;

    const result = await client.query(query);
    return result.rows;
  } catch (error) {
    logger.error(`Error listing extensions for ${dbName}: ${getErrorMessage(error)}`);
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * Installs an extension on a database
 */
export async function installExtension(dbName: string, extensionName: string, port: number = 5432): Promise<{ success: boolean; error?: string }> {
  const client = await createPostgresConnection(port, dbName);

  try {
    const format = await import('pg-format');
    const query = format.default('CREATE EXTENSION IF NOT EXISTS %I', extensionName);
    await client.query(query);
    logger.info(`Extension "${extensionName}" installed on database "${dbName}"`);

    // Automatically update shared_preload_libraries for pg_stat_statements
    if (extensionName === 'pg_stat_statements') {
      const { updateSharedPreloadLibraries } = await import('./postgresManager');
      await updateSharedPreloadLibraries('pg_stat_statements', 'add');
    }

    return { success: true };
  } catch (error) {
    logger.error(`Error installing extension ${extensionName} on ${dbName}: ${getErrorMessage(error)}`);
    return { success: false, error: getErrorMessage(error) };
  } finally {
    await client.end();
  }
}

/**
 * Uninstalls an extension from a database
 */
export async function uninstallExtension(dbName: string, extensionName: string, port: number = 5432): Promise<{ success: boolean; error?: string }> {
  const client = await createPostgresConnection(port, dbName);

  try {
    const format = await import('pg-format');
    const query = format.default('DROP EXTENSION IF EXISTS %I', extensionName);
    await client.query(query);
    logger.info(`Extension "${extensionName}" uninstalled from database "${dbName}"`);

    // Automatiquement retirer pg_stat_statements de shared_preload_libraries
    if (extensionName === 'pg_stat_statements') {
      const { updateSharedPreloadLibraries } = await import('./postgresManager');
      await updateSharedPreloadLibraries('pg_stat_statements', 'remove');
    }

    return { success: true };
  } catch (error) {
    logger.error(`Error uninstalling extension ${extensionName} from ${dbName}: ${getErrorMessage(error)}`);
    return { success: false, error: getErrorMessage(error) };
  } finally {
    await client.end();
  }
}

/**
 * Retrieves performance statistics (pg_stat_statements)
 */
export async function getPostgresPerformanceStats(dbName: string, port: number = 5432): Promise<{
  success: boolean;
  stats?: any[];
  summary?: { totalCalls: number; totalTime: number };
  error?: string;
  extensionActive?: boolean;
  isNotPreloaded?: boolean;
  dataDirectory?: string
}> {
  const client = await createPostgresConnection(port, dbName);

  try {
    // Check if the extension is installed
    const extCheck = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'");
    if (extCheck.rows.length === 0) {
      return { success: true, stats: [], extensionActive: false };
    }

    // Detect the time column name (total_time vs total_exec_time)
    const colCheck = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'pg_stat_statements' AND column_name = 'total_exec_time'
    `);
    const timeColumn = colCheck.rows.length > 0 ? 'total_exec_time' : 'total_time';

    const query = `
      SELECT 
        query,
        calls,
        ${timeColumn} as total_time,
        (${timeColumn} / calls) as mean_time,
        rows,
        100.0 * ${timeColumn} / SUM(${timeColumn}) OVER() as percentage
      FROM pg_stat_statements
      WHERE query NOT LIKE 'FETCH%' -- Ignore noise
        AND query NOT LIKE '%/* bbdump-internal */%' -- Ignore bbdump queries
      ORDER BY ${timeColumn} DESC
      LIMIT 20;
    `;

    const result = await client.query(query);

    // Retrieve the global total for the dashboard (excluding bbdump)
    const summaryQuery = `
      SELECT 
        sum(calls) as total_calls,
        sum(${timeColumn}) as total_time
      FROM pg_stat_statements
      WHERE query NOT LIKE '%/* bbdump-internal */%'
    `;
    const summaryResult = await client.query(summaryQuery);
    const summary = summaryResult.rows[0];

    return {
      success: true,
      stats: result.rows,
      summary: {
        totalCalls: parseInt(summary.total_calls || '0'),
        totalTime: parseFloat(summary.total_time || '0')
      },
      extensionActive: true
    };
  } catch (error) {
    if (getErrorMessage(error).includes('pg_stat_statements must be loaded via shared_preload_libraries')) {
      // Try to retrieve the data directory to help the user
      let dataDir = 'unknown';
      try {
        const dirResult = await client.query('SHOW data_directory');
        dataDir = dirResult.rows[0]?.data_directory;
      } catch { /* ignore */ }

      return { success: true, stats: [], extensionActive: true, isNotPreloaded: true, dataDirectory: dataDir };
    }
    logger.error(`Error getting performance stats for ${dbName}: ${getErrorMessage(error)}`);
    return { success: false, error: getErrorMessage(error) };
  } finally {
    await client.end();
  }
}

/**
 * Resets performance statistics
 */
export async function resetPostgresPerformanceStats(dbName: string, port: number = 5432): Promise<{ success: boolean; error?: string }> {
  const client = await createPostgresConnection(port, dbName);

  try {
    await client.query('SELECT pg_stat_statements_reset()');
    logger.info(`Performance stats reset for database "${dbName}"`);
    return { success: true };
  } catch (error) {
    logger.error(`Error resetting performance stats for ${dbName}: ${getErrorMessage(error)}`);
    return { success: false, error: getErrorMessage(error) };
  } finally {
    await client.end();
  }
}

/**
 * Restarts the PostgreSQL server
 */
export async function restartPostgres(): Promise<{ success: boolean; error?: string }> {
  const { restartPostgresService } = await import('./postgresManager');
  return await restartPostgresService();
}

/**
 * Checks if an extension is configured in the server
 */
export async function checkPostgresConfig(extensionName: string): Promise<{ success: boolean; isPresent: boolean; error?: string }> {
  const { checkSharedPreloadLibraries } = await import('./postgresManager');
  return await checkSharedPreloadLibraries(extensionName);
}

/**
 * Attempts to automatically fix the configuration
 */
export async function fixPostgresConfig(extensionName: string): Promise<{ success: boolean; error?: string }> {
  const { updateSharedPreloadLibraries } = await import('./postgresManager');
  return await updateSharedPreloadLibraries(extensionName, 'add');
}

import { Client } from 'pg';
import { getErrorMessage } from './utils';
import format from 'pg-format';
import { logger } from './logger';
import * as net from 'net';
import * as os from 'os';
import * as postgresManager from './postgresManager';
import { tryPgConnect, getPgClient } from './postgresManager';

interface CreateDatabaseParams {
  name: string;
  displayName?: string;
  port: number;
  password?: string;
}

interface CreateDatabaseResult {
  success: boolean;
  error?: string;
  database?: {
    name: string;
    displayName?: string;
    host: string;
    port: number;
    user: string;
    password: string;
  };
}



/**
 * Vérifie si PostgreSQL est accessible sur un port donné
 * Essaie plusieurs fois avec des délais pour laisser le temps à PostgreSQL de démarrer
 */
async function checkPostgresServer(port: number, password?: string): Promise<{ available: boolean; error?: string }> {
  // Essayer plusieurs fois avec des délais (au cas où PostgreSQL est en train de démarrer)
  const maxAttempts = 5;
  const delayBetweenAttempts = 2000; // 2 secondes
  let lastError: string = '';

  // Détecter l'utilisateur PostgreSQL à utiliser
  const os = await import('os');
  const currentUser = os.userInfo().username;
  const usersToTry = [currentUser, 'postgres', process.env.USER || '', process.env.USERNAME || ''];

  const isLinux = os.platform() === 'linux';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // On Linux, try Unix socket first (peer auth, no password needed)
    if (isLinux) {
      for (const user of usersToTry) {
        if (!user) continue;
        try {
          await tryPgConnect(port, user);
          logger.info(`PostgreSQL server is accessible on port ${port} with user ${user} via socket (attempt ${attempt}/${maxAttempts})`);
          return { available: true };
        } catch (error) {
          lastError = getErrorMessage(error);
        }
      }
    }

    // TCP connections with various passwords
    const passwords = isLinux ? ['postgres', 'admin', 'password'] : ['', 'postgres', 'admin', 'password'];
    if (password) {
      passwords.unshift(password);
    }

    for (const user of usersToTry) {
      if (!user) continue;

      for (const pwd of passwords) {
        const testClient = new Client({
          host: 'localhost',
          port: port,
          user: user,
          password: pwd,
          database: 'postgres',
          connectionTimeoutMillis: 5000
        });

        try {
          await testClient.connect();
          await testClient.end();
          logger.info(`PostgreSQL server is accessible on port ${port} with user ${user} (attempt ${attempt}/${maxAttempts})`);
          return { available: true };
        } catch (error) {
          lastError = getErrorMessage(error);
          try {
            await testClient.end();
          } catch {
            // Ignore errors when closing
          }
        }
      }
    }

    // Si ce n'est pas le dernier essai, attendre avant de réessayer
    if (attempt < maxAttempts) {
      logger.info(`PostgreSQL not accessible yet, waiting ${delayBetweenAttempts}ms before retry (attempt ${attempt}/${maxAttempts})...`);
      await new Promise(resolve => setTimeout(resolve, delayBetweenAttempts));
    }
  }

  // Vérifier si le port est ouvert (pour donner un meilleur message d'erreur)
  const portAvailable = await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.once('close', () => resolve(true));
      server.close();
    });
    server.on('error', () => resolve(false));
  });

  const startHint = isLinux
    ? 'sudo systemctl start postgresql'
    : 'brew services start postgresql@17';
  const checkHint = isLinux
    ? 'systemctl status postgresql'
    : 'brew services list | grep postgresql';

  if (portAvailable) {
    return {
      available: false,
      error: `No PostgreSQL server found on port ${port}. The port is free, which means PostgreSQL is not running on this port.\n\nPlease:\n1. Start PostgreSQL: ${startHint}\n2. Verify PostgreSQL is running: ${checkHint}`
    };
  }

  return {
    available: false,
    error: `Cannot connect to PostgreSQL server on port ${port} after ${maxAttempts} attempts.\n\nLast error: ${lastError}\n\nPossible solutions:\n- Make sure PostgreSQL is installed and running\n- Start PostgreSQL: ${startHint}\n- Check if PostgreSQL is running: ${checkHint}`
  };
}

/**
 * Détecte l'utilisateur PostgreSQL à utiliser
 */
async function detectPostgresUser(port: number, password?: string): Promise<string> {
  const currentUser = os.userInfo().username;
  const usersToTry = [currentUser, 'postgres', process.env.USER || '', process.env.USERNAME || ''];
  const isLinux = os.platform() === 'linux';

  for (const user of usersToTry) {
    if (!user) continue;

    // On Linux, try Unix socket first (peer auth)
    if (isLinux) {
      try {
        await tryPgConnect(port, user);
        logger.info(`Detected PostgreSQL user: ${user} (via socket)`);
        return user;
      } catch {
        // Fall through to TCP
      }
    }

    // TCP with provided password or empty (macOS trust auth)
    try {
      const testClient = new Client({
        host: 'localhost',
        port: port,
        user: user,
        password: password || (isLinux ? 'postgres' : ''),
        database: 'postgres',
        connectionTimeoutMillis: 3000
      });

      await testClient.connect();
      await testClient.end();
      logger.info(`Detected PostgreSQL user: ${user}`);
      return user;
    } catch {
      continue;
    }
  }

  // Par défaut, utiliser l'utilisateur système
  logger.info(`Using system user as default: ${currentUser}`);
  return currentUser;
}

/**
 * Crée une connexion au serveur PostgreSQL (sans spécifier de base)
 */
async function connectToPostgresServer(port: number, password?: string): Promise<Client> {
  // Vérifier d'abord si le serveur est accessible
  const check = await checkPostgresServer(port, password);
  if (!check.available) {
    throw new Error(check.error || `Cannot connect to PostgreSQL server on port ${port}`);
  }

  // Détecter l'utilisateur PostgreSQL à utiliser
  const postgresUser = await detectPostgresUser(port, password);
  const isLinux = os.platform() === 'linux';

  // On Linux, try Unix socket first (peer auth)
  if (isLinux) {
    try {
      const client = await getPgClient(port, postgresUser);
      return client;
    } catch {
      // Fall through to TCP attempts
    }
  }

  // Essayer de se connecter avec différents mots de passe
  const passwords = isLinux ? ['postgres', 'admin', 'password'] : ['', 'postgres', 'admin', 'password'];
  if (password) {
    passwords.unshift(password);
  }

  for (const pwd of passwords) {
    const client = new Client({
      host: 'localhost',
      port: port,
      user: postgresUser,
      password: pwd,
      database: 'postgres',
      connectionTimeoutMillis: 5000
    });

    try {
      await client.connect();
      return client;
    } catch {
      try {
        await client.end();
      } catch {
        // Ignore errors when closing
      }
    }
  }

  throw new Error(`Cannot connect to PostgreSQL server on port ${port} with user ${postgresUser}. Authentication failed. Please check your PostgreSQL credentials.`);
}

/**
 * Crée une base de données PostgreSQL locale
 */
export interface CreateDatabaseProgress {
  step: string;
  message: string;
  progress: number;
}

export async function createLocalDatabase(
  params: CreateDatabaseParams,
  existingPorts: number[],
  onProgress?: (progress: CreateDatabaseProgress) => void
): Promise<CreateDatabaseResult> {
  let client: Client | null = null;

  const reportProgress = (step: string, message: string, progress: number) => {
    if (onProgress) {
      onProgress({ step, message, progress });
    }
    logger.info(`[${step}] ${message}`);
  };

  try {
    // Valider le nom de la base
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(params.name)) {
      return {
        success: false,
        error: 'Database name must start with a letter and contain only letters, numbers, and underscores'
      };
    }

    // S'assurer que PostgreSQL est installé et démarré
    reportProgress('preparing', 'Ensuring PostgreSQL is installed and running...', 10);
    const ensureResult = await postgresManager.ensurePostgreSQL(
      params.port,
      (pgProgress) => {
        reportProgress('preparing', pgProgress.message, 10 + (pgProgress.progress * 0.4));
      }
    );

    if (!ensureResult.success) {
      return {
        success: false,
        error: ensureResult.error || 'Failed to prepare PostgreSQL'
      };
    }

    // Vérifier d'abord si PostgreSQL est accessible sur le port demandé
    reportProgress('checking', `Checking PostgreSQL server accessibility on port ${params.port}...`, 50);
    logger.info(`Checking PostgreSQL server accessibility on port ${params.port}`);
    const check = await checkPostgresServer(params.port, params.password);
    if (!check.available) {
      logger.error(`PostgreSQL server not accessible: ${check.error}`);
      return {
        success: false,
        error: check.error || `PostgreSQL server is not accessible on port ${params.port}. Please make sure PostgreSQL is installed and running on this port.`
      };
    }

    // Utiliser le port demandé (il est déjà vérifié comme accessible)
    const serverPort = params.port;
    reportProgress('connecting', `Connecting to PostgreSQL server on port ${serverPort}...`, 55);
    logger.info(`Connecting to PostgreSQL server on port ${serverPort} for database ${params.name}`);

    // Se connecter au serveur PostgreSQL
    client = await connectToPostgresServer(serverPort, params.password);
    logger.info(`Connected to PostgreSQL server on port ${serverPort}`);

    // Vérifier si la base existe déjà
    reportProgress('checking', `Checking if database "${params.name}" already exists...`, 60);
    const checkQuery = `SELECT 1 FROM pg_database WHERE datname = $1`;
    const checkResult = await client.query(checkQuery, [params.name]);

    if (checkResult.rows.length > 0) {
      await client.end();
      return {
        success: false,
        error: `Database "${params.name}" already exists`
      };
    }

    // Créer la base de données (utiliser pg-format pour échapper le nom)
    reportProgress('creating', `Creating database "${params.name}"...`, 70);
    const createQuery = format('CREATE DATABASE %I', params.name);
    await client.query(createQuery);
    logger.info(`Database "${params.name}" created successfully`);

    await client.end();
    reportProgress('complete', `Database "${params.name}" created successfully`, 100);

    // Détecter l'utilisateur PostgreSQL utilisé pour cette connexion
    const postgresUser = await detectPostgresUser(serverPort, params.password);

    // Retourner les informations de connexion avec l'utilisateur détecté
    return {
      success: true,
      database: {
        name: params.name,
        displayName: params.displayName,
        host: 'localhost',
        port: serverPort,
        user: postgresUser,
        password: params.password || '' // Utiliser le mot de passe fourni ou vide
      }
    };
  } catch (error) {
    if (client) {
      try {
        await client.end();
      } catch {
        // Ignore errors when closing
      }
    }

    logger.error(`Error creating database: ${getErrorMessage(error)}`);
    return {
      success: false,
      error: getErrorMessage(error) || 'Failed to create database'
    };
  }
}


export interface DuplicateDatabaseProgress {
  step: string;
  message: string;
  progress: number;
}

/**
 * Duplique une base de données externe vers une base locale
 */
export async function duplicateExternalToLocal(
  _sourceDb: {
    name: string;
    host: string;
    port: number;
    user: string;
    password?: string;
    ssl?: boolean;
    connectionString?: string;
  },
  _newDbName: string,
  _newPort: number,
  _existingPorts: number[],
  _onProgress?: (progress: DuplicateDatabaseProgress) => void
): Promise<{ success: boolean; error?: string; database?: any }> {
  // Cette fonction orchestre le backup et le restore
  // Mais comme elle dépend de backupManager qui dépend de config... 
  // Idéalement cette orchestration devrait être faite dans l'IPC handler ou un module supérieur.
  // CEPENDANT, pour résoudre l'erreur de compilation rapidement :
  // Je vais retourner une erreur disant que cette fonction doit être gérée par l'appelant pour l'instant
  // OU MIEUX : je déplace la logique de "duplicate" de l'IPC vers ici ? Non, car ça dépend de `backupManager`.

  // Correction : L'erreur TS dit que `duplicateExternalToLocal` n'existe pas dans `databaseCreator`.
  // C'est parce que j'ai laissé l'appel dans `databaseCreationIpc.ts` mais je n'ai pas implémenté la fonction.
  // La logique était DANS `main.ts` auparavant.
  // Je dois donc implémenter cette fonction ici, en important `backupManager`.

  // Problème : Circular dependency probable si j'importe `backupManager` ici.
  // `backupManager` est utilisé par `databaseCreator` ??? Non.

  // Solution pour le refactoring :
  // Je vais implémenter `duplicateExternalToLocal` DANS `databaseCreationIpc.ts` directement,
  // au lieu d'appeler `databaseCreator`.
  // `databaseCreator` ne devrait s'occuper que de CRÉER une base vide (ce qu'il fait déjà avec `createLocalDatabase`).
  // L'orchestration (Backup -> Create -> Restore) est une logique "métier" supérieure.

  return { success: false, error: "Not implemented in databaseCreator, logic moved to IPC" };
}

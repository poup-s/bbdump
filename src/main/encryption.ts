import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { pathManager } from './paths';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_FILE = pathManager.encryptionKeyPath;

class EncryptionManager {
  private encryptionKey: Buffer | null = null;

  constructor() {
    this.initializeKey();
  }

  private initializeKey(): void {
    try {
      if (fs.existsSync(KEY_FILE)) {
        // Charger la clé existante
        const keyData = fs.readFileSync(KEY_FILE, 'utf8');
        this.encryptionKey = Buffer.from(keyData, 'hex');
        logger.info('Clé de chiffrement chargée');
      } else {
        // Générer une nouvelle clé
        this.encryptionKey = crypto.randomBytes(KEY_LENGTH);
        fs.writeFileSync(KEY_FILE, this.encryptionKey.toString('hex'), 'utf8');
        // Permissions restrictives (lecture/écriture pour le propriétaire seulement)
        try {
          fs.chmodSync(KEY_FILE, 0o600);
        } catch (error) {
          logger.warn(`Impossible de définir les permissions du fichier de clé: ${error}`);
        }
        logger.info('Nouvelle clé de chiffrement générée et sauvegardée');
      }
    } catch (error) {
      logger.error(`Erreur lors de l'initialisation de la clé de chiffrement: ${error}`);
      // Générer une clé temporaire en mémoire
      this.encryptionKey = crypto.randomBytes(KEY_LENGTH);
      logger.warn('Utilisation d\'une clé de chiffrement temporaire (non persistante)');
    }
  }

  encrypt(text: string): string {
    if (!this.encryptionKey) {
      throw new Error('Clé de chiffrement non initialisée');
    }

    try {
      // Générer un IV (Initialization Vector) aléatoire
      const iv = crypto.randomBytes(IV_LENGTH);

      // Créer le cipher
      const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);

      // Chiffrer le texte
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      // Récupérer l'auth tag
      const authTag = cipher.getAuthTag();

      // Combiner IV + authTag + texte chiffré
      const result = iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;

      return result;
    } catch (error) {
      logger.error(`Erreur lors du chiffrement: ${error}`);
      throw error;
    }
  }

  decrypt(encryptedText: string): string {
    if (!this.encryptionKey) {
      throw new Error('Clé de chiffrement non initialisée');
    }

    try {
      // Séparer IV, authTag et texte chiffré
      const parts = encryptedText.split(':');
      if (parts.length !== 3) {
        // Format ancien ou invalide - retourner tel quel
        // (pour compatibilité avec anciennes configs non chiffrées)
        return encryptedText;
      }

      const iv = Buffer.from(parts[0], 'hex');
      const authTag = Buffer.from(parts[1], 'hex');
      const encrypted = parts[2];

      // Créer le decipher
      const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv);
      decipher.setAuthTag(authTag);

      // Déchiffrer
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      logger.error(`Erreur lors du déchiffrement: ${error}`);
      // Throw error to let the caller know decryption failed
      throw new Error(`Decryption failed: ${error}`);
    }
  }

  isEncrypted(text: string): boolean {
    // Vérifier si le texte est au format chiffré (iv:authTag:encrypted)
    // IV = 32 hex chars, authTag = 32 hex chars, encrypted = hex string
    const parts = text.split(':');
    if (parts.length !== 3) return false;
    const hexPattern = /^[0-9a-f]+$/i;
    return parts[0].length === IV_LENGTH * 2
      && parts[1].length === AUTH_TAG_LENGTH * 2
      && hexPattern.test(parts[0])
      && hexPattern.test(parts[1])
      && hexPattern.test(parts[2])
      && parts[2].length > 0;
  }

  // Migrer une configuration non chiffrée vers chiffrée
  migrateConfig(config: any): any {
    if (!config.databases || !Array.isArray(config.databases)) {
      return config;
    }

    let migrated = false;
    const migratedConfig = {
      ...config,
      databases: config.databases.map((db: any) => {
        if (db.password && !this.isEncrypted(db.password)) {
          migrated = true;
          logger.info(`Migration du mot de passe chiffré pour ${db.name}`);
          return {
            ...db,
            password: this.encrypt(db.password)
          };
        }
        return db;
      })
    };

    if (migrated) {
      logger.info('Configuration migrée vers des mots de passe chiffrés');
    }

    return migratedConfig;
  }
}

export const encryptionManager = new EncryptionManager();


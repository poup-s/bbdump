import * as crypto from 'crypto';
import * as fs from 'fs';
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
        // Load the existing key
        const keyData = fs.readFileSync(KEY_FILE, 'utf8');
        this.encryptionKey = Buffer.from(keyData, 'hex');
        logger.info('Encryption key loaded');
      } else {
        // Generate a new key
        this.encryptionKey = crypto.randomBytes(KEY_LENGTH);
        fs.writeFileSync(KEY_FILE, this.encryptionKey.toString('hex'), 'utf8');
        // Restrictive permissions (read/write for the owner only)
        try {
          fs.chmodSync(KEY_FILE, 0o600);
        } catch (error) {
          logger.warn(`Unable to set key file permissions: ${error}`);
        }
        logger.info('New encryption key generated and saved');
      }
    } catch (error) {
      logger.error(`Error initializing the encryption key: ${error}`);
      // Generate a temporary key in memory
      this.encryptionKey = crypto.randomBytes(KEY_LENGTH);
      logger.warn('Using a temporary encryption key (non-persistent)');
    }
  }

  encrypt(text: string): string {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not initialized');
    }

    try {
      // Generate a random IV (Initialization Vector)
      const iv = crypto.randomBytes(IV_LENGTH);

      // Create the cipher
      const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);

      // Encrypt the text
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      // Retrieve the auth tag
      const authTag = cipher.getAuthTag();

      // Combine IV + authTag + encrypted text
      const result = iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;

      return result;
    } catch (error) {
      logger.error(`Error during encryption: ${error}`);
      throw error;
    }
  }

  decrypt(encryptedText: string): string {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not initialized');
    }

    try {
      // Separate IV, authTag and encrypted text
      const parts = encryptedText.split(':');
      if (parts.length !== 3) {
        // Old or invalid format - return as is
        // (for compatibility with old unencrypted configs)
        return encryptedText;
      }

      const iv = Buffer.from(parts[0], 'hex');
      const authTag = Buffer.from(parts[1], 'hex');
      const encrypted = parts[2];

      // Create the decipher
      const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv);
      decipher.setAuthTag(authTag);

      // Decrypt
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      logger.error(`Error during decryption: ${error}`);
      // Throw error to let the caller know decryption failed
      throw new Error(`Decryption failed: ${error}`);
    }
  }

  isEncrypted(text: string): boolean {
    // Check if the text is in encrypted format (iv:authTag:encrypted)
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

  // Migrate an unencrypted configuration to encrypted
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
          logger.info(`Migrating encrypted password for ${db.name}`);
          return {
            ...db,
            password: this.encrypt(db.password)
          };
        }
        return db;
      })
    };

    if (migrated) {
      logger.info('Configuration migrated to encrypted passwords');
    }

    return migratedConfig;
  }
}

export const encryptionManager = new EncryptionManager();


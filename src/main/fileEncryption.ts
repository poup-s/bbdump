import * as crypto from 'crypto';
import * as fs from 'fs';
import { logger } from './logger';
import { encryptionManager } from './encryption';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const CHUNK_SIZE = 64 * 1024; // 64KB chunks

/**
 * Classe pour chiffrer/déchiffrer des fichiers de backup
 */
class FileEncryptionManager {
  
  /**
   * Vérifie si un fichier est chiffré en lisant son en-tête
   */
  isFileEncrypted(filePath: string): boolean {
    try {
      if (!fs.existsSync(filePath)) {
        return false;
      }
      
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(32);
      fs.readSync(fd, buffer as unknown as NodeJS.ArrayBufferView, 0, 32, 0);
      fs.closeSync(fd);
      
      // Vérifier le magic number "BBDUMP_ENCRYPTED_V1"
      const magicNumber = buffer.toString('utf8', 0, 19);
      return magicNumber === 'BBDUMP_ENCRYPTED_V1';
    } catch (error) {
      logger.error(`Erreur lors de la vérification du chiffrement: ${error}`);
      return false;
    }
  }

  /**
   * Chiffre un fichier
   */
  async encryptFile(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const safeResolve = () => { if (!settled) { settled = true; resolve(); } };
      const safeReject = (err: any) => { if (!settled) { settled = true; reject(err); } };

      try {
        const key = encryptionManager['encryptionKey']; // Accès à la clé privée
        if (!key) {
          throw new Error('Clé de chiffrement non disponible');
        }

        // Générer un IV aléatoire
        const iv = crypto.randomBytes(IV_LENGTH);

        // Créer le cipher
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

        // Créer les streams
        const input = fs.createReadStream(inputPath, { highWaterMark: CHUNK_SIZE });
        const output = fs.createWriteStream(outputPath);

        // Écrire l'en-tête du fichier chiffré
        // Format: MAGIC_NUMBER(19 bytes) + IV(16 bytes) + AUTH_TAG_PLACEHOLDER(16 bytes)
        const header = Buffer.alloc(19 + IV_LENGTH + AUTH_TAG_LENGTH);
        header.write('BBDUMP_ENCRYPTED_V1', 0, 19, 'utf8');
        iv.copy(header, 19);
        // Le tag sera écrit à la fin
        output.write(header);

        // Chiffrer et écrire les données
        input.on('data', (chunk: string | Buffer) => {
          const encrypted = cipher.update(chunk as unknown as NodeJS.ArrayBufferView);
          output.write(encrypted);
        });

        input.on('end', () => {
          const finalData = cipher.final();
          output.write(finalData);

          // Récupérer et écrire le tag d'authentification
          const authTag = cipher.getAuthTag();

          // Revenir en arrière pour écrire le tag dans l'en-tête
          output.end(() => {
            try {
              const fd = fs.openSync(outputPath, 'r+');
              const bytesWritten = fs.writeSync(fd, authTag as unknown as NodeJS.ArrayBufferView, 0, AUTH_TAG_LENGTH, 19 + IV_LENGTH);
              fs.closeSync(fd);

              if (bytesWritten !== AUTH_TAG_LENGTH) {
                throw new Error(`Échec de l'écriture du tag d'authentification`);
              }

              logger.info(`Fichier chiffré: ${outputPath}`);
              safeResolve();
            } catch (error) {
              logger.error(`Erreur lors de l'écriture du tag: ${error}`);
              safeReject(error);
            }
          });
        });

        input.on('error', (error) => {
          logger.error(`Erreur lors de la lecture du fichier: ${error}`);
          output.destroy();
          safeReject(error);
        });

        output.on('error', (error) => {
          logger.error(`Erreur lors de l'écriture du fichier chiffré: ${error}`);
          input.destroy();
          safeReject(error);
        });

      } catch (error) {
        logger.error(`Erreur lors du chiffrement du fichier: ${error}`);
        safeReject(error);
      }
    });
  }

  /**
   * Déchiffre un fichier
   */
  async decryptFile(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const safeResolve = () => { if (!settled) { settled = true; resolve(); } };
      const safeReject = (err: any) => { if (!settled) { settled = true; reject(err); } };

      try {
        const key = encryptionManager['encryptionKey'];
        if (!key) {
          throw new Error('Clé de chiffrement non disponible');
        }

        // Lire l'en-tête du fichier
        const fd = fs.openSync(inputPath, 'r');
        const headerBuffer = Buffer.alloc(19 + IV_LENGTH + AUTH_TAG_LENGTH);
        fs.readSync(fd, headerBuffer as unknown as NodeJS.ArrayBufferView, 0, headerBuffer.length, 0);

        // Vérifier le magic number
        const magicNumber = headerBuffer.toString('utf8', 0, 19);
        if (magicNumber !== 'BBDUMP_ENCRYPTED_V1') {
          fs.closeSync(fd);
          throw new Error('Format de fichier chiffré invalide');
        }

        // Extraire IV et auth tag
        const iv = headerBuffer.slice(19, 19 + IV_LENGTH);
        const authTag = headerBuffer.slice(19 + IV_LENGTH, 19 + IV_LENGTH + AUTH_TAG_LENGTH);

        fs.closeSync(fd);

        // Créer le decipher
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        // Créer les streams (skip header)
        const input = fs.createReadStream(inputPath, {
          start: 19 + IV_LENGTH + AUTH_TAG_LENGTH,
          highWaterMark: CHUNK_SIZE
        });
        const output = fs.createWriteStream(outputPath);

        // Déchiffrer et écrire les données
        input.on('data', (chunk: string | Buffer) => {
          try {
            const decrypted = decipher.update(chunk as unknown as NodeJS.ArrayBufferView);
            output.write(decrypted);
          } catch (error) {
            input.destroy();
            output.destroy();
            safeReject(error);
          }
        });

        input.on('end', () => {
          try {
            const finalData = decipher.final();
            output.write(finalData);
            output.end(() => {
              logger.info(`Fichier déchiffré: ${outputPath}`);
              safeResolve();
            });
          } catch (error) {
            output.destroy();
            safeReject(error);
          }
        });

        input.on('error', (error) => {
          logger.error(`Erreur lors de la lecture du fichier chiffré: ${error}`);
          output.destroy();
          safeReject(error);
        });

        output.on('error', (error) => {
          logger.error(`Erreur lors de l'écriture du fichier déchiffré: ${error}`);
          input.destroy();
          safeReject(error);
        });

      } catch (error) {
        logger.error(`Erreur lors du déchiffrement du fichier: ${error}`);
        safeReject(error);
      }
    });
  }
}

export const fileEncryptionManager = new FileEncryptionManager();


import * as crypto from 'crypto';
import * as fs from 'fs';
import { logger } from './logger';
import { encryptionManager } from './encryption';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const CHUNK_SIZE = 64 * 1024; // 64KB chunks

/**
 * Class for encrypting/decrypting backup files
 */
class FileEncryptionManager {
  
  /**
   * Checks if a file is encrypted by reading its header
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
      
      // Check the magic number "BBDUMP_ENCRYPTED_V1"
      const magicNumber = buffer.toString('utf8', 0, 19);
      return magicNumber === 'BBDUMP_ENCRYPTED_V1';
    } catch (error) {
      logger.error(`Error checking encryption status: ${error}`);
      return false;
    }
  }

  /**
   * Encrypts a file
   */
  async encryptFile(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const safeResolve = () => { if (!settled) { settled = true; resolve(); } };
      const safeReject = (err: any) => { if (!settled) { settled = true; reject(err); } };

      try {
        const key = encryptionManager['encryptionKey']; // Access to the private key
        if (!key) {
          throw new Error('Encryption key not available');
        }

        // Generate a random IV
        const iv = crypto.randomBytes(IV_LENGTH);

        // Create the cipher
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

        // Create the streams
        const input = fs.createReadStream(inputPath, { highWaterMark: CHUNK_SIZE });
        const output = fs.createWriteStream(outputPath);

        // Write the encrypted file header
        // Format: MAGIC_NUMBER(19 bytes) + IV(16 bytes) + AUTH_TAG_PLACEHOLDER(16 bytes)
        const header = Buffer.alloc(19 + IV_LENGTH + AUTH_TAG_LENGTH);
        header.write('BBDUMP_ENCRYPTED_V1', 0, 19, 'utf8');
        iv.copy(header, 19);
        // The tag will be written at the end
        output.write(header);

        // Encrypt and write the data
        input.on('data', (chunk: string | Buffer) => {
          const encrypted = cipher.update(chunk as unknown as NodeJS.ArrayBufferView);
          output.write(encrypted);
        });

        input.on('end', () => {
          const finalData = cipher.final();
          output.write(finalData);

          // Retrieve and write the authentication tag
          const authTag = cipher.getAuthTag();

          // Go back to write the tag in the header
          output.end(() => {
            try {
              const fd = fs.openSync(outputPath, 'r+');
              const bytesWritten = fs.writeSync(fd, authTag as unknown as NodeJS.ArrayBufferView, 0, AUTH_TAG_LENGTH, 19 + IV_LENGTH);
              fs.closeSync(fd);

              if (bytesWritten !== AUTH_TAG_LENGTH) {
                throw new Error(`Failed to write the authentication tag`);
              }

              logger.info(`File encrypted: ${outputPath}`);
              safeResolve();
            } catch (error) {
              logger.error(`Error writing the tag: ${error}`);
              safeReject(error);
            }
          });
        });

        input.on('error', (error) => {
          logger.error(`Error reading the file: ${error}`);
          output.destroy();
          safeReject(error);
        });

        output.on('error', (error) => {
          logger.error(`Error writing the encrypted file: ${error}`);
          input.destroy();
          safeReject(error);
        });

      } catch (error) {
        logger.error(`Error encrypting the file: ${error}`);
        safeReject(error);
      }
    });
  }

  /**
   * Decrypts a file
   */
  async decryptFile(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const safeResolve = () => { if (!settled) { settled = true; resolve(); } };
      const safeReject = (err: any) => { if (!settled) { settled = true; reject(err); } };

      try {
        const key = encryptionManager['encryptionKey'];
        if (!key) {
          throw new Error('Encryption key not available');
        }

        // Read the file header
        const fd = fs.openSync(inputPath, 'r');
        const headerBuffer = Buffer.alloc(19 + IV_LENGTH + AUTH_TAG_LENGTH);
        fs.readSync(fd, headerBuffer as unknown as NodeJS.ArrayBufferView, 0, headerBuffer.length, 0);

        // Check the magic number
        const magicNumber = headerBuffer.toString('utf8', 0, 19);
        if (magicNumber !== 'BBDUMP_ENCRYPTED_V1') {
          fs.closeSync(fd);
          throw new Error('Invalid encrypted file format');
        }

        // Extract IV and auth tag
        const iv = headerBuffer.slice(19, 19 + IV_LENGTH);
        const authTag = headerBuffer.slice(19 + IV_LENGTH, 19 + IV_LENGTH + AUTH_TAG_LENGTH);

        fs.closeSync(fd);

        // Create the decipher
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        // Create the streams (skip header)
        const input = fs.createReadStream(inputPath, {
          start: 19 + IV_LENGTH + AUTH_TAG_LENGTH,
          highWaterMark: CHUNK_SIZE
        });
        const output = fs.createWriteStream(outputPath);

        // Decrypt and write the data
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
              logger.info(`File decrypted: ${outputPath}`);
              safeResolve();
            });
          } catch (error) {
            output.destroy();
            safeReject(error);
          }
        });

        input.on('error', (error) => {
          logger.error(`Error reading the encrypted file: ${error}`);
          output.destroy();
          safeReject(error);
        });

        output.on('error', (error) => {
          logger.error(`Error writing the decrypted file: ${error}`);
          input.destroy();
          safeReject(error);
        });

      } catch (error) {
        logger.error(`Error decrypting the file: ${error}`);
        safeReject(error);
      }
    });
  }
}

export const fileEncryptionManager = new FileEncryptionManager();


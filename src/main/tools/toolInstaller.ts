import { spawn } from 'child_process';
import { exec } from 'child_process';
import { promisify } from 'util';
import { detectOS, getOSType } from '../os/osDetector';
import { logger } from '../logger';

const execAsync = promisify(exec);

export interface InstallationProgress {
  step: string;
  message: string;
  progress: number; // 0-100
}

/**
 * Installe Homebrew sur macOS
 */
export async function installHomebrew(
  onProgress: (progress: InstallationProgress) => void
): Promise<{ success: boolean; error?: string }> {
  if (getOSType() !== 'macos') {
    return { success: false, error: 'Homebrew installation is only available on macOS' };
  }

  try {
    onProgress({ step: 'downloading', message: 'Téléchargement du script d\'installation Homebrew...', progress: 10 });
    
    return new Promise((resolve) => {
      const curlProcess = spawn('curl', ['-fsSL', 'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let script = '';
      curlProcess.stdout?.on('data', (data) => {
        script += data.toString();
      });

      curlProcess.stderr?.on('data', (data) => {
        logger.warn(`curl: ${data.toString().trim()}`);
      });

      curlProcess.on('close', async (code) => {
        if (code !== 0) {
          resolve({
            success: false,
            error: 'Échec du téléchargement du script d\'installation Homebrew'
          });
          return;
        }

        onProgress({ step: 'installing', message: 'Installation de Homebrew (cela peut prendre quelques minutes)...', progress: 30 });
        logger.info('Installation de Homebrew...');

        const bashProcess = spawn('bash', ['-c', script], {
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let output = '';
        bashProcess.stdout?.on('data', (data) => {
          output += data.toString();
          logger.info(`Homebrew install: ${data.toString().trim()}`);
        });

        bashProcess.stderr?.on('data', (data) => {
          output += data.toString();
          logger.warn(`Homebrew install: ${data.toString().trim()}`);
        });

        bashProcess.on('close', (installCode) => {
          if (installCode === 0) {
            onProgress({ step: 'complete', message: 'Homebrew installé avec succès', progress: 100 });
            resolve({ success: true });
          } else {
            resolve({
              success: false,
              error: `Échec de l'installation de Homebrew: ${output}`
            });
          }
        });
      });
    });
  } catch (error: any) {
    return {
      success: false,
      error: `Échec de l'installation de Homebrew: ${error.message}`
    };
  }
}

/**
 * Installe PostgreSQL selon l'OS
 */
export async function installPostgreSQL(
  onProgress: (progress: InstallationProgress) => void
): Promise<{ success: boolean; error?: string }> {
  const os = detectOS();
  
  if (os.type === 'macos') {
    return installPostgresMacOS(onProgress);
  } else if (os.type === 'linux') {
    return installPostgresLinux(onProgress);
  } else {
    return {
      success: false,
      error: 'L\'installation de PostgreSQL sur Windows n\'est pas encore supportée. Veuillez l\'installer manuellement depuis https://www.postgresql.org/download/windows/'
    };
  }
}

/**
 * Installe PostgreSQL sur macOS avec Homebrew
 */
async function installPostgresMacOS(
  onProgress: (progress: InstallationProgress) => void
): Promise<{ success: boolean; error?: string }> {
  try {
    // Vérifier si Homebrew est installé
    onProgress({ step: 'checking', message: 'Vérification de l\'installation de Homebrew...', progress: 10 });
    try {
      await execAsync('brew --version');
    } catch {
      return {
        success: false,
        error: 'Homebrew n\'est pas installé. Veuillez installer Homebrew d\'abord: https://brew.sh'
      };
    }

    // Installer PostgreSQL (essayer la version la plus récente d'abord)
    onProgress({ step: 'installing', message: 'Installation de PostgreSQL via Homebrew...', progress: 30 });
    logger.info('Installation de PostgreSQL via Homebrew...');
    
    return new Promise((resolve) => {
      // Essayer PostgreSQL 17 d'abord, puis 16 en fallback
      const brewProcess = spawn('brew', ['install', 'postgresql@17'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      brewProcess.stdout?.on('data', (data) => {
        output += data.toString();
        logger.info(`Homebrew: ${data.toString().trim()}`);
      });

      brewProcess.stderr?.on('data', (data) => {
        output += data.toString();
        logger.warn(`Homebrew: ${data.toString().trim()}`);
      });

      brewProcess.on('close', async (code) => {
        if (code === 0) {
          onProgress({ step: 'installing', message: 'PostgreSQL installé avec succès', progress: 80 });
          resolve({ success: true });
        } else {
          // Essayer PostgreSQL 16 en fallback
          logger.info('PostgreSQL 17 non disponible, essai avec PostgreSQL 16...');
          onProgress({ step: 'installing', message: 'Essai avec PostgreSQL 16...', progress: 30 });
          
          const brewProcess16 = spawn('brew', ['install', 'postgresql@16'], {
            stdio: ['ignore', 'pipe', 'pipe']
          });

          let output16 = '';
          brewProcess16.stdout?.on('data', (data) => {
            output16 += data.toString();
            logger.info(`Homebrew: ${data.toString().trim()}`);
          });

          brewProcess16.stderr?.on('data', (data) => {
            output16 += data.toString();
            logger.warn(`Homebrew: ${data.toString().trim()}`);
          });

          brewProcess16.on('close', (code16) => {
            if (code16 === 0) {
              onProgress({ step: 'installing', message: 'PostgreSQL installé avec succès', progress: 80 });
              resolve({ success: true });
            } else {
              resolve({
                success: false,
                error: `Échec de l'installation de PostgreSQL: ${output}\n\nTentative avec PostgreSQL 16: ${output16}`
              });
            }
          });
        }
      });
    });
  } catch (error: any) {
    return {
      success: false,
      error: `Échec de l'installation de PostgreSQL: ${error.message}`
    };
  }
}

/**
 * Installe PostgreSQL sur Linux
 */
async function installPostgresLinux(
  onProgress: (progress: InstallationProgress) => void
): Promise<{ success: boolean; error?: string }> {
  try {
    // Détecter le gestionnaire de paquets
    onProgress({ step: 'checking', message: 'Détection du gestionnaire de paquets...', progress: 10 });
    
    let installCommand: string[];
    let updateCommand: string[];
    
    try {
      await execAsync('which apt-get');
      // Debian/Ubuntu
      updateCommand = ['apt-get', 'update'];
      installCommand = ['apt-get', 'install', '-y', 'postgresql', 'postgresql-contrib'];
    } catch {
      try {
        await execAsync('which yum');
        // RHEL/CentOS
        installCommand = ['yum', 'install', '-y', 'postgresql-server', 'postgresql-contrib'];
        updateCommand = [];
      } catch {
        return {
          success: false,
          error: 'Distribution Linux non supportée. Veuillez installer PostgreSQL manuellement.'
        };
      }
    }

    // Mettre à jour les paquets si nécessaire
    if (updateCommand.length > 0) {
      onProgress({ step: 'updating', message: 'Mise à jour de la liste des paquets...', progress: 20 });
      await execAsync(updateCommand.join(' '));
    }

    // Installer PostgreSQL
    onProgress({ step: 'installing', message: 'Installation de PostgreSQL...', progress: 40 });
    logger.info(`Installation de PostgreSQL avec: ${installCommand.join(' ')}`);
    await execAsync(installCommand.join(' '));

    // Initialiser la base de données
    onProgress({ step: 'initdb', message: 'Initialisation de la base de données PostgreSQL...', progress: 80 });
    try {
      await execAsync('postgresql-setup --initdb || /usr/pgsql-*/bin/postgresql-setup --initdb');
    } catch (error: any) {
      logger.warn(`Initdb peut avoir échoué ou être déjà fait: ${error.message}`);
    }

    onProgress({ step: 'installing', message: 'PostgreSQL installé avec succès', progress: 100 });
    return { success: true };
  } catch (error: any) {
    return {
      success: false,
      error: `Échec de l'installation de PostgreSQL: ${error.message}`
    };
  }
}


import { spawn, exec } from 'child_process';
import { getErrorMessage } from '../utils';
import { promisify } from 'util';
import { detectOS, getOSType } from '../os/osDetector';
import { logger } from '../logger';

const execAsync = promisify(exec);

export interface InstallationProgress {
  step: string;
  message: string;
  progress: number; // 0-100
}

export interface InstallationResult {
  success: boolean;
  error?: string;
  externalInstallation?: boolean;
  instructions?: string;
}

/**
 * Installs Homebrew on macOS by opening Terminal.app
 * (Homebrew requires an interactive TTY for sudo)
 */
export async function installHomebrew(
  onProgress: (progress: InstallationProgress) => void
): Promise<InstallationResult> {
  if (getOSType() !== 'macos') {
    return { success: false, error: 'Homebrew installation is only available on macOS' };
  }

  try {
    onProgress({ step: 'opening-terminal', message: 'Ouverture du Terminal...', progress: 50 });

    const homebrewInstallCommand = '/bin/bash -c \\"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\\"';

    // Use osascript to open Terminal.app with the command
    const appleScript = [
      'tell application "Terminal"',
      '  activate',
      `  do script "${homebrewInstallCommand}"`,
      'end tell'
    ].join('\n');

    await execAsync(`osascript -e '${appleScript}'`);

    logger.info('Opened Terminal.app with Homebrew install command');

    onProgress({
      step: 'waiting',
      message: 'Terminal ouvert. Terminez l\'installation puis cliquez sur Revérifier.',
      progress: 100
    });

    return {
      success: true,
      externalInstallation: true,
      instructions: 'Une fenêtre Terminal a été ouverte avec la commande d\'installation de Homebrew. Suivez les instructions dans le Terminal, puis revenez ici et cliquez sur "Revérifier".'
    };
  } catch (error) {
    logger.error(`Failed to open Terminal for Homebrew installation: ${getErrorMessage(error)}`);
    return {
      success: false,
      error: `Impossible d'ouvrir le Terminal. Veuillez installer Homebrew manuellement en exécutant cette commande dans le Terminal :\n\n/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
    };
  }
}

/**
 * Installs PostgreSQL based on the OS
 */
export async function installPostgreSQL(
  onProgress: (progress: InstallationProgress) => void,
  options?: { brewPath?: string }
): Promise<InstallationResult> {
  const os = detectOS();

  if (os.type === 'macos') {
    return installPostgresMacOS(onProgress, options?.brewPath);
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
 * Installs PostgreSQL on macOS with Homebrew (uses the full brew path)
 */
async function installPostgresMacOS(
  onProgress: (progress: InstallationProgress) => void,
  brewPath?: string
): Promise<InstallationResult> {
  try {
    onProgress({ step: 'checking', message: 'Vérification de l\'installation de Homebrew...', progress: 10 });

    // Resolve the brew path if not provided
    if (!brewPath) {
      const { detectHomebrew } = await import('./toolDetector');
      const homebrewResult = await detectHomebrew();
      if (homebrewResult.installed && homebrewResult.path) {
        brewPath = homebrewResult.path;
      }
    }

    if (!brewPath) {
      return {
        success: false,
        error: 'Homebrew n\'est pas installé. Veuillez installer Homebrew d\'abord, puis revérifier.'
      };
    }

    logger.info(`Using Homebrew at: ${brewPath}`);

    // Build an enhanced env with Homebrew paths
    const brewBinDir = brewPath.replace(/\/brew$/, '');
    const enhancedEnv = {
      ...process.env,
      PATH: `${brewBinDir}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`
    };

    // Install PostgreSQL (try the most recent version first)
    onProgress({ step: 'installing', message: 'Installation de PostgreSQL via Homebrew...', progress: 30 });
    logger.info(`Installation de PostgreSQL via Homebrew (using: ${brewPath})...`);

    return new Promise((resolve) => {
      const brewProcess = spawn(brewPath!, ['install', 'postgresql@17'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: enhancedEnv
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
          onProgress({ step: 'complete', message: 'PostgreSQL installé avec succès', progress: 100 });
          resolve({ success: true });
        } else {
          // Try PostgreSQL 16 as fallback
          logger.info('PostgreSQL 17 non disponible, essai avec PostgreSQL 16...');
          onProgress({ step: 'installing', message: 'Essai avec PostgreSQL 16...', progress: 30 });

          const brewProcess16 = spawn(brewPath!, ['install', 'postgresql@16'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: enhancedEnv
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
              onProgress({ step: 'complete', message: 'PostgreSQL installé avec succès', progress: 100 });
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
  } catch (error) {
    return {
      success: false,
      error: `Échec de l'installation de PostgreSQL: ${getErrorMessage(error)}`
    };
  }
}

/**
 * Installs PostgreSQL on Linux by opening a terminal
 * (requires sudo for apt-get/yum/dnf)
 */
async function installPostgresLinux(
  onProgress: (progress: InstallationProgress) => void
): Promise<InstallationResult> {
  try {
    onProgress({ step: 'detecting', message: 'Détection du gestionnaire de paquets...', progress: 10 });

    // Detect the package manager
    let installCommand: string;
    try {
      await execAsync('which apt-get');
      installCommand = 'sudo apt-get update && sudo apt-get install -y postgresql postgresql-contrib';
    } catch {
      try {
        await execAsync('which dnf');
        installCommand = 'sudo dnf install -y postgresql-server postgresql-contrib';
      } catch {
        try {
          await execAsync('which yum');
          installCommand = 'sudo yum install -y postgresql-server postgresql-contrib';
        } catch {
          return {
            success: false,
            error: 'Distribution Linux non supportée. Veuillez installer PostgreSQL manuellement.'
          };
        }
      }
    }

    onProgress({ step: 'opening-terminal', message: 'Ouverture du terminal...', progress: 50 });

    // Try to open a terminal with the command
    const terminals = [
      { cmd: 'gnome-terminal', args: ['--', 'bash', '-c', `${installCommand}; echo ""; echo "Installation terminée. Vous pouvez fermer cette fenêtre."; read -p "Appuyez sur Entrée pour fermer..."`] },
      { cmd: 'konsole', args: ['-e', 'bash', '-c', `${installCommand}; echo ""; echo "Installation terminée. Vous pouvez fermer cette fenêtre."; read -p "Appuyez sur Entrée pour fermer..."`] },
      { cmd: 'xfce4-terminal', args: ['-e', `bash -c '${installCommand}; echo ""; echo "Installation terminée."; read -p "Appuyez sur Entrée..."'`] },
      { cmd: 'xterm', args: ['-e', `bash -c '${installCommand}; echo ""; echo "Installation terminée."; read -p "Appuyez sur Entrée..."'`] },
    ];

    for (const terminal of terminals) {
      try {
        await execAsync(`which ${terminal.cmd}`);
        spawn(terminal.cmd, terminal.args, { detached: true, stdio: 'ignore' });

        logger.info(`Opened ${terminal.cmd} with PostgreSQL install command`);

        onProgress({
          step: 'waiting',
          message: 'Terminal ouvert. Terminez l\'installation puis cliquez sur Revérifier.',
          progress: 100
        });

        return {
          success: true,
          externalInstallation: true,
          instructions: `Une fenêtre de terminal a été ouverte avec la commande d'installation. Terminez l'installation, puis revenez ici et cliquez sur "Revérifier".`
        };
      } catch {
        continue;
      }
    }

    // Fallback: show the command to copy-paste
    return {
      success: false,
      error: `Impossible d'ouvrir un terminal automatiquement. Veuillez exécuter cette commande manuellement :\n\n${installCommand}`
    };
  } catch (error) {
    return {
      success: false,
      error: `Échec de l'installation de PostgreSQL: ${getErrorMessage(error)}`
    };
  }
}

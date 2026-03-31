import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Centralized application path management
 * Uses app.getPath('userData') for packaged applications
 * and process.cwd() for development
 */
class PathManager {
  private _appDataPath: string;

  constructor() {
    // In development mode, use the current directory
    // In production mode (packaged), use userData
    if (app.isPackaged) {
      this._appDataPath = app.getPath('userData');
    } else {
      this._appDataPath = process.cwd();
    }

    // Create the necessary directories
    this.ensureDirectories();
  }

  get appDataPath(): string {
    return this._appDataPath;
  }

  get logsPath(): string {
    return path.join(this._appDataPath, 'logs');
  }

  get backupsPath(): string {
    return path.join(this._appDataPath, 'backups');
  }

  get configPath(): string {
    return path.join(this._appDataPath, 'config.json');
  }

  get encryptionKeyPath(): string {
    return path.join(this._appDataPath, '.encryption.key');
  }

  get claudeDesktopConfigPath(): string {
    const home = app.getPath('home');
    switch (process.platform) {
      case 'darwin':
        return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      case 'win32':
        return path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
      default:
        return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
    }
  }

  get mcpServerPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'mcp-postgres', 'index.js');
    }
    return path.resolve(__dirname, '..', '..', 'mcp-postgres', 'build', 'index.js');
  }

  private ensureDirectories(): void {
    const dirs = [
      this.logsPath,
      this.backupsPath
    ];

    dirs.forEach(dir => {
      fs.mkdirSync(dir, { recursive: true });
    });
  }
}

export const pathManager = new PathManager();


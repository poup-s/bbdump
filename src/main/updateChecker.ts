import { app, net } from 'electron';
import { logger } from './logger';

export interface UpdateInfo {
  updateAvailable: boolean;
  version: string;
  url: string;
  releaseNotes: string;
  error?: string;
}

const GITHUB_REPO = 'poup-s/bbDump-app';
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

export async function checkForUpdates(): Promise<UpdateInfo> {
  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (value: UpdateInfo) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutHandle);
        resolve(value);
      }
    };

    // Timeout: abort request after 15 seconds
    const timeoutHandle = setTimeout(() => {
      logger.warn('Update check timed out after 15 seconds');
      request.abort();
      safeResolve({
        updateAvailable: false,
        version: '',
        url: '',
        releaseNotes: '',
        error: 'Update check timed out'
      });
    }, 15000);

    const request = net.request(GITHUB_API_URL);

    request.on('response', (response) => {
      let data = '';

      response.on('data', (chunk) => {
        data += chunk.toString();
      });

      response.on('end', () => {
        if (response.statusCode === 200) {
          try {
            const release = JSON.parse(data);
            const latestVersion = release.tag_name.replace(/^v/, '');
            const currentVersion = app.getVersion();

            // Simple semantic version comparison
            const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;

            safeResolve({
              updateAvailable,
              version: latestVersion,
              url: release.html_url,
              releaseNotes: release.body
            });
          } catch (error: any) {
            logger.error(`Error parsing update response: ${error.message}`);
            safeResolve({
              updateAvailable: false,
              version: '',
              url: '',
              releaseNotes: '',
              error: 'Failed to parse update information'
            });
          }
        } else {
          logger.error(`Update check failed with status: ${response.statusCode}`);
          safeResolve({
            updateAvailable: false,
            version: '',
            url: '',
            releaseNotes: '',
            error: `Failed to check for updates (Status: ${response.statusCode})`
          });
        }
      });
    });

    request.on('error', (error) => {
      logger.error(`Update check request error: ${error.message}`);
      safeResolve({
        updateAvailable: false,
        version: '',
        url: '',
        releaseNotes: '',
        error: error.message
      });
    });

    request.end();
  });
}

function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;

    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }

  return 0;
}

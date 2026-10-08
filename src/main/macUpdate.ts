/**
 * macOS updates without Squirrel. Squirrel.Mac only installs signed apps, and bbdump is not
 * signed yet, so bbdump updates itself: it downloads the release's zip, checks it against
 * the sha512 published in latest-mac.yml, unpacks it with ditto (which keeps the ad-hoc
 * signature Apple Silicon needs) and, once the app has quit, a small script swaps the
 * bundle and relaunches it. Files downloaded by the app itself carry no quarantine flag,
 * so Gatekeeper lets the new version open.
 *
 * This module holds the parts that do not need Electron, so they can be tested.
 */
import * as path from 'path';

export interface ManifestFile {
  url: string;
  sha512: string;
  size: number;
}

/** The `version` and `files` of electron-builder's latest-mac.yml (a small, fixed YAML shape) */
export function parseUpdateManifest(text: string): { version: string; files: ManifestFile[] } {
  let version = '';
  const files: ManifestFile[] = [];
  let current: Partial<ManifestFile> | null = null;
  let inFiles = false;
  const flush = () => {
    if (current?.url && current.sha512) files.push({ url: current.url, sha512: current.sha512, size: current.size ?? 0 });
    current = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const top = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (top) {
      flush();
      inFiles = top[1] === 'files';
      if (top[1] === 'version') version = top[2].replace(/^['"]|['"]$/g, '');
      continue;
    }
    if (!inFiles) continue;
    const item = /^\s*-\s+url:\s*(.+)$/.exec(line);
    if (item) {
      flush();
      current = { url: item[1].trim() };
      continue;
    }
    const field = /^\s+(sha512|size):\s*(.+)$/.exec(line);
    if (field && current) {
      if (field[1] === 'sha512') current.sha512 = field[2].trim();
      else current.size = parseInt(field[2], 10) || 0;
    }
  }
  flush();
  return { version, files };
}

/** The zip for this Mac: `-arm64-mac.zip` on Apple Silicon, `-mac.zip` on Intel */
export function pickMacArchive(files: ManifestFile[], arch: string): ManifestFile | null {
  const zips = files.filter(f => /(^|[-.])mac\.zip$/.test(f.url));
  const arm = zips.find(f => f.url.endsWith('-arm64-mac.zip'));
  const intel = zips.find(f => !f.url.endsWith('-arm64-mac.zip'));
  return (arch === 'arm64' ? arm : intel) ?? null;
}

/** /Applications/bbdump.app from …/bbdump.app/Contents/MacOS/bbdump; null outside a bundle */
export function appBundleFromExe(exePath: string): string | null {
  const macos = path.dirname(exePath);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  if (path.basename(macos) !== 'MacOS' || path.basename(contents) !== 'Contents' || !bundle.endsWith('.app')) return null;
  return bundle;
}

/** macOS runs an app opened from Downloads from a random read-only copy (App Translocation) */
export const isTranslocated = (bundlePath: string) => bundlePath.includes('/AppTranslocation/');

/**
 * Runs detached once bbdump quits: args are the app's pid, the installed bundle, the new
 * bundle and the log file. The current version is kept aside until the copy succeeds, and
 * put back otherwise; either way the app is reopened.
 */
export const INSTALL_SCRIPT = `#!/bin/sh
PID="$1"; TARGET="$2"; NEW="$3"; LOG="$4"
BACKUP="\${TARGET%.app}.previous.app"
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [INFO] [update] $*" >> "$LOG"; }
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 240 ]; then log "bbdump did not quit, update cancelled"; exit 1; fi
  sleep 0.25
done
rm -rf "$BACKUP"
if ! mv "$TARGET" "$BACKUP"; then
  log "could not move the current version aside, update cancelled"
  open "$TARGET"
  exit 1
fi
if ditto "$NEW" "$TARGET"; then
  xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
  rm -rf "$BACKUP"
  log "new version installed"
else
  rm -rf "$TARGET"
  mv "$BACKUP" "$TARGET"
  log "copy failed, previous version restored"
fi
rm -rf "$(dirname "$(dirname "$NEW")")"
open "$TARGET"
`;

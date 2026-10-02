#!/usr/bin/env node
// Adds `minimumSystemVersion` to release/latest-mac.yml so electron-updater does not
// offer an update to Macs that cannot run it. electron-builder only writes the value
// into the app's Info.plist (LSMinimumSystemVersion), not into the update manifest.
//
// electron-updater compares the manifest value with os.release(), i.e. the Darwin
// kernel version, not the macOS version: macOS 11+ maps to Darwin (major + 9).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath: the project path may contain spaces (URL.pathname keeps them as %20)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const macosMin = pkg.build?.mac?.minimumSystemVersion;
const manifest = path.join(root, 'release', 'latest-mac.yml');

if (!macosMin) {
  console.log('set-update-min-os: no build.mac.minimumSystemVersion, nothing to do');
  process.exit(0);
}
if (!fs.existsSync(manifest)) {
  console.log('set-update-min-os: release/latest-mac.yml not found (not a mac build), skipping');
  process.exit(0);
}

const macosMajor = parseInt(String(macosMin).split('.')[0], 10);
if (!(macosMajor >= 11)) {
  console.error(`set-update-min-os: unsupported macOS minimum "${macosMin}" (expected 11 or later)`);
  process.exit(1);
}
const darwinVersion = `${macosMajor + 9}.0.0`;

const lines = fs.readFileSync(manifest, 'utf8').split('\n').filter(l => !l.startsWith('minimumSystemVersion:'));
const versionIndex = lines.findIndex(l => l.startsWith('version:'));
if (versionIndex < 0) {
  console.error('set-update-min-os: no "version:" line in latest-mac.yml');
  process.exit(1);
}
lines.splice(versionIndex + 1, 0, `minimumSystemVersion: ${darwinVersion}`);
fs.writeFileSync(manifest, lines.join('\n'));
console.log(`set-update-min-os: latest-mac.yml requires Darwin ${darwinVersion} (macOS ${macosMin})`);

// macOS self-update: reading latest-mac.yml, picking the zip, and the script that swaps the bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { parseUpdateManifest, pickMacArchive, appBundleFromExe, isTranslocated, INSTALL_SCRIPT } = require(path.join(process.cwd(), 'dist/main/macUpdate.js'));

const MANIFEST = `version: 1.1.2
files:
  - url: bbdump-1.1.2-arm64-mac.zip
    sha512: ARMSHA==
    size: 120000000
  - url: bbdump-1.1.2-mac.zip
    sha512: INTELSHA==
    size: 125000000
  - url: bbdump-1.1.2-arm64.dmg
    sha512: DMGSHA==
    size: 130000000
path: bbdump-1.1.2-arm64-mac.zip
sha512: ARMSHA==
releaseDate: '2026-10-08T10:00:00.000Z'
`;

test('latest-mac.yml: version and every file with its sha512 and size', () => {
  const { version, files } = parseUpdateManifest(MANIFEST);
  assert.equal(version, '1.1.2');
  assert.equal(files.length, 3);
  assert.deepEqual(files[1], { url: 'bbdump-1.1.2-mac.zip', sha512: 'INTELSHA==', size: 125000000 });
});

test('the zip for the Mac: arm64 on Apple Silicon, the other one on Intel, never a dmg', () => {
  const { files } = parseUpdateManifest(MANIFEST);
  assert.equal(pickMacArchive(files, 'arm64').url, 'bbdump-1.1.2-arm64-mac.zip');
  assert.equal(pickMacArchive(files, 'x64').url, 'bbdump-1.1.2-mac.zip');
  assert.equal(pickMacArchive(files.filter(f => f.url !== 'bbdump-1.1.2-mac.zip'), 'x64'), null);
});

test('bundle from the executable, and App Translocation spotted', () => {
  assert.equal(appBundleFromExe('/Applications/bbdump.app/Contents/MacOS/bbdump'), '/Applications/bbdump.app');
  assert.equal(appBundleFromExe('/usr/local/bin/electron'), null);
  assert.equal(isTranslocated('/private/var/folders/x/AppTranslocation/ABC/d/bbdump.app'), true);
  assert.equal(isTranslocated('/Applications/bbdump.app'), false);
});

test('install script: swaps the bundle once the app has quit, cleans up and reopens it', { skip: process.platform !== 'darwin' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-swap-'));
  try {
    const target = path.join(dir, 'Applications', 'bbdump.app');
    const work = path.join(dir, 'bbdump-update-x');
    const fresh = path.join(work, 'extract', 'bbdump.app');
    fs.mkdirSync(path.join(target, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(target, 'Contents', 'version'), 'old');
    fs.mkdirSync(path.join(fresh, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(fresh, 'Contents', 'version'), 'new');
    // A fake `open` records what would be launched
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "$1" > "${dir}/opened"\n`, { mode: 0o755 });
    const script = path.join(work, 'install-update.sh');
    fs.writeFileSync(script, INSTALL_SCRIPT, { mode: 0o700 });
    const log = path.join(dir, 'app.log');

    const result = spawnSync('/bin/sh', [script, '999999', target, fresh, log], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(fs.readFileSync(path.join(target, 'Contents', 'version'), 'utf8'), 'new');
    assert.equal(fs.existsSync(path.join(dir, 'Applications', 'bbdump.previous.app')), false);
    assert.equal(fs.existsSync(work), false);
    assert.equal(fs.readFileSync(path.join(dir, 'opened'), 'utf8').trim(), target);
    assert.match(fs.readFileSync(log, 'utf8'), /\[update\] new version installed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

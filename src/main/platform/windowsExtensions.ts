/**
 * Extensions on Windows, for the EDB server bbdump installs: no package manager there, so the
 * official Windows builds are downloaded, checked, and copied into the server's folder.
 * - PostGIS bundle (OSGeo): postgis, raster, topology, pgRouting, h3… (zip + md5);
 * - TimescaleDB (GitHub release): DLLs and SQL files (zip + sha256 from the release).
 * Copying into Program Files needs administrator rights: one Windows prompt (PowerShell
 * -Verb RunAs). No Electron import: the CI runs it as is.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run } from './probe';

export type WindowsExtensionSource = 'postgis' | 'timescaledb';

export interface WindowsDownload {
  url: string;
  file: string;
  algorithm: 'md5' | 'sha256';
  digest: string;
}

type Log = (line: string) => void;

const POSTGIS_BASE = 'https://download.osgeo.org/postgis/windows';
const TIMESCALE_RELEASE = 'https://api.github.com/repos/timescale/timescaledb/releases/latest';

/** The newest PostGIS bundle zip in an OSGeo directory listing, e.g. "postgis-bundle-pg18-3.6.2x64.zip" */
export function newestPostgisBundle(listing: string, major: number): string | null {
  const re = new RegExp(`postgis-bundle-pg${major}-(\\d+(?:\\.\\d+)*)x64\\.zip(?!\\.)`, 'g');
  const found = [...new Set([...listing.matchAll(re)].map(m => m[1]))];
  const rank = (v: string) => v.split('.').map(n => parseInt(n, 10) || 0);
  found.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
    return 0;
  });
  return found.length ? `postgis-bundle-pg${major}-${found[0]}x64.zip` : null;
}

/** The md5 in an OSGeo ".md5" file ("<hex> *<file>") */
export function parseMd5File(text: string): string | null {
  return /^([a-f0-9]{32})\b/i.exec(text.trim())?.[1].toLowerCase() ?? null;
}

/** The Windows zip of a TimescaleDB release for PostgreSQL <major>, with its sha256 */
export function timescaleAsset(release: { assets?: Array<{ name?: string; browser_download_url?: string; digest?: string }> }, major: number): WindowsDownload | null {
  const name = `timescaledb-postgresql-${major}-windows-amd64.zip`;
  const asset = release.assets?.find(a => a.name === name);
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset?.digest || '')?.[1];
  if (!asset?.browser_download_url || !digest) return null;
  return { url: asset.browser_download_url, file: name, algorithm: 'sha256', digest: digest.toLowerCase() };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': 'bbdump', Accept: '*/*' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

/** Where to download the build of `source` for PostgreSQL <major>, with the digest to check */
export async function resolveWindowsDownload(source: WindowsExtensionSource, major: number): Promise<WindowsDownload> {
  if (source === 'postgis') {
    const dir = `${POSTGIS_BASE}/pg${major}/`;
    const file = newestPostgisBundle(await fetchText(dir), major);
    if (!file) throw new Error(`No PostGIS build for PostgreSQL ${major} on download.osgeo.org`);
    const digest = parseMd5File(await fetchText(`${dir}${file}.md5`));
    if (!digest) throw new Error(`No checksum for ${file}`);
    return { url: `${dir}${file}`, file, algorithm: 'md5', digest };
  }
  const release = JSON.parse(await fetchText(TIMESCALE_RELEASE));
  const download = timescaleAsset(release, major);
  if (!download) throw new Error(`No TimescaleDB build for PostgreSQL ${major} in the latest release`);
  return download;
}

/** Downloads to `dest` and checks the digest; the file is removed when it does not match */
export async function downloadChecked(download: WindowsDownload, dest: string, log: Log): Promise<void> {
  log(`Downloading ${download.file}`);
  const response = await fetch(download.url, { headers: { 'User-Agent': 'bbdump' } });
  if (!response.ok || !response.body) throw new Error(`${download.url}: HTTP ${response.status}`);
  const hash = crypto.createHash(download.algorithm);
  const out = fs.createWriteStream(dest);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      if (!out.write(value)) await new Promise<void>(resolve => out.once('drain', () => resolve()));
    }
  } finally {
    await new Promise<void>(resolve => out.end(() => resolve()));
  }
  const actual = hash.digest('hex');
  if (actual !== download.digest) {
    fs.rmSync(dest, { force: true });
    throw new Error(`${download.file}: ${download.algorithm} does not match (expected ${download.digest}, got ${actual})`);
  }
  log(`${download.file}: ${download.algorithm} checked`);
}

/** A PowerShell single-quoted string */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The server folder from its SHAREDIR ("C:\Program Files\PostgreSQL\18\share"), or null if it is not an EDB layout */
export function pgRootFromSharedir(sharedir: string): string | null {
  const m = /^([a-z]:\\.+\\PostgreSQL\\\d+(?:\.\d+)?)\\share\\?$/i.exec(sharedir.replace(/\//g, '\\'));
  return m ? m[1] : null;
}

/**
 * PowerShell copying an extracted build into the server folder. PostGIS: its bin DLLs only
 * when the server has none of that name (the server's own are in use and must not change),
 * then lib, share and gdal-data. TimescaleDB: DLLs to lib, SQL and control files to
 * share\extension. Writes "ok" to `doneFile` at the end.
 */
export function copyScript(source: WindowsExtensionSource, extracted: string, pgRoot: string, doneFile: string): string {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `$src = ${psQuote(extracted)}`,
    `$dst = ${psQuote(pgRoot)}`,
  ];
  if (source === 'postgis') {
    lines.push(
      "$bundle = Get-ChildItem -Directory $src | Where-Object { $_.Name -like 'postgis-bundle-*' } | Select-Object -First 1",
      "if (-not $bundle) { throw 'Unexpected PostGIS archive' }",
      "Get-ChildItem -File (Join-Path $bundle.FullName 'bin') | Where-Object { -not (Test-Path (Join-Path $dst ('bin\\' + $_.Name))) } | Copy-Item -Destination (Join-Path $dst 'bin')",
      "foreach ($dir in 'bin\\postgisgui', 'lib', 'share', 'gdal-data') {",
      "  $from = Join-Path $bundle.FullName $dir",
      "  if (Test-Path $from) { New-Item -ItemType Directory -Force (Join-Path $dst $dir) | Out-Null; Copy-Item -Recurse -Force (Join-Path $from '*') (Join-Path $dst $dir) }",
      "}",
    );
  } else {
    lines.push(
      "$from = Join-Path $src 'timescaledb'",
      "if (-not (Test-Path $from)) { throw 'Unexpected TimescaleDB archive' }",
      "Copy-Item -Force (Join-Path $from '*.dll') (Join-Path $dst 'lib')",
      "Copy-Item -Force (Join-Path $from '*.sql'), (Join-Path $from '*.control') (Join-Path $dst 'share\\extension')",
    );
  }
  lines.push(`Set-Content -Path ${psQuote(doneFile)} -Value 'ok'`);
  return lines.join('\r\n') + '\r\n';
}

function powershellPath(): string {
  return path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Downloads, checks and copies the Windows build of `source` into `pgRoot` (one administrator
 * prompt). The extension can then be created; TimescaleDB also needs a restart (preload).
 */
export async function installWindowsExtension(
  source: WindowsExtensionSource,
  major: number,
  pgRoot: string,
  log: Log = () => {},
): Promise<{ success: boolean; error?: string; cancelled?: boolean }> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-ext-'));
  try {
    const download = await resolveWindowsDownload(source, major);
    const zip = path.join(work, download.file);
    await downloadChecked(download, zip, log);

    log(`Extracting ${download.file}`);
    const extracted = path.join(work, 'files');
    const expand = await run(powershellPath(), [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(extracted)} -Force`,
    ], 10 * 60 * 1000);
    if (!expand.ok) return { success: false, error: `Could not extract ${download.file}: ${expand.stderr.trim().slice(-300)}` };

    const script = path.join(work, 'copy.ps1');
    const doneFile = path.join(work, 'done.txt');
    fs.writeFileSync(script, copyScript(source, extracted, pgRoot, doneFile), 'utf8');
    log(`Copying into ${pgRoot} (Windows asks for administrator rights)`);
    const copy = await run(powershellPath(), [
      '-NoProfile', '-NonInteractive', '-Command',
      `Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(`"${script}"`)} -Verb RunAs -WindowStyle Hidden -Wait`,
    ], 10 * 60 * 1000);
    if (!copy.ok && /cancel|annul/i.test(copy.stderr)) return { success: false, cancelled: true, error: 'Cancelled' };
    if (!fs.existsSync(doneFile)) {
      return { success: false, error: `Could not copy the files into ${pgRoot}${copy.stderr.trim() ? `: ${copy.stderr.trim().slice(-300)}` : ''}` };
    }
    log(`${source} copied into ${pgRoot}`);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

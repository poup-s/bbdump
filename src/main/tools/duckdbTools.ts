/**
 * The DuckDB command-line tool (duckdb), installed by the user: Homebrew, winget, or DuckDB's
 * own install script on Linux (~/.duckdb/cli/latest/duckdb). Found once, with its version
 * (DuckDB 2 takes -no-agent).
 */
import { defaultWhich, firstExisting, run, type WhichFn } from '../platform/probe';
import { duckdbCandidates, duckdbInstallHint, duckdbVersionOf } from '../../shared/engines/duckdbCli';

export { duckdbCandidates, duckdbInstallHint };

let cached: { file: string; version?: string } | null = null;

/** The tool and its version, or an error that says how to install it */
export async function requireDuckdb(which: WhichFn = defaultWhich, platform = process.platform): Promise<{ file: string; version?: string }> {
    if (cached) return cached;
    const file = (await which('duckdb')) ?? firstExisting(duckdbCandidates(platform));
    if (!file) throw new Error(`The duckdb tool was not found. Install it: ${duckdbInstallHint(platform)}`);
    const result = await run(file, ['--version'], 10000).catch(() => null);
    cached = { file, version: result ? duckdbVersionOf(result.stdout + result.stderr) : undefined };
    return cached;
}

/** A new lookup next time (after an install) */
export function forgetDuckdb(): void {
    cached = null;
}

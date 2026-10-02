/**
 * Version from `pg_dump --version`-style output, e.g. "pg_dump (PostgreSQL) 17.10".
 * Anchored on "(PostgreSQL) X.Y" so wrapper noise mixed into the output (openSUSE's
 * pg_alts prints shell errors with line numbers) cannot be picked up instead.
 */
export function parsePgVersion(output: string): string | null {
    const anchored = output.match(/\(PostgreSQL\)\s+(\d+(?:\.\d+)?)/);
    if (anchored) return anchored[1];
    const loose = output.match(/(\d+\.\d+)/);
    return loose ? loose[1] : null;
}

export function getErrorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/**
 * Masks credentials in free text (connection URIs, keyword/value conninfo, env dumps)
 * so they never reach the log file.
 */
export function redactSecrets(text: string): string {
    return text
        // Password = everything up to the '@' (quotes included: encodeURIComponent keeps ')
        .replace(/(postgres(?:ql)?:\/\/[^:/\s@"']*:)[^\s@]*@/gi, '$1***@')
        .replace(/(password\s*=\s*)('[^']*'|[^\s"'&]+)/gi, '$1***')
        .replace(/(PGPASSWORD=)\S+/g, '$1***');
}

/**
 * A connection error as the user can read it: what happened in a few words (its kind, translated
 * by the screen), and the driver's own message as a detail, without Electron's
 * "Error invoking remote method '…': Error:" prefix.
 */
export type ConnectionErrorKind = 'refused' | 'notFound' | 'timeout' | 'auth' | 'tls' | 'missingDatabase' | 'other';

export function readableConnectionError(raw: string): { kind: ConnectionErrorKind; detail: string } {
  const detail = raw
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^(?:[A-Za-z]*Error:\s*)+/, '')
    .trim();
  const text = detail.toLowerCase();
  const kind: ConnectionErrorKind =
    /econnrefused|connection refused|could not connect to server|no connection could be made/.test(text) ? 'refused'
      : /enotfound|eai_again|getaddrinfo|could not translate host name|unknown host/.test(text) ? 'notFound'
        : /etimedout|timed? ?out|timeout/.test(text) ? 'timeout'
          : /password authentication failed|access denied|login failed|authentication failed|auth failed|bad auth|unauthorized/.test(text) ? 'auth'
            : /ssl|tls|certificate|self[- ]signed/.test(text) ? 'tls'
              : /does not exist|unknown database|cannot open database|no such file/.test(text) ? 'missingDatabase'
                : 'other';
  return { kind, detail };
}

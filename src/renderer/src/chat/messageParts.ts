/**
 * An assistant answer is free text with OpenUI Lang programs in ```openui fences (tables,
 * charts…). Split for display: text as is, each program to the OpenUI renderer. A fence
 * still open at the end is a program being streamed.
 */
export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'ui'; source: string; complete: boolean };

const FENCE = /```openui[^\n]*\n/g;

export function splitOpenUi(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const pushText = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) parts.push({ kind: 'text', text: trimmed });
  };
  let cursor = 0;
  FENCE.lastIndex = 0;
  let open: RegExpExecArray | null;
  while ((open = FENCE.exec(text))) {
    pushText(text.slice(cursor, open.index));
    const start = open.index + open[0].length;
    const close = text.indexOf('```', start);
    if (close < 0) {
      parts.push({ kind: 'ui', source: text.slice(start), complete: false });
      return parts;
    }
    parts.push({ kind: 'ui', source: text.slice(start, close), complete: true });
    cursor = close + 3;
    FENCE.lastIndex = cursor;
  }
  // A program written without its fence (some models skip it): rendered all the same
  const rest = text.slice(cursor);
  if (!parts.length && /^\s*root\s*=\s*[A-Z]\w*\(/.test(rest)) return [{ kind: 'ui', source: rest.trim(), complete: true }];
  pushText(rest);
  return parts;
}

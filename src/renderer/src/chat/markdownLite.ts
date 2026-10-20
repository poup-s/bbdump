/**
 * The little Markdown AI answers use (paragraphs, # titles, - and 1. lists, **bold**,
 * `code`, ``` blocks), turned into plain data the chat renders as text: no HTML is ever
 * injected from an answer.
 */
export interface Inline { text: string; bold?: boolean; code?: boolean }
export type MdBlock =
  | { type: 'p'; inlines: Inline[] }
  | { type: 'h'; inlines: Inline[] }
  | { type: 'ul' | 'ol'; items: Inline[][] }
  | { type: 'code'; text: string; lang?: string };

export function inlines(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > cursor) out.push({ text: text.slice(cursor, m.index) });
    const token = m[0];
    out.push(token.startsWith('**') ? { text: token.slice(2, -2), bold: true } : { text: token.slice(1, -1), code: true });
    cursor = m.index + token.length;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) });
  return out;
}

export function markdownLite(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'p', inlines: inlines(paragraph.join(' ')) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const lang = line.slice(3).trim().toLowerCase() || undefined;
      const code: string[] = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      blocks.push({ type: 'code', text: code.join('\n'), ...(lang ? { lang } : {}) });
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: 'h', inlines: inlines(heading[1]) });
    } else if (bullet || numbered) {
      flush();
      const type = bullet ? 'ul' : 'ol';
      const last = blocks[blocks.length - 1];
      const item = inlines((bullet ?? numbered)![1]);
      if (last && last.type === type) last.items.push(item);
      else blocks.push({ type, items: [item] });
    } else if (!line.trim()) {
      flush();
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

/** A code block holding SQL: folded in the chat like the Sql blocks */
export function isSqlBlock(block: { text: string; lang?: string }): boolean {
  return block.lang === 'sql' || block.lang === 'postgresql' || block.lang === 'psql'
    || (!block.lang && /^\s*(select|with|explain)\b/i.test(block.text));
}

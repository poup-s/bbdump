/**
 * What the AI will see of a value of unknown origin once anonymized: partly starred, its
 * shape kept. The same rule as the MCP server (mcp-postgres/src/masking.ts, partialValue),
 * so the preview in the chat is exactly what is sent.
 */
export function partialPreview(text: string): string {
  const at = text.indexOf('@');
  if (at > 0 && at < text.length - 1) {
    const local = text.slice(0, at);
    const hidden = Math.max(local.length - 3, Math.ceil(local.length / 2));
    return '*'.repeat(hidden) + local.slice(hidden) + text.slice(at);
  }
  if (/^[0-9 +().-]{6,}$/.test(text)) return text.slice(0, -2).replace(/[0-9]/g, '*') + text.slice(-2);
  const third = Math.max(1, Math.ceil(text.length / 3));
  return '*'.repeat(third) + text.slice(third);
}

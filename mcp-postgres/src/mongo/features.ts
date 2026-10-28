/**
 * MongoDB is always on in bbdump (stable since 1.5). The AI's access can still be turned off
 * feature by feature: the app writes them to features.json next to config.json ("disabled"),
 * read on every call so a change applies at once. A level saved while MongoDB was in testing
 * ("engines": {"mongodb": "off"}) no longer applies.
 */
import * as fs from 'fs';
import * as path from 'path';

export type MongoFeature = 'mcp.read' | 'mcp.write';

/** Whether features.json content (absent: null) lets the AI read (or change) MongoDB databases */
export function mongoReadAllowed(content: unknown, feature: MongoFeature = 'mcp.read'): boolean {
  const value = content as { disabled?: unknown } | null;
  const disabled = Array.isArray(value?.disabled) ? value.disabled : [];
  // Changing needs reading too
  return !disabled.includes('mcp.read') && !disabled.includes(feature);
}

export function mongoToolsEnabled(feature: MongoFeature = 'mcp.read'): boolean {
  const configPath = process.env.BBDUMP_CONFIG_PATH;
  if (!configPath) return false;
  const file = path.join(path.dirname(configPath), 'features.json');
  let content: unknown = null;
  try {
    if (fs.existsSync(file)) content = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Unreadable: the app uses its defaults too, where MongoDB is on
  }
  return mongoReadAllowed(content, feature);
}

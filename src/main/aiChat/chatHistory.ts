/**
 * Database chat history: one encrypted file per conversation, in
 * <userData>/ai-chat-history/<database id>/<conversation id>.json, apart from config.json.
 * A conversation holds what the AI read, so it is encrypted, and kept 30 days after its last
 * message unless pinned. No Electron import: the folder and the cipher are given.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ChatConversation {
  id: string;
  databaseId: string;
  provider: string;
  model?: string;
  /** The tool's session, to continue the conversation */
  sessionId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  /** What the chat shows (user and assistant messages with their blocks) */
  messages: unknown[];
  /** Local models: the conversation bbdump sends the model, to continue it after a restart */
  localMessages?: unknown[];
}

export type ConversationSummary = Pick<ChatConversation, 'id' | 'databaseId' | 'provider' | 'model' | 'title' | 'createdAt' | 'updatedAt' | 'pinned'> & { messageCount: number };

export interface Cipher {
  encrypt: (text: string) => string;
  decrypt: (text: string) => string;
}

export const RETENTION_DAYS = 30;
const MAX_BYTES = 4 * 1024 * 1024;
const ID_RE = /^[\w-]{1,80}$/;

export class ChatHistory {
  constructor(private root: string, private cipher: Cipher, private now: () => number = Date.now) {}

  private dir(databaseId: string): string {
    if (!ID_RE.test(databaseId)) throw new Error('Invalid database id');
    return path.join(this.root, databaseId);
  }

  private file(databaseId: string, id: string): string {
    if (!ID_RE.test(id)) throw new Error('Invalid conversation id');
    return path.join(this.dir(databaseId), `${id}.json`);
  }

  private read(file: string): ChatConversation | null {
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { v?: number; data?: string };
      if (stored.v !== 1 || typeof stored.data !== 'string') return null;
      return JSON.parse(this.cipher.decrypt(stored.data)) as ChatConversation;
    } catch {
      return null;
    }
  }

  private expired(c: ChatConversation): boolean {
    return !c.pinned && this.now() - Date.parse(c.updatedAt) > RETENTION_DAYS * 86400000;
  }

  /** The conversations of a database, pinned first then newest; expired ones are deleted */
  list(databaseId: string): ConversationSummary[] {
    const dir = this.dir(databaseId);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out: ConversationSummary[] = [];
    for (const name of files) {
      const file = path.join(dir, name);
      const c = this.read(file);
      if (!c || this.expired(c)) {
        // Unreadable (key replaced) or past its time
        fs.rmSync(file, { force: true });
        continue;
      }
      out.push({ id: c.id, databaseId: c.databaseId, provider: c.provider, model: c.model, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, pinned: !!c.pinned, messageCount: c.messages.length });
    }
    return out.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  }

  get(databaseId: string, id: string): ChatConversation | null {
    const c = this.read(this.file(databaseId, id));
    return c && !this.expired(c) ? c : null;
  }

  /** Saves a conversation; its pin is kept unless given */
  save(conversation: ChatConversation): void {
    const file = this.file(conversation.databaseId, conversation.id);
    const previous = this.read(file);
    const next: ChatConversation = { ...conversation, pinned: conversation.pinned ?? previous?.pinned ?? false, createdAt: previous?.createdAt ?? conversation.createdAt };
    const data = JSON.stringify({ v: 1, data: this.cipher.encrypt(JSON.stringify(next)) });
    if (data.length > MAX_BYTES) throw new Error('This conversation is too long to be kept');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  pin(databaseId: string, id: string, pinned: boolean): boolean {
    const c = this.get(databaseId, id);
    if (!c) return false;
    this.save({ ...c, pinned });
    return true;
  }

  delete(databaseId: string, id: string): void {
    fs.rmSync(this.file(databaseId, id), { force: true });
  }

  /** Every conversation of a database, pinned ones included */
  clear(databaseId: string): void {
    fs.rmSync(this.dir(databaseId), { recursive: true, force: true });
  }

  /** Every conversation of every database */
  clearAll(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

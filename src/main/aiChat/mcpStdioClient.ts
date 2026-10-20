/**
 * A small MCP client over stdio (JSON-RPC, one message per line): enough to run bbdump's own
 * MCP server for a chat with a local model (Ollama, LM Studio), list its tools and call them.
 * No Electron import.
 */
import { spawn, type ChildProcess } from 'child_process';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

export class McpStdioClient {
  private child: ChildProcess;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private stderr = '';

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-2000); });
    const fail = (error: Error) => {
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    };
    this.child.on('error', fail);
    this.child.on('close', () => fail(new Error(`The bbdump MCP server stopped${this.stderr.trim() ? `: ${this.stderr.trim().split('\n').pop()}` : ''}`)));
    this.child.stdin?.on('error', () => { /* reported through close */ });
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString();
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.startsWith('{')) continue;
      try {
        const message = JSON.parse(line);
        const waiting = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
        if (!waiting) continue;
        this.pending.delete(message.id);
        if (message.error) waiting.reject(new Error(message.error.message || 'MCP error'));
        else waiting.resolve(message.result);
      } catch {
        // not a message
      }
    }
  }

  private request<T>(method: string, params: unknown, timeoutMs = 120000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer from the bbdump MCP server`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value as T); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bbdump-chat', version: '1.0.0' } }, 30000);
    this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request<{ tools?: McpTool[] }>('tools/list', {}, 30000);
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }>('tools/call', { name, arguments: args });
    const text = (result?.content ?? []).map(c => c.text ?? '').join('\n');
    return { text, isError: !!result?.isError };
  }

  close(): void {
    this.child.kill();
  }
}

/**
 * The part of node:sqlite bbdump uses (Node 22.13+, Electron 44's Node 24). @types/node 20 does
 * not describe it yet; this file goes once @types/node is 22 or more.
 */
declare module 'node:sqlite' {
    type SQLInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;
    type SQLOutputValue = null | number | bigint | string | Uint8Array;

    interface DatabaseSyncOptions {
        open?: boolean;
        readOnly?: boolean;
        enableForeignKeyConstraints?: boolean;
    }

    interface StatementColumn {
        column: string | null;
        database: string | null;
        name: string;
        table: string | null;
        type: string | null;
    }

    class StatementSync {
        all(...params: SQLInputValue[]): Array<Record<string, SQLOutputValue>>;
        get(...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
        run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
        columns(): StatementColumn[];
    }

    class DatabaseSync {
        constructor(path: string, options?: DatabaseSyncOptions);
        exec(sql: string): void;
        prepare(sql: string): StatementSync;
        close(): void;
    }

    function backup(source: DatabaseSync, destination: string, options?: { rate?: number }): Promise<number>;
}

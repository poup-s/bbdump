/// <reference types="vite/client" />

declare module '*.vue' {
    import type { DefineComponent } from 'vue'
    const component: DefineComponent<{}, {}, any>
    export default component
}

interface IpcRenderer {
    invoke(channel: string, ...args: any[]): Promise<any>;
    on(channel: string, listener: (event: any, ...args: any[]) => void): () => void;
    removeListener(channel: string, listener: (...args: any[]) => void): void;
    removeAllListeners(channel: string): void;
    send(channel: string, ...args: any[]): void;
}

interface Shell {
    openExternal(url: string): Promise<void>;
    showItemInFolder(path: string): Promise<void>;
}

interface ElectronAPI {
    ipcRenderer: IpcRenderer;
    shell: Shell;
    platform: NodeJS.Platform;
}

// This file is a global script (no top-level import/export), so Window can be
// augmented directly. `electron` is undefined when the preload did not run.
interface Window {
    electron?: ElectronAPI;
}

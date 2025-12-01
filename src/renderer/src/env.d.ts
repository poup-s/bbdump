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
}

declare global {
    interface Window {
        electron: ElectronAPI;
    }
}

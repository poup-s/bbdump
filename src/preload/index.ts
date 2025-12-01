import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// Custom APIs for renderer
const api = {
    // IPC Wrapper
    ipcRenderer: {
        invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
        on: (channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void) => {
            ipcRenderer.on(channel, listener);
            return () => ipcRenderer.removeListener(channel, listener);
        },
        removeListener: (channel: string, listener: (...args: any[]) => void) => ipcRenderer.removeListener(channel, listener),
        removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),
        send: (channel: string, ...args: any[]) => ipcRenderer.send(channel, ...args)
    },
    // Shell Wrapper (if needed, though we should avoid exposing full shell)
    shell: {
        openExternal: (url: string) => import('electron').then(({ shell }) => shell.openExternal(url)),
        showItemInFolder: (path: string) => import('electron').then(({ shell }) => shell.showItemInFolder(path))
    }
};

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
    try {
        contextBridge.exposeInMainWorld('electron', api);
    } catch (error) {
        console.error(error);
    }
} else {
    // @ts-ignore (define in dts)
    window.electron = api;
}

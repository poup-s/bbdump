// Wrapper to get electron modules from preload script

let ipcRenderer: IpcRenderer;
let shell: Shell;

if (window.electron) {
    ipcRenderer = window.electron.ipcRenderer;
    shell = window.electron.shell;
} else {
    console.warn('Electron preload not detected. IPC calls will fail.');
    ipcRenderer = {
        invoke: (...args: unknown[]) => {
            console.log('Mock invoke:', args);
            return Promise.resolve();
        },
        on: (...args: unknown[]) => {
            console.log('Mock on:', args);
            return () => { };
        },
        send: (...args: unknown[]) => {
            console.log('Mock send:', args);
        },
        removeListener: () => { },
        removeAllListeners: () => { }
    };
    shell = {
        openExternal: (url: string) => {
            console.log('Mock openExternal:', url);
            return Promise.resolve();
        },
        showItemInFolder: (path: string) => {
            console.log('Mock showItemInFolder:', path);
            return Promise.resolve();
        }
    };
}

export { ipcRenderer, shell };

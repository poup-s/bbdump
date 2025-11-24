// Simple wrapper to get electron modules in renderer with nodeIntegration: true

let ipcRenderer: any;
let shell: any;

// @ts-ignore
if (window.require) {
    // @ts-ignore
    const electron = window.require('electron');
    ipcRenderer = electron.ipcRenderer;
    shell = electron.shell;
} else {
    console.warn('Electron not detected. IPC calls will fail.');
    ipcRenderer = {
        invoke: (...args: any[]) => {
            console.log('Mock invoke:', args);
            return Promise.resolve();
        },
        on: (...args: any[]) => {
            console.log('Mock on:', args);
        },
        send: (...args: any[]) => {
            console.log('Mock send:', args);
        },
        removeAllListeners: () => { }
    };
    shell = {
        openExternal: (url: string) => console.log('Mock openExternal:', url),
        showItemInFolder: (path: string) => console.log('Mock showItemInFolder:', path)
    };
}

export { ipcRenderer, shell };

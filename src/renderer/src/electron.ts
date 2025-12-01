// Wrapper to get electron modules from preload script

let ipcRenderer: any;
let shell: any;

if (window.electron) {
    ipcRenderer = window.electron.ipcRenderer;
    shell = window.electron.shell;
} else {
    console.warn('Electron preload not detected. IPC calls will fail.');
    ipcRenderer = {
        invoke: (...args: any[]) => {
            console.log('Mock invoke:', args);
            return Promise.resolve();
        },
        on: (...args: any[]) => {
            console.log('Mock on:', args);
            return () => { };
        },
        send: (...args: any[]) => {
            console.log('Mock send:', args);
        },
        removeListener: () => { },
        removeAllListeners: () => { }
    };
    shell = {
        openExternal: (url: string) => console.log('Mock openExternal:', url),
        showItemInFolder: (path: string) => console.log('Mock showItemInFolder:', path)
    };
}

export { ipcRenderer, shell };

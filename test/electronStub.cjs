// Lets main-process modules that import 'electron' (logger, paths) load in plain node.
// The fake app is "not packaged", so pathManager uses process.cwd(): callers chdir to a
// temporary directory before requiring anything that logs.
const Module = require('module');

const fakeElectron = {
  app: { isPackaged: false, getPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  ipcMain: { handle() {}, on() {} },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

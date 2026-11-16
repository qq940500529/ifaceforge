const { contextBridge, ipcRenderer } = require('electron');

const methods = [
  'state',
  'select',
  'chooseProject',
  'register',
  'remove',
  'locale',
  'tasks',
  'cancelScan',
  'command',
  'chooseFile',
  'download',
  'copy',
  'releases',
];
const bridge = Object.fromEntries(
  methods.map((method) => [method, (...args) => ipcRenderer.invoke('ifaceforge:' + method, ...args)]),
);
contextBridge.exposeInMainWorld('ifaceforge', Object.freeze(bridge));

const { contextBridge, ipcRenderer } = require('electron');

const methods = [
  'state',
  'select',
  'chooseProject',
  'register',
  'remove',
  'locale',
  'tasks',
  'scanDetails',
  'cancelScan',
  'command',
  'chooseFile',
  'download',
  'copy',
  'releases',
  'about',
  'repository',
];
const bridge = Object.fromEntries(
  methods.map((method) => [method, (...args) => ipcRenderer.invoke('ifaceforge:' + method, ...args)]),
);
contextBridge.exposeInMainWorld('ifaceforge', Object.freeze(bridge));

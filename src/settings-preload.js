'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumoSettings', {
  getState: () => ipcRenderer.invoke('browser:settings-get-state'),
  save: (settings) => ipcRenderer.invoke('browser:save-settings', settings),
  resetPermission: (origin, permission) => ipcRenderer.invoke('browser:settings-permission-reset', origin, permission),
  resetAllPermissions: () => ipcRenderer.invoke('browser:settings-permissions-reset-all'),
  importBookmarks: () => ipcRenderer.invoke('browser:settings-bookmarks-import'),
  exportBookmarks: () => ipcRenderer.invoke('browser:settings-bookmarks-export'),
  clearBrowsingData: (selection) => ipcRenderer.invoke('browser:settings-clear-data', selection),
  close: () => ipcRenderer.send('browser:settings-close'),
  onState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('browser:state', listener);
    return () => ipcRenderer.removeListener('browser:state', listener);
  },
});

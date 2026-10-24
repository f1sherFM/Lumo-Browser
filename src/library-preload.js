'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumoLibrary', {
  getData: () => ipcRenderer.invoke('browser:library-get-data'),
  switchKind: (kind) => ipcRenderer.invoke('browser:library-switch-kind', kind),
  close: () => ipcRenderer.send('browser:library-close'),
  openUrl: (url) => ipcRenderer.invoke('browser:library-open-url', url),
  removeBookmark: (url) => ipcRenderer.invoke('browser:library-bookmark-remove', url),
  clearHistory: () => ipcRenderer.invoke('browser:library-history-clear'),
  cancelDownload: (id) => ipcRenderer.invoke('browser:library-download-cancel', id),
  openDownload: (id) => ipcRenderer.invoke('browser:library-download-open', id),
  showDownload: (id) => ipcRenderer.invoke('browser:library-download-show', id),
  removeDownload: (id) => ipcRenderer.invoke('browser:library-download-remove', id),
  clearFinishedDownloads: () => ipcRenderer.invoke('browser:library-downloads-clear-finished'),
  onData: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('browser:library-data', listener);
    return () => ipcRenderer.removeListener('browser:library-data', listener);
  },
  onKind: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, kind) => callback(kind);
    ipcRenderer.on('browser:library-kind', listener);
    return () => ipcRenderer.removeListener('browser:library-kind', listener);
  },
});

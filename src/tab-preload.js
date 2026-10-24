'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Only the bundled new-tab document receives a search bridge. Remote pages load
// this preload too, but get no additional API exposed to their JavaScript.
const isLumoNewTab = window.location.protocol === 'lumo:' &&
  window.location.pathname.toLowerCase().endsWith('/newtab.html');

if (isLumoNewTab) {
  contextBridge.exposeInMainWorld('lumoNewTab', {
    search: (query) => ipcRenderer.invoke('browser:search-from-newtab', String(query ?? '')),
    onActivated: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = () => callback();
      ipcRenderer.on('browser:newtab-activated', listener);
      return () => ipcRenderer.removeListener('browser:newtab-activated', listener);
    },
  });
}

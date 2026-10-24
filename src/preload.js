const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumo', {
  getState: () => ipcRenderer.invoke('browser:get-state'),
  navigate: (address) => ipcRenderer.invoke('browser:navigate', address),
  newTab: () => ipcRenderer.invoke('browser:new-tab'),
  activateTab: (tabId) => ipcRenderer.invoke('browser:activate-tab', tabId),
  closeTab: (tabId) => ipcRenderer.invoke('browser:close-tab', tabId),
  duplicateTab: (tabId) => ipcRenderer.invoke('browser:duplicate-tab', tabId),
  toggleTabPinned: (tabId) => ipcRenderer.invoke('browser:toggle-tab-pinned', tabId),
  moveTab: (tabId, targetTabId, insertAfter) => ipcRenderer.invoke('browser:move-tab', tabId, targetTabId, insertAfter),
  closeOtherTabs: (tabId) => ipcRenderer.invoke('browser:close-other-tabs', tabId),
  closeTabsToRight: (tabId) => ipcRenderer.invoke('browser:close-tabs-to-right', tabId),
  back: () => ipcRenderer.invoke('browser:back'),
  forward: () => ipcRenderer.invoke('browser:forward'),
  reload: () => ipcRenderer.invoke('browser:reload'),
  home: () => ipcRenderer.invoke('browser:home'),
  toggleSettings: () => ipcRenderer.send('browser:toggle-settings'),
  openLibrary: (kind) => ipcRenderer.invoke('browser:open-library', kind),
  toggleBookmark: () => ipcRenderer.invoke('browser:toggle-bookmark'),
  onImmersive: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, active) => callback(active);
    ipcRenderer.on('browser:immersive', listener);
    return () => ipcRenderer.removeListener('browser:immersive', listener);
  },
  onState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('browser:state', listener);
    return () => ipcRenderer.removeListener('browser:state', listener);
  },
  onFocusAddress: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('browser:focus-address', listener);
    return () => ipcRenderer.removeListener('browser:focus-address', listener);
  },
  onSidebarWidth: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, width) => callback(width);
    ipcRenderer.on('browser:sidebar-width', listener);
    return () => ipcRenderer.removeListener('browser:sidebar-width', listener);
  },
});

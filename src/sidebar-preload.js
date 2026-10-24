const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumoSidebar', {
  getState: () => ipcRenderer.invoke('browser:get-state'),
  setSidebarWidth: (width) => ipcRenderer.send('browser:set-sidebar-width', width),
  focusAddress: () => ipcRenderer.send('browser:focus-address-request'),
  home: () => ipcRenderer.invoke('browser:home'),
  toggleSettings: () => ipcRenderer.send('browser:toggle-settings'),
  newTab: () => ipcRenderer.invoke('browser:new-tab'),
  activateTab: (tabId) => ipcRenderer.invoke('browser:activate-tab', tabId),
  closeTab: (tabId) => ipcRenderer.invoke('browser:close-tab', tabId),
  duplicateTab: (tabId) => ipcRenderer.invoke('browser:duplicate-tab', tabId),
  toggleTabPinned: (tabId) => ipcRenderer.invoke('browser:toggle-tab-pinned', tabId),
  pinCurrentSite: (tabId) => ipcRenderer.invoke('browser:pin-current-site', tabId),
  removePinnedSite: (url) => ipcRenderer.invoke('browser:remove-pinned-site', url),
  openPinnedSite: (url) => ipcRenderer.invoke('browser:open-pinned-site', url),
  moveTab: (tabId, targetTabId, insertAfter) => ipcRenderer.invoke('browser:move-tab', tabId, targetTabId, insertAfter),
  closeOtherTabs: (tabId) => ipcRenderer.invoke('browser:close-other-tabs', tabId),
  closeTabsToRight: (tabId) => ipcRenderer.invoke('browser:close-tabs-to-right', tabId),
  back: () => ipcRenderer.invoke('browser:back'),
  forward: () => ipcRenderer.invoke('browser:forward'),
  reload: () => ipcRenderer.invoke('browser:reload'),
  onState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('browser:state', listener);
    return () => ipcRenderer.removeListener('browser:state', listener);
  },
});

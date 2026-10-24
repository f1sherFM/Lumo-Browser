'use strict';

const form = document.getElementById('settingsForm');
const searchEngine = document.getElementById('searchEngine');
const startupBehavior = document.getElementById('startupBehavior');
const networkMode = document.getElementById('networkMode');
const proxyUrl = document.getElementById('proxyUrl');
const proxyUrlLabel = document.getElementById('proxyUrlLabel');
const routeStatus = document.getElementById('routeStatus');
const settingsNotice = document.getElementById('settingsNotice');
const saveButton = document.getElementById('saveSettings');
const cancelButton = document.getElementById('cancelSettings');
const closeButton = document.getElementById('closeSettings');
const permissionList = document.getElementById('permissionList');
const resetAllPermissionsButton = document.getElementById('resetAllPermissions');
const importBookmarksButton = document.getElementById('importBookmarks');
const exportBookmarksButton = document.getElementById('exportBookmarks');
const clearBrowsingDataButton = document.getElementById('clearBrowsingData');

let lastSettings = null;
let lastPermissionsSignature = null;

function setStatus(message, state = '') {
  routeStatus.textContent = message;
  routeStatus.dataset.state = state;
}

function setNotice(message, state = '') {
  settingsNotice.textContent = message;
  settingsNotice.dataset.state = state;
  settingsNotice.hidden = !message;
}

function updateProxyVisibility() {
  const visible = networkMode.value === 'custom';
  proxyUrl.hidden = !visible;
  proxyUrlLabel.hidden = !visible;
}

function permissionLabel(permission) {
  return ({
    geolocation: 'Location',
    notifications: 'Notifications',
    media: 'Camera / microphone',
    'clipboard-read': 'Clipboard access',
  })[permission] || permission;
}

function renderPermissions(decisions = []) {
  const signature = JSON.stringify(decisions.map(({ origin, permission, allowed }) => ({ origin, permission, allowed })));
  if (signature === lastPermissionsSignature) return;
  lastPermissionsSignature = signature;
  permissionList.replaceChildren();
  resetAllPermissionsButton.disabled = decisions.length === 0;
  if (!decisions.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No site permissions have been decided this session.';
    permissionList.append(empty);
    return;
  }

  for (const decision of decisions) {
    const row = document.createElement('div');
    row.className = 'permission-row';

    const detail = document.createElement('div');
    detail.className = 'permission-detail';
    const origin = document.createElement('strong');
    origin.className = 'permission-origin';
    origin.textContent = decision.origin;
    origin.title = decision.origin;
    const description = document.createElement('span');
    description.className = 'permission-description';
    description.textContent = permissionLabel(decision.permission);
    detail.append(origin, description);

    const status = document.createElement('span');
    status.className = `permission-state ${decision.allowed ? 'is-allowed' : 'is-blocked'}`;
    status.textContent = decision.allowed ? 'Allowed' : 'Blocked';

    const reset = document.createElement('button');
    reset.className = 'small-action-button';
    reset.type = 'button';
    reset.textContent = 'Reset';
    reset.setAttribute('aria-label', `Reset ${permissionLabel(decision.permission)} decision for ${decision.origin}`);
    reset.addEventListener('click', async () => {
      reset.disabled = true;
      try {
        const result = await window.lumoSettings.resetPermission(decision.origin, decision.permission);
        if (result?.ok) setNotice(`Reset ${permissionLabel(decision.permission)} for ${decision.origin}.`, 'success');
        else setNotice(result?.error || 'Could not reset this permission.', 'error');
      } catch (error) {
        setNotice(error?.message || 'Could not reset this permission.', 'error');
      } finally {
        reset.disabled = false;
      }
    });

    row.append(detail, status, reset);
    permissionList.append(row);
  }
}

function applyState(state) {
  if (state.settings) {
    lastSettings = state.settings;
    if (document.activeElement !== searchEngine) searchEngine.value = state.settings.searchEngine || 'duckduckgo';
    if (document.activeElement !== startupBehavior) startupBehavior.value = state.settings.startupBehavior || 'restore';
    if (document.activeElement !== networkMode) networkMode.value = state.settings.network?.mode || 'custom';
    if (document.activeElement !== proxyUrl) proxyUrl.value = state.settings.network?.proxyUrl || 'socks5://127.0.0.1:10808';
  }
  updateProxyVisibility();
  renderPermissions(Array.isArray(state.permissionDecisions) ? state.permissionDecisions : []);

  if (state.networkReady) setStatus(`Route configured · ${state.networkLabel || 'Configured'}`, 'ready');
  else if (state.networkStartupError || state.settingsWarning) {
    setStatus(state.networkStartupError || state.settingsWarning, 'error');
  } else setStatus('Network route has not been confirmed.', '');
}

networkMode.addEventListener('change', updateProxyVisibility);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveButton.disabled = true;
  setNotice('Saving settings…');
  const settings = {
    searchEngine: searchEngine.value,
    startupBehavior: startupBehavior.value,
    network: { mode: networkMode.value, proxyUrl: proxyUrl.value.trim() },
  };
  try {
    const result = await window.lumoSettings.save(settings);
    if (!result?.ok) {
      setNotice(result?.error || 'Could not save settings.', 'error');
      return;
    }
    lastSettings = result.state?.settings || settings;
    applyState(result.state || {});
    setNotice('Settings saved. Startup behavior changes take effect next launch.', 'success');
  } catch (error) {
    setNotice(error?.message || 'Could not save settings.', 'error');
  } finally {
    saveButton.disabled = false;
  }
});

resetAllPermissionsButton.addEventListener('click', async () => {
  resetAllPermissionsButton.disabled = true;
  try {
    const result = await window.lumoSettings.resetAllPermissions();
    if (result?.ok) setNotice(`Reset ${result.count} site permission decision${result.count === 1 ? '' : 's'}. Sites will ask again when needed.`, 'success');
    else setNotice(result?.error || 'Could not reset site permissions.', 'error');
  } catch (error) {
    setNotice(error?.message || 'Could not reset site permissions.', 'error');
  } finally {
    resetAllPermissionsButton.disabled = false;
  }
});

importBookmarksButton.addEventListener('click', async () => {
  importBookmarksButton.disabled = true;
  setNotice('Opening bookmark file…');
  try {
    const result = await window.lumoSettings.importBookmarks();
    if (result?.canceled) setNotice('Bookmark import canceled.');
    else if (result?.ok) setNotice(`Imported ${result.imported} bookmark${result.imported === 1 ? '' : 's'}; skipped ${result.duplicates} duplicate or existing entr${result.duplicates === 1 ? 'y' : 'ies'}. Total: ${result.total}.`, 'success');
    else setNotice(result?.error || 'Could not import bookmarks.', 'error');
  } catch (error) {
    setNotice(error?.message || 'Could not import bookmarks.', 'error');
  } finally {
    importBookmarksButton.disabled = false;
  }
});

exportBookmarksButton.addEventListener('click', async () => {
  exportBookmarksButton.disabled = true;
  setNotice('Preparing bookmark export…');
  try {
    const result = await window.lumoSettings.exportBookmarks();
    if (result?.canceled) setNotice('Bookmark export canceled.');
    else if (result?.ok) setNotice(`Exported ${result.count} bookmark${result.count === 1 ? '' : 's'} to the selected HTML file.`, 'success');
    else setNotice(result?.error || 'Could not export bookmarks.', 'error');
  } catch (error) {
    setNotice(error?.message || 'Could not export bookmarks.', 'error');
  } finally {
    exportBookmarksButton.disabled = false;
  }
});

clearBrowsingDataButton.addEventListener('click', async () => {
  const selection = {
    history: document.getElementById('clearHistory').checked,
    cookies: document.getElementById('clearCookies').checked,
    siteStorage: document.getElementById('clearSiteStorage').checked,
    cache: document.getElementById('clearCache').checked,
    downloadList: document.getElementById('clearDownloadList').checked,
    permissions: document.getElementById('clearPermissions').checked,
  };
  if (!Object.values(selection).some(Boolean)) {
    setNotice('Choose at least one data type to clear.', 'error');
    return;
  }
  clearBrowsingDataButton.disabled = true;
  setNotice('Clearing selected browsing data…');
  try {
    const result = await window.lumoSettings.clearBrowsingData(selection);
    if (result?.canceled) setNotice('Clearing canceled.');
    else if (result?.ok) {
      document.querySelectorAll('.clear-data-options input[type="checkbox"]').forEach((checkbox) => { checkbox.checked = false; });
      setNotice(`Cleared: ${result.cleared.join(', ')}. Downloaded files were not deleted.`, 'success');
    } else setNotice(result?.error || 'Could not clear selected data.', 'error');
  } catch (error) {
    setNotice(error?.message || 'Could not clear selected data.', 'error');
  } finally {
    clearBrowsingDataButton.disabled = false;
  }
});

cancelButton.addEventListener('click', () => window.lumoSettings.close());
closeButton.addEventListener('click', () => window.lumoSettings.close());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.lumoSettings.close();
});
window.lumoSettings.onState(applyState);
window.lumoSettings.getState().then(applyState).catch((error) => setStatus(error?.message || 'Could not load settings.', 'error'));

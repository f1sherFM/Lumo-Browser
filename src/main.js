'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { app, BrowserWindow, WebContentsView, dialog, ipcMain, protocol, session, shell } = require('electron');
const { DEFAULT_SETTINGS, MAX_RESTORED_TABS, isWebUrl, normalizeAddress, normalizeSavedSession, reorderTabItems, setTabPinnedOrder, getOtherClosableTabIds, getClosableTabIdsToRight, sanitizeDownloadFilename, validateSettings } = require('./core');
const { getWebOrigin, isSecurePermissionOrigin, describePermission, permissionDecisionKey } = require('./permissions');
const { parseBookmarkImport, bookmarksToNetscapeHtml, mergeImportedBookmarks } = require('./bookmarks');

const COLLAPSED_SIDEBAR_WIDTH = 76;
const EXPANDED_SIDEBAR_WIDTH = 248;
const TOOLBAR_HEIGHT = 76;
const START_PAGE_PATH = path.join(__dirname, 'newtab.html');
const START_PAGE_URL = 'lumo://app/newtab.html';

// Register a secure internal origin before Electron becomes ready. The handler
// only serves a small allowlist of bundled new-tab assets (never arbitrary paths).
protocol.registerSchemesAsPrivileged([{
  scheme: 'lumo',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);
const SETTINGS_TEMPLATE_PATH = path.join(__dirname, '..', 'lumo.config.json');
const WEB_PREFERENCES = {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  devTools: !app.isPackaged,
  preload: path.join(__dirname, 'tab-preload.js'),
};
const MAX_HISTORY_ITEMS = 500;
const MAX_BOOKMARKS = 500;
const MAX_DOWNLOAD_ITEMS = 100;
const MAX_BOOKMARK_IMPORT_BYTES = 5 * 1024 * 1024;
const LIBRARY_KINDS = new Set(['history', 'bookmarks', 'downloads']);

let sidebarWidth = COLLAPSED_SIDEBAR_WIDTH;
let SETTINGS = {
  searchEngine: DEFAULT_SETTINGS.searchEngine,
  startupBehavior: DEFAULT_SETTINGS.startupBehavior,
  network: { ...DEFAULT_SETTINGS.network },
};
let settingsPath = '';
let sessionPath = '';
let browserDataPath = '';
let settingsWarning = '';
let networkStartupError = '';
let networkReady = false;
let mainWindow = null;
let sidebarView = null;
let settingsView = null;
let libraryView = null;
let libraryKind = 'history';
let activeTabId = null;
let nextTabId = 1;
let persistTimer = null;
let browserDataPersistTimer = null;
let browserData = { history: [], bookmarks: [], downloads: [], pinnedSites: [] };
let immersiveFullscreen = false;
let htmlFullscreenTabId = null;
const activeDownloads = new Map();
const reservedDownloadPaths = new Set();
const sessionPermissionDecisions = new Map();
const pendingPermissionPrompts = new Map();
let permissionPromptQueue = Promise.resolve();
let permissionDecisionEpoch = 0;
const tabs = new Map();

function cloneDefaultSettings() {
  return { searchEngine: DEFAULT_SETTINGS.searchEngine, startupBehavior: DEFAULT_SETTINGS.startupBehavior, network: { ...DEFAULT_SETTINGS.network } };
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    // Replacing an existing file can behave differently on Windows; preserve a fallback.
    try {
      fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    } finally {
      try { fs.unlinkSync(temporaryPath); } catch { /* Already moved or removed. */ }
    }
  }
}

function initializeStorage() {
  const userDataDirectory = app.getPath('userData');
  fs.mkdirSync(userDataDirectory, { recursive: true });
  settingsPath = path.join(userDataDirectory, 'lumo.config.json');
  sessionPath = path.join(userDataDirectory, 'session.json');
  browserDataPath = path.join(userDataDirectory, 'browser-data.json');

  if (!fs.existsSync(settingsPath)) {
    if (fs.existsSync(SETTINGS_TEMPLATE_PATH)) {
      try {
        fs.copyFileSync(SETTINGS_TEMPLATE_PATH, settingsPath);
      } catch (error) {
        settingsWarning = `Could not migrate lumo.config.json: ${error.message}`;
      }
    } else {
      writeJsonAtomic(settingsPath, cloneDefaultSettings());
    }
  }

  let settingsLoaded = true;
  try {
    SETTINGS = validateSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    // Persist the normalized schema so older configs gain the new searchEngine field.
    writeJsonAtomic(settingsPath, SETTINGS);
  } catch (error) {
    SETTINGS = cloneDefaultSettings();
    settingsWarning = `Settings need attention: ${error.message}. Open Lumo settings and save a valid configuration.`;
    settingsLoaded = false;
  }

  try {
    const data = JSON.parse(fs.readFileSync(browserDataPath, 'utf8'));
    const downloads = Array.isArray(data.downloads) ? data.downloads : [];
    browserData = {
      history: Array.isArray(data.history) ? data.history.filter((item) => item && isWebUrl(item.url)).slice(0, MAX_HISTORY_ITEMS) : [],
      bookmarks: Array.isArray(data.bookmarks) ? data.bookmarks.filter((item) => item && isWebUrl(item.url)).slice(0, MAX_BOOKMARKS) : [],
      pinnedSites: Array.isArray(data.pinnedSites) ? data.pinnedSites.filter((item) => item && isWebUrl(item.url)).slice(0, 100).map((item) => ({ url: item.url, title: String(item.title || item.url).slice(0, 160) })) : [],
      downloads: downloads.filter((item) => item && typeof item === 'object').slice(0, MAX_DOWNLOAD_ITEMS).map((item) => {
        const state = ['completed', 'interrupted', 'cancelled', 'downloading'].includes(item.state) ? item.state : 'interrupted';
        const storedPath = typeof item.path === 'string' && isSafeDownloadPath(item.path) ? path.resolve(item.path) : '';
        return {
          id: typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID(),
          url: isWebUrl(item.url) ? item.url : '',
          filename: sanitizeDownloadFilename(item.filename),
          path: storedPath,
          state: state === 'downloading' ? 'interrupted' : state,
          receivedBytes: Number.isFinite(item.receivedBytes) ? Math.max(0, item.receivedBytes) : 0,
          totalBytes: Number.isFinite(item.totalBytes) ? Math.max(0, item.totalBytes) : 0,
          startedAt: Number.isFinite(item.startedAt) ? item.startedAt : Date.now(),
          mimeType: typeof item.mimeType === 'string' ? item.mimeType.slice(0, 160) : '',
        };
      }),
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[Lumo] Could not load browser data:', error.message);
  }
  return settingsLoaded;
}

function persistBrowserData() {
  if (!browserDataPath) return;
  try {
    writeJsonAtomic(browserDataPath, browserData);
  } catch (error) {
    console.error('[Lumo] Could not save browser data:', error);
  }
}

function scheduleBrowserDataPersist() {
  if (!browserDataPath || browserDataPersistTimer) return;
  browserDataPersistTimer = setTimeout(() => {
    browserDataPersistTimer = null;
    persistBrowserData();
  }, 400);
  browserDataPersistTimer.unref?.();
}

function snapshotTabUrl(tab) {
  if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return '';
  const currentUrl = tab.view.webContents.getURL();
  if (isStartPageUrl(currentUrl)) return '';
  const url = currentUrl && currentUrl !== 'about:blank' ? currentUrl : tab.url;
  return isWebUrl(url) ? url : '';
}

function persistSession() {
  if (!sessionPath || tabs.size === 0) return;
  const tabEntries = [...tabs.values()].map((tab) => ({
    id: tab.id,
    url: snapshotTabUrl(tab),
    pinned: Boolean(tab.pinned),
  }));
  // Pinned tabs remain high priority for restore; always keep the active tab too.
  const safeEntries = tabEntries.slice(0, MAX_RESTORED_TABS);
  const activeEntry = tabEntries.find((entry) => entry.id === activeTabId);
  if (activeEntry && !safeEntries.some((entry) => entry.id === activeEntry.id) && safeEntries.length) {
    safeEntries[safeEntries.length - 1] = activeEntry;
    const grouped = [...safeEntries.filter((entry) => entry.pinned), ...safeEntries.filter((entry) => !entry.pinned)];
    safeEntries.splice(0, safeEntries.length, ...grouped);
  }
  const activeIndex = Math.max(0, safeEntries.findIndex((entry) => entry.id === activeTabId));
  try {
    writeJsonAtomic(sessionPath, {
      version: 2,
      savedAt: new Date().toISOString(),
      activeIndex: Math.min(activeIndex, Math.max(0, safeEntries.length - 1)),
      tabs: safeEntries.length
        ? safeEntries.map(({ url, pinned }) => ({ url, pinned }))
        : [{ url: '', pinned: false }],
    });
  } catch (error) {
    console.error('[Lumo] Could not save session:', error);
  }
}

function scheduleSessionSave() {
  if (!sessionPath) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistSession();
  }, 350);
  persistTimer.unref?.();
}

function loadSavedSession() {
  try {
    const saved = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    return normalizeSavedSession(saved, MAX_RESTORED_TABS);
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[Lumo] Could not restore previous session:', error.message);
    return { tabs: [{ url: '' }], activeIndex: 0 };
  }
}

function isStartPageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'lumo:' && url.hostname === 'app' && url.pathname === '/newtab.html';
  } catch {
    return false;
  }
}

function installLumoProtocol() {
  const assets = new Map([
    ['/newtab.html', { file: 'newtab.html', type: 'text/html; charset=utf-8' }],
    ['/newtab.css', { file: 'newtab.css', type: 'text/css; charset=utf-8' }],
    ['/newtab.js', { file: 'newtab.js', type: 'text/javascript; charset=utf-8' }],
  ]);

  protocol.handle('lumo', (request) => {
    let url;
    try { url = new URL(request.url); }
    catch { return new Response('Bad request', { status: 400 }); }
    if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
    const asset = assets.get(url.pathname);
    if (!asset) return new Response('Not found', { status: 404 });
    try {
      return new Response(fs.readFileSync(path.join(__dirname, asset.file)), {
        status: 200,
        headers: { 'Content-Type': asset.type, 'X-Content-Type-Options': 'nosniff' },
      });
    } catch (error) {
      console.error(`[Lumo] Could not serve internal asset ${asset.file}:`, error);
      return new Response('Internal resource unavailable', { status: 500 });
    }
  });
}

function getNetworkLabel(settings = SETTINGS) {
  if (settings.network.mode === 'system') return 'System proxy';
  if (settings.network.mode === 'direct') return 'Direct connection';
  try {
    const parsed = new URL(settings.network.proxyUrl);
    const scheme = parsed.protocol.replace(':', '').toUpperCase();
    return `${scheme} · ${parsed.hostname}:${parsed.port}`;
  } catch {
    return 'Custom proxy';
  }
}

async function configureNetwork(settings) {
  if (settings.network.mode === 'system') {
    await session.defaultSession.setProxy({ mode: 'system' });
  } else if (settings.network.mode === 'direct') {
    await session.defaultSession.setProxy({ mode: 'direct' });
  } else {
    await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: settings.network.proxyUrl });
  }
  await session.defaultSession.closeAllConnections();
  console.log(`[Lumo] Network route configured: ${getNetworkLabel(settings)}`);
}

function getPermissionRequestOrigin(webContents, details = {}) {
  const requestingUrl = details.requestingUrl || webContents?.getURL?.() || '';
  const requestingOrigin = getWebOrigin(requestingUrl);
  const topOrigin = getWebOrigin(webContents?.getURL?.() || '');

  // Only allow requests attributable to the currently loaded web origin. This
  // prevents an unrelated/cross-origin iframe from borrowing a top-level grant.
  if (!requestingOrigin || !topOrigin || requestingOrigin !== topOrigin || !isSecurePermissionOrigin(requestingUrl)) return '';
  if (details.isMainFrame === false && details.embeddingOrigin && getWebOrigin(details.embeddingOrigin) !== topOrigin) return '';
  return requestingOrigin;
}

async function promptForSitePermission(origin, permission, details = {}) {
  const key = permissionDecisionKey(origin, permission);
  if (!key) return false;
  if (sessionPermissionDecisions.has(key)) return sessionPermissionDecisions.get(key);
  if (pendingPermissionPrompts.has(key)) return pendingPermissionPrompts.get(key);

  const description = describePermission(permission, details);
  const promptEpoch = permissionDecisionEpoch;
  // Serialize native dialogs. Some sites request multiple permissions nearly
  // simultaneously; stacking modal prompts makes the browser feel broken.
  const promise = permissionPromptQueue.catch(() => {}).then(async () => {
    if (sessionPermissionDecisions.has(key)) return sessionPermissionDecisions.get(key);
    let allowed = false;
    try {
      const options = {
        type: 'question',
        title: 'Lumo site permission',
        message: `${origin} wants to access ${description}.`,
        detail: 'Your choice applies to this Lumo session only. Unknown permission types are blocked by default.',
        buttons: ['Allow for this session', 'Block'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const result = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      allowed = result.response === 0;
    } catch (error) {
      console.warn('[Lumo] Could not show site permission prompt:', error?.message || error);
    }
    if (promptEpoch !== permissionDecisionEpoch) return false;
    sessionPermissionDecisions.set(key, allowed);
    sendState();
    return allowed;
  });
  permissionPromptQueue = promise.then(() => undefined, () => undefined);

  pendingPermissionPrompts.set(key, promise);
  try {
    return await promise;
  } finally {
    if (pendingPermissionPrompts.get(key) === promise) pendingPermissionPrompts.delete(key);
  }
}

function installNetworkAndPermissionGuards() {
  const defaultSession = session.defaultSession;

  // Use both handlers, as required by Electron, and remember decisions only in
  // memory. The browser asks explicitly for common permissions and denies all
  // unreviewed permission types by default.
  defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details = {}) => {
    const origin = getWebOrigin(requestingOrigin || details.requestingUrl || webContents?.getURL?.() || '');
    const topOrigin = getWebOrigin(webContents?.getURL?.() || '');
    if (!origin || !isSecurePermissionOrigin(requestingOrigin || details.requestingUrl || webContents?.getURL?.() || '') || (topOrigin && origin !== topOrigin)) return false;
    const key = permissionDecisionKey(origin, permission);
    return Boolean(key && sessionPermissionDecisions.get(key) === true);
  });

  defaultSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    let responded = false;
    const respond = (allowed) => {
      if (responded) return;
      responded = true;
      callback(Boolean(allowed));
    };

    const origin = getPermissionRequestOrigin(webContents, details);
    const key = permissionDecisionKey(origin, permission);
    // Unknown permission types, internal pages, and cross-origin frames are
    // rejected without a prompt. The allowlist remains intentionally narrow.
    if (!key || !describePermission(permission, details) || !networkReady) {
      respond(false);
      return;
    }
    if (sessionPermissionDecisions.has(key)) {
      respond(sessionPermissionDecisions.get(key));
      return;
    }

    promptForSitePermission(origin, permission, details).then((allowed) => {
      // Do not grant a permission if this webContents navigated to another
      // origin while the native prompt was open.
      const currentOrigin = getWebOrigin(webContents?.getURL?.() || '');
      respond(Boolean(allowed && !webContents.isDestroyed() && currentOrigin === origin));
    }).catch((error) => {
      console.warn('[Lumo] Site permission request failed:', error?.message || error);
      respond(false);
    });
  });

  // If applying the selected network route fails, fail closed for all external
  // HTTP(S)/WebSocket requests rather than silently loading sites via another route.
  defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      if (!networkReady) return callback({ cancel: true });
      return callback({});
    },
  );
}

function getTab(tabId = activeTabId) {
  return tabId == null ? null : tabs.get(Number(tabId)) || null;
}

function getTabForContents(contents) {
  for (const tab of tabs.values()) {
    if (tab.view && !tab.view.webContents.isDestroyed() && tab.view.webContents === contents) return tab;
  }
  return null;
}

function getTabSnapshot(tab) {
  if (!tab) return null;
  const contents = tab.view?.webContents;
  const alive = contents && !contents.isDestroyed();
  let url = tab.url || '';
  if (alive) {
    const currentUrl = contents.getURL();
    if (isStartPageUrl(currentUrl)) url = '';
    else if (currentUrl && currentUrl !== 'about:blank') url = currentUrl;
  }

  return {
    id: tab.id,
    title: isStartPageUrl(alive ? contents.getURL() : '') ? 'New tab' : (tab.title || 'New tab'),
    url,
    favicon: tab.favicon || '',
    pinned: Boolean(tab.pinned),
    loading: Boolean(tab.loading),
    error: tab.error || '',
    active: tab.id === activeTabId,
  };
}

function getPermissionSettings() {
  return [...sessionPermissionDecisions.entries()].map(([key, allowed]) => {
    const separator = key.indexOf('\u0000');
    if (separator < 0) return null;
    const origin = key.slice(0, separator);
    const permission = key.slice(separator + 1);
    if (!origin || !permission) return null;
    return { origin, permission, allowed: Boolean(allowed), description: describePermission(permission) || permission };
  }).filter(Boolean).sort((a, b) => a.origin.localeCompare(b.origin) || a.permission.localeCompare(b.permission));
}

function getState() {
  const active = getTab();
  const contents = active?.view?.webContents;
  const alive = contents && !contents.isDestroyed();
  const activeSnapshot = getTabSnapshot(active);

  return {
    activeTabId,
    tabs: [...tabs.values()].map(getTabSnapshot),
    pinnedSites: browserData.pinnedSites,
    immersiveFullscreen,
    tabCount: tabs.size,
    title: activeSnapshot?.title || 'New tab',
    url: activeSnapshot?.url || '',
    canGoBack: Boolean(alive && contents.navigationHistory.canGoBack()),
    canGoForward: Boolean(alive && contents.navigationHistory.canGoForward()),
    loading: Boolean(active?.loading),
    error: active?.error || '',
    networkLabel: getNetworkLabel(),
    networkReady,
    networkStartupError,
    settingsWarning,
    settings: {
      searchEngine: SETTINGS.searchEngine,
      startupBehavior: SETTINGS.startupBehavior,
      network: { mode: SETTINGS.network.mode, proxyUrl: SETTINGS.network.proxyUrl },
    },
    permissionDecisions: getPermissionSettings(),
    historyCount: browserData.history.length,
    bookmarkCount: browserData.bookmarks.length,
    downloadCount: browserData.downloads.length,
    isBookmarked: Boolean(activeSnapshot?.url && browserData.bookmarks.some((item) => item.url === activeSnapshot.url)),
  };
}

function sendState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const state = getState();
  if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('browser:immersive', immersiveFullscreen);
  if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('browser:state', state);
  }
  if (sidebarView && !sidebarView.webContents.isDestroyed()) {
    sidebarView.webContents.send('browser:state', state);
  }
  if (settingsView && !settingsView.webContents.isDestroyed()) {
    settingsView.webContents.send('browser:state', state);
  }
  scheduleSessionSave();
}

function recordHistory(tab, url) {
  if (!isWebUrl(url)) return;
  let fallbackTitle = url;
  try { fallbackTitle = new URL(url).hostname; } catch { /* Use URL as fallback title. */ }
  const entry = { url, title: tab.title || fallbackTitle, visitedAt: Date.now() };
  browserData.history = [entry, ...browserData.history.filter((item) => item.url !== url)].slice(0, MAX_HISTORY_ITEMS);
  persistBrowserData();
  sendLibraryData();
}

function updateHistoryTitle(tab) {
  const url = snapshotTabUrl(tab);
  if (!url) return;
  const entry = browserData.history.find((item) => item.url === url);
  if (!entry) return;
  const title = String(tab.title || '').trim();
  if (!title || title === entry.title) return;
  entry.title = title.slice(0, 500);
  persistBrowserData();
  sendLibraryData();
}

function getLibraryData() {
  return {
    kind: libraryKind,
    history: browserData.history.slice(0, MAX_HISTORY_ITEMS).map((item) => ({
      url: item.url, title: item.title || item.url, visitedAt: item.visitedAt,
    })),
    bookmarks: browserData.bookmarks.slice(0, MAX_BOOKMARKS).map((item) => ({
      url: item.url, title: item.title || item.url, addedAt: item.addedAt || 0,
    })),
    downloads: browserData.downloads.slice(0, MAX_DOWNLOAD_ITEMS).map((item) => ({
      id: item.id, url: item.url, filename: item.filename, state: item.state,
      receivedBytes: item.receivedBytes, totalBytes: item.totalBytes,
      startedAt: item.startedAt, mimeType: item.mimeType,
    })),
  };
}

function sendLibraryData() {
  if (libraryView && !libraryView.webContents.isDestroyed() && libraryView.webContents.isLoading() === false) {
    libraryView.webContents.send('browser:library-data', getLibraryData());
  }
}

function isSafeDownloadPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return false;
  try {
    const target = path.resolve(rawPath);
    const downloadsRoot = path.resolve(app.getPath('downloads'));
    return path.dirname(target).toLowerCase() === downloadsRoot.toLowerCase();
  } catch {
    return false;
  }
}

function getUniqueDownloadPath(rawFilename) {
  const downloadsRoot = app.getPath('downloads');
  fs.mkdirSync(downloadsRoot, { recursive: true });
  const filename = sanitizeDownloadFilename(rawFilename);
  const extension = path.extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  let candidate = path.join(downloadsRoot, filename);
  let suffix = 1;
  while (fs.existsSync(candidate) || reservedDownloadPaths.has(candidate.toLowerCase())) {
    candidate = path.join(downloadsRoot, `${stem} (${suffix++})${extension}`);
  }
  reservedDownloadPaths.add(candidate.toLowerCase());
  return candidate;
}

function installDownloadManager() {
  session.defaultSession.on('will-download', (_event, item) => {
    const id = crypto.randomUUID();
    const targetPath = getUniqueDownloadPath(item.getFilename());
    item.setSavePath(targetPath);
    const record = {
      id, url: isWebUrl(item.getURL()) ? item.getURL() : '',
      filename: sanitizeDownloadFilename(path.basename(targetPath)), path: targetPath,
      state: 'downloading', receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(),
      startedAt: Date.now(), mimeType: item.getMimeType() || '',
    };
    browserData.downloads = [record, ...browserData.downloads.filter((entry) => entry.id !== id)].slice(0, MAX_DOWNLOAD_ITEMS);
    activeDownloads.set(id, item);
    persistBrowserData();
    sendState();
    sendLibraryData();

    item.on('updated', (_updatedEvent, state) => {
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.path = isSafeDownloadPath(item.getSavePath()) ? item.getSavePath() : targetPath;
      record.filename = sanitizeDownloadFilename(path.basename(record.path || targetPath));
      if (state === 'interrupted') record.state = 'interrupted';
      else if (record.state === 'downloading') record.state = 'downloading';
      scheduleBrowserDataPersist();
      sendLibraryData();
    });

    item.once('done', (_doneEvent, state) => {
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.path = isSafeDownloadPath(item.getSavePath()) ? item.getSavePath() : targetPath;
      record.state = ['completed', 'cancelled', 'interrupted'].includes(state) ? state : 'interrupted';
      activeDownloads.delete(id);
      reservedDownloadPaths.delete(targetPath.toLowerCase());
      persistBrowserData();
      sendState();
      sendLibraryData();
    });
  });
}

// The page viewport is anchored to the collapsed rail. The sidebar expands as a
// native overlay and never changes page bounds on hover.
function updatePageBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  const bounds = immersiveFullscreen
    ? { x: 0, y: 0, width, height }
    : { x: COLLAPSED_SIDEBAR_WIDTH, y: TOOLBAR_HEIGHT, width: Math.max(0, width - COLLAPSED_SIDEBAR_WIDTH), height: Math.max(0, height - TOOLBAR_HEIGHT) };
  for (const tab of tabs.values()) tab.view.setBounds(bounds);
}

function updateSidebarBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !sidebarView || sidebarView.webContents.isDestroyed()) return;
  const [, height] = mainWindow.getContentSize();
  sidebarView.setBounds({ x: 0, y: 0, width: immersiveFullscreen ? 0 : sidebarWidth, height: Math.max(0, height) });
}

function updateSettingsBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !settingsView || settingsView.webContents.isDestroyed()) return;
  const [windowWidth, windowHeight] = mainWindow.getContentSize();
  const width = Math.min(432, Math.max(340, windowWidth - 32));
  const height = Math.min(700, Math.max(380, windowHeight - TOOLBAR_HEIGHT - 12));
  settingsView.setBounds({
    x: Math.max(COLLAPSED_SIDEBAR_WIDTH + 12, windowWidth - width - 12),
    y: TOOLBAR_HEIGHT + 6,
    width: Math.min(width, windowWidth - Math.max(COLLAPSED_SIDEBAR_WIDTH + 12, 0)),
    height: Math.min(height, windowHeight - TOOLBAR_HEIGHT - 12),
  });
}

function updateLibraryBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !libraryView || libraryView.webContents.isDestroyed()) return;
  const [windowWidth, windowHeight] = mainWindow.getContentSize();
  const x = Math.min(Math.max(COLLAPSED_SIDEBAR_WIDTH + 12, sidebarWidth + 12), Math.max(12, windowWidth - 340));
  const width = Math.max(300, Math.min(424, windowWidth - x - 12));
  const height = Math.max(280, Math.min(650, windowHeight - TOOLBAR_HEIGHT - 16));
  libraryView.setBounds({
    x, y: TOOLBAR_HEIGHT + 8,
    width: Math.min(width, windowWidth - x - 8),
    height: Math.min(height, windowHeight - TOOLBAR_HEIGHT - 12),
  });
}

function raiseViewStack() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const active = getTab();
  if (active?.view && !active.view.webContents.isDestroyed()) mainWindow.contentView.addChildView(active.view);
  if (sidebarView && !sidebarView.webContents.isDestroyed()) mainWindow.contentView.addChildView(sidebarView);
  if (libraryView && !libraryView.webContents.isDestroyed()) mainWindow.contentView.addChildView(libraryView);
  if (settingsView && !settingsView.webContents.isDestroyed()) mainWindow.contentView.addChildView(settingsView);
}

function focusAddressBar() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.focus();
  mainWindow.webContents.focus();
  mainWindow.webContents.send('browser:focus-address');
}

function activateTab(tabId, options = {}) {
  const tab = getTab(tabId);
  if (!tab || !mainWindow || mainWindow.isDestroyed()) return false;

  activeTabId = tab.id;
  for (const candidate of tabs.values()) candidate.view.setVisible(candidate.id === activeTabId);
  raiseViewStack();
  updatePageBounds();
  updateSidebarBounds();
  updateLibraryBounds();
  updateSettingsBounds();
  sendState();
  notifyNewTabActivated(tab);
  if (options.focusAddress) focusAddressBar();
  return true;
}

function notifyNewTabActivated(tab) {
  const contents = tab?.view?.webContents;
  if (!contents || contents.isDestroyed() || !isStartPageUrl(contents.getURL()) || contents.isLoading()) return;
  contents.send('browser:newtab-activated');
}

function friendlyNetworkError(rawMessage, url) {
  const message = String(rawMessage || 'Could not open this address.');
  const upper = message.toUpperCase();
  let host = 'the site';
  try { host = new URL(url).hostname; } catch { /* Keep generic label. */ }

  if (!networkReady) {
    return `External navigation is paused because Lumo could not confirm its network configuration. Open Settings, choose a valid route, and save it before trying ${host} again.`;
  }
  if (/ERR_SOCKS_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/.test(upper)) {
    return `Lumo could not connect through ${getNetworkLabel()}. Check that your local proxy is running and that its type and port match Settings.`;
  }
  if (/ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|TIMED OUT/.test(upper)) {
    if (SETTINGS.network.mode === 'custom') {
      return `Connection to ${host} timed out. Check that ${getNetworkLabel()} is running and can reach this site.`;
    }
    return `Connection to ${host} timed out. The site may be unreachable from this network, or the server may be responding slowly.`;
  }
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/.test(upper)) {
    return `Lumo could not resolve ${host}. Check the proxy/DNS settings and try again.`;
  }
  return message;
}

function navigateTab(tab, url) {
  if (!tab || tab.view.webContents.isDestroyed()) return;
  if (isWebUrl(url) && !networkReady) {
    tab.error = friendlyNetworkError(networkStartupError || 'Network route unavailable.', url);
    tab.loading = false;
    sendState();
    return;
  }
  tab.error = '';
  tab.loading = true;
  tab.url = isStartPageUrl(url) ? '' : url;
  sendState();
  const load = tab.view.webContents.loadURL(url);
  load.catch((error) => {
    if (error?.code === 'ERR_ABORTED' || !tabs.has(tab.id)) return;
    tab.loading = false;
    tab.error = friendlyNetworkError(error?.message || error?.code, url);
    sendState();
  });
}

function reorderTabMap(orderedTabs) {
  tabs.clear();
  for (const tab of orderedTabs) tabs.set(tab.id, tab);
}

function reorderTabMapPinnedFirst() {
  const current = [...tabs.values()];
  reorderTabMap([...current.filter((tab) => tab.pinned), ...current.filter((tab) => !tab.pinned)]);
}

function moveTab(tabId, targetTabId, insertAfter = false) {
  const ordered = reorderTabItems([...tabs.values()], Number(tabId), Number(targetTabId), insertAfter === true);
  if (!ordered) return false;
  reorderTabMap(ordered);
  sendState();
  return true;
}

function toggleTabPinned(tabId) {
  const tab = getTab(tabId);
  if (!tab) return false;
  const ordered = setTabPinnedOrder([...tabs.values()], tab.id, !tab.pinned);
  if (!ordered) return false;
  reorderTabMap(ordered);
  sendState();
  return true;
}

function duplicateTab(tabId) {
  const source = getTab(tabId);
  if (!source) return null;
  const url = snapshotTabUrl(source);
  return createTab(url || START_PAGE_URL, true, { pinned: Boolean(source.pinned) });
}

function closeOtherTabs(tabId) {
  const keepTab = getTab(tabId);
  if (!keepTab) return false;
  const ids = getOtherClosableTabIds([...tabs.values()], keepTab.id);
  for (const id of ids) if (tabs.has(id)) closeTab(id);
  if (tabs.has(keepTab.id)) activateTab(keepTab.id);
  sendState();
  return true;
}

function closeTabsToRight(tabId) {
  const target = getTab(tabId);
  if (!target) return false;
  const ids = getClosableTabIdsToRight([...tabs.values()], target.id);
  for (const id of ids) if (tabs.has(id)) closeTab(id);
  sendState();
  return true;
}

function closeTab(tabId) {
  const tab = getTab(tabId);
  if (!tab) return false;

  if (tabs.size === 1) {
    // Closing the final tab opens a genuinely fresh New Tab, instead of
    // reusing its old WebContents/history stack behind a new-tab URL.
    tabs.delete(tab.id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.contentView.removeChildView(tab.view); } catch { /* Already detached. */ }
    }
    if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    activeTabId = null;
    createTab(START_PAGE_URL, true);
    return true;
  }

  const currentIds = [...tabs.keys()];
  const oldIndex = currentIds.indexOf(tab.id);
  const wasActive = tab.id === activeTabId;
  tabs.delete(tab.id);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(tab.view);
  if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close();

  if (wasActive) {
    const remainingIds = [...tabs.keys()];
    const nextIndex = Math.max(0, oldIndex - 1);
    activeTabId = remainingIds[Math.min(nextIndex, remainingIds.length - 1)];
    activateTab(activeTabId);
  } else {
    sendState();
  }
  return true;
}

function setImmersiveFullscreen(active) {
  const next = Boolean(active);
  if (immersiveFullscreen === next) return;
  immersiveFullscreen = next;
  updatePageBounds();
  updateSidebarBounds();
  updateSettingsBounds();
  updateLibraryBounds();
  sendState();
}

function createTab(initialUrl = START_PAGE_URL, activate = true, options = {}) {
  const id = nextTabId++;
  const view = new WebContentsView({ webPreferences: { ...WEB_PREFERENCES } });
  view.setBackgroundColor('#0e1016');
  view.setVisible(false);

  const tab = { id, view, title: 'New tab', url: '', favicon: '', loading: false, error: '', pinned: options.pinned === true };
  tabs.set(id, tab);
  reorderTabMapPinnedFirst();
  mainWindow.contentView.addChildView(view);
  updatePageBounds();
  const contents = view.webContents;
  contents.on('enter-html-full-screen', () => {
    if (tab.id !== activeTabId || !mainWindow || mainWindow.isDestroyed()) return;
    // Keep the native window state untouched: the page owns HTML fullscreen.
    // Expanding the WebContentsView and hiding only Lumo chrome preserves the
    // page's own fullscreen controls (notably Twitch's player settings).
    htmlFullscreenTabId = tab.id;
    setImmersiveFullscreen(true);
  });
  contents.on('leave-html-full-screen', () => {
    if (htmlFullscreenTabId !== tab.id || !mainWindow || mainWindow.isDestroyed()) return;
    htmlFullscreenTabId = null;
    setImmersiveFullscreen(false);
  });

  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const modifier = process.platform === 'darwin' ? input.meta : input.control;
    const key = String(input.key || '').toLowerCase();

    if (modifier && key === 'l') {
      event.preventDefault(); focusAddressBar();
    } else if (modifier && key === 'r') {
      event.preventDefault(); contents.reload();
    } else if (modifier && input.shift && key === 'o') {
      event.preventDefault(); openLibraryView('bookmarks');
    } else if (modifier && key === 'h') {
      event.preventDefault(); openLibraryView('history');
    } else if (modifier && key === 'j') {
      event.preventDefault(); openLibraryView('downloads');
    } else if (modifier && key === 'd') {
      event.preventDefault(); toggleActiveBookmark();
    } else if (modifier && key === 't') {
      event.preventDefault(); createTab(START_PAGE_URL, true, { focusAddress: true });
    } else if (modifier && key === 'w') {
      event.preventDefault(); closeTab(tab.id);
    } else if (modifier && key === 'tab') {
      event.preventDefault();
      const ids = [...tabs.keys()];
      if (ids.length > 1) {
        const index = ids.indexOf(activeTabId);
        const direction = input.shift ? -1 : 1;
        activateTab(ids[(index + direction + ids.length) % ids.length]);
      }
    } else if (modifier && /^[1-8]$/.test(key)) {
      event.preventDefault();
      const target = [...tabs.keys()][Number(key) - 1];
      if (target != null) activateTab(target);
    } else if (modifier && key === '9') {
      event.preventDefault();
      const ids = [...tabs.keys()];
      if (ids.length) activateTab(ids[ids.length - 1]);
    } else if (input.alt && input.key === 'ArrowLeft') {
      event.preventDefault();
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    } else if (input.alt && input.key === 'ArrowRight') {
      event.preventDefault();
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    }
  });

  contents.on('did-start-loading', () => { tab.loading = true; tab.error = ''; sendState(); });
  contents.on('did-stop-loading', () => { tab.loading = false; sendState(); });
  contents.on('did-finish-load', () => {
    if (tab.id === activeTabId && isStartPageUrl(contents.getURL())) {
      contents.send('browser:newtab-activated');
    }
  });
  contents.on('did-navigate', (_event, url) => {
    if (isStartPageUrl(url)) {
      tab.url = '';
      tab.title = 'New tab';
      tab.favicon = '';
    } else {
      tab.url = url;
      tab.error = '';
      // Start with the destination host so history does not inherit the
      // previous page's title while Chromium is committing the new document.
      try { tab.title = new URL(url).hostname.replace(/^www\./i, '') || url; }
      catch { tab.title = url; }
      recordHistory(tab, url);
    }
    sendState();
  });
  contents.on('did-navigate-in-page', (_event, url) => {
    if (!isStartPageUrl(url) && isWebUrl(url)) {
      tab.url = url;
      recordHistory(tab, url);
    }
    sendState();
  });
  contents.on('page-title-updated', (_event, title) => {
    tab.title = title?.trim() || (isStartPageUrl(contents.getURL()) ? 'New tab' : 'Untitled');
    updateHistoryTitle(tab);
    sendState();
  });
  contents.on('page-favicon-updated', (_event, favicons) => {
    const candidate = Array.isArray(favicons) ? favicons.find((item) => /^(https?:|data:image\/)/i.test(item)) : '';
    tab.favicon = candidate || '';
    sendState();
  });
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    tab.loading = false;
    tab.error = friendlyNetworkError(errorDescription || `Page failed to load (${errorCode})`, validatedURL || tab.url);
    if (validatedURL && isWebUrl(validatedURL)) tab.url = validatedURL;
    sendState();
  });
  contents.on('render-process-gone', (_event, details) => {
    tab.loading = false;
    tab.error = `Page process stopped (${details.reason || 'unknown reason'}). You can reload this tab.`;
    sendState();
  });
  contents.on('will-navigate', (event, url) => {
    if (isStartPageUrl(url)) return;
    if (!isWebUrl(url) || !networkReady) {
      event.preventDefault();
      if (isWebUrl(url) && !networkReady) {
        tab.error = friendlyNetworkError(networkStartupError, url);
        sendState();
      }
    }
  });
  contents.on('will-redirect', (event, url) => {
    if (!isWebUrl(url) || !networkReady) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (isWebUrl(url) && networkReady) {
      createTab(url, disposition !== 'background-tab', { focusAddress: false });
    }
    // Non-HTTP(S) popups are denied rather than handed to operating-system handlers.
    return { action: 'deny' };
  });

  if (activate) activateTab(id, { focusAddress: options.focusAddress });
  navigateTab(tab, initialUrl);
  return tab;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 760,
    minHeight: 560,
    title: 'Lumo',
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'assets', 'lumo.ico')
      : path.join(__dirname, '..', 'assets', 'lumo.ico'),
    backgroundColor: '#0e1016',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppUiUrl(url, 'index.html')) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  mainWindow.on('resize', () => { updatePageBounds(); updateSidebarBounds(); updateSettingsBounds(); updateLibraryBounds(); });
  mainWindow.on('enter-full-screen', () => {
    // Re-apply bounds after Electron finishes the native fullscreen transition.
    updatePageBounds(); updateSidebarBounds(); updateSettingsBounds(); updateLibraryBounds();
  });
  mainWindow.on('leave-full-screen', () => {
    // DOM fullscreen owns immersive mode; ordinary OS fullscreen should not
    // leave the browser chrome hidden after the window returns to normal.
    if (htmlFullscreenTabId === null) setImmersiveFullscreen(false);
    updatePageBounds(); updateSidebarBounds(); updateSettingsBounds(); updateLibraryBounds();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.send('browser:sidebar-width', sidebarWidth);
    sendState();
  });
  mainWindow.on('closed', () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    persistSession();
    if (settingsView && !settingsView.webContents.isDestroyed()) settingsView.webContents.close();
    settingsView = null;
    if (libraryView && !libraryView.webContents.isDestroyed()) libraryView.webContents.close();
    libraryView = null;
    for (const tab of tabs.values()) {
      if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    tabs.clear();
    if (sidebarView && !sidebarView.webContents.isDestroyed()) sidebarView.webContents.close();
    sidebarView = null;
    activeTabId = null;
    mainWindow = null;
  });

  sidebarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'sidebar-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  sidebarView.setBackgroundColor('#13151d');
  sidebarView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  sidebarView.webContents.on('did-finish-load', sendState);
  sidebarView.webContents.on('will-navigate', (event, url) => {
    if (!isAppUiUrl(url, 'sidebar.html')) event.preventDefault();
  });
  mainWindow.contentView.addChildView(sidebarView);
  updateSidebarBounds();
  sidebarView.webContents.loadFile(path.join(__dirname, 'sidebar.html')).catch((error) => {
    console.error('[Lumo] Could not load sidebar overlay:', error);
  });

  const savedSession = SETTINGS.startupBehavior === 'restore'
    ? loadSavedSession()
    : { tabs: [{ url: '', pinned: false }], activeIndex: 0 };
  const createdTabs = savedSession.tabs.map((item) => createTab(item.url || START_PAGE_URL, false, { pinned: item.pinned === true }));
  activeTabId = createdTabs[Math.min(savedSession.activeIndex, createdTabs.length - 1)]?.id ?? createdTabs[0]?.id ?? null;
  if (activeTabId != null) activateTab(activeTabId);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function isAppUiUrl(rawUrl, fileName) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === path.resolve(path.join(__dirname, fileName));
  } catch {
    return false;
  }
}


function closeLibraryView() {
  if (!libraryView) return;
  const current = libraryView;
  libraryView = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.contentView.removeChildView(current); } catch { /* View may already be detached. */ }
  }
  if (!current.webContents.isDestroyed()) current.webContents.close();
}

function openLibraryView(requestedKind) {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'Browser window is not available.' };
  if (!LIBRARY_KINDS.has(requestedKind)) return { ok: false, error: 'Unknown library section.' };
  if (settingsView) closeSettingsView();

  if (libraryView && !libraryView.webContents.isDestroyed()) {
    if (libraryKind === requestedKind) {
      closeLibraryView();
      raiseViewStack();
      return { ok: true, open: false };
    }
    libraryKind = requestedKind;
    raiseViewStack();
    updateLibraryBounds();
    if (!libraryView.webContents.isLoading()) {
      libraryView.webContents.send('browser:library-kind', libraryKind);
      sendLibraryData();
    }
    return { ok: true, open: true, kind: libraryKind };
  }

  libraryKind = requestedKind;
  libraryView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'library-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  libraryView.setBackgroundColor('#00000000');
  libraryView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  libraryView.webContents.on('will-navigate', (event, url) => {
    if (!isAppUiUrl(url, 'library.html')) event.preventDefault();
  });
  libraryView.webContents.on('did-finish-load', () => {
    if (!libraryView || libraryView.webContents.isDestroyed()) return;
    libraryView.webContents.send('browser:library-kind', libraryKind);
    sendLibraryData();
  });
  mainWindow.contentView.addChildView(libraryView);
  updateLibraryBounds();
  raiseViewStack();
  libraryView.webContents.loadFile(path.join(__dirname, 'library.html')).catch((error) => {
    console.error('[Lumo] Could not open library:', error);
    closeLibraryView();
    raiseViewStack();
  });
  return { ok: true, open: true, kind: libraryKind };
}

function toggleActiveBookmark() {
  const tab = getTab();
  const url = snapshotTabUrl(tab);
  if (!tab || !isWebUrl(url)) return { ok: false, error: 'Open a website before saving a bookmark.' };
  const index = browserData.bookmarks.findIndex((item) => item.url === url);
  if (index >= 0) {
    browserData.bookmarks.splice(index, 1);
    persistBrowserData();
    sendState();
    sendLibraryData();
    return { ok: true, bookmarked: false };
  }
  const title = String(tab.title || url).trim().slice(0, 500) || url;
  browserData.bookmarks.unshift({ url, title, addedAt: Date.now() });
  browserData.bookmarks = browserData.bookmarks.slice(0, MAX_BOOKMARKS);
  persistBrowserData();
  sendState();
  sendLibraryData();
  return { ok: true, bookmarked: true };
}

function isTrustedLibraryEvent(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && libraryView &&
    !libraryView.webContents.isDestroyed() && event?.sender === libraryView.webContents &&
    event.senderFrame && event.senderFrame === event.sender.mainFrame &&
    isAppUiUrl(event.senderFrame.url, 'library.html'));
}

function assertTrustedLibrary(event) {
  if (!isTrustedLibraryEvent(event)) throw new Error('This action is only available from Lumo Library.');
}

function openLibraryUrl(rawUrl) {
  if (!isWebUrl(rawUrl)) return { ok: false, error: 'Only HTTP and HTTPS bookmarks or history entries can be opened.' };
  const tab = getTab();
  if (!tab) return { ok: false, error: 'There is no active tab.' };
  navigateTab(tab, rawUrl);
  // Let Electron deliver the IPC response before destroying the library sender.
  setTimeout(() => {
    if (libraryView) {
      closeLibraryView();
      raiseViewStack();
    }
  }, 50);
  return { ok: true };
}

function closeSettingsView() {
  if (!settingsView) return;
  const current = settingsView;
  settingsView = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.contentView.removeChildView(current); } catch { /* View may already be detached. */ }
  }
  if (!current.webContents.isDestroyed()) current.webContents.close();
}

function toggleSettingsView() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (libraryView) closeLibraryView();
  if (settingsView && !settingsView.webContents.isDestroyed()) {
    closeSettingsView();
    return;
  }

  settingsView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  settingsView.setBackgroundColor('#171a24');
  settingsView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsView.webContents.on('will-navigate', (event, url) => {
    if (!isAppUiUrl(url, 'settings.html')) event.preventDefault();
  });
  mainWindow.contentView.addChildView(settingsView);
  updateSettingsBounds();
  settingsView.webContents.loadFile(path.join(__dirname, 'settings.html')).then(sendState).catch((error) => {
    console.error('[Lumo] Could not open settings:', error);
    closeSettingsView();
  });
}

function isTrustedSettingsEvent(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && settingsView &&
    !settingsView.webContents.isDestroyed() && event?.sender === settingsView.webContents &&
    event.senderFrame && event.senderFrame === event.sender.mainFrame &&
    isAppUiUrl(event.senderFrame.url, 'settings.html'));
}

function assertTrustedSettings(event) {
  if (!isTrustedSettingsEvent(event)) throw new Error('This action is only available from Lumo Settings.');
}

function isTrustedUiEvent(event) {
  if (!mainWindow || mainWindow.isDestroyed() || !event?.senderFrame) return false;
  if (event.senderFrame !== event.sender.mainFrame) return false;
  if (event.sender === mainWindow.webContents) return isAppUiUrl(event.senderFrame.url, 'index.html');
  if (sidebarView && !sidebarView.webContents.isDestroyed() && event.sender === sidebarView.webContents) {
    return isAppUiUrl(event.senderFrame.url, 'sidebar.html');
  }
  return false;
}

function assertTrustedUi(event) {
  if (!isTrustedUiEvent(event)) throw new Error('This action is only available from the Lumo interface.');
}

function assertNewTabSender(event) {
  const tab = getTabForContents(event.sender);
  if (!tab || !event.senderFrame || event.senderFrame !== event.sender.mainFrame || !isStartPageUrl(event.senderFrame.url)) {
    throw new Error('Search is only available from a Lumo new-tab page.');
  }
  return tab;
}

ipcMain.on('browser:set-sidebar-width', (event, requestedWidth) => {
  if (!sidebarView || !isTrustedUiEvent(event) || event.sender !== sidebarView.webContents) return;
  const numericWidth = Number(requestedWidth);
  if (!Number.isFinite(numericWidth)) return;
  const nextWidth = Math.max(COLLAPSED_SIDEBAR_WIDTH, Math.min(EXPANDED_SIDEBAR_WIDTH, Math.round(numericWidth)));
  if (nextWidth === sidebarWidth) return;
  sidebarWidth = nextWidth;
  updateSidebarBounds();
  updateLibraryBounds();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('browser:sidebar-width', sidebarWidth);
  }
});

ipcMain.on('browser:focus-address-request', (event) => {
  if (!sidebarView || !isTrustedUiEvent(event) || event.sender !== sidebarView.webContents) return;
  focusAddressBar();
});

ipcMain.handle('browser:get-state', (event) => { assertTrustedUi(event); return getState(); });
ipcMain.on('browser:toggle-settings', (event) => {
  if (!isTrustedUiEvent(event)) return;
  toggleSettingsView();
});
ipcMain.handle('browser:settings-get-state', (event) => { assertTrustedSettings(event); return getState(); });
ipcMain.on('browser:settings-close', (event) => { if (isTrustedSettingsEvent(event)) closeSettingsView(); });

ipcMain.handle('browser:navigate', async (event, rawAddress) => {
  assertTrustedUi(event);
  let url;
  try { url = normalizeAddress(rawAddress, SETTINGS.searchEngine); }
  catch (error) { return { ok: false, error: error.message }; }
  if (isWebUrl(url) && !networkReady) return { ok: false, error: friendlyNetworkError(networkStartupError, url) };
  const tab = getTab();
  if (!tab) return { ok: false, error: 'There is no active tab.' };
  try {
    navigateTab(tab, url);
    return { ok: true, url };
  } catch (error) {
    return { ok: false, error: friendlyNetworkError(error?.message || error?.code, url) };
  }
});

ipcMain.handle('browser:search-from-newtab', async (event, query) => {
  const tab = assertNewTabSender(event);
  let url;
  try { url = normalizeAddress(String(query ?? ''), SETTINGS.searchEngine); }
  catch (error) { return { ok: false, error: error.message }; }
  if (!networkReady) return { ok: false, error: friendlyNetworkError(networkStartupError, url) };
  navigateTab(tab, url);
  return { ok: true, url };
});

ipcMain.handle('browser:pin-current-site', (event, tabId) => {
  assertTrustedUi(event);
  const tab = getTab(Number(tabId));
  const snapshot = getTabSnapshot(tab);
  if (!snapshot || !isWebUrl(snapshot.url)) return { ok: false, error: 'Open a website before saving a shortcut.' };
  const existing = browserData.pinnedSites.find((site) => site.url === snapshot.url);
  if (existing) return { ok: true, alreadyPinned: true, state: getState() };
  browserData.pinnedSites.push({ url: snapshot.url, title: snapshot.title || snapshot.url });
  browserData.pinnedSites = browserData.pinnedSites.slice(0, 100);
  persistBrowserData(); sendState();
  return { ok: true, state: getState() };
});
ipcMain.handle('browser:remove-pinned-site', (event, url) => {
  assertTrustedUi(event);
  const before = browserData.pinnedSites.length;
  browserData.pinnedSites = browserData.pinnedSites.filter((site) => site.url !== String(url));
  if (before !== browserData.pinnedSites.length) { persistBrowserData(); sendState(); }
  return { ok: before !== browserData.pinnedSites.length, state: getState() };
});
ipcMain.handle('browser:open-pinned-site', (event, url) => {
  assertTrustedUi(event);
  const site = browserData.pinnedSites.find((item) => item.url === String(url));
  if (!site || !isWebUrl(site.url)) return { ok: false };
  const tab = createTab(site.url, true);
  return { ok: true, tabId: tab.id };
});

ipcMain.handle('browser:new-tab', (event) => {
  assertTrustedUi(event);
  const tab = createTab(START_PAGE_URL, true);
  return { ok: true, tabId: tab.id, state: getState() };
});
ipcMain.handle('browser:activate-tab', (event, tabId) => {
  assertTrustedUi(event);
  const activated = activateTab(Number(tabId));
  return { ok: activated, state: getState() };
});
ipcMain.handle('browser:close-tab', (event, tabId) => {
  assertTrustedUi(event);
  const closed = closeTab(Number(tabId));
  return { ok: closed, state: getState() };
});
ipcMain.handle('browser:duplicate-tab', (event, tabId) => {
  assertTrustedUi(event);
  const duplicated = duplicateTab(Number(tabId));
  return { ok: Boolean(duplicated), tabId: duplicated?.id ?? null, state: getState() };
});
ipcMain.handle('browser:toggle-tab-pinned', (event, tabId) => {
  assertTrustedUi(event);
  const changed = toggleTabPinned(Number(tabId));
  return { ok: changed, state: getState() };
});
ipcMain.handle('browser:move-tab', (event, tabId, targetTabId, insertAfter) => {
  assertTrustedUi(event);
  const moved = moveTab(Number(tabId), Number(targetTabId), insertAfter === true);
  return { ok: moved, state: getState() };
});
ipcMain.handle('browser:close-other-tabs', (event, tabId) => {
  assertTrustedUi(event);
  const closed = closeOtherTabs(Number(tabId));
  return { ok: closed, state: getState() };
});
ipcMain.handle('browser:close-tabs-to-right', (event, tabId) => {
  assertTrustedUi(event);
  const closed = closeTabsToRight(Number(tabId));
  return { ok: closed, state: getState() };
});
ipcMain.handle('browser:back', (event) => {
  assertTrustedUi(event);
  const contents = getTab()?.view.webContents;
  if (contents && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
});
ipcMain.handle('browser:forward', (event) => {
  assertTrustedUi(event);
  const contents = getTab()?.view.webContents;
  if (contents && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
});
ipcMain.handle('browser:reload', (event) => {
  assertTrustedUi(event);
  const contents = getTab()?.view.webContents;
  if (contents && !contents.isDestroyed() && !isStartPageUrl(contents.getURL())) contents.reload();
  else if (contents) navigateTab(getTab(), START_PAGE_URL);
});
ipcMain.handle('browser:home', (event) => {
  assertTrustedUi(event);
  const tab = getTab();
  if (tab) navigateTab(tab, START_PAGE_URL);
});

ipcMain.handle('browser:open-library', (event, kind) => {
  assertTrustedUi(event);
  return openLibraryView(kind);
});
ipcMain.handle('browser:toggle-bookmark', (event) => {
  assertTrustedUi(event);
  return toggleActiveBookmark();
});
ipcMain.handle('browser:library-get-data', (event) => {
  assertTrustedLibrary(event);
  return getLibraryData();
});
ipcMain.handle('browser:library-switch-kind', (event, kind) => {
  assertTrustedLibrary(event);
  if (!LIBRARY_KINDS.has(kind)) return { ok: false, error: 'Unknown library section.' };
  libraryKind = kind;
  sendLibraryData();
  return { ok: true, kind };
});
ipcMain.on('browser:library-close', (event) => {
  if (isTrustedLibraryEvent(event)) {
    closeLibraryView();
    raiseViewStack();
  }
});
ipcMain.handle('browser:library-open-url', (event, rawUrl) => {
  assertTrustedLibrary(event);
  return openLibraryUrl(String(rawUrl || ''));
});
ipcMain.handle('browser:library-bookmark-remove', (event, rawUrl) => {
  assertTrustedLibrary(event);
  const url = String(rawUrl || '');
  if (!isWebUrl(url)) return { ok: false, error: 'Invalid bookmark address.' };
  browserData.bookmarks = browserData.bookmarks.filter((item) => item.url !== url);
  persistBrowserData();
  sendState();
  sendLibraryData();
  return { ok: true };
});
ipcMain.handle('browser:library-history-clear', (event) => {
  assertTrustedLibrary(event);
  browserData.history = [];
  persistBrowserData();
  sendState();
  sendLibraryData();
  return { ok: true };
});
ipcMain.handle('browser:library-download-cancel', (event, id) => {
  assertTrustedLibrary(event);
  const key = String(id || '');
  const item = activeDownloads.get(key);
  if (!item) return { ok: false, error: 'This download is no longer active.' };
  try { item.cancel(); return { ok: true }; }
  catch (error) { return { ok: false, error: error.message || 'Could not cancel the download.' }; }
});
ipcMain.handle('browser:library-download-open', async (event, id) => {
  assertTrustedLibrary(event);
  const record = browserData.downloads.find((item) => item.id === String(id || ''));
  if (!record || record.state !== 'completed' || !isSafeDownloadPath(record.path) || !fs.existsSync(record.path)) {
    return { ok: false, error: 'The downloaded file is not available.' };
  }
  const error = await shell.openPath(record.path);
  return error ? { ok: false, error } : { ok: true };
});
ipcMain.handle('browser:library-download-show', (event, id) => {
  assertTrustedLibrary(event);
  const record = browserData.downloads.find((item) => item.id === String(id || ''));
  if (!record || !isSafeDownloadPath(record.path) || !fs.existsSync(record.path)) {
    return { ok: false, error: 'The downloaded file is not available on disk.' };
  }
  shell.showItemInFolder(record.path);
  return { ok: true };
});
ipcMain.handle('browser:library-download-remove', (event, id) => {
  assertTrustedLibrary(event);
  const key = String(id || '');
  if (activeDownloads.has(key)) return { ok: false, error: 'Cancel the active download before removing it.' };
  browserData.downloads = browserData.downloads.filter((item) => item.id !== key);
  persistBrowserData();
  sendState();
  sendLibraryData();
  return { ok: true };
});
ipcMain.handle('browser:library-downloads-clear-finished', (event) => {
  assertTrustedLibrary(event);
  browserData.downloads = browserData.downloads.filter((item) => item.state === 'downloading' || activeDownloads.has(item.id));
  persistBrowserData();
  sendState();
  sendLibraryData();
  return { ok: true };
});

ipcMain.handle('browser:settings-permission-reset', (event, rawOrigin, rawPermission) => {
  assertTrustedSettings(event);
  const origin = typeof rawOrigin === 'string' ? rawOrigin : '';
  const permission = typeof rawPermission === 'string' ? rawPermission : '';
  const key = permissionDecisionKey(origin, permission);
  if (!key || !isSecurePermissionOrigin(origin)) return { ok: false, error: 'Invalid site permission.' };
  permissionDecisionEpoch += 1;
  const existed = sessionPermissionDecisions.delete(key);
  sendState();
  return { ok: true, existed, state: getState() };
});

ipcMain.handle('browser:settings-permissions-reset-all', (event) => {
  assertTrustedSettings(event);
  const count = sessionPermissionDecisions.size;
  permissionDecisionEpoch += 1;
  sessionPermissionDecisions.clear();
  sendState();
  return { ok: true, count, state: getState() };
});

ipcMain.handle('browser:settings-bookmarks-export', async (event) => {
  assertTrustedSettings(event);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Lumo bookmarks',
    defaultPath: path.join(app.getPath('downloads'), 'Lumo Bookmarks.html'),
    filters: [{ name: 'HTML bookmarks', extensions: ['html', 'htm'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(result.filePath, bookmarksToNetscapeHtml(browserData.bookmarks), 'utf8');
    return { ok: true, count: browserData.bookmarks.length, filePath: result.filePath };
  } catch (error) {
    return { ok: false, error: `Could not export bookmarks: ${error.message}` };
  }
});

ipcMain.handle('browser:settings-bookmarks-import', async (event) => {
  assertTrustedSettings(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import bookmarks into Lumo',
    properties: ['openFile'],
    filters: [
      { name: 'Bookmarks (HTML or JSON)', extensions: ['html', 'htm', 'json'] },
      { name: 'HTML bookmarks', extensions: ['html', 'htm'] },
      { name: 'JSON bookmarks', extensions: ['json'] },
    ],
  });
  if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };
  try {
    const filePath = result.filePaths[0];
    const fileStats = fs.statSync(filePath);
    if (!fileStats.isFile() || fileStats.size > MAX_BOOKMARK_IMPORT_BYTES) {
      return { ok: false, error: 'Bookmark files must be regular files no larger than 5 MB.' };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const imported = parseBookmarkImport(raw);
    const merged = mergeImportedBookmarks(browserData.bookmarks, imported, MAX_BOOKMARKS);
    browserData.bookmarks = merged.bookmarks;
    persistBrowserData();
    sendState();
    sendLibraryData();
    return { ok: true, imported: merged.added, duplicates: merged.duplicates, total: browserData.bookmarks.length };
  } catch (error) {
    return { ok: false, error: error?.message || 'Could not import bookmarks.' };
  }
});

ipcMain.handle('browser:settings-clear-data', async (event, rawSelection) => {
  assertTrustedSettings(event);
  const selection = rawSelection && typeof rawSelection === 'object' ? rawSelection : {};
  const chosen = {
    history: selection.history === true,
    cookies: selection.cookies === true,
    cache: selection.cache === true,
    siteStorage: selection.siteStorage === true,
    downloadList: selection.downloadList === true,
    permissions: selection.permissions === true,
  };
  const names = [];
  if (chosen.history) names.push('browsing history');
  if (chosen.cookies) names.push('cookies and authentication cache');
  if (chosen.siteStorage) names.push('site storage');
  if (chosen.cache) names.push('cached files');
  if (chosen.downloadList) names.push('download history (downloaded files will remain on disk)');
  if (chosen.permissions) names.push('site permission decisions');
  if (!names.length) return { ok: false, error: 'Select at least one type of data to clear.' };

  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Clear browsing data',
    message: 'Clear the selected browsing data?',
    detail: `This will clear: ${names.join(', ')}. Clearing cookies or site storage may sign you out of websites. Downloaded files will not be deleted.`,
    buttons: ['Clear data', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (confirmation.response !== 0) return { ok: false, canceled: true };

  try {
    const defaultSession = session.defaultSession;
    if (chosen.cookies) {
      await defaultSession.clearStorageData({ storages: ['cookies'] });
      if (typeof defaultSession.clearAuthCache === 'function') await defaultSession.clearAuthCache();
    }
    if (chosen.siteStorage) {
      await defaultSession.clearStorageData({ storages: ['filesystem', 'indexdb', 'localstorage', 'shadercache', 'serviceworkers', 'cachestorage'] });
    }
    if (chosen.cache) await defaultSession.clearCache();

    if (chosen.history) browserData.history = [];
    if (chosen.downloadList) browserData.downloads = browserData.downloads.filter((item) => item.state === 'downloading' || activeDownloads.has(item.id));
    if (chosen.permissions) {
      permissionDecisionEpoch += 1;
      sessionPermissionDecisions.clear();
    }
    if (chosen.history || chosen.downloadList) persistBrowserData();
    sendState();
    sendLibraryData();
    return { ok: true, cleared: names };
  } catch (error) {
    console.error('[Lumo] Could not clear selected browsing data:', error);
    return { ok: false, error: `Some data could not be cleared: ${error?.message || error}` };
  }
});

ipcMain.handle('browser:save-settings', async (event, rawSettings) => {
  assertTrustedSettings(event);
  let nextSettings;
  try { nextSettings = validateSettings(rawSettings); }
  catch (error) { return { ok: false, error: error.message }; }

  const previousSettings = SETTINGS;
  const networkChanged = nextSettings.network.mode !== previousSettings.network.mode ||
    nextSettings.network.proxyUrl !== previousSettings.network.proxyUrl;
  const mustApplyNetwork = networkChanged || !networkReady;

  if (mustApplyNetwork) {
    // Pause external requests during route changes. If applying the new route fails,
    // keep the browser fail-closed rather than briefly using an unconfirmed route.
    networkReady = false;
    sendState();
    try {
      await configureNetwork(nextSettings);
    } catch (error) {
      networkReady = false;
      networkStartupError = `Could not apply network settings: ${error?.message || error}`;
      sendState();
      return { ok: false, error: `${networkStartupError}. External requests are paused until a valid route can be applied.` };
    }
  }

  try {
    writeJsonAtomic(settingsPath, nextSettings);
  } catch (error) {
    if (mustApplyNetwork) {
      try {
        await configureNetwork(previousSettings);
        networkReady = true;
      } catch (restoreError) {
        networkReady = false;
        networkStartupError = `Saving settings failed and the previous route could not be restored: ${restoreError.message}`;
      }
      sendState();
    }
    return { ok: false, error: `Could not save settings: ${error.message}` };
  }

  SETTINGS = nextSettings;
  if (mustApplyNetwork) networkReady = true;
  settingsWarning = '';
  networkStartupError = '';
  sendState();
  return { ok: true, state: getState() };
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  // Opening the app again focuses the existing browser window instead of starting
  // another process against the same session and history files.
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  if (process.platform === 'win32') app.setAppUserModelId('computer.lumo.browser');

  app.whenReady().then(async () => {
    installLumoProtocol();
    const settingsLoaded = initializeStorage();
    installNetworkAndPermissionGuards();
    installDownloadManager();
    if (settingsLoaded) {
      try {
        await configureNetwork(SETTINGS);
        networkReady = true;
      } catch (error) {
        networkReady = false;
        networkStartupError = `Could not apply network settings: ${error?.message || error}`;
        console.error('[Lumo] Failed to apply network settings:', error);
      }
    } else {
      networkReady = false;
      networkStartupError = 'Network access is paused until a valid configuration is saved in Settings.';
    }

    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    if (persistTimer) clearTimeout(persistTimer);
    if (browserDataPersistTimer) clearTimeout(browserDataPersistTimer);
    browserDataPersistTimer = null;
    persistSession();
    persistBrowserData();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  searchEngine: 'duckduckgo',
  startupBehavior: 'restore',
  network: Object.freeze({ mode: 'custom', proxyUrl: 'socks5://127.0.0.1:10808' }),
});

const SEARCH_ENGINES = Object.freeze({
  duckduckgo: (query) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
  google: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  bing: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  startpage: (query) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(query)}`,
});

function isWebUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}



const MAX_RESTORED_TABS = 50;

function normalizeSavedSession(saved, maxTabs = MAX_RESTORED_TABS) {
  const safeMax = Number.isInteger(maxTabs) && maxTabs > 0 ? maxTabs : MAX_RESTORED_TABS;
  const rawTabs = Array.isArray(saved?.tabs) ? saved.tabs : [];
  const restored = rawTabs.slice(0, safeMax).map((item) => ({
    url: item && isWebUrl(item.url) ? item.url : '',
    pinned: item?.pinned === true,
  }));
  if (!restored.length) return { tabs: [{ url: '', pinned: false }], activeIndex: 0 };

  const rawActiveIndex = Number.isInteger(saved?.activeIndex)
    ? Math.max(0, Math.min(saved.activeIndex, restored.length - 1))
    : restored.length - 1;
  const activeTab = restored[rawActiveIndex];
  // Keep pinned tabs grouped first, preserving relative order within each group.
  const tabs = [...restored.filter((item) => item.pinned), ...restored.filter((item) => !item.pinned)];
  return { tabs, activeIndex: tabs.indexOf(activeTab) };
}

function reorderTabItems(items, draggedId, targetId, insertAfter = false) {
  if (!Array.isArray(items)) return null;
  const list = [...items];
  const fromIndex = list.findIndex((item) => item?.id === draggedId);
  const targetIndex = list.findIndex((item) => item?.id === targetId);
  if (fromIndex < 0 || targetIndex < 0 || draggedId === targetId) return null;
  if (Boolean(list[fromIndex].pinned) !== Boolean(list[targetIndex].pinned)) return null;
  const [dragged] = list.splice(fromIndex, 1);
  const adjustedTargetIndex = list.findIndex((item) => item?.id === targetId);
  list.splice(adjustedTargetIndex + (insertAfter ? 1 : 0), 0, dragged);
  return list;
}

function setTabPinnedOrder(items, tabId, pinned) {
  if (!Array.isArray(items)) return null;
  const list = [...items];
  const tab = list.find((item) => item?.id === tabId);
  if (!tab) return null;
  tab.pinned = Boolean(pinned);
  return [...list.filter((item) => item.pinned), ...list.filter((item) => !item.pinned)];
}

function getOtherClosableTabIds(items, keepId) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => item && item.id !== keepId && !item.pinned).map((item) => item.id);
}

function getClosableTabIdsToRight(items, targetId) {
  if (!Array.isArray(items)) return [];
  const index = items.findIndex((item) => item?.id === targetId);
  if (index < 0) return [];
  return items.slice(index + 1).filter((item) => item && !item.pinned).map((item) => item.id);
}

function sanitizeDownloadFilename(rawName) {
  const lastSegment = String(rawName ?? 'download').split(/[\\/]/).pop() || 'download';
  const safe = lastSegment
    .replace(/[<>:"|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 180);
  if (!safe || safe === '.' || safe === '..') return 'download';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(safe) ? `_${safe}` : safe;
}

function validateSettings(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const searchEngine = ['duckduckgo', 'google', 'bing', 'startpage'].includes(raw.searchEngine)
    ? raw.searchEngine
    : DEFAULT_SETTINGS.searchEngine;
  const startupBehavior = ['restore', 'newtab'].includes(raw.startupBehavior) ? raw.startupBehavior : DEFAULT_SETTINGS.startupBehavior;
  const requestedMode = raw.network?.mode;
  if (!['custom', 'system', 'direct'].includes(requestedMode)) {
    throw new Error('Choose a valid network mode.');
  }

  let proxyUrl = String(raw.network?.proxyUrl ?? DEFAULT_SETTINGS.network.proxyUrl).trim();
  if (requestedMode === 'custom') {
    let parsed;
    try {
      parsed = new URL(proxyUrl);
    } catch {
      throw new Error('The proxy address is not a valid URL.');
    }
    if (!['socks5:', 'socks4:', 'http:'].includes(parsed.protocol)) {
      throw new Error('Proxy must use socks5://, socks4://, or http://.');
    }
    if (!parsed.hostname || !parsed.port || Number(parsed.port) < 1 || Number(parsed.port) > 65535 || parsed.username || parsed.password) {
      throw new Error('Enter a valid proxy host and port. Proxy credentials in the URL are not supported.');
    }
    if (!['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) {
      throw new Error('Proxy address must contain only a scheme, host, and port.');
    }
    proxyUrl = `${parsed.protocol}//${parsed.host}`;
  }

  return {
    searchEngine,
    startupBehavior,
    network: { mode: requestedMode, proxyUrl },
  };
}

function normalizeAddress(rawValue, searchEngine = DEFAULT_SETTINGS.searchEngine) {
  const value = String(rawValue ?? '').trim();
  if (!value) throw new Error('Enter a URL or a search query.');

  // `example.com:8080` and `localhost:3000` are host:port inputs, not
  // custom URL schemes. Recognize them before rejecting non-HTTP schemes.
  const looksLikeHostWithPort = /^(?:localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+|\[[0-9a-f:]+\]|\d{1,3}(?:\.\d{1,3}){3}):\d+(?:\/.*)?$/i.test(value);
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) && !looksLikeHostWithPort) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('That address does not look valid.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http:// and https:// addresses are supported.');
    }
    return parsed.toString();
  }

  const looksLikeHost = !/\s/.test(value) &&
    (value.includes('.') || /^localhost(?::\d+)?(?:\/.*)?$/i.test(value) ||
      /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/.*)?$/.test(value) ||
      /^\[[0-9a-f:]+\](?::\d+)?(?:\/.*)?$/i.test(value));

  if (looksLikeHost) {
    try {
      const parsed = new URL(`https://${value}`);
      if (parsed.hostname) return parsed.toString();
    } catch {
      // Fall through to a search query for malformed host-like text.
    }
  }

  const makeSearchUrl = SEARCH_ENGINES[searchEngine] || SEARCH_ENGINES[DEFAULT_SETTINGS.searchEngine];
  return makeSearchUrl(value);
}

module.exports = { DEFAULT_SETTINGS, SEARCH_ENGINES, MAX_RESTORED_TABS, isWebUrl, normalizeAddress, normalizeSavedSession, reorderTabItems, setTabPinnedOrder, getOtherClosableTabIds, getClosableTabIdsToRight, sanitizeDownloadFilename, validateSettings };

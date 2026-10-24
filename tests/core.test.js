'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SETTINGS, isWebUrl, normalizeAddress, normalizeSavedSession, reorderTabItems, setTabPinnedOrder, getOtherClosableTabIds, getClosableTabIdsToRight, sanitizeDownloadFilename, validateSettings } = require('../src/core');

test('normalizes explicit HTTP and HTTPS addresses', () => {
  assert.equal(normalizeAddress('https://example.com/path'), 'https://example.com/path');
  assert.equal(normalizeAddress('example.com'), 'https://example.com/');
  assert.equal(normalizeAddress('example.com:8443/health'), 'https://example.com:8443/health');
  assert.equal(normalizeAddress('localhost:3000'), 'https://localhost:3000/');
  assert.equal(normalizeAddress('[::1]:3000'), 'https://[::1]:3000/');
});

test('rejects privileged and non-web protocols from the address bar', () => {
  assert.throws(() => normalizeAddress('file:///C:/secret.txt'), /Only http/);
  assert.throws(() => normalizeAddress('javascript:alert(1)'), /Only http/);
});

test('uses selected search engine for ordinary search text', () => {
  assert.equal(normalizeAddress('hello world', 'google'), 'https://www.google.com/search?q=hello%20world');
  assert.equal(normalizeAddress('hello world', 'bing'), 'https://www.bing.com/search?q=hello%20world');
  assert.equal(normalizeAddress('hello world', 'startpage'), 'https://www.startpage.com/sp/search?query=hello%20world');
  assert.equal(normalizeAddress('hello world'), 'https://duckduckgo.com/?q=hello%20world');
});

test('validates supported proxy schemes and rejects credentials', () => {
  const settings = validateSettings({
    searchEngine: 'startpage',
    network: { mode: 'custom', proxyUrl: 'socks5://127.0.0.1:10808' },
  });
  assert.equal(settings.searchEngine, 'startpage');
  assert.equal(settings.network.proxyUrl, 'socks5://127.0.0.1:10808');
  assert.equal(validateSettings({ network: { mode: 'custom', proxyUrl: 'socks5://[::1]:10808' } }).network.proxyUrl, 'socks5://[::1]:10808');
  assert.throws(() => validateSettings({ network: { mode: 'custom', proxyUrl: 'ftp://127.0.0.1:21' } }), /Proxy must use/);
  assert.throws(() => validateSettings({ network: { mode: 'custom', proxyUrl: 'http://user:secret@localhost:8080' } }), /credentials/);
  assert.throws(() => validateSettings({ network: { mode: 'custom', proxyUrl: 'socks5://localhost:0' } }), /valid proxy host/);
  assert.throws(() => validateSettings({ network: { mode: 'custom', proxyUrl: 'socks5://localhost:10808/path' } }), /only a scheme/);
});

test('supports explicit system and direct network modes', () => {
  assert.equal(validateSettings({ network: { mode: 'system' } }).network.mode, 'system');
  assert.equal(validateSettings({ network: { mode: 'direct' } }).network.mode, 'direct');
});

test('identifies only HTTP and HTTPS URLs as web URLs', () => {
  assert.equal(isWebUrl('https://example.com'), true);
  assert.equal(isWebUrl('http://localhost:3000'), true);
  assert.equal(isWebUrl('file:///tmp/page.html'), false);
  assert.equal(isWebUrl('javascript:alert(1)'), false);
});

test('defaults include a custom local SOCKS5 proxy, DuckDuckGo, and session restore', () => {
  assert.equal(DEFAULT_SETTINGS.searchEngine, 'duckduckgo');
  assert.equal(DEFAULT_SETTINGS.startupBehavior, 'restore');
  assert.equal(DEFAULT_SETTINGS.network.proxyUrl, 'socks5://127.0.0.1:10808');
});

test('validates startup behavior and safely defaults older settings to restoring the previous session', () => {
  assert.equal(validateSettings({ network: { mode: 'direct' }, startupBehavior: 'newtab' }).startupBehavior, 'newtab');
  assert.equal(validateSettings({ network: { mode: 'direct' }, startupBehavior: 'restore' }).startupBehavior, 'restore');
  assert.equal(validateSettings({ network: { mode: 'direct' }, startupBehavior: 'run-arbitrary-code' }).startupBehavior, 'restore');
  assert.equal(validateSettings({ network: { mode: 'direct' } }).startupBehavior, 'restore');
});

test('sanitizes download filenames without path traversal or Windows-reserved characters', () => {
  assert.equal(sanitizeDownloadFilename('C:\\Users\\me\\report.pdf'), 'report.pdf');
  assert.equal(sanitizeDownloadFilename('../secret?.txt'), 'secret_.txt');
  assert.equal(sanitizeDownloadFilename('   '), 'download');
  assert.equal(sanitizeDownloadFilename('CON.txt'), '_CON.txt');
  assert.equal(sanitizeDownloadFilename('really-long-name'.repeat(20)).length, 180);
});


test('normalizes saved sessions defensively and caps restored tabs', () => {
  const restored = normalizeSavedSession({
    activeIndex: 999,
    tabs: [
      { url: 'https://example.com' },
      { url: 'file:///C:/private.txt' },
      { url: 'https://second.example/path' },
    ],
  });
  assert.deepEqual(restored, {
    tabs: [
      { url: 'https://example.com', pinned: false },
      { url: '', pinned: false },
      { url: 'https://second.example/path', pinned: false },
    ],
    activeIndex: 2,
  });

  const tooMany = normalizeSavedSession({
    activeIndex: 48,
    tabs: Array.from({ length: 55 }, (_, index) => ({ url: `https://site${index}.example/` })),
  });
  assert.equal(tooMany.tabs.length, 50);
  assert.equal(tooMany.activeIndex, 48);
  assert.equal(tooMany.tabs[49].url, 'https://site49.example/');
  assert.deepEqual(normalizeSavedSession({ tabs: [], activeIndex: 0 }), { tabs: [{ url: '', pinned: false }], activeIndex: 0 });
});


test('restores pinned tabs first while keeping the selected tab identity', () => {
  const restored = normalizeSavedSession({
    activeIndex: 2,
    tabs: [
      { url: 'https://normal.example/' },
      { url: 'https://pinned.example/', pinned: true },
      { url: 'https://selected.example/' },
    ],
  });
  assert.deepEqual(restored.tabs, [
    { url: 'https://pinned.example/', pinned: true },
    { url: 'https://normal.example/', pinned: false },
    { url: 'https://selected.example/', pinned: false },
  ]);
  assert.equal(restored.activeIndex, 2);
});

test('reorders tabs without crossing pinned and unpinned groups', () => {
  const tabs = [
    { id: 1, pinned: true }, { id: 2, pinned: true },
    { id: 3, pinned: false }, { id: 4, pinned: false }, { id: 5, pinned: false },
  ];
  assert.deepEqual(reorderTabItems(tabs, 5, 3, false).map((tab) => tab.id), [1, 2, 5, 3, 4]);
  assert.deepEqual(reorderTabItems(tabs, 1, 2, true).map((tab) => tab.id), [2, 1, 3, 4, 5]);
  assert.equal(reorderTabItems(tabs, 1, 3, false), null);
  assert.equal(reorderTabItems(tabs, 3, 3, false), null);
  assert.equal(reorderTabItems(tabs, 99, 3, false), null);
});

test('pinning moves tabs into the pinned group and unpinning preserves group order', () => {
  const tabs = [
    { id: 1, pinned: true }, { id: 2, pinned: false },
    { id: 3, pinned: false }, { id: 4, pinned: true },
  ];
  const pinned = setTabPinnedOrder(tabs, 3, true);
  assert.deepEqual(pinned.map((tab) => [tab.id, tab.pinned]), [[1, true], [3, true], [4, true], [2, false]]);
  const unpinned = setTabPinnedOrder(pinned, 1, false);
  assert.deepEqual(unpinned.map((tab) => [tab.id, tab.pinned]), [[3, true], [4, true], [1, false], [2, false]]);
  assert.equal(setTabPinnedOrder(tabs, 88, true), null);
});

test('close-other and close-to-right lists preserve pinned tabs', () => {
  const tabs = [
    { id: 1, pinned: true }, { id: 2, pinned: true },
    { id: 3, pinned: false }, { id: 4, pinned: false }, { id: 5, pinned: false },
  ];
  assert.deepEqual(getOtherClosableTabIds(tabs, 4), [3, 5]);
  assert.deepEqual(getOtherClosableTabIds(tabs, 1), [3, 4, 5]);
  assert.deepEqual(getClosableTabIdsToRight(tabs, 2), [3, 4, 5]);
  assert.deepEqual(getClosableTabIdsToRight(tabs, 4), [5]);
  assert.deepEqual(getClosableTabIdsToRight(tabs, 5), []);
});

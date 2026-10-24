'use strict';

const libraryList = document.getElementById('libraryList');
const panelTitle = document.getElementById('panelTitle');
const listCaption = document.getElementById('listCaption');
const clearAction = document.getElementById('clearAction');
const footer = document.getElementById('libraryFooter');
const closeButton = document.getElementById('closeLibrary');
const tabs = [...document.querySelectorAll('.library-tab')];

let currentKind = 'history';
let data = { history: [], bookmarks: [], downloads: [] };

const LABELS = {
  history: { title: 'History', caption: 'Recently visited', footer: 'History is saved locally on this device.' },
  bookmarks: { title: 'Bookmarks', caption: 'Saved pages', footer: 'Your saved pages are stored locally.' },
  downloads: { title: 'Downloads', caption: 'Recent downloads', footer: 'Files are saved to your Windows Downloads folder.' },
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function hostFor(rawUrl) {
  try { return new URL(rawUrl).hostname.replace(/^www\./i, '') || 'Web'; }
  catch { return 'Lumo'; }
}

function initialFor(rawUrl, fallback = '') {
  const source = fallback || hostFor(rawUrl);
  return source.trim().slice(0, 1).toUpperCase() || '•';
}

function formatDate(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Saved earlier';
  try { return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return 'Saved earlier'; }
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let result = bytes / 1024;
  let index = 0;
  while (result >= 1024 && index < units.length - 1) { result /= 1024; index += 1; }
  return `${result.toFixed(result >= 10 ? 0 : 1)} ${units[index]}`;
}

function setKind(kind, notify = true) {
  if (!Object.hasOwn(LABELS, kind)) return;
  currentKind = kind;
  const labels = LABELS[kind];
  panelTitle.textContent = labels.title;
  listCaption.textContent = labels.caption;
  footer.textContent = labels.footer;
  clearAction.hidden = kind === 'bookmarks';
  clearAction.textContent = kind === 'history' ? 'Clear history' : 'Clear finished';
  for (const tab of tabs) {
    const active = tab.dataset.kind === kind;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-pressed', String(active));
  }
  renderItems();
  if (notify) window.lumoLibrary.switchKind(kind).catch(() => {});
}

function makeSiteRow(item, mode) {
  const row = el('article', 'library-row');
  const icon = el('span', 'site-icon', initialFor(item.url, item.title));
  icon.setAttribute('aria-hidden', 'true');

  const open = el('button', 'item-main');
  open.type = 'button';
  open.title = item.url || '';
  const copy = el('span', 'item-copy');
  copy.append(el('span', 'item-title', item.title || hostFor(item.url)));
  copy.append(el('span', 'item-url', hostFor(item.url)));
  copy.append(el('span', 'item-meta', mode === 'history' ? formatDate(item.visitedAt) : `Added ${formatDate(item.addedAt)}`));
  open.append(icon, copy);
  open.addEventListener('click', async () => {
    const result = await window.lumoLibrary.openUrl(item.url);
    if (!result?.ok && result?.error) window.alert(result.error);
  });
  row.append(open);

  if (mode === 'bookmarks') {
    const remove = el('button', 'row-action danger', '×');
    remove.type = 'button';
    remove.title = 'Remove bookmark';
    remove.setAttribute('aria-label', `Remove bookmark ${item.title || item.url}`);
    remove.addEventListener('click', async () => {
      const result = await window.lumoLibrary.removeBookmark(item.url);
      if (!result?.ok && result?.error) window.alert(result.error);
    });
    row.append(remove);
  }
  return row;
}

function downloadLabel(item) {
  const state = item.state || 'interrupted';
  const total = Number(item.totalBytes) || 0;
  const received = Number(item.receivedBytes) || 0;
  if (state === 'completed') return `Completed · ${formatBytes(received || total)}`;
  if (state === 'downloading') {
    if (total > 0) return `Downloading · ${Math.min(99, Math.round(received / total * 100))}% · ${formatBytes(received)} of ${formatBytes(total)}`;
    return `Downloading · ${formatBytes(received)}`;
  }
  if (state === 'cancelled') return `Cancelled · ${formatBytes(received)}`;
  return `Interrupted · ${formatBytes(received)}`;
}

function makeDownloadRow(item) {
  const row = el('article', 'library-row download-row');
  const icon = el('span', 'site-icon', '↓');
  icon.setAttribute('aria-hidden', 'true');
  const copy = el('div', 'download-copy');
  copy.append(el('span', 'item-title', item.filename || 'Downloaded file'));
  const state = el('span', 'download-state', downloadLabel(item));
  state.dataset.state = item.state || 'interrupted';
  copy.append(state);
  const total = Number(item.totalBytes) || 0;
  if (item.state === 'downloading' && total > 0) {
    const track = el('div', 'progress-track');
    const bar = el('div', 'progress-bar');
    bar.style.width = `${Math.max(0, Math.min(100, Number(item.receivedBytes) / total * 100))}%`;
    track.append(bar);
    copy.append(track);
  }
  const actions = el('div', 'download-actions');
  const actionButton = (label, title, callback, className = '') => {
    const button = el('button', `row-action ${className}`.trim(), label);
    button.type = 'button'; button.title = title; button.addEventListener('click', callback); return button;
  };

  if (item.state === 'downloading') {
    actions.append(actionButton('×', 'Cancel download', async () => {
      const result = await window.lumoLibrary.cancelDownload(item.id);
      if (!result?.ok && result?.error) window.alert(result.error);
    }, 'danger'));
  } else {
    if (item.state === 'completed') {
      actions.append(actionButton('Open', 'Open downloaded file', async () => {
        const result = await window.lumoLibrary.openDownload(item.id);
        if (!result?.ok && result?.error) window.alert(result.error);
      }));
      actions.append(actionButton('Folder', 'Show in folder', async () => {
        const result = await window.lumoLibrary.showDownload(item.id);
        if (!result?.ok && result?.error) window.alert(result.error);
      }));
    }
    actions.append(actionButton('×', 'Remove from list', async () => {
      const result = await window.lumoLibrary.removeDownload(item.id);
      if (!result?.ok && result?.error) window.alert(result.error);
    }, 'danger'));
  }

  row.append(icon, copy, actions);
  return row;
}

function showEmpty(kind) {
  const empty = el('div', 'empty-state');
  const mark = el('div', 'empty-mark', kind === 'history' ? '↺' : kind === 'bookmarks' ? '☆' : '↓');
  const title = el('div', 'empty-title', kind === 'history' ? 'Nothing here yet' : kind === 'bookmarks' ? 'No bookmarks saved' : 'No downloads yet');
  const message = el('div', 'empty-copy', kind === 'history'
    ? 'Pages you visit will appear here.'
    : kind === 'bookmarks'
      ? 'Use the star in the toolbar to save a page for later.'
      : 'Files downloaded from websites will appear here.');
  empty.append(mark, title, message);
  libraryList.append(empty);
}

function renderItems() {
  libraryList.replaceChildren();
  const items = Array.isArray(data[currentKind]) ? data[currentKind] : [];
  if (!items.length) {
    showEmpty(currentKind);
    return;
  }
  if (currentKind === 'history' || currentKind === 'bookmarks') {
    for (const item of items) libraryList.append(makeSiteRow(item, currentKind));
  } else {
    for (const item of items) libraryList.append(makeDownloadRow(item));
  }
}

for (const tab of tabs) tab.addEventListener('click', () => setKind(tab.dataset.kind));
closeButton.addEventListener('click', () => window.lumoLibrary.close());
clearAction.addEventListener('click', async () => {
  if (currentKind === 'history') {
    if (!window.confirm('Clear all browsing history? This cannot be undone.')) return;
    const result = await window.lumoLibrary.clearHistory();
    if (!result?.ok && result?.error) window.alert(result.error);
  } else if (currentKind === 'downloads') {
    const result = await window.lumoLibrary.clearFinishedDownloads();
    if (!result?.ok && result?.error) window.alert(result.error);
  }
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.lumoLibrary.close(); });
window.lumoLibrary.onData((nextData) => {
  data = { history: [], bookmarks: [], downloads: [], ...(nextData || {}) };
  if (data.kind && data.kind !== currentKind) setKind(data.kind, false);
  else renderItems();
});
window.lumoLibrary.onKind((kind) => setKind(kind, false));
window.lumoLibrary.getData().then((nextData) => {
  data = { history: [], bookmarks: [], downloads: [], ...(nextData || {}) };
  setKind(data.kind || 'history', false);
}).catch(() => {});

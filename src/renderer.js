'use strict';

const addressInput = document.getElementById('addressInput');
const addressForm = document.getElementById('addressForm');
const backButton = document.getElementById('backButton');
const forwardButton = document.getElementById('forwardButton');
const reloadButton = document.getElementById('reloadButton');
const shortcutHint = document.getElementById('shortcutHint');
const toast = document.getElementById('toast');
const bookmarkButton = document.getElementById('bookmarkButton');
const historyButton = document.getElementById('historyButton');
const bookmarksButton = document.getElementById('bookmarksButton');
const downloadsButton = document.getElementById('downloadsButton');

let toastTimer = null;
let lastShownNetworkError = '';
let lastShownError = '';
let lastActiveTabId = null;
let currentState = { tabs: [], activeTabId: null };
const isApple = navigator.platform.toLowerCase().includes('mac');
const modifierLabel = isApple ? '⌘' : 'CTRL';
shortcutHint.textContent = `${modifierLabel} L`;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 5200);
}

function applyState(state = {}) {
  currentState = { ...state, tabs: Array.isArray(state.tabs) ? state.tabs : [] };
  document.body.classList.toggle('immersive-fullscreen', Boolean(state.immersiveFullscreen));
  const activeTabChanged = state.activeTabId !== lastActiveTabId;
  lastActiveTabId = state.activeTabId ?? null;

  // Keep the native OS title bar stable; page titles belong in the vertical tab rail.
  document.title = 'Lumo';
  if (activeTabChanged || document.activeElement !== addressInput) {
    addressInput.value = typeof state.url === 'string' ? state.url : '';
  }
  if (typeof state.canGoBack === 'boolean') backButton.disabled = !state.canGoBack;
  if (typeof state.canGoForward === 'boolean') forwardButton.disabled = !state.canGoForward;
  const isBookmarked = Boolean(state.isBookmarked);
  bookmarkButton.classList.toggle('is-bookmarked', isBookmarked);
  bookmarkButton.setAttribute('aria-pressed', String(isBookmarked));
  bookmarkButton.title = isBookmarked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';
  bookmarkButton.disabled = !Boolean(state.url);

  if (state.error) {
    if (state.error !== lastShownError) showToast(state.error);
    lastShownError = state.error;
  } else {
    lastShownError = '';
  }
  if (state.networkStartupError && state.networkStartupError !== lastShownNetworkError) {
    showToast(state.networkStartupError);
    lastShownNetworkError = state.networkStartupError;
  } else if (state.settingsWarning && state.settingsWarning !== lastShownNetworkError) {
    showToast(state.settingsWarning);
    lastShownNetworkError = state.settingsWarning;
  }
}

async function navigateFromInput() {
  const value = addressInput.value.trim();
  if (!value) return;
  addressInput.blur();
  try {
    const result = await window.lumo.navigate(value);
    if (!result?.ok && result?.error) showToast(result.error);
  } catch (error) {
    showToast(error?.message || 'Navigation failed.');
  }
}

async function createTabAndFocusAddress() {
  try {
    await window.lumo.newTab();
    addressInput.focus();
    addressInput.select();
  } catch (error) {
    showToast(error?.message || 'Could not create a new tab.');
  }
}

addressForm.addEventListener('submit', (event) => {
  event.preventDefault();
  navigateFromInput();
});
backButton.addEventListener('click', () => window.lumo.back());
forwardButton.addEventListener('click', () => window.lumo.forward());
reloadButton.addEventListener('click', () => window.lumo.reload());
bookmarksButton.addEventListener('click', () => window.lumo.openLibrary('bookmarks').catch((error) => showToast(error?.message || 'Could not open bookmarks.')));
historyButton.addEventListener('click', () => window.lumo.openLibrary('history').catch((error) => showToast(error?.message || 'Could not open history.')));
downloadsButton.addEventListener('click', () => window.lumo.openLibrary('downloads').catch((error) => showToast(error?.message || 'Could not open downloads.')));
bookmarkButton.addEventListener('click', async () => {
  try {
    const result = await window.lumo.toggleBookmark();
    if (!result?.ok && result?.error) showToast(result.error);
    else showToast(result.bookmarked ? 'Bookmark saved.' : 'Bookmark removed.');
  } catch (error) { showToast(error?.message || 'Could not update bookmark.'); }
});

document.addEventListener('keydown', (event) => {
  const mod = isApple ? event.metaKey : event.ctrlKey;
  const key = event.key.toLowerCase();

  if (mod && key === 'l') {
    event.preventDefault(); addressInput.focus(); addressInput.select();
  } else if (mod && key === 'r') {
    event.preventDefault(); window.lumo.reload();
  } else if (mod && event.shiftKey && key === 'o') {
    event.preventDefault(); window.lumo.openLibrary('bookmarks');
  } else if (mod && key === 'h') {
    event.preventDefault(); window.lumo.openLibrary('history');
  } else if (mod && key === 'j') {
    event.preventDefault(); window.lumo.openLibrary('downloads');
  } else if (mod && key === 'd') {
    event.preventDefault(); window.lumo.toggleBookmark();
  } else if (mod && key === 't') {
    event.preventDefault(); createTabAndFocusAddress();
  } else if (mod && key === 'w') {
    event.preventDefault();
    if (lastActiveTabId != null) window.lumo.closeTab(lastActiveTabId);
  } else if (mod && key === 'tab') {
    event.preventDefault();
    const ids = currentState.tabs.map((tab) => tab.id);
    if (ids.length > 1) {
      const currentIndex = ids.indexOf(lastActiveTabId);
      const direction = event.shiftKey ? -1 : 1;
      window.lumo.activateTab(ids[(currentIndex + direction + ids.length) % ids.length]);
    }
  } else if (mod && /^[1-8]$/.test(key)) {
    event.preventDefault();
    const tab = currentState.tabs[Number(key) - 1];
    if (tab) window.lumo.activateTab(tab.id);
  } else if (mod && key === '9') {
    event.preventDefault();
    if (currentState.tabs.length) window.lumo.activateTab(currentState.tabs[currentState.tabs.length - 1].id);
  } else if (event.altKey && event.key === 'ArrowLeft') {
    event.preventDefault(); window.lumo.back();
  } else if (event.altKey && event.key === 'ArrowRight') {
    event.preventDefault(); window.lumo.forward();
  }
});

addressInput.addEventListener('focus', () => addressInput.select());
addressInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    window.lumo.getState().then((state) => {
      addressInput.value = state.url || '';
      addressInput.blur();
    });
  }
});

window.lumo.onState(applyState);
window.lumo.onFocusAddress(() => { addressInput.focus(); addressInput.select(); });
window.lumo.onSidebarWidth((width) => {
  const clamped = Math.max(76, Math.min(248, Number(width) || 76));
  document.documentElement.style.setProperty('--sidebar-width', `${clamped}px`);
});
window.lumo.getState().then(applyState).catch(() => {
  showToast('Could not read browser state. Restart Lumo and try again.');
});

window.lumo.onImmersive((active) => document.body.classList.toggle('immersive-fullscreen', Boolean(active)));

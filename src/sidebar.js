const sidebar = document.querySelector('.sidebar');
const chrome = document.querySelector('.chrome');
const tabsList = document.getElementById('tabsList');
const newTabButton = document.getElementById('newTabButton');
const searchUtility = document.getElementById('searchUtility');
const homeUtility = document.getElementById('homeUtility');
const settingsUtility = document.getElementById('settingsUtility');
const tabsCount = document.getElementById('tabsCount');
const pinnedSitesList = document.getElementById('pinnedSitesList');
const pinnedSitesCount = document.getElementById('pinnedSitesCount');
const saveSiteButton = document.getElementById('saveSiteButton');
const tabContextMenu = document.getElementById('tabContextMenu');

const COLLAPSED_SIDEBAR_WIDTH = 76;
const EXPANDED_SIDEBAR_WIDTH = 248;
const isApple = navigator.platform.toLowerCase().includes('mac');
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let animationFrame = 0;
let lastReportedWidth = COLLAPSED_SIDEBAR_WIDTH;
let currentState = { tabs: [], activeTabId: null };
let draggedTabId = null;
let contextTabId = null;

function reportSidebarWidth(width) {
  const roundedWidth = Math.round(width);
  document.documentElement.style.setProperty('--sidebar-width', `${roundedWidth}px`);
  if (roundedWidth !== lastReportedWidth) {
    lastReportedWidth = roundedWidth;
    window.lumoSidebar.setSidebarWidth(roundedWidth);
  }
}

function animateSidebar(expanded) {
  chrome.classList.toggle('sidebar-expanded', expanded);
  if (animationFrame) cancelAnimationFrame(animationFrame);

  if (prefersReducedMotion) {
    reportSidebarWidth(expanded ? EXPANDED_SIDEBAR_WIDTH : COLLAPSED_SIDEBAR_WIDTH);
    return;
  }

  const current = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'),
  ) || COLLAPSED_SIDEBAR_WIDTH;
  const target = expanded ? EXPANDED_SIDEBAR_WIDTH : COLLAPSED_SIDEBAR_WIDTH;

  if (Math.abs(current - target) < 1) {
    reportSidebarWidth(target);
    return;
  }

  const startedAt = performance.now();
  const duration = 165;
  const frame = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    reportSidebarWidth(current + (target - current) * eased);
    if (progress < 1) {
      animationFrame = requestAnimationFrame(frame);
    } else {
      animationFrame = 0;
      reportSidebarWidth(target);
    }
  };
  animationFrame = requestAnimationFrame(frame);
}

sidebar.addEventListener('pointerenter', () => animateSidebar(true));
sidebar.addEventListener('pointerleave', () => animateSidebar(false));

function shortHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '') || 'Web';
  } catch {
    return 'Web';
  }
}

function tabInitial(url) {
  if (!url) return 'L';
  return shortHost(url).slice(0, 1).toUpperCase() || '◌';
}

function isElementFullyVisible(element, container) {
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom;
}

function renderTabs(tabs = [], activeTabId = null) {
  renderPinnedSites(currentState.pinnedSites || []);
  const fragment = document.createDocumentFragment();

  let sawPinnedTab = false;
  let insertedUnpinnedDivider = false;
  for (const tab of tabs) {
    if (sawPinnedTab && !tab.pinned && !insertedUnpinnedDivider) {
      const divider = document.createElement('div');
      divider.className = 'tab-section-divider';
      divider.setAttribute('role', 'separator');
      divider.setAttribute('aria-label', 'Unpinned tabs');
      fragment.append(divider);
      insertedUnpinnedDivider = true;
    }
    if (tab.pinned) sawPinnedTab = true;

    const item = document.createElement('div');
    item.className = `tab-item${tab.id === activeTabId ? ' active' : ''}${tab.pinned ? ' pinned' : ''}`;
    item.dataset.tabId = String(tab.id);
    item.draggable = true;

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'tab-select';
    select.dataset.action = 'activate';
    select.dataset.tabId = String(tab.id);
    select.setAttribute('role', 'tab');
    select.setAttribute('aria-selected', String(tab.id === activeTabId));
    select.title = tab.url || tab.title || 'New tab';

    const favicon = document.createElement('span');
    favicon.className = `tab-favicon${tab.loading ? ' is-loading' : ''}`;
    favicon.textContent = tab.favicon ? '' : tabInitial(tab.url);
    favicon.setAttribute('aria-hidden', 'true');
    if (tab.favicon && /^(https?:|data:image\/)/i.test(tab.favicon)) {
      const image = document.createElement('img');
      image.alt = '';
      image.draggable = false;
      image.referrerPolicy = 'no-referrer';
      image.src = tab.favicon;
      image.addEventListener('error', () => { image.remove(); favicon.textContent = tabInitial(tab.url); }, { once: true });
      favicon.append(image);
    }

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || 'New tab';
    select.append(favicon, title);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.dataset.action = 'close';
    close.dataset.tabId = String(tab.id);
    close.setAttribute('aria-label', `Close ${tab.title || 'tab'}`);
    close.title = 'Close tab (Ctrl+W)';
    close.textContent = '×';

    const pinMark = document.createElement('span');
    pinMark.className = 'tab-pin-indicator';
    pinMark.setAttribute('aria-label', 'Pinned tab');
    pinMark.title = 'Pinned tab';
    pinMark.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8l-1 6 3 3v2H6v-2l3-3-1-6ZM12 15v5"/></svg>';

    item.append(select, pinMark, close);
    fragment.append(item);
  }

  tabsList.replaceChildren(fragment);
  const activeButton = tabsList.querySelector('.tab-item.active .tab-select');
  if (activeButton) {
    const item = activeButton.closest('.tab-item');
    if (item && !isElementFullyVisible(item, tabsList)) {
      item.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    }
  }
}

function renderPinnedSites(sites = []) {
  pinnedSitesCount.textContent = String(sites.length);
  const fragment = document.createDocumentFragment();
  for (const site of sites) {
    const row = document.createElement('div'); row.className = 'saved-site-item'; row.title = site.url;
    const open = document.createElement('button'); open.type = 'button'; open.className = 'saved-site-open'; open.dataset.siteUrl = site.url;
    const icon = document.createElement('span'); icon.className = 'saved-site-icon'; icon.textContent = tabInitial(site.url);
    const label = document.createElement('span'); label.className = 'saved-site-title'; label.textContent = site.title || shortHost(site.url);
    open.append(icon, label);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'saved-site-remove'; remove.dataset.removeUrl = site.url; remove.title = `Remove ${site.title || site.url}`; remove.setAttribute('aria-label', remove.title); remove.textContent = '×';
    row.append(open, remove); fragment.append(row);
  }
  pinnedSitesList.replaceChildren(fragment);
}

function applyState(state = {}) {
  currentState = { ...state, tabs: Array.isArray(state.tabs) ? state.tabs : [] };
  tabsCount.textContent = `${currentState.tabs.length} open`;
  const onStartPage = typeof state.url === 'string' && state.url.startsWith('lumo://app/newtab.html');
  homeUtility.classList.toggle('is-active', onStartPage);
  if (draggedTabId === null) renderTabs(currentState.tabs, currentState.activeTabId ?? null);
}

async function createTabAndFocusAddress() {
  try {
    await window.lumoSidebar.newTab();
    window.lumoSidebar.focusAddress();
  } catch {
    // The main browser UI surfaces navigation and startup errors.
  }
}

function clearDropTargets() {
  tabsList.querySelectorAll('.drop-before, .drop-after').forEach((item) => {
    item.classList.remove('drop-before', 'drop-after');
    delete item.dataset.dropPosition;
  });
}

function hideTabContextMenu() {
  tabContextMenu.hidden = true;
  tabContextMenu.replaceChildren();
  contextTabId = null;
}

function appendMenuSeparator() {
  const separator = document.createElement('div');
  separator.className = 'tab-context-separator';
  separator.setAttribute('role', 'separator');
  tabContextMenu.append(separator);
}

function appendMenuItem(label, action, options = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `tab-context-item${options.danger ? ' is-danger' : ''}`;
  button.setAttribute('role', 'menuitem');
  button.dataset.menuAction = action;
  button.disabled = Boolean(options.disabled);
  const labelNode = document.createElement('span');
  labelNode.textContent = label;
  button.append(labelNode);
  if (options.shortcut) {
    const shortcut = document.createElement('span');
    shortcut.className = 'tab-context-shortcut';
    shortcut.textContent = options.shortcut;
    button.append(shortcut);
  }
  tabContextMenu.append(button);
}

function isWebSite(url) { try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; } }

function showTabContextMenu(tabId, clientY) {
  const tab = currentState.tabs.find((item) => item.id === tabId);
  if (!tab) return;
  contextTabId = tabId;
  animateSidebar(true);
  tabContextMenu.replaceChildren();
  appendMenuItem('Save site shortcut', 'save-site', { disabled: !isWebSite(tab.url) });
  appendMenuItem('Duplicate tab', 'duplicate');
  appendMenuItem(tab.pinned ? 'Unpin tab' : 'Pin tab', 'pin');
  appendMenuSeparator();
  appendMenuItem('Close tab', 'close', { shortcut: isApple ? '⌘ W' : 'Ctrl+W', danger: true });
  const closableOthers = currentState.tabs.filter((item) => item.id !== tabId && !item.pinned);
  const rightTabs = currentState.tabs.slice(currentState.tabs.findIndex((item) => item.id === tabId) + 1).filter((item) => !item.pinned);
  appendMenuItem('Close other tabs', 'close-others', { disabled: closableOthers.length === 0 });
  appendMenuItem('Close tabs to the right', 'close-right', { disabled: rightTabs.length === 0 });
  tabContextMenu.hidden = false;
  const estimatedHeight = tabContextMenu.scrollHeight || 230;
  const top = Math.max(8, Math.min(Number(clientY) - 12, window.innerHeight - estimatedHeight - 8));
  tabContextMenu.style.top = `${top}px`;
  tabContextMenu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}

async function runTabMenuAction(action) {
  const tabId = contextTabId;
  hideTabContextMenu();
  if (tabId == null) return;
  try {
    if (action === 'save-site') await window.lumoSidebar.pinCurrentSite(tabId);
    else if (action === 'duplicate') await window.lumoSidebar.duplicateTab(tabId);
    else if (action === 'pin') await window.lumoSidebar.toggleTabPinned(tabId);
    else if (action === 'close') await window.lumoSidebar.closeTab(tabId);
    else if (action === 'close-others') await window.lumoSidebar.closeOtherTabs(tabId);
    else if (action === 'close-right') await window.lumoSidebar.closeTabsToRight(tabId);
  } catch (error) {
    console.warn('[Lumo] Tab action failed:', error);
  }
}

newTabButton.addEventListener('click', createTabAndFocusAddress);
saveSiteButton.addEventListener('click', async () => {
  if (currentState.activeTabId == null) return;
  try { await window.lumoSidebar.pinCurrentSite(currentState.activeTabId); } catch (error) { console.warn('[Lumo] Could not save site shortcut:', error); }
});
pinnedSitesList.addEventListener('click', async (event) => {
  const open = event.target.closest('button[data-site-url]');
  const remove = event.target.closest('button[data-remove-url]');
  try {
    if (open) await window.lumoSidebar.openPinnedSite(open.dataset.siteUrl);
    else if (remove) await window.lumoSidebar.removePinnedSite(remove.dataset.removeUrl);
  } catch (error) { console.warn('[Lumo] Saved-site action failed:', error); }
});
searchUtility.addEventListener('click', () => window.lumoSidebar.focusAddress());
homeUtility.addEventListener('click', () => window.lumoSidebar.home());
settingsUtility.addEventListener('click', () => window.lumoSidebar.toggleSettings());

tabsList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action][data-tab-id]');
  if (!button) return;
  const tabId = Number(button.dataset.tabId);
  if (!Number.isInteger(tabId)) return;

  try {
    if (button.dataset.action === 'activate') {
      await window.lumoSidebar.activateTab(tabId);
    } else if (button.dataset.action === 'close') {
      await window.lumoSidebar.closeTab(tabId);
    }
  } catch {
    // The main browser UI is responsible for browser status messages.
  }
});

tabsList.addEventListener('auxclick', async (event) => {
  if (event.button !== 1) return;
  const item = event.target.closest('.tab-item[data-tab-id]');
  if (!item) return;
  event.preventDefault();
  await window.lumoSidebar.closeTab(Number(item.dataset.tabId));
});

tabContextMenu.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-menu-action]');
  if (button && !button.disabled) runTabMenuAction(button.dataset.menuAction);
});

tabsList.addEventListener('contextmenu', (event) => {
  const item = event.target.closest('.tab-item[data-tab-id]');
  if (!item) return;
  event.preventDefault();
  showTabContextMenu(Number(item.dataset.tabId), event.clientY);
});

document.addEventListener('pointerdown', (event) => {
  if (!tabContextMenu.hidden && !event.target.closest('#tabContextMenu')) hideTabContextMenu();
});
document.addEventListener('keydown', (event) => {
  if (tabContextMenu.hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    hideTabContextMenu();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const items = [...tabContextMenu.querySelectorAll('button:not(:disabled)')];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    items[(index + direction + items.length) % items.length].focus();
  }
});

// HTML drag-and-drop reorders tab metadata in the main process; it never recreates
// or reloads a WebContentsView, so the page state stays intact.
tabsList.addEventListener('dragstart', (event) => {
  const item = event.target.closest('.tab-item[data-tab-id]');
  if (!item || event.target.closest('.tab-close')) {
    event.preventDefault();
    return;
  }
  draggedTabId = Number(item.dataset.tabId);
  item.classList.add('dragging');
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(draggedTabId));
  }
  hideTabContextMenu();
});

tabsList.addEventListener('dragover', (event) => {
  if (draggedTabId == null) return;
  const target = event.target.closest('.tab-item[data-tab-id]');
  const dragged = currentState.tabs.find((item) => item.id === draggedTabId);
  const targetTab = target && currentState.tabs.find((item) => item.id === Number(target.dataset.tabId));
  if (!target || !dragged || !targetTab || targetTab.id === dragged.id || Boolean(targetTab.pinned) !== Boolean(dragged.pinned)) {
    clearDropTargets();
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  clearDropTargets();
  const rect = target.getBoundingClientRect();
  const after = event.clientY > rect.top + rect.height / 2;
  target.classList.add(after ? 'drop-after' : 'drop-before');
  target.dataset.dropPosition = after ? 'after' : 'before';
});

tabsList.addEventListener('drop', async (event) => {
  if (draggedTabId == null) return;
  const target = event.target.closest('.tab-item[data-tab-id]');
  if (!target) return;
  event.preventDefault();
  const sourceId = draggedTabId;
  const targetId = Number(target.dataset.tabId);
  const after = target.dataset.dropPosition === 'after';
  clearDropTargets();
  try {
    if (sourceId !== targetId) await window.lumoSidebar.moveTab(sourceId, targetId, after);
  } catch (error) {
    console.warn('[Lumo] Could not reorder tabs:', error);
  }
});

tabsList.addEventListener('dragend', () => {
  draggedTabId = null;
  clearDropTargets();
  tabsList.querySelectorAll('.dragging').forEach((item) => item.classList.remove('dragging'));
  renderTabs(currentState.tabs, currentState.activeTabId ?? null);
});

document.addEventListener('keydown', (event) => {
  const mod = isApple ? event.metaKey : event.ctrlKey;
  const key = String(event.key || '').toLowerCase();
  const ids = currentState.tabs.map((tab) => tab.id);

  if (mod && key === 'l') {
    event.preventDefault();
    window.lumoSidebar.focusAddress();
  } else if (mod && key === 'r') {
    event.preventDefault();
    window.lumoSidebar.reload();
  } else if (mod && key === 't') {
    event.preventDefault();
    createTabAndFocusAddress();
  } else if (mod && key === 'w') {
    event.preventDefault();
    if (currentState.activeTabId != null) window.lumoSidebar.closeTab(currentState.activeTabId);
  } else if (mod && key === 'tab') {
    event.preventDefault();
    if (ids.length > 1) {
      const index = ids.indexOf(currentState.activeTabId);
      const direction = event.shiftKey ? -1 : 1;
      window.lumoSidebar.activateTab(ids[(index + direction + ids.length) % ids.length]);
    }
  } else if (mod && /^[1-8]$/.test(key)) {
    event.preventDefault();
    const targetId = ids[Number(key) - 1];
    if (targetId != null) window.lumoSidebar.activateTab(targetId);
  } else if (mod && key === '9') {
    event.preventDefault();
    if (ids.length) window.lumoSidebar.activateTab(ids[ids.length - 1]);
  } else if (event.altKey && event.key === 'ArrowLeft') {
    event.preventDefault();
    window.lumoSidebar.back();
  } else if (event.altKey && event.key === 'ArrowRight') {
    event.preventDefault();
    window.lumoSidebar.forward();
  }
});

window.lumoSidebar.onState(applyState);
window.lumoSidebar.getState().then(applyState).catch(() => {});

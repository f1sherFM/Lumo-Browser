'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('new-tab page contains the Figma-guided hero, search, quick links, and focus card', () => {
  const html = read('src/newtab.html');
  assert.match(html, /A QUIETER CORNER OF THE INTERNET/);
  assert.match(html, /Find your own flow\./);
  assert.match(html, /id="searchInput"/);
  assert.match(html, /PICK UP WHERE YOU LEFT OFF/);
  assert.match(html, /A moment for yourself/);
  assert.match(html, /href="https:\/\/www\.cscastart\.com\/"/);
});

test('main, sidebar, settings, library and new-tab use the agreed palette and modern font stack', () => {
  for (const stylesheet of ['src/styles.css', 'src/newtab.css', 'src/settings.css', 'src/library.css']) {
    const css = read(stylesheet);
    assert.match(css, /#0e1016/i, `${stylesheet} should use the Night background token`);
    assert.match(css, /#171a24/i, `${stylesheet} should use the Surface token`);
    assert.match(css, /#ab91fa/i, `${stylesheet} should use the Lilac accent`);
    assert.match(css, /Segoe UI Variable/);
    assert.doesNotMatch(css, /Trebuchet MS/);
  }
});

test('native page bounds and UI sidebar widths stay aligned to the collapsed/expanded rail', () => {
  const main = read('src/main.js');
  const css = read('src/styles.css');
  const sidebar = read('src/sidebar.js');
  const renderer = read('src/renderer.js');
  assert.match(main, /COLLAPSED_SIDEBAR_WIDTH = 76/);
  assert.match(main, /EXPANDED_SIDEBAR_WIDTH = 248/);
  assert.match(main, /TOOLBAR_HEIGHT = 76/);
  assert.match(main, /x: COLLAPSED_SIDEBAR_WIDTH,[\s\S]*y: TOOLBAR_HEIGHT/);
  assert.match(css, /--sidebar-width: 76px/);
  assert.match(css, /--sidebar-expanded-width: 248px/);
  assert.match(css, /--toolbar-height: 76px/);
  assert.match(sidebar, /COLLAPSED_SIDEBAR_WIDTH = 76/);
  assert.match(sidebar, /EXPANDED_SIDEBAR_WIDTH = 248/);
  assert.match(renderer, /Math\.max\(76, Math\.min\(248/);
});

test('sidebar utility controls are present and wired to real browser actions', () => {
  const html = read('src/sidebar.html');
  const js = read('src/sidebar.js');
  const preload = read('src/sidebar-preload.js');
  assert.match(html, /id="searchUtility"/);
  assert.match(html, /id="homeUtility"/);
  assert.match(html, /id="settingsUtility"/);
  assert.match(html, /id="tabsCount"/);
  assert.match(js, /searchUtility\.addEventListener\('click', \(\) => window\.lumoSidebar\.focusAddress\(\)\)/);
  assert.match(js, /homeUtility\.addEventListener\('click', \(\) => window\.lumoSidebar\.home\(\)\)/);
  assert.match(js, /settingsUtility\.addEventListener\('click', \(\) => window\.lumoSidebar\.toggleSettings\(\)\)/);
  assert.match(preload, /toggleSettings: \(\) => ipcRenderer\.send\('browser:toggle-settings'\)/);
});

test('new-tab search advertises Ctrl+K and implements the shortcut', () => {
  assert.match(read('src/newtab.html'), /CTRL&nbsp; K/);
  assert.match(read('src/newtab.js'), /event\.key\.toLowerCase\(\) === 'k'/);
});


test('Orbit logo is used consistently in app assets, sidebar, and new-tab hero', () => {
  const logo = read('assets/lumo.svg');
  const sidebar = read('src/sidebar.html');
  const newTab = read('src/newtab.html');
  assert.match(logo, /Lumo Orbit/);
  assert.match(logo, /<ellipse/);
  assert.match(logo, /<circle/);
  assert.match(sidebar, /class="brand-mark"/);
  assert.match(sidebar, /id="orbitPlanet"/);
  assert.match(newTab, /class="emblem"/);
  assert.match(newTab, /id="heroPlanet"/);
});


test('Orbit and new-tab entrance motion is restrained and supports reduced-motion preferences', () => {
  const newTabHtml = read('src/newtab.html');
  const newTabCss = read('src/newtab.css');
  const sidebarHtml = read('src/sidebar.html');
  const sidebarJs = read('src/sidebar.js');
  assert.match(newTabHtml, /class="orbit-ring-front"/);
  assert.match(newTabHtml, /class="orbit-star"/);
  assert.match(sidebarHtml, /class="orbit-ring-front"/);
  assert.match(newTabCss, /@keyframes orbit-draw/);
  assert.match(newTabCss, /@keyframes star-arrive/);
  assert.match(newTabCss, /prefers-reduced-motion:\s*reduce/);
  assert.match(sidebarJs, /prefers-reduced-motion/);
  assert.match(sidebarJs, /if \(prefersReducedMotion\)/);
});


test('Orbit is a closed layered ring and the hero animation is triggered after the tab becomes active', () => {
  const logo = read('assets/lumo.svg');
  const newTab = read('src/newtab.html');
  const sidebar = read('src/sidebar.html');
  const css = read('src/newtab.css');
  const js = read('src/newtab.js');
  const preload = read('src/tab-preload.js');
  const main = read('src/main.js');

  for (const source of [logo, newTab, sidebar]) {
    assert.match(source, /pathLength="1000"/);
    assert.match(source, /stroke-dasharray="500 500"/);
    assert.doesNotMatch(source, /stroke-dasharray="188 120"/);
    assert.doesNotMatch(source, /stroke-dashoffset="-150"/);
  }
  assert.match(css, /html\.motion-intro \.emblem \.orbit-ring-front \{ animation: orbit-draw/);
  assert.match(css, /@keyframes orbit-draw \{ from \{ stroke-dasharray: 0 1000/);
  assert.match(js, /lumoNewTab\.onActivated\(playIntroOnce\)/);
  assert.match(js, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
  assert.match(preload, /onActivated: \(callback\)/);
  assert.match(main, /notifyNewTabActivated\(tab\)/);
  assert.match(main, /browser:newtab-activated/);
});


test('new-tab content stays hidden until entrance animation is armed, preventing first-paint flash', () => {
  const css = read('src/newtab.css');
  const js = read('src/newtab.js');
  assert.match(css, /html:not\(\.motion-ready\) \.emblem-aura/);
  assert.match(css, /html:not\(\.motion-ready\) \.quick-card/);
  assert.match(js, /root\.classList\.add\(motionClass, 'motion-ready'\)/);
  assert.match(js, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
});


test('reduced-motion preference keeps a small opacity intro instead of removing all motion cues', () => {
  const css = read('src/newtab.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /html\.motion-reduced \.emblem,\nhtml\.motion-reduced \.eyebrow/);
  assert.match(css, /animation: gentle-fade 220ms ease-out both/);
  assert.match(css, /@keyframes gentle-fade/);
  assert.doesNotMatch(css, /\*, \*::before, \*::after \{ animation: none !important;/);
});

test('settings uses the Lumo visual system with grouped sections and accessible custom controls', () => {
  const html = read('src/settings.html');
  const css = read('src/settings.css');
  assert.match(html, /class="settings-title-group"/);
  assert.match(html, /class="settings-mark"/);
  assert.match(html, /aria-labelledby="searchSectionTitle"/);
  assert.match(html, /aria-labelledby="networkSectionTitle"/);
  assert.match(html, /id="searchEngine"/);
  assert.match(html, /id="networkMode"/);
  assert.match(html, /id="proxyUrl"/);
  assert.match(html, /id="routeStatus" role="status" aria-live="polite"/);
  assert.match(html, /value="startpage"/);
  assert.match(css, /--accent:\s*#ab91fa/i);
  assert.match(css, /\.settings-section\s*\{[\s\S]*border-radius:\s*13px/);
  assert.match(css, /\.section-icon/);
  assert.match(css, /\.route-status\[data-state="ready"\]/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});

test('toolbar actions are grouped compactly without changing their existing handlers', () => {
  const html = read('src/index.html');
  const css = read('src/styles.css');
  const renderer = read('src/renderer.js');
  assert.match(html, /class="toolbar-tools" role="group" aria-label="Page and library tools"/);
  assert.match(html, /class="toolbar-tools-divider" aria-hidden="true"/);
  for (const id of ['bookmarkButton', 'bookmarksButton', 'historyButton', 'downloadsButton']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(css, /\.toolbar-tools\s*\{/);
  assert.match(css, /\.toolbar-tools-divider\s*\{/);
  assert.match(renderer, /bookmarksButton\.addEventListener\('click'/);
  assert.match(renderer, /historyButton\.addEventListener\('click'/);
  assert.match(renderer, /downloadsButton\.addEventListener\('click'/);
  assert.match(renderer, /bookmarkButton\.addEventListener\('click'/);
});


test('vertical tabs expose drag reordering, pinning, duplication and a context menu', () => {
  const html = read('src/sidebar.html');
  const js = read('src/sidebar.js');
  const css = read('src/styles.css');
  const preload = read('src/sidebar-preload.js');
  const main = read('src/main.js');
  for (const id of ['tabContextMenu', 'tabsList']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(js, /tabsList\.addEventListener\('dragstart'/);
  assert.match(js, /tabsList\.addEventListener\('dragover'/);
  assert.match(js, /tabsList\.addEventListener\('drop'/);
  assert.match(js, /showTabContextMenu/);
  assert.match(js, /Duplicate tab/);
  assert.match(js, /Close other tabs/);
  assert.match(js, /Close tabs to the right/);
  assert.match(css, /\.tab-item\.pinned/);
  assert.match(css, /\.tab-context-menu\[hidden\]/);
  for (const method of ['duplicateTab', 'toggleTabPinned', 'moveTab', 'closeOtherTabs', 'closeTabsToRight']) {
    assert.match(preload, new RegExp(`${method}:`));
  }
  for (const channel of ['browser:duplicate-tab', 'browser:toggle-tab-pinned', 'browser:move-tab', 'browser:close-other-tabs', 'browser:close-tabs-to-right']) {
    assert.ok(main.includes(channel), `Missing IPC handler for ${channel}`);
  }
  assert.match(main, /pinned: Boolean\(tab\.pinned\)/);
});

test('settings exposes startup behavior, session permissions, bookmark transfer, and browsing-data controls', () => {
  const html = read('src/settings.html');
  const js = read('src/settings.js');
  const preload = read('src/settings-preload.js');
  const main = read('src/main.js');
  const core = read('src/core.js');
  for (const id of ['startupBehavior', 'permissionList', 'resetAllPermissions', 'importBookmarks', 'exportBookmarks', 'clearBrowsingData', 'clearHistory', 'clearCookies', 'clearSiteStorage', 'clearCache', 'clearDownloadList', 'clearPermissions']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(core, /startupBehavior: 'restore'/);
  assert.match(main, /SETTINGS\.startupBehavior === 'restore'/);
  assert.match(js, /startupBehavior: startupBehavior\.value/);
  for (const method of ['resetPermission', 'resetAllPermissions', 'importBookmarks', 'exportBookmarks', 'clearBrowsingData']) {
    assert.match(preload, new RegExp(`${method}:`));
  }
  for (const channel of ['browser:settings-permission-reset', 'browser:settings-permissions-reset-all', 'browser:settings-bookmarks-import', 'browser:settings-bookmarks-export', 'browser:settings-clear-data']) {
    assert.ok(main.includes(channel), `Missing settings handler: ${channel}`);
  }
  assert.match(main, /assertTrustedSettings\(event\)/);
});


test('persistent site shortcuts and automatic immersive fullscreen are wired into the browser', () => {
  const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  const sidebar = fs.readFileSync(path.join(root, 'src/sidebar.html'), 'utf8');
  const sidebarJs = fs.readFileSync(path.join(root, 'src/sidebar.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'src/sidebar-preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
  assert.match(main, /pinnedSites: Array\.isArray\(data\.pinnedSites\)/);
  assert.match(main, /browser:pin-current-site/);
  assert.match(main, /enter-html-full-screen/);
  assert.match(main, /leave-html-full-screen/);
  assert.match(sidebar, /id="pinnedSitesList"/);
  assert.match(sidebarJs, /renderPinnedSites/);
  assert.match(preload, /openPinnedSite/);
  assert.match(renderer, /immersive-fullscreen/);
});

test('fullscreen transitions reapply native view bounds and the tabs list hides its scrollbar', () => {
  const main = read('src/main.js');
  const css = read('src/styles.css');
  assert.match(main, /function setImmersiveFullscreen\(active\)/);
  assert.match(main, /mainWindow\.on\('enter-full-screen'/);
  assert.match(main, /mainWindow\.on\('leave-full-screen'/);
  assert.match(css, /\.tabs-list\s*\{[\s\S]*?scrollbar-width:\s*none/);
  assert.match(css, /\.tabs-list::-webkit-scrollbar\s*\{\s*display:\s*none/);
});


test('HTML fullscreen does not force native window fullscreen or toggle it on exit', () => {
  const main = read('src/main.js');
  const enter = main.slice(main.indexOf("contents.on('enter-html-full-screen'"), main.indexOf("contents.on('before-input-event'"));
  assert.match(enter, /setImmersiveFullscreen\(true\)/);
  assert.doesNotMatch(enter, /mainWindow\.setFullScreen\(/);
  assert.match(enter, /page owns HTML fullscreen/i);
  assert.doesNotMatch(enter, /setFullScreen\(false\)/);
});

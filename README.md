# Lumo 0.10.11 — New Tab Flash Fix

Windows-first Electron/Chromium browser MVP. This release extends the Settings panel with session-level site-permission management, bookmark import/export, browsing-data clearing, and a configurable startup behavior. The Orbit identity, vertical overlay tabs, network configuration, library, and tab management are retained.

## What's new

- **Startup behavior:** choose to restore the previous session or open a fresh New Tab at the next launch. Existing configuration files migrate to `restore` by default.
- **Site permissions:** review permissions decided during the current Lumo session, reset one decision, or reset all decisions. Permissions remain session-only; unknown types and insecure origins are blocked.
- **Bookmark import/export:** import standard browser Netscape bookmark HTML or JSON containing a bookmark array; export in portable Netscape bookmark HTML. URLs are restricted to HTTP(S), imports are deduplicated, and existing bookmarks are retained when the 500-item cap is reached.
- **Clear browsing data:** selectively clear Lumo's history records, cookies/authentication cache, site storage, cache, download-history records, and session permission decisions. A confirmation explains the selection. Downloaded files are never deleted by this control, and active downloads remain listed.
- **Settings feedback:** dedicated status messages report import/export/clear outcomes without overwriting network status.

## Run locally

```powershell
npm ci
npm run check
npm test
npm start
```

## Build Windows packages

```powershell
npm run pack:win
npm run dist:win:installer
npm run dist:win:portable
```

Build artifacts are written to `release/`. Electron GUI testing and Windows packaging must be verified on a Windows machine.

## Notes

- Site-permission decisions are temporary and are not stored in the profile after exit.
- Clearing cookies and/or site storage may sign you out or reset website preferences.
- Clearing the download list only removes Lumo's records; files in the Downloads folder remain untouched.
- `startupBehavior` is saved in the user's Lumo settings and only affects the next launch.


## 0.10.8

- Added persistent saved website shortcuts in the Orbit sidebar. These are separate from temporary pinned tabs, persist in browser data across restarts, and can be opened or removed from the sidebar. Save the active site with “Save current site” or from a tab context menu.
- Added automatic immersive fullscreen for websites that request HTML fullscreen (such as video players). Lumo enters fullscreen, hides the toolbar/sidebar, and restores the normal browser UI when fullscreen ends.
- Made `npm test` run test files sequentially to avoid the intermittent failure observed when Node runs the suite in parallel.


## 0.10.9

- Improved immersive fullscreen transitions: browser chrome is hidden as soon as a page requests HTML fullscreen, native view bounds are refreshed after Electron window fullscreen transitions, and the normal UI is restored on exit.
- Removed the visible scrollbar from the vertical Tabs list while preserving scrolling for long tab lists.
- `npm test` remains sequential by default to avoid the intermittent parallel-run failure.
- Validation: `npm run check` and `npm test` pass in the development environment. Actual Windows GUI/fullscreen playback still needs confirmation on a Windows machine.


## 0.10.10

- Fixed the fullscreen regression by no longer forcing the native Electron window into/out of OS fullscreen when a website enters/exits HTML fullscreen. Lumo now hides only its own chrome and adjusts the website view, leaving the website/player's fullscreen controls under Chromium's control.
- Kept the hidden Tabs scrollbar behavior and persistent site shortcuts.
- Validation: automated checks and tests pass in the development environment. Twitch playback/fullscreen still requires manual confirmation in the user's Windows environment.


## 0.10.11

- Fixed a brief first-paint flash on the New Tab page before its entrance animation starts.
- Animated content remains in its pre-animation state until the activation animation is armed.
- Preserved the one-time entrance animation and reduced-motion behavior.
- Automated regression coverage added for the initial hidden state and animation readiness class.

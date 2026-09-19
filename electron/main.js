'use strict';
/*
 * MacCleaner — Electron main process.
 *
 * Turns the Express web app into a native desktop window. The full backend
 * (scanner, trash, scheduler, system info) runs in-process exactly as it
 * does on the web, listening on a random localhost port; the window simply
 * loads it. On top of that, the desktop build adds:
 *  - a menu-bar/tray icon with live free-disk stats and quick actions
 *  - folder drag-and-drop (onto the window or the dock icon) → instant scan
 *  - native notifications when a scheduled scan crosses its growth threshold
 *  - auto-updates from GitHub Releases (electron-updater), asking before
 *    restarting; updates require a code-signed build on macOS, so failures
 *    there are logged and otherwise ignored.
 */
const { app, BrowserWindow, Tray, Menu, Notification, shell, ipcMain, dialog, nativeImage, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Built backend lives in dist/. `npm run build` (tsc) must run before packaging.
const { startServer } = require(path.join(__dirname, '..', 'dist', 'server.js'));
const { onGrowthAlert } = require(path.join(__dirname, '..', 'dist', 'services', 'scheduler.js'));
const { diskUsage } = require(path.join(__dirname, '..', 'dist', 'services', 'diskUsage.js'));
const { formatBytes } = require(path.join(__dirname, '..', 'dist', 'utils', 'formatBytes.js'));

let running = null; // { server, port, shutdown }
let mainWindow = null;
let tray = null;
let trayTimer = null;
/** Last successful fan/temp status, or null while unavailable. Drives the
 *  tray title suffix and the live menu section; cleared on a failed fetch. */
let fanStatus = null;
/** Consecutive fan-status fetch failures — used to back the poll off to 60s. */
let fanFailures = 0;
/** Set once we log the first successful fetch, to keep the log quiet after. */
let fanStatusLogged = false;
/** Current tray poll cadence in ms (15s normally, 60s after repeated fails). */
let trayIntervalMs = 0;
/** True while refreshTray is in flight — its awaits (slow disk walk, 3s fan
 *  timeout) can outlive the next poll tick, and overlapping runs would race
 *  on fanStatus and double-schedule the poll. */
let trayRefreshBusy = false;
/** Paths handed to us before the window was ready (dock drops, CLI args). */
const pendingScanPaths = [];

/** True while the "update downloaded" dialog is on screen. electron-updater
 *  re-checks every 6h and can re-emit update-downloaded; without this guard
 *  identical dialogs stack (each one's OK could trigger quitAndInstall). */
let updateDialogOpen = false;

const TRAY_POLL_OK_MS = 15_000;
const TRAY_POLL_BACKOFF_MS = 60_000;
const FAN_FETCH_TIMEOUT_MS = 3_000;
/** After this many consecutive failures, slow the poll to conserve resources. */
const FAN_BACKOFF_AFTER = 3;

/* ─────────────────────────── Scan-path plumbing ─────────────────────────── */

/** Folder for any path: directories pass through, files resolve to their parent. */
function toScannableDir(p) {
  try {
    const stat = fs.statSync(p);
    return stat.isDirectory() ? p : path.dirname(p);
  } catch {
    return null;
  }
}

function requestScan(rawPath) {
  const dir = toScannableDir(rawPath);
  if (!dir) return;
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    showMainWindow();
    mainWindow.webContents.send('treemap:scan-path', dir);
  } else {
    pendingScanPaths.push(dir);
  }
}

function flushPendingScans() {
  while (pendingScanPaths.length > 0 && mainWindow) {
    mainWindow.webContents.send('treemap:scan-path', pendingScanPaths.shift());
  }
}

/** Directory args from a launch/second launch (Windows/Linux drag-onto-icon). */
function scanPathsFromArgv(argv) {
  return argv.slice(1).filter((arg) => {
    if (arg.startsWith('-')) return false;
    try {
      return fs.statSync(arg).isDirectory();
    } catch {
      return false;
    }
  });
}

ipcMain.handle('treemap:resolve-scan-path', (_event, p) => {
  if (typeof p !== 'string' || !p) return null;
  return toScannableDir(p);
});

/* Update-preference IPC (Preferences → General → Software updates). */
ipcMain.handle('updates:get', () => autoUpdatesEnabled());
ipcMain.on('updates:set', (_event, on) => {
  writeUpdatePrefs({ autoFetch: on === true });
  if (on === true) {
    fallbackMode = false; // a rebuild may now be signed — try the real channel
    ghCheckedAt = 0;
    setupAutoUpdates(); // re-arms the 6h cadence (guarded against re-entry)
  } else if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
});

/* ─────────────────────────────── Window ─────────────────────────────── */

async function boot() {
  const publicDir = path.join(__dirname, '..', 'public');
  // Port 0 → OS assigns a free port, so two machines never collide.
  running = await startServer({ host: '127.0.0.1', port: 0, publicDir });
  console.log(`[treemap] desktop server ready on 127.0.0.1:${running.port}`);
  createWindow(running.port);
  createTray();
  wireGrowthNotifications();
  setupAutoUpdates();
}

function createWindow(port) {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1024,
    minHeight: 700,
    // macOS: a transparent backdrop lets the "under-window" vibrancy material
    // (the Liquid-Glass look) show the desktop/wallpaper through the app. On
    // win/linux we keep the opaque solid background so nothing changes there.
    backgroundColor: isMac ? '#00000000' : '#f5f6f8',
    ...(isMac
      ? {
          vibrancy: 'under-window',
          visualEffectState: 'active', // keep the material lively even when unfocused
          // Frameless native style: traffic lights overlay the app chrome and the
          // renderer provides the drag region (see .titlebar-drag in index.html).
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 16, y: 18 },
        }
      : {}),
    show: false,
    title: 'MacCleaner',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // .on, not .once: a reload (Cmd+R) re-fires did-finish-load and paths can
  // arrive at any moment (dock drop while minimized). The flush is a no-op on
  // an empty queue, so firing it after every load costs nothing.
  mainWindow.webContents.on('did-finish-load', flushPendingScans);

  // Never let the window navigate away from the local app — a compromised
  // renderer must not be able to load a remote page with the bridge attached.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) event.preventDefault();
  });

  // Any external link (e.g. future "About") opens in the real browser, not in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Parse — never prefix-match. A startsWith('http://127.0.0.1') check also
    // admits 127.0.0.10, 127.0.0.1.evil.com and every other local port; only
    // the app's own origin may open in-app (it would get the preload bridge).
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { action: 'deny' }; // unparseable → not ours, not openable
    }
    if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port === String(port)) {
      return { action: 'allow' };
    }
    // Everything else: only https reaches the OS handler — never http,
    // file:// or custom schemes (which could launch arbitrary handlers).
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showMainWindow() {
  if (!mainWindow) {
    if (running) createWindow(running.port);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Reveal the window and switch the renderer to a named view (e.g. 'fans').
 *  If the window is still loading, the request is delivered once it finishes. */
function showView(view) {
  const wasReady = mainWindow && !mainWindow.webContents.isLoading();
  showMainWindow();
  if (!mainWindow) return;
  if (wasReady) {
    mainWindow.webContents.send('treemap:navigate-view', view);
  } else {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('treemap:navigate-view', view);
    });
  }
}

/* ─────────────────────────────── Tray ─────────────────────────────── */

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true); // macOS recolors it for light/dark menu bars
  tray = new Tray(icon);
  tray.setToolTip('MacCleaner — macOS Cleaner Suite');
  tray.on('click', () => {
    // Windows/Linux convention: left-click opens the app.
    if (process.platform !== 'darwin') showMainWindow();
  });
  refreshTray();
  scheduleTrayPoll(TRAY_POLL_OK_MS);
}

/** (Re)arm the tray poll at the given cadence, replacing any existing timer.
 *  Called on startup and whenever we cross the failure threshold either way,
 *  so a recovered API snaps back to the fast 15s cadence. */
function scheduleTrayPoll(intervalMs) {
  if (intervalMs === trayIntervalMs && trayTimer) return;
  trayIntervalMs = intervalMs;
  if (trayTimer) clearInterval(trayTimer);
  trayTimer = setInterval(refreshTray, intervalMs);
  trayTimer.unref();
}

/**
 * Fetch GET /api/fans/status from the in-process server with a short timeout.
 * Reads are unprivileged and normally succeed; on any error (server not up,
 * timeout, non-200, bad JSON) it resolves to null so callers can fall back to
 * the disk-only tray. Never rejects — the tray must never be blocked by this.
 */
function fetchFanStatus() {
  return new Promise((resolve) => {
    if (!running) return resolve(null);
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    let request;
    try {
      request = net.request({
        method: 'GET',
        url: `http://127.0.0.1:${running.port}/api/fans/status`,
      });
      request.setHeader('X-MacCleaner-Token', running.token);
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => {
      try { request.abort(); } catch {}
      done(null);
    }, FAN_FETCH_TIMEOUT_MS);
    timer.unref?.();
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        response.on('data', () => {});
        response.on('end', () => {});
        clearTimeout(timer);
        return done(null);
      }
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(body);
          done(parsed && Array.isArray(parsed.fans) ? parsed : null);
        } catch {
          done(null);
        }
      });
      response.on('error', () => { clearTimeout(timer); done(null); });
    });
    request.on('error', () => { clearTimeout(timer); done(null); });
    request.end();
  });
}

/** Round a temp to a whole number; returns null for non-finite input. */
function roundTemp(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

/**
 * Build the disabled info rows shown between the disk line and Open MacCleaner.
 * Returns [] when the status is unavailable so the whole section is omitted.
 */
function fanMenuSection(status) {
  if (!status || !status.temps) return [];
  const rows = [];
  const temps = status.temps;
  const cpu = roundTemp(temps.cpuPerf);
  const gpu = roundTemp(temps.gpu);
  if (cpu !== null || gpu !== null) {
    const parts = [];
    if (cpu !== null) parts.push(`CPU ${cpu}°`);
    if (gpu !== null) parts.push(`GPU ${gpu}°`);
    rows.push({ label: parts.join(' · '), enabled: false });
  }

  const hottest = temps.hottest;
  const hot = hottest ? roundTemp(hottest.value) : null;
  if (hot !== null) {
    const key = hottest.key ? ` (${hottest.key})` : '';
    rows.push({ label: `Hottest: ${hot}°${key}`, enabled: false });
  }

  const fans = Array.isArray(status.fans) ? status.fans : [];
  if (fans.length > 0) {
    // All fans macOS-controlled (thermal mode) → collapse to a single note.
    const allThermal = fans.every((f) => f && f.mode === 'thermal');
    if (allThermal) {
      rows.push({ label: 'Fans — controlled by macOS', enabled: false });
    } else {
      for (const f of fans) {
        const label = f.label || `Fan ${(f.id ?? 0) + 1}`;
        const rpm = typeof f.actualRpm === 'number' && Number.isFinite(f.actualRpm)
          ? Math.round(f.actualRpm).toLocaleString()
          : '—';
        rows.push({ label: `${label} — ${rpm} RPM`, enabled: false });
      }
    }
  }

  if (rows.length === 0) return [];
  return [{ type: 'separator' }, ...rows, { type: 'separator' }];
}

async function refreshTray() {
  if (!tray || trayRefreshBusy) return;
  trayRefreshBusy = true;
  // try/finally: a throw mid-refresh (menu build, etc.) must not wedge the
  // guard or the tray would silently stop updating forever.
  try {
    // Disk stats: unchanged formatting; the source of truth for the title base.
    let statsLabel = 'Disk stats unavailable';
    let diskTitle = '';
    try {
      const { total, free } = await diskUsage(os.homedir());
      statsLabel = `${formatBytes(free)} free of ${formatBytes(total)} (${total > 0 ? Math.round(((total - free) / total) * 100) : 0}% used)`;
      diskTitle = ` ${formatBytes(free, 0)} free`;
    } catch (err) {
      console.error('[treemap] tray disk stats failed:', err);
    }

    // Fan/temp status: best-effort. Track failures to drive the poll backoff.
    const status = await fetchFanStatus();
    if (status) {
      fanStatus = status;
      fanFailures = 0;
      if (!fanStatusLogged) {
        console.log('[treemap] tray updater: fan/temp status live');
        fanStatusLogged = true;
      }
      scheduleTrayPoll(TRAY_POLL_OK_MS);
    } else {
      fanStatus = null;
      fanFailures += 1;
      if (fanFailures >= FAN_BACKOFF_AFTER) scheduleTrayPoll(TRAY_POLL_BACKOFF_MS);
    }

    // Title: the exact disk text as today, with " · 72°" appended when a hottest
    // temp is available. If fans are unavailable, the disk text is left untouched.
    let title = diskTitle;
    if (fanStatus && fanStatus.temps && fanStatus.temps.hottest && diskTitle) {
      const hot = roundTemp(fanStatus.temps.hottest.value);
      if (hot !== null) title = `${diskTitle} · ${hot}°`;
    }
    if (process.platform === 'darwin') tray.setTitle(title); // text next to the icon

    const menu = Menu.buildFromTemplate([
      { label: statsLabel, enabled: false },
      ...fanMenuSection(fanStatus),
      { type: 'separator' },
      { label: 'Open MacCleaner', click: showMainWindow },
      { label: 'Open Fans', click: () => showView('fans') },
      {
        label: 'Scan Home Folder',
        click: () => {
          showMainWindow();
          requestScan(os.homedir());
        },
      },
      { type: 'separator' },
      { label: 'Quit MacCleaner', click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
  } finally {
    trayRefreshBusy = false;
  }
}

/* ──────────────────────── Growth notifications ──────────────────────── */

function wireGrowthNotifications() {
  onGrowthAlert((alert) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: 'MacCleaner — folder growing fast',
      body: alert.message,
    });
    n.on('click', showMainWindow);
    n.show();
  });
}

/* ───────────────────────────── Auto-update ─────────────────────────────
   Update channel: GitHub Releases (the repo is open source). Signed builds
   get the full electron-updater flow — notification → "Download and install"
   → downloaded → "Restart to update" → quitAndInstall. Unsigned (ad-hoc)
   builds fall back to the GitHub Releases API: same notification, the click
   opens the release page for a browser download (Squirrel.Mac refuses
   unsigned updates, so a self-replace is impossible — fail closed). */

const GH_REPO = 'helloworldxdwastaken/MacCleaner';
const UPDATE_PREFS_FILE = 'updates.json';
let updateTimer = null;          // 6h check cadence
let updateDownloading = false;   // "Download and install" already clicked
let ghCheckedAt = 0;             // fallback rate-limit (1 check / 6h)

function readUpdatePrefs() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), UPDATE_PREFS_FILE), 'utf8'));
  } catch {
    return {};
  }
}
function writeUpdatePrefs(patch) {
  try {
    const file = path.join(app.getPath('userData'), UPDATE_PREFS_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...readUpdatePrefs(), ...patch }, null, 2));
  } catch {
    /* prefs are best-effort */
  }
}
function autoUpdatesEnabled() {
  return readUpdatePrefs().autoFetch !== false; // default ON
}

function semverNewer(tag, current) {
  const a = String(tag).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(current).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

function notifyUpdate(body, onClick) {
  if (!Notification.isSupported()) {
    if (onClick) onClick();
    return;
  }
  const n = new Notification({ title: 'MacCleaner — update available', body });
  n.on('click', () => {
    showMainWindow();
    if (onClick) onClick();
  });
  n.show();
}

function checkGitHubReleases() {
  // Rate-limit: one API call per 6h cadence tick.
  if (Date.now() - ghCheckedAt < 5 * 3600_000) return;
  ghCheckedAt = Date.now();
  try {
    const req = net.request({
      method: 'GET',
      host: 'api.github.com',
      path: `/repos/${GH_REPO}/releases/latest`,
      headers: { 'User-Agent': 'MacCleaner-Updater', Accept: 'application/vnd.github+json' },
    });
    req.on('response', (res) => {
      if (res.statusCode !== 200) return;
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const rel = JSON.parse(body);
          const version = String(rel.tag_name || '').replace(/^v/, '');
          if (!semverNewer(version, app.getVersion())) return;
          const url = rel.html_url || '';
          notifyUpdate(
            `Version ${version} is available — download and install from GitHub.`,
            () => { if (/^https:\/\//i.test(url)) shell.openExternal(url); }
          );
        } catch {
          /* malformed release payload — wait for the next tick */
        }
      });
    });
    req.on('error', () => {});
    req.end();
  } catch {
    /* network unavailable — next tick */
  }
}

function setupAutoUpdates() {
  if (!app.isPackaged) return; // dev runs would just error
  if (!autoUpdatesEnabled()) return; // user turned auto-fetch off in Preferences
  if (updateTimer) return; // re-entry after the toggle flips back on

  let autoUpdater = null;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    /* fall through to the GitHub-API channel */
  }

  if (autoUpdater) {
    // Signed flow: notify FIRST, download on click, restart-to-update after.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      notifyUpdate(`Version ${info.version} is available — download and install.`, () => {
        if (updateDownloading) return; // one download at a time
        updateDownloading = true;
        autoUpdater.downloadUpdate().catch(() => { updateDownloading = false; });
      });
    });
    autoUpdater.on('update-downloaded', (info) => {
      updateDownloading = false;
      notifyUpdate(`Version ${info.version} is ready — restart to update.`);
      if (updateDialogOpen) return; // already asking — never stack dialogs
      updateDialogOpen = true;
      dialog
        .showMessageBox({
          type: 'info',
          buttons: ['Restart Now', 'Later'],
          defaultId: 0,
          cancelId: 1,
          message: `MacCleaner ${info.version} is ready to install.`,
          detail: 'Restart to update — or it installs automatically the next time you quit.',
        })
        .then(({ response }) => {
          if (response === 0) autoUpdater.quitAndInstall();
        })
        .catch(() => {})
        .finally(() => {
          updateDialogOpen = false; // let the next downloaded update ask again
        });
    });
    autoUpdater.on('error', (err) => {
      // Unsigned/ad-hoc builds: Squirrel.Mac refuses the update. Switch to the
      // GitHub-Releases channel instead of dying silently.
      const msg = (err && (err.message || String(err))) || '';
      if (/sign|signature|unsigned|staging|checksum/i.test(msg)) {
        fallbackToGitHub();
        return;
      }
      console.error('[treemap] auto-update error:', msg);
    });
    autoUpdater.checkForUpdates().catch(() => fallbackToGitHub());
  } else {
    fallbackToGitHub();
  }

  updateTimer = setInterval(() => {
    if (fallbackMode) { checkGitHubReleases(); return; }
    autoUpdater.checkForUpdates().catch(() => fallbackToGitHub());
  }, 6 * 3600_000);
  updateTimer.unref();
}

let fallbackMode = false;
/** Unsigned builds: Squirrel.Mac refuses ad-hoc updates, so the update
 *  channel becomes the GitHub Releases page (browser download). */
function fallbackToGitHub() {
  if (fallbackMode) return;
  fallbackMode = true;
  checkGitHubReleases();
}

/* ───────────────────────────── App lifecycle ───────────────────────────── */

// A minimal app menu so standard shortcuts (Cmd+Q, Cmd+R, Copy/Paste) work.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        // DevTools stay a dev aid — don't advertise the shortcut in packaged
        // builds (the renderer holds no secrets, but less surface is better).
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// macOS: folder dropped onto the dock icon / "Open With" — may fire pre-ready.
app.on('open-file', (event, p) => {
  event.preventDefault();
  // Show/create the window first: without it a drop before boot (or after the
  // user closed the window) would queue the path with nothing to ever flush it.
  showMainWindow();
  requestScan(p);
});

// Single-instance lock: a second launch focuses the window and forwards its args.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    showMainWindow();
    for (const dir of scanPathsFromArgv(argv)) requestScan(dir);
  });

  app.whenReady().then(() => {
    buildMenu();
    boot()
      .then(() => {
        // Windows/Linux: a folder dragged onto the app icon arrives as an arg.
        for (const dir of scanPathsFromArgv(process.argv)) requestScan(dir);
      })
      .catch((err) => {
        console.error('[treemap] failed to start server:', err);
        app.quit();
      });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && running) {
        createWindow(running.port);
      }
    });
  });

  // The tray keeps MacCleaner alive when the window closes (scheduled scans keep
  // running); quit explicitly from the tray or app menu.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !tray) app.quit();
  });

  app.on('before-quit', () => {
    if (trayTimer) clearInterval(trayTimer);
    // Best-effort: drop any active fan boost so it never outlives the app.
    // shutdownFans() fires an `auto` at the root daemon without awaiting
    // (before-quit doesn't wait for async work); the daemon's own 10-second
    // heartbeat watchdog is the guaranteed backstop if this write is cut off.
    try {
      const { shutdownFans } = require(path.join(__dirname, '..', 'dist', 'services', 'fans.js'));
      shutdownFans();
    } catch (err) {
      console.error('[treemap] fan shutdown skipped:', err?.message || err);
    }
    if (running) running.shutdown();
  });
}

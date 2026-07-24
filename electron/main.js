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
/** Paths handed to us before the window was ready (dock drops, CLI args). */
const pendingScanPaths = [];

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
    backgroundColor: isMac ? '#00000000' : '#0a0a0d',
    ...(isMac
      ? {
          vibrancy: 'under-window',
          visualEffectState: 'active', // keep the material lively even when unfocused
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
  mainWindow.webContents.once('did-finish-load', flushPendingScans);

  // Never let the window navigate away from the local app — a compromised
  // renderer must not be able to load a remote page with the bridge attached.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) event.preventDefault();
  });

  // Any external link (e.g. future "About") opens in the real browser, not in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1')) return { action: 'allow' };
    // Only http(s) goes to the OS handler — never file:// or custom schemes.
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
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
  if (!tray) return;

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

/* ───────────────────────────── Auto-update ───────────────────────────── */

function setupAutoUpdates() {
  if (!app.isPackaged) return; // dev runs would just error
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.error('[treemap] electron-updater unavailable:', err);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    const message = `MacCleaner ${info.version} has been downloaded.`;
    dialog
      .showMessageBox({
        type: 'info',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        message,
        detail: 'Restart to apply the update — or it installs automatically the next time you quit.',
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      })
      .catch(() => {});
  });
  autoUpdater.on('error', (err) => {
    // Expected on macOS without code signing; never bother the user about it.
    console.error('[treemap] auto-update error:', err?.message || err);
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  const updateTimer = setInterval(check, 6 * 3600_000);
  updateTimer.unref();
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
        { role: 'toggleDevTools' },
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

# MacCleaner — Agent Guide

## Project overview

MacCleaner (v2.0.0, MIT, author `dronx`) is a macOS cleaner suite: Smart Scan junk cleanup,
a GrandPerspective-style squarified disk treemap, performance monitoring, maintenance
tasks, app uninstaller/updater, and SMC-based fan control. The treemap engine originates
from [TreeMap](https://github.com/Prithvi-Web/Treemap) (used with permission); MacCleaner
builds the broader cleaner suite around it.

It ships in two forms built from the same backend:

- **Web app** — a standalone Express 5 server (`src/index.ts`) serving a single-file
  frontend on `http://127.0.0.1:4280`.
- **Electron desktop app** (`electron/main.js`) — starts the same Express backend
  in-process on a random localhost port and loads it in a window; adds a tray icon,
  drag-and-drop scanning, native notifications, and electron-updater auto-updates.

## Tech stack

- **Backend:** Node.js 20+, TypeScript (strict, CommonJS, `tsc` → `dist/`), Express 5.
  Runtime dependencies are only `express` and `electron-updater`.
- **Frontend:** one zero-dependency file, `public/index.html` (~5300 lines, inline
  CSS + JS, hand-coded Canvas 2D — no React, D3, or build step).
- **Desktop:** Electron 31 (`electron/main.js` main process, `electron/preload.js`
  context-isolated bridge for drag-drop paths and scan pushes).
- **Native helper:** Swift SMC fan-control daemon in `native/fanhelper/` (see below).
- **Packaging:** electron-builder (dmg/zip for macOS, NSIS for Windows, AppImage for
  Linux) → `release/`. Config lives in the `"build"` key of `package.json`.

## Code layout

```text
src/
  index.ts      Web-server entrypoint (port 4280; PORT/HOST env override) + graceful shutdown
  server.ts     createApp()/startServer() — shared by CLI and Electron
  api/          Express routers: scan, file, system, insight, settings, cleaner,
                app, maintenance, activity, fan
  services/     diskScanner (concurrent walker), cleaner (trash/open), duplicateFinder
                (staged size→64KB→SHA-256 hashing), snapshots (Trends history),
                cleanupRules (smart suggestions), scheduler (60s setInterval recurring
                scans), apps + updater (Homebrew cask / Sparkle / MAS), maintenance,
                fans, macClean, settings, storage (app-data JSON), diskUsage, activity
  middleware/   auth (token + Host guard), pathGuard, rateLimiter, errorHandler
  models/       Shared TypeScript interfaces (types.ts)
  utils/        formatBytes, treemap (squarified layout), pathSanitizer, glob
electron/
  main.js       Desktop shell: window, tray, drag-drop, notifications, auto-update
  preload.js    Context-isolated bridge (never expose more than needed here)
public/
  index.html    The entire frontend
native/fanhelper/
  Sources/*.swift   SMC daemon (SMC.swift, FanController.swift, Daemon.swift, main.swift)
  build.sh          swiftc build → universal binary, ad-hoc signed
  install.sh / uninstall.sh / *.plist   LaunchDaemon lifecycle (run as root)
scripts/
  afterPack.js      electron-builder hook (signs the fan helper inside the .app)
  gen-tray-icon.js  Procedural tray icon generator
  render-icon.swift Rasterizes build/icon.svg → build/icon.png
build/          App icon source (icon.svg, icon.png)
dist/           tsc output (gitignored build artifact, but present locally)
release/        electron-builder output
```

## Build, run, and test commands

```bash
npm install
npm run build          # tsc → dist/
npm start              # web app at http://127.0.0.1:4280
npm run dev            # tsx watch (auto-reload) on src/index.ts
npm run typecheck      # tsc --noEmit
npm run app            # build + launch the Electron app locally
npm run build:helper   # compile the Swift fan helper (macOS, needs Xcode toolchain)
npm run dist:mac       # helper + tsc + electron-builder → release/ dmg+zip
npm run dist:win       # Windows NSIS installer (must run on Windows)
```

**There is no test suite** — no test framework, no test script, no test files.
Verification is `npm run typecheck` and manual testing of the running app
(`npm run dev` / `npm run app`). If you add tests, you are establishing a new
convention; otherwise don't add a test framework unasked.

macOS installers can only be built on macOS, Windows ones on Windows. The GitHub
Actions workflow `.github/workflows/release.yml` builds both on tag pushes (`v*`)
or manual dispatch, without code signing (`CSC_IDENTITY_AUTO_DISCOVERY: false`),
and attaches installers plus `latest*.yml` auto-update metadata to the Release.
Release process: bump `version` in `package.json`, push a matching `v*` tag.

## Architecture details that matter

- **Single source, two hosts.** All backend behavior lives behind
  `createApp(publicDir, token)` in `src/server.ts`. Electron requires the compiled
  `dist/` output — always `npm run build` before `npm run app` or packaging.
- **Per-launch API token.** Every `/api` request requires the random per-launch token
  (`X-MacCleaner-Token` header, or `?token=` query for SSE/`<img>` only). It is
  injected into the served `index.html` as `window.MACCLEANER_TOKEN` and never
  persisted. `src/middleware/auth.ts` also mounts a global `hostGuard` rejecting
  non-loopback Host headers (DNS-rebinding defense) — it must stay ahead of every
  route, including `GET /`.
- **Graceful shutdown.** SIGTERM/SIGINT drain SSE streams, cancel scans and duplicate
  hashing, stop the scheduler, then close the server (see `src/index.ts` and
  `src/server.ts` `shutdown()`). Preserve these paths when adding background work.
- **Scan lifecycle.** `startScan` in `src/services/diskScanner.ts` realpath-resolves
  roots and rejects `/` and `/System/Volumes/Data`. Completed trees are pruned to
  ~500k nodes; directories with dropped children carry `truncated: true` and must be
  treated as non-empty by aggregations. Scan results live in memory only and expire
  after 30 minutes.
- **Snapshots are automatic** — saved after every successful scan (totals + top-level
  entry sizes only, capped at 200 per folder), powering Trends with zero setup.
- **Duplicate detection is staged** (size → first 64 KB hash → full SHA-256) so large
  scans finish hashing fast; the UI refuses to trash every copy in a group.
- **Login items** come from two merged sources in `src/services/maintenance.ts`:
  System Events (classic, toggleable) and `sfltool dumpbtm` (modern BTM background
  items, read-only, `kind: 'background'`). `setLoginItemEnabled` only accepts `.app` paths.
- **Fan control.** `src/services/fans.ts` talks to the Swift helper over a unix socket
  (newline-delimited JSON: `status` / `boost` / `heartbeat` / `auto`, 10 s watchdog).
  Unprivileged reads work everywhere; boosting needs the root LaunchDaemon installed
  via `native/fanhelper/install.sh`. Boost is additive-only (raises the fan floor,
  never caps it) with a hardware-side failsafe restoring auto control. Dev overrides:
  `FANHELPER_SOCKET` (daemon side) and `MACCLEANER_FANHELPER_SOCKET` (backend side).
  See `native/fanhelper/README.md` for the full protocol and safety model.
- **App data** lives in the platform app-data folder (`~/Library/Application Support/MacCleaner`,
  `%APPDATA%\MacCleaner`, `~/.config/maccleaner`) as small JSON files. Override with
  `MACCLEANER_DATA_DIR` (legacy `TREEMAP_DATA_DIR` still honored). On first launch,
  data is migrated from the old `TreeMap` folder (`migrateLegacyDataDir` in
  `src/services/storage.ts`).

## Code style and conventions

- TypeScript strict mode; ES2022 target, CommonJS modules. Match the existing style:
  typed function signatures, doc comments on exported functions explaining *why*,
  section banners (`/* ---- ... ---- */`) in longer files.
- The frontend is ONE file. JS binds by element id — **never rename ids or `data-*`
  hooks** in `public/index.html`. Any new raw `/api` URL used by `img`/`iframe`/
  `EventSource` must carry `?token=` — only `fetch` through the `api()` helper gets
  the auth header automatically.
- Keep dependencies minimal — deliberate choices were made to avoid them (e.g. the
  scheduler is a 60-second `setInterval`, not `node-cron`). Confirm a library is
  already in `package.json` before using it; surface it if a capability is missing
  rather than silently adding a dependency.
- `storage.ts` `withFileLock` serializes read→mutate→write per file — never call
  `writeJsonFile` inside its callback (deadlock).
- Icon pipeline: edit `build/icon.svg`, rasterize with
  `swift scripts/render-icon.swift build/icon.svg 1024` → `build/icon.png`; tray glyph
  is procedural — edit `inGlyph` in `scripts/gen-tray-icon.js` and run it. In-app marks
  (sidebar, empty state, favicon) are inline SVG in `public/index.html` — keep in sync
  manually.
- `PROJECT_MEMORY.md` holds durable project facts (architecture, gotchas, a change
  log). Read it before non-trivial work and keep it current.

## Security considerations

This is a cleaner tool that deletes user files; the defensive layers below are
load-bearing — do not weaken them:

- Paths are sanitized and traversal-proofed (`src/utils/pathSanitizer.ts`); the
  blocklist is lexical and case-insensitive, and macOS symlinks need both spellings
  blocked (`/etc` + `/private/etc`, `/var/db` + `/private/var/db`). Do NOT block all of
  `/var` — `/var/folders` holds legitimate user caches.
- `DELETE /api/files` only authorizes paths inside scans with status `complete`
  (`requireInsideScanRoot` in `src/middleware/pathGuard.ts`), with parent-level
  realpath checks so symlinks can't escape the scanned tree.
- Deletes always go to the OS Trash (Finder via `osascript` on macOS, Recycle Bin via
  PowerShell on Windows, `gio` on Linux) — never hard-delete.
- Token-bucket rate limiting (10 req/s per IP) on `/api`; JSON body limit 1 MB;
  `trust proxy` is off and `x-powered-by` disabled.
- Electron lockdown: sandbox, navigation blocked, CSP, `openExternal` restricted to
  https. Keep it that way in `electron/main.js`/`preload.js`.
- Outbound network is limited to the Updater (Homebrew cask catalog, Sparkle feeds,
  MAS) and electron-updater release checks. No analytics/telemetry — don't add any.
- Builds are unsigned/ad-hoc signed (`scripts/afterPack.js`), so macOS auto-update
  silently never installs (Squirrel.Mac rejects it) — expected, fails closed.
- Never commit secrets; `PROJECT_MEMORY.md` is committed, so no keys there either.

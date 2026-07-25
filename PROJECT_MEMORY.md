# MacCleaner — Project Memory

> Durable project knowledge lives here — not in any agent's personal/global memory.
> Agents: read this before working on the project; append new durable facts via `/memo`.
> One fact per bullet, keep it terse. No secrets/keys (this file is committed).

## Architecture
- All `/api` routes require a per-launch random token (`src/middleware/auth.ts`): `X-MacCleaner-Token` header, or `?token=` query for SSE/`<img>` only. Token is injected into the served index.html as `window.MACCLEANER_TOKEN`, never persisted to disk.
- Global `hostGuard` (`src/middleware/auth.ts`) rejects missing/non-loopback Host headers (DNS-rebinding defense) — it must stay mounted ahead of every route, including `GET /` (which dispenses the token).
- `DELETE /api/files` only authorizes paths inside scans with status `complete` (`requireInsideScanRoot`, `src/middleware/pathGuard.ts`); delete targets are realpath-checked at the parent level so symlinks can't escape the scanned tree.
- Scan roots are realpath-resolved in `startScan` (`src/services/diskScanner.ts`); `/` and `/System/Volumes/Data` are rejected (`assertScanRootAllowed`).
- Completed scan trees are pruned to ~500k nodes; dirs with dropped children carry `truncated: true` and must be treated as non-empty by aggregations.

## Build / Run / Deploy
- `npm run build` (tsc) → `dist/`; standalone server: `npm start` (port 4280, `PORT`/`HOST` env override); desktop: `npm run app`.
- macOS auto-updater silently never installs: builds are ad-hoc signed (`scripts/afterPack.js`), Squirrel.Mac rejects them. Fails closed, but users are not actually auto-updated until the app is properly signed/notarized.

## Gotchas / lessons learned
- `storage.ts` `withFileLock` serializes read→mutate→write per file — never call `writeJsonFile` inside its callback (deadlock).
- Path blocklist (`src/utils/pathSanitizer.ts`) is lexical + case-insensitive; macOS symlinks need both spellings blocked (`/etc` + `/private/etc`, `/var/db` + `/private/var/db`). Do NOT block all of `/var` — `/var/folders` holds user temp/caches, a legitimate clean target.
- Login items come from TWO sources: System Events (classic "Open at Login", toggleable) and `sfltool dumpbtm` (modern BTM/SMAppService background items — Adobe CC & co., read-only, macOS owns the switch). Both are merged in `src/services/maintenance.ts` `listLoginItems`; BTM records have `kind: 'background'`. `setLoginItemEnabled` only accepts `.app` paths.
- The frontend is ONE file (`public/index.html`); JS binds by element id — never rename ids/data-* hooks. Any new raw `/api` URL (img/iframe/EventSource) must carry `?token=` — only `fetch` via `api()` gets the header automatically.
- Icon pipeline: edit `build/icon.svg`, rasterize with `swift scripts/render-icon.swift build/icon.svg 1024` → rename to `build/icon.png`; tray glyph is procedural — edit `inGlyph` in `scripts/gen-tray-icon.js` and run it. In-app marks (sidebar, empty state, favicon) are inline SVG in `public/index.html` — keep them in sync manually.

## Log
- 2026-07-24 — created. Full security audit + fixes: per-launch API token, Host guard, completed-scan deletion authorization, expanded case-insensitive blocklist, realpath checks, activity/snapshot write mutex, 500k-node tree cap, Electron lockdown (sandbox, will-navigate, CSP, openExternal https-only).
- 2026-07-25 — login-item detection now includes BTM background items (fixes missing Adobe CC); new treemap-mosaic logo (app icon, tray, sidebar, favicon); dashboard redesigned (hero strip with disk ring + facts + Smart Scan CTA); app-wide card/focus/hover polish.
- 2026-07-25 — fan control: `/api/fans/status` now reports `boostSource` ('user'|'rules'|'both'|null, computed in `src/services/fans.ts`); UI keeps Auto selected when the rules engine boosts and shows a rules banner instead of flipping to Boost. Smart Scan is now scan → review (`#fcList` checkboxes fed by `/api/cleaner/cache-plan` `entries`) → remove-ticked, with per-phase button labels.
- GOTCHA: if a packaged build "quits silently right after launch" (exit 0, empty logs, no crash report, process dies <5s), check `launchctl getenv ELECTRON_RUN_AS_NODE` — a leftover `launchctl setenv ELECTRON_RUN_AS_NODE 1` from backend debugging makes EVERY launch (incl. `open -a`) run the binary as plain Node. Fix: `launchctl unsetenv ELECTRON_RUN_AS_NODE`. Diagnose with `--version`: Node version printed = polluted env.

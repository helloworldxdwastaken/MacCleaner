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

## Log
- 2026-07-24 — created. Full security audit + fixes: per-launch API token, Host guard, completed-scan deletion authorization, expanded case-insensitive blocklist, realpath checks, activity/snapshot write mutex, 500k-node tree cap, Electron lockdown (sandbox, will-navigate, CSP, openExternal https-only).

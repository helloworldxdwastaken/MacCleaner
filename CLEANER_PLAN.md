# TreeMap → Cleaner Suite — Master Plan

> **This file is the source of truth.** Always read from here and update here.
> Status legend: ✅ designed · 🔨 building · ✔️ shipped · ⏳ pending

## 📒 Session plan — 2026-07-07 (Rebrand → MacCleaner · Fan Control · UI polish · v2 release)

**Decisions (user-confirmed):** app name **MacCleaner**; new bundle id `com.dronx.maccleaner`;
new PUBLIC repo `helloworldxdwastaken/MacCleaner`; logo = sparkle/clean-swoosh on gradient
rounded-square; "Treemap" survives ONLY as the disk-visualizer feature/view name; credit
**Prithvi-Web** for the disk treemap (README + About), MIT copyright notice retained in LICENSE.

**Workstreams (in order, Opus agents, Fable orchestrates):**
1. **Rebrand** — rename app identity everywhere (package.json, electron, UI, 5-language strings,
   docs, publish config, artifact names). Flag Electron userData path migration (TreeMap → MacCleaner).
2. **New logo** — one SVG source → icns/dock, tray (gen-tray-icon), sidebar logo, favicon, README hero.
3. **Fan control ("Fans" sidebar row)** — TG Pro style: live temps (all sensors) + fan RPMs; boost-only
   manual control + temp-rule auto-boost; root **LaunchDaemon helper** (compiled Swift/C SMC client,
   AppleSMC IOKit; F0Md/F0Tg write; failsafe: daemon restores AUTO if app heartbeat stops or on exit).
   Never below system auto minimum. One-time admin install prompt; clean uninstall path.
4. **UI polish all views** + reminder.txt items: Updater (no container chrome, "Apps" not "Other apps",
   Homebrew section last & hidden when empty), Performance disabled-login-items re-enable toggle,
   settings moved to sidebar bottom-left, language selector with rounded flag icons.
   **Sidebar spec (user, 2026-07-07):** top = new logo ONLY (same mark as app icon); live info block
   with temperature + relevant stats (fan RPM/CPU) via unprivileged sensor reads; NO disk indicator
   on the rail — disk selector/usage lives in a dropdown instead.
   **Scrap spec (user, 2026-07-07, rev b):** DELETE Compare entirely; Trends view removed but its
   chart moves INTO Dashboard; MERGE Treemap+Grid → one "Disk Map" view with layout toggle; remove
   dead "soon" rows (System Junk, Trash, Large & Old); file group = Disk Map + Duplicates.
   **Dashboard redo (user):** REAL dashboard, never "choose folder to get started" (old TreeMap
   launcher UX) — always-live disk usage, temps/fans, lifetime impact, activity, trend chart,
   quick actions. **Known UI bugs to fix:** horizontal scrolling instead of fitting; top bar weird bg.
   **Glass restyle (user):** app-wide Liquid-Glass look — Electron native vibrancy + CSS glass
   (backdrop blur, translucent surfaces), both themes. Decision: STAY Electron (no Swift rewrite
   this release; API layer keeps a future SwiftUI client possible).
5. **Methods audit** — verify every cleaning method is best-practice; apply fixes.
6. **Final audit + release** — multi-agent review, `npm run dist:mac`, publish to new repo.

## ⚠️ AS-BUILT UI reconciliation (2026-06-30) — read this before trusting older UI prose

Parts of the original UI prose below describe **intended** design that the shipped code does
**not** match. Where they conflict, **this section wins.** Verified against `public/index.html`.

- **Nav = left sidebar, NOT a mega-menu.** The "mega-menu top navigation" language in *Context &
  vision* and the tables is **superseded** (see §1's resolved decision). A fixed left rail
  (`.sidebar`, 214px wide, `border-radius:16px`, inset 14px; content offset `margin-left:242px`) is
  what ships. No mega-menu exists.
- **Logo lives at the TOP of the sidebar, not centered on the header line.** `.side-logo` sits at
  the sidebar's top (padding `18px 8px 16px`, hairline divider beneath it). The header bar has **no
  logo** — only theme/settings/Clean Up on the right. (The §"Design system" Logo paragraph already
  reflects this; just confirming it matches the build.)
- **"Smart Scan" is currently just the Fast Clean view.** The sidebar's **Smart Scan** row routes to
  `view-fastclean` (Empty Bin + clear caches). There is **no `#view-smartscan` orchestrator** yet —
  §6 and the `smartscan` view-id in the canonical list are **still PENDING**, not shipped.
- **Dashboard activity hub (§7) is BUILT** (2026-06-30). The Dashboard's right column now has a
  **"Lifetime impact"** tiles card + **"Recent activity"** feed backed by `/api/activity` +
  `activity.json`. Uninstalls, brew updates, and Fast Clean record on success. (Scan-stat tiles —
  Files/Folders/Largest — remain in the left column.) See §7.
- **Currently live sidebar rows:** Dashboard, Smart Scan (=fastclean), **Maintenance**, Uninstaller
  (apps), Updater, Treemap, Grid, Duplicates, Compare, Trends. **Disabled ("soon"):** System Junk,
  Trash, Large & Old. (System Junk + Trash are the next to build.)

## 📒 Session log — 2026-06-30 (Applications category: Uninstaller + Updater)

**What was built this session**
- **Uninstaller** (`#view-apps`, `/api/apps`, `/api/apps/leftovers`) — searchable installed-app list
  (`/Applications` + `~/Applications`, never `/System`); selecting an app finds its `~/Library`
  leftovers (matched by **bundle id** exact+prefixed **and** exact app name) across Application
  Support / Caches / Preferences / Containers / Saved State / HTTPStorages / WebKit / Logs / Cookies /
  Group Containers / LaunchAgents. Each leftover is `startScan`-registered (so the existing
  `DELETE /api/files` authorizes it — **no new delete path**) and sized inline. Per-row **Reveal in
  Finder**. Running-app detection via **`pgrep -x CFBundleExecutable`** (exact, not `pgrep -f`); a
  running app's `.app` checkbox is **disabled ("quit to remove")** so only leftovers are actionable.
- **Updater** (`#view-updater`, `/api/updater`) — Homebrew casks (see §3 Updater). v1 shipped.
- **Real app icons** — `.app/Contents/Resources/*.icns` → 64px PNG via **`sips`**, reusing
  Maintenance's shared `getAppIconPng()` (one extractor for both features), delivered **inline as
  base64 data URIs** on `/api/apps`, `/api/apps/leftovers`, `/api/updater` (avoids a per-icon request
  burst that would trip the 20-token rate limiter). Letter-tile fallback on miss.

**What changed in existing code**
- `confirmTrash`/`trashPaths` (`public/index.html`) gained optional **`sizeHint` / `labels` / `onDone`
  / `skipRescan`** so non-scan-tree tools (Uninstaller) show correct sizes/names and refresh themselves
  instead of triggering a folder rescan (R1 satisfied without mutating `state.pathIndex`).
- New files: `src/services/apps.ts`, `src/services/updater.ts`, `src/api/appRoutes.ts`; types
  `AppSummary` / `AppLeftover` / `AppLeftoversResult` / `OutdatedCask` / `BrewUpgradeResult` (all with
  an `icon` field). `appRouter` mounted in `server.ts` (alongside `maintenanceRouter`).
- **Bug fixed:** detail pane didn't clear on select — `.apps-empty{display:flex}` beat the UA
  `[hidden]` rule → pinned with `.apps-empty[hidden]{display:none}`. **a11y:** app rows use
  `aria-pressed` (not invalid `aria-selected` on `role=button`).
- **Verification:** `npm run build` clean; endpoints + both guards (reject `/System` app, reject bad
  brew token) tested live; inline JS parses; a read-only UI audit agent found no Critical/Major issues.

**What's there now (Applications):** Uninstaller fully working; Updater = Homebrew upgrades + a
classified "Other apps" group (Mac App Store / website links).

**Follow-ups requested 2026-06-30 — now DONE this session**
1. ✔️ **Activity recording (§7).** `activity.ts` + `/api/activity` + Dashboard "Lifetime impact"
   tiles + "Recent activity" feed. Uninstall / brew update / Fast Clean record on success. (See §7.)
2. ✔️ **Updater v2 — non-brew apps.** Mac App Store apps → App Store link; self-updating/unknown →
   website link (reverse-DNS bundle-id heuristic). Honest classification, no fake "update available".
   (See §3 Updater.) **Deferred:** Sparkle appcast version-checking (network, rare on this Mac).

## 📦 Status & changelog (this session)

**SHIPPED on `feature/clean-the-mac` (builds clean, verified on macOS 26):**
- **Nav → CleanMyMac-style floating sidebar** (logo at top, Dashboard + Smart Scan pinned, grouped
  tools). Removed the header "Clean Up" button. Stable scrollbar gutter; cohesive typography.
- **Smart Scan** (`view-fastclean`) — one-click **Empty Bin + clear caches**. Backend: `cleaner.ts`
  `emptyTrash()` (direct `~/.Trash` delete — Finder scripting is unreliable on macOS 26), batched
  `moveToTrash`, `canAccessTrash`, `openFullDiskAccessSettings`; `cleanerRoutes.ts`
  (`fast-clean`, `empty-trash`, `open-fda`); `macClean.ts` catalog + `CACHE_EXCLUDE`. UI: centered
  hero, light-sweep ring while cleaning, in-place green-check finished state, FDA onboarding.
- **Performance** (`view-maintenance`) — `maintenance.ts` + `maintenanceRoutes.ts`: Flush DNS,
  Rebuild Launch Services (`-r`, no removed `-kill`), **Login Items** (real app icons via `sips`
  `app-icon` endpoint, iOS toggles, **disabled apps stay listed as off**, persisted in
  `maintenance.json`, Apple services filtered). Login Items on top (scrollable) + Maintenance below.
- **Applications** (parallel effort) — Uninstaller + Updater (`apps.ts`, `appRoutes.ts`,
  `updater.ts`, views in `index.html`). Uninstall button reads **"Uninstall"**.

**NOW (live sidebar rows):** Dashboard · Smart Scan · Performance · Uninstaller · Updater · Treemap ·
Grid · Duplicates · Compare · Trends.

**PENDING (next):**
- **System Junk** — granular cache/junk catalog UI (per-item checkboxes, dev caches off by default).
- **Trash** — dedicated bin view (size + empty).
- **Large & Old Files** — client-side size/age filter over existing `/api/large-files`.
- **Smart Scan orchestrator (§6)** — current Smart Scan is just the fast-clean slice; the aggregated
  scan→review→clean across all tools is still pending.
- **Dashboard activity hub (§7)** — lifetime stats + `/api/activity` — not built.

**Known constraints:** web mode needs **Full Disk Access** (Bin) + **Automation** (login items);
the **Electron desktop build** needs a network install of the electron binary in this env.


## 🔧 Active work — Updater rework + audit fixes (planned, approved)

**Audit result:** sidebar/Smart Scan/Performance/Preferences/languages+flags/settings-gear-bottom-left/
Dashboard activity hub are all **done & working**; the TDZ crash is fixed. Remaining:
1. **Updater rework** (decision: Apps + mas + Homebrew). No container/website. Layout: **Apps** (top, each
   with an **Open** button that launches the app so it self-updates) → **Mac App Store** updates via the
   `mas` CLI if installed (real one-click) → **Homebrew** casks at the **bottom** (real `brew upgrade`).
   Backend: add `masAvailable`/`outdatedMasApps`/`upgradeMas` to `updater.ts`; `/api/updater` returns
   `{brewAvailable,casks,masAvailable,masUpdates,apps}`; add `/api/updater/mas-upgrade` + `/api/updater/open`.
2. **Smart Scan records activity** so Dashboard "Junk cleaned" isn't always 0 (`recordActivity` in `fastCleanRun`).
3. **Preferences confirmation**: toast on language/theme change + footer **Save→Done** for clearer close.
4. **Concise copy**: shorten the Uninstaller running banner → "Quit X first to remove it."


### Updater — REAL updates via Homebrew cask catalog ✔️ SHIPPED
The Updater now does genuine one-click updates, not just "Open":
- `updater.ts`: `caskCatalog()` fetches Homebrew's public cask catalog (`formulae.brew.sh/api/cask.json`,
  ~7.7k apps, cached 24h) → app-name → {token, latest version}. `appUpdates()` matches every installed
  app and tags it with an update from **cask** (most apps), **Mac App Store** (`mas`), or **Sparkle**
  (appcast). `upgradeCaskAdopt()` = `brew install --cask --adopt --force <token>` (adopts a manually-
  installed app + installs the latest).
- Route: `GET /api/updater` → `{brewAvailable, masAvailable, apps:[{name,path,icon,source,currentVersion,update}]}`;
  `POST /api/updater/cask-upgrade {token}`, `/updater/mas-upgrade {id}`, `/updater/open {path}`.
- Frontend: one Apps list; real **Update vX→vY** (primary) sorted on top, **Open**/**App Store** for the rest.
- Verified on this Mac: **6 of 22 apps** got real cask updates (Claude, Discord, Slack, Tailscale, VS Code, WhatsApp).
- Tradeoff: makes outbound requests to brew's cask API + vendor appcasts (was local-only); `brew --adopt`
  lets Homebrew take over those apps.

## Context & vision

TreeMap (by Prithvi-Web) is a disk-space **tree visualizer** — "scan a folder → see its tree →
clean within it." We (fork: `helloworldxdwastaken`, branch `feature/clean-the-mac`) are building
a **CleanMyMac-style Cleaner suite on top**, unifying the whole app under a **mega-menu**
top navigation.

**Top-bar categories** (mega-menu reveals each category's tools with icons; the menu itself does
not open a page — clicking a tool navigates to it):

| Category | Tools | Source |
|---|---|---|
| 🔍 **Smart Scan** | One-click scan + aggregated results landing | NEW (orchestrator) |
| 🧹 **Cleanup** | Fast Clean · System Junk · Trash Bins | NEW |
| ⚡ **Speed** | Optimization · Maintenance | NEW (conservative) |
| 📦 **Applications** | Uninstaller · Updater | NEW |
| 🗂️ **Files** | Treemap · Grid · Large & Old Files · Duplicates · Compare · Trends | REUSE maintainer's engine |

No **Protection** category (malware/privacy need heavy deps — out of scope).

## Design system — typography & layout (must stay cohesive)

**Fonts must be cohesive across every view — header, body, everything.** Different views must NOT use
different heading fonts/sizes (e.g. Smart Scan vs Dashboard must match). Use the app's single system
font stack everywhere (already on `body`) and one shared type scale:
- **Page/hero titles** (empty state, Smart Scan): `30px / 700 / -0.6px letter-spacing` — identical
  declarations, no view-specific variants.
- **Card headers** (`.card h2`): `12px / 600`.
- **Body/labels:** inherit the system stack; no per-view font-family or ad-hoc sizes that diverge.
When adding any new view, reuse these exact values — never introduce a one-off heading style.

**Layout:** left sidebar is a **floating rounded panel** (inset 14px, `border-radius:16px`, shadow) and
**contains the TreeMap logo at its top**; the header bar is offset to sit only over the content area
(`margin-left` = sidebar width + gaps). No top divider line. Tool screens (e.g. Smart Scan) are **open
centered heroes — no boxed card wrapper**, and **vertically centered** in the content area using the
same flex pattern as the empty state (`min-height: 66vh; justify-content: center`) — never top-aligned
with dead space below.

**Header bar:** holds only theme toggle + settings on the right. The old **"Clean Up" button was
removed** (redundant now that cleanup lives in the sidebar/Smart Scan). The legacy Clean Up modal
markup remains in the DOM but is no longer surfaced; fold its useful rules (Empty Folders, custom
rules) into the Cleaner tools later if wanted.

**Logo:** keep the **original size and spacing** — 26px mark + 16px wordmark, gap 11 — unchanged from
the old header logo. It sits at the **top of the sidebar, pushed down off the rounded container edge**
(top padding) with a **hairline divider separating it from the tabs** (clean gap between logo and the
first tool). Do not shrink or re-style it per location.

**Cross-page consistency:** the page reserves a **stable scrollbar gutter** (`overflow-y: scroll` +
`scrollbar-gutter: stable`) so the header controls and logo never shift horizontally between views
(short page vs scrolling page). Header is fixed-height (58px) and offset by the sidebar width — its
position must be identical on every view.

## UI conventions — concise copy & reactivity (apply to every view)

Long strings make the UI look cluttered and break layout at smaller widths. Keep it tight:
- **Cap user-facing copy.** Row titles short; one-line subtitles that **truncate with ellipsis**
  (`white-space:nowrap; overflow:hidden; text-overflow:ellipsis`) instead of wrapping to 2–3 lines.
- **Trim verbose status/warning text.** Example to fix: the Uninstaller running-app banner
  *"X is running — quit it first, then move it to the Trash."* → shorten to **"Quit X first to remove it."**
  Audit other long strings too (toasts, banners, descriptions) — this rule is global, not just Uninstaller.
- **No raw paths in primary rows** (already applied to Login Items): show the name; keep paths to a
  secondary/hover spot.
- Everything must reflow cleanly and stay reactive; prefer short labels + tooltips over long sentences.

## Preferences popup & Localization (PLANNED — not built yet)

> **✔️ SHIPPED (v1):** Preferences is now a tabbed modal — **General** (3-way theme Light/Dark/System + **Language** picker), **Scheduler**, **Ignore List**. i18n built with a vanilla `STRINGS` table for **en/es/ru/de/fr** + `t()` + `applyLang()` (persisted in `localStorage`, defaults to system locale). Translated chrome: sidebar nav + group headers, Preferences modal, Smart Scan title/subtitle/Clean. Untagged strings fall back to English; expand coverage by adding keys to `STRINGS` + `data-i18n`/`t()` calls. No new deps.

**Preferences = one full modal** with a **left tab rail + right content panel** (like macOS System
Settings / CleanMyMac preferences). It consolidates today's Settings modal. Recommended tabs:
- **General** — **Language** picker + **Appearance** (Light / Dark / System theme/mode). *(Per the
  user's idea: a single "General" tab holds language + theme — recommended.)*
- **Scheduler** — the existing scheduled-scans UI (moved in).
- **Ignore List** — the existing ignore-patterns UI (moved in).
- **About** — version + links (optional).
Open from the header gear; reuse the existing `glass`/modal styles; the left rail mirrors the sidebar
`.side-item` look; the right panel swaps content by selected tab.

**Localization (i18n) — vanilla, zero new deps:**
- A `STRINGS = { en:{…}, es:{…}, … }` table + a `t(key)` helper. Hydrate static markup with a
  `data-i18n="key"` pass (same pattern as the existing `data-icon` hydration); dynamic strings call `t()`.
- Persist the chosen language (server `settings.json` or `localStorage`); default to the **system
  locale**, fall back to English. Switching language re-renders visible text **without a reload**.
- Start with English + 1–2 languages (e.g. Spanish) to prove the wiring, then expand.
- The string table + `t()` live inside `public/index.html` (no dependency added).

## Non-negotiable constraints (CONTRIBUTING.md)

- **No new dependencies.** Frontend stays vanilla JS/CSS inside the single `public/index.html`.
- **All deletes go through the OS Trash** — except the one explicit, user-confirmed permanent op
  (Empty Bin).
- **Safety model unchanged:** the app may only trash paths inside a folder it actually scanned
  (`requireInsideScanRoot` → `insideAnyScanRoot`, `src/middleware/pathGuard.ts`). New cleaner
  tools therefore run a **real `startScan()`** on their target dirs so deletes flow through the
  existing `DELETE /api/files` path. **No new delete path, no widening of the guard.**
- Must pass `npm run build` (`tsc` over `src/`; `index.html` is served static, not compiled).

## Best practices (from competitor research — CleanMyMac, AppCleaner, OnyX, DaisyDisk)

These are research-backed rules the design now follows. Sources at the bottom of this section.

1. **Clear cache *contents/per-app subfolders*, never the umbrella folder.** Best practice is to
   delete individual items inside `~/Library/Caches`, **not** `~/Library/Caches` itself. Our scan-then-
   trash already targets the umbrella's *children* (per-app subfolders) and leaves the folder — keep it
   that way; the OS/app regenerates caches on next launch.
2. **Only ever touch `~/Library` (user), never `/Library` or `/System/Library`.** CleanMyMac explicitly
   refuses system paths. Our catalog is already home-dir only; `pathSanitizer` blocks system dirs.
   Reinforced as a hard rule.
3. **Maintain an exclusion allowlist (a "Safety Database" analog).** Some caches store
   *non-regenerable* data and must be excluded from auto-clean — CleanMyMac excludes **Spotify** and
   **Gradle** user caches by default. Add an `EXCLUDE` set in `macClean.ts` (Spotify offline cache,
   Gradle, and any cache whose loss = re-download pain) so System Junk/Fast Clean never auto-select them.
4. **Expensive-to-rebuild dev artifacts are shown but DEFAULT-UNCHECKED (opt-in).** CleanMyMac excludes
   **Xcode iOS DeviceSupport, Archives, module caches, simulators** from automatic cleaning because
   re-downloading device support is slow/painful. Our System Junk must render these but with their
   checkbox **off by default** + a "slow to rebuild" note. (Archives are user artifacts → never offer.)
5. **Full Disk Access (FDA) is required** to clean much of `~/Library` on modern macOS (TCC). Plan a
   **permission-onboarding step**: detect missing access (cache deletes failing EPERM), and show a
   "Grant Full Disk Access" guide (System Settings → Privacy & Security → Full Disk Access → add the
   app / the terminal running it). Handle per-path EPERM gracefully (we already collect `failed[]`).
   *(Web mode: the controlling terminal/node process needs FDA; Electron: the app bundle needs it.)*
6. **No "memory cleaner / RAM booster" — it's placebo.** On Apple Silicon "unused memory is wasted
   memory"; cleaners' gains fade and *increase* swap. Speed ships **zero** memory/purge features; at
   most a read-only memory-pressure indicator. This is why §4 is deliberately tiny.
7. **No "Shredder"/secure-delete.** `srm` and "Secure Empty Trash" were removed (Sierra);
   `diskutil secureErase` is deprecated on SSDs (wear-leveling makes overwrite unreliable). Apple's
   model is per-file encryption + key disposal (FileVault). A shredder would be security theater AND
   break the trash-only/recoverable promise → excluded; recommend FileVault instead.
8. **Uninstaller: match by bundle id AND app name AND developer/vendor name.** AppCleaner finds 95%+ of
   leftovers by searching `~/Library` (and `/Library` service files) for the app *and* developer name
   (e.g. "Adobe", "Microsoft") to catch whole suites. Add optional developer-name matching to §3.
9. **One-click but reviewable.** The market pattern (CleanMyMac Smart Scan) = scan → present safe
   defaults pre-selected, risky/permanent items unchecked → user reviews → clean. Our Smart Scan does
   exactly this (recoverable on by default; Empty Bin + expensive dev caches off by default).

*Sources: MacPaw/CleanMyMac System Junk + Safety docs, iBoysoft cache guide, AppCleaner/Nektony
uninstaller guides, Apple Discussions on srm/secureErase removal, MacPaw FDA permission docs.*

## Build sequencing

1. **Fast Clean** (Cleanup) — **FIRST shippable slice.** Empty Bin (permanent, confirmed; plain
   `empty trash`, no pref-flip) + clear `~/Library/Caches` (to Trash). Order: empty Bin → THEN trash
   caches. Build with the corrections: `sizeHint` (R1), `trashMany` AppleScript batching + trash-phase
   progress (R3), `du`-for-size + lazy `startScan`-on-clean (R6), handle 403/404 re-register (R5).
2. **Dashboard activity hub** (§7) — small, high-value, cross-cutting; wire the increment hook so
   Fast Clean already records "junk cleaned / recovered." Can land with step 1.
3. Trash tool (reuses Fast Clean's empty-trash + a bin-scan endpoint).
4. System Junk (build route + view; expanded catalog + EXCLUDE allowlist + default-unchecked dev caches).
5. Nav shell (sidebar or mega-menu per the pending decision) — lands once a 2nd tool exists.
6. Applications → Uninstaller (lazy sizing; exact-match running-app detection).
7. Files → Large & Old Files (mostly reuse).
8. Smart Scan (4 states; orchestrates the above).
9. Speed / Maintenance (smallest, safest set) — last.

---

## 1. Navigation & sidebar shell ✅ (UPDATED — left sidebar, CleanMyMac-style)

**Decision:** a persistent **left sidebar** exactly like CleanMyMac X (per the reference
screenshots), replacing the centered top `.tabbar`. Layout: a fixed-width left rail with
**Smart Scan** pinned at the top (highlighted pill), then uppercase muted **group headers** with
their tool rows (icon + label) beneath; the selected tool gets a highlighted pill. The content
area fills the rest. Groups + tools:

- **Dashboard** (pinned top — the default landing / activity hub)
- **Smart Scan** (pinned top — the one-click clean. **v1 = Empty Bin + clear caches**, formerly
  called "Fast Clean"; the view id stays `fastclean` internally. A fuller multi-tool orchestrator
  can fold in later under this same name.)
- **Cleanup** — System Junk · Trash
- **Speed** — Maintenance
- **Applications** — Uninstaller · Updater
- **Files** — Treemap · Grid · Large & Old Files · Duplicates · Compare · Trends

(No Protection group. Dashboard + Smart Scan are pinned at the very top, above the group headers —
mirroring CleanMyMac's pinned "Smart Scan".) Why sidebar over the earlier mega-menu: it's what every leading cleaner
uses, all tools are visible (discoverable + builds trust), it sidesteps the Electron title-bar
drag-region problem, and it won't read as "website chrome." Same `switchView` routing underneath.

- **Structure:** `<aside class="sidebar">` with `.side-group` blocks (a `.side-head` label + N
  `.side-item[data-view]` rows). Reuse `glass`/`--surface` tokens so it feels native. The existing
  header keeps the logo + theme/settings; the tab row moves into the sidebar.
- **Routing:** keep `switchView(name)` as the single source of truth, extended minimally:
  - Add `VIEW_CAT` map (view → category) to set `.cat-active` on the owning category.
  - Extend the `standalone` set (today just `trends`/`compare`) to include all Cleaner/Speed/
    Applications tools + `largeold` so they render without a prior treemap scan.
  - Keep the existing per-view lazy-load block; sibling tools append `if (name==='fastclean') …`.
  - Repoint the `.tabbar button` wiring (~1098–1099) to `.tool[data-view]` + `.cat[data-default-view]`.
- **Icons:** reuse the `PATHS` + `data-icon` hydration (~941–993). New SVG paths needed (minimum):
  `scan`, `broom`, `gauge`, `wrench`; reuse existing `hardDrive`/`box`/`refresh`/`clock`/`trash`/
  `copy`/`diff`/`trendUp` for the rest.
- **Non-macOS:** after `loadSystem()`, gate Cleanup/Speed/Applications groups (disable + tooltip
  "macOS only"); `switchView` guards against deep-links → falls back to a safe view + toast.
  Smart Scan + Files stay enabled on all platforms.
- **Migration safety:** all existing `.view` sections kept byte-for-byte; only their entry
  point moves from a top tab to a sidebar row. Clean Up modal untouched.
- **Integration contract (view ids):** `smartscan`, `fastclean`, `systemjunk`, `trash`, `speed`,
  `uninstaller`/`apps`, `updater`, `large` (canonical set, see Review corrections).

## 2. Cleanup category ✅

Reuses: `moveToTrash`/`run` (`src/services/cleaner.ts`), `DELETE /api/files`
(`src/api/fileRoutes.ts`), `startScan` + `GET /api/scan/:id/result`, `resolveMacCleanCategories`
(`src/services/macClean.ts`), `MacCleanCategoryResult` (`src/models/types.ts`), and frontend
`trashPaths`/`confirmTrash` + the duplicates `poll()` pattern (`public/index.html`).

### Backend
- **`emptyTrash()`** in `src/services/cleaner.ts` — `osascript -e 'tell application "Finder" to empty
  trash'`. **No path argument → no injection surface, nothing to guard against scan roots.**
  **CORRECTION (tech review R4):** do **NOT** flip `warns before emptying` — that's a *persistent
  global* Finder pref that stays disabled if the process dies mid-op. Scripted `empty trash` does not
  prompt anyway. Note the verb empties **all mounted volumes'** trashes (louder permanent warning in UI).
- New router **`src/api/cleanerRoutes.ts`** (mount in `src/server.ts` ~line 38):
  - `POST /api/cleaner/empty-trash` → `emptyTrash()`. No guards (no path input). PERMANENT.
  - `GET /api/cleaner/fast-clean` → `startScan(~/Library/Caches)`, return `{categories:[…scanId]}`.
  - `GET /api/cleaner/system-junk` → `startScan` each catalog dir, return categories + scanIds.
  - `GET /api/cleaner/trash-bin` → `startScan(~/.Trash)`, return `{path, scanId}`.
- Expand `macClean.ts` catalog (crash reports, saved app state, dev caches…), keeping subtrees
  **disjoint** (don't break out sub-paths of `~/Library/Caches` while also scanning it as umbrella).
- Add an **`EXCLUDE` allowlist** (Safety-Database analog, best-practice #3): cache subfolders that
  must never be auto-selected — e.g. `com.spotify.client`, Gradle (`~/.gradle`), and any
  non-regenerable cache. The cache-clearing step filters these out of the trash set.
- Mark **expensive-to-rebuild** categories (`iOS DeviceSupport`, `Simulator caches`, Xcode module
  caches) as `defaultChecked: false` (best-practice #4); never offer Xcode **Archives** at all.

### Frontend (`#view-cleanup` or three views `fastclean`/`systemjunk`/`trashbins`)
- Shared `pollScanSize(scanId, onSize)` helper (700ms poll, supersede-guarded). Trash a dir's
  **contents** (its `root.children` paths) in ≤500-path chunks.
- **Smart Scan (v1, SHIPPED as the `view-fastclean` view) — UI rules every tool screen follows:**
  - **Open centered hero, no card/box wrapper**, **vertically centered** (`min-height:66vh;
    justify-content:center`, same as the empty state). Layout: icon mark → title → one-line subtitle →
    small status line → big circular Clean button.
  - **One-click, no option checkboxes.** Clears caches (always) and empties the Bin (only when Full
    Disk Access is granted; otherwise the subtitle shows an inline "Grant Full Disk Access" link). The
    Bin's permanent step still requires the explicit danger confirm. Order: empty Bin → then caches.
  - **While cleaning:** a **light sweeps around the whole button ring** (conic-gradient ring; no inner
    spinner icon; button label hidden) + a **small status line *above* the button** naming the current
    step ("Emptying the Bin…", "Clearing application caches…"). **Single status — never double.**
  - **Finished state is IN PLACE (not a new screen):** the icon mark swaps to a green checkmark, the
    subtitle becomes the result ("X freed — …"), the button reads "Done"; re-enter from the sidebar to re-scan.
- **System Junk:** clone Smart Suggestions pane markup; categories with per-item checkboxes,
  select-all, reclaimable total; "Move selected to Trash" → `confirmTrash`.
- **Trash Bins:** show bin size + top items; "Empty Bin" → permanent confirm → `empty-trash`.
  v1 covers `~/.Trash` for display; Finder's verb empties all mounted trashes (documented).

### Edge cases
Bin already empty (skip confirm if 0); permission-denied caches (scanner swallows EACCES, trash
collects `failed[]`); huge cache scans (background walk + skeleton + poll); stale scanId after
30-min eviction → re-fetch `/api/cleaner/*`; **double-purge guard** = the empty-then-trash order
must never be reordered.

---

## 3. Applications category ✔️ SHIPPED (Uninstaller + Updater, 2026-06-30)

macOS-only. Same safety spine: every path to be trashed is first `startScan()`-ed so the existing
`DELETE /api/files` authorizes it. Zero deps — metadata via `execFile` to system binaries.

> **Implemented (v1).** Both tools are live (sidebar rows `apps` + `updater` enabled).
> - **Backend:** `src/services/apps.ts` (`listInstalledApps`, `findLeftovers`, exact running-app
>   detection via `pgrep -x` on `CFBundleExecutable`, scan-to-register-and-size), `src/services/updater.ts`
>   (Homebrew detect → `brew outdated --cask --greedy --json=v2` → per-cask `brew upgrade --cask`),
>   `src/api/appRoutes.ts` (`GET /api/apps`, `GET /api/apps/leftovers`, `GET /api/updater`,
>   `POST /api/updater/upgrade`). Endpoint pins targets to a **top-level `.app` directly inside
>   `/Applications` or `~/Applications`** (rejects `/System/Applications`). Mounted in `server.ts`.
> - **App icons:** real bundle icons — `.icns` → 64px PNG via `sips`, disk-cached, returned **inline as
>   base64 data URIs** on `/api/apps`, `/api/apps/leftovers`, and `/api/updater` (one request per view →
>   no per-icon fan-out, no rate-limit bursts). Letter-tile fallback on missing/failed icon.
>   (Supersedes the "icons deferred to v2" note below.)
> - **Frontend:** `#view-apps` two-pane (searchable list by name+bundle id → leftovers checklist, all
>   checked, per-row Reveal-in-Finder) and `#view-updater` (cask rows with per-app Update). Uninstall uses
>   the new `sizeHint`/`labels`/`onDone` options on `confirmTrash`/`trashPaths` so non-scan-tree paths
>   show correct sizes (R1) and refresh the tool instead of a folder rescan.
> - **Updater scope (resolved):** user chose **read-only + per-cask upgrade** (not pure DEFER). Hidden
>   when `brew` is absent. No auto-upgrade-all.

### Backend
- New **`src/services/apps.ts`**:
  - `listInstalledApps()` — scan `/Applications` + `~/Applications` only; **never `/System/Applications`**
    (Apple apps). App = top-level `*.app`. Read `Contents/Info.plist` via
    `execFile('plutil', ['-convert','json','-o','-', …])` → bundleId/name/version. Cheap size via
    `du -sk` (don't `startScan` dozens of apps on first paint). Icons deferred to v2 (letter-tile
    placeholder in UI; `iconPath: null` field reserved).
  - `findLeftovers(appPath)` — build candidate paths from **bundleId AND human name** across
    `~/Library/{Application Support, Caches, Preferences/*.plist, Containers, Saved Application State,
    HTTPStorages, Logs}` + `LaunchAgents/*<bundleId>*` (readdir prefix-match, no shell glob). Keep only
    existing paths (exact-segment/filename match, never substring-on-Library-root). `startScan` the
    bundle + each leftover; await completion (small targets) → return sizes inline.
- New **`src/api/appRoutes.ts`** (mount in `server.ts`):
  - `GET /api/apps` → `{apps}` (darwin only; `[]` elsewhere).
  - `GET /api/apps/leftovers?path=` — `guardQueryPath('path')` + assert resolved path is inside
    `/Applications`|`~/Applications` and ends `.app` (reject `/System/Applications`). Returns
    `{app, leftovers, totalSize}`.
  - Trash reuses `DELETE /api/files` (no new delete path).
- Types: `AppSummary`, `AppLeftover` in `src/models/types.ts`.

### Frontend (`apps` tab + `#view-apps`, two-pane)
Searchable app list (client-side filter like Grid) → select → leftovers checklist (all checked) →
"Move app + leftovers to Trash". **Search matches app name AND developer/vendor name** (best-practice
#8) so typing "Adobe"/"Microsoft" surfaces a whole suite's apps + leftovers at once. **Reuse detail:** before `confirmTrash(paths)`, seed
`state.pathIndex` with `{name,path,size}` stubs from the response so the confirm modal + "recovered"
toast show correct totals (pathIndex is otherwise scan-tree-only). Re-`loadApps()` after.

### Safety / edge cases
Exclude system apps at enumeration + endpoint; detect running app via `pgrep -f` → warn "Quit first",
never kill; no bundleId → name-only matching; per-path tolerance (readdir/stat skip, `moveToTrash`
collects `failed[]`); 30-min scan TTL → re-fetch leftovers (re-register) on `OUTSIDE_SCAN_ROOT`.

### Updater — ✔️ v1 + v2 SHIPPED (Homebrew + classified link-out)

**v1 — Homebrew casks (actionable).** `src/services/updater.ts` + `/api/updater`:
`brew outdated --cask --greedy --json=v2` → outdated casks (token, installed→latest, app icon via the
shared extractor). Per-cask **Update** → `POST /api/updater/upgrade {token}` → `brew upgrade --cask`
(token regex-validated, execFile no-shell). Decision (user): **read-only + per-cask upgrade**, no upgrade-all.

**v2 — *normal* apps too, grouped + linked out.** Grounded in a real scan of this Mac: **0 expose a
readable Sparkle `SUFeedURL`**, **~3 are Mac App Store**, the rest are casks or **self-updating
Electron/custom apps** (Chrome/Discord/VS Code/Claude…) that update silently on launch via their own
updater (Keystone/Squirrel/electron-updater) — **no externally invokable "update" handler exists** for
those. So the Updater never fakes "update available"; it classifies each app and links to the source:

| Mechanism | Detect (shipped) | Action (shipped) |
|---|---|---|
| **Homebrew cask** | name matches a `brew outdated` token | **Update** → `brew upgrade --cask` (real) |
| **Mac App Store** | `Contents/_MASReceipt/receipt` exists | **App Store** link → `macappstore://showUpdatesPage` (browser scheme, no backend) |
| **Self-updating / unknown** | neither of the above | **Website** link (best-effort from reverse-DNS bundle id → `https://vendor.tld`) or muted "self-updating" if none |

- **Shipped impl:** `AppSummary` gains `updateSource:'mas'|'self'` + `website` (`apps.ts`
  `websiteFromBundleId`, TLD-allowlisted). `/api/updater` → `{available, casks, others}` where
  `others = listInstalledApps() minus cask-name matches`. UI `#view-updater` renders **two groups**:
  Homebrew (actionable) then **Other apps** (App Store / Website links). Links are plain `<a>` / scheme
  URLs — **no new backend open/exec surface, no network from our app.**
- **Deferred (future):** real "update available" detection for **Sparkle** apps would need a network
  **appcast fetch** of `SUFeedURL` — rare on this machine and the one place it'd touch the network, so
  left as opt-in/best-effort for later. "Open the app to trigger its updater" was **not** added (would
  need an unguarded local-`open` endpoint; the website/App-Store links cover the need more safely).

## 4. Speed category — "Maintenance" ✔️ SHIPPED (v1)

CleanMyMac "Speed" is mostly placebo/sudo-gated on modern macOS, so we ship a **small, honest set**
of safe, no-sudo actions + user login-item control. **Spotlight reindex was dropped** (heavy
background reindex; user opted out). **No memory/RAM "boosters"** (placebo).

**Shipped actions (verified on macOS 26):**
- **Flush DNS cache** — `dscacheutil -flushcache` (unprivileged). The `killall -HUP mDNSResponder`
  reload needs root → attempted but reported as "skipped (needs privileges)", never faked.
- **Rebuild Launch Services** — `…/lsregister -r -domain local -domain user` (fixes "Open With").
  Note: `-kill` was **removed on recent macOS** ("dangerous and no longer useful") — `-r` alone works.
- **Login Items** — list the user's "Open at Login" apps via System Events osascript, with a **toggle
  to enable/disable** each. **Apple/system items are filtered out** (`/System/*`, `com.apple.*`) — only
  user apps are shown/managed. Disable = `delete login item`; enable = `make new login item {path}`.

### Backend (`src/services/maintenance.ts`, `src/api/maintenanceRoutes.ts`, mounted in `server.ts`)
- `flushDns()`, `rebuildLaunchServices()`, `listLoginItems()`, `setLoginItemEnabled(name,path,enabled)`.
  `run(cmd,args)` mirrors `cleaner.ts` (execFile, no shell); osascript strings escaped.
- Routes: `POST /api/maintenance/run {action}` (allowlisted ids → `AppError(400,'UNKNOWN_ACTION')`;
  result `{id, ok, message}`), `GET /api/maintenance/login-items` → `{items}`,
  `POST /api/maintenance/login-items {name,path,enabled}`. macOS-gated (409 `NOT_MACOS`).
- **Automation permission:** listing/toggling login items controls System Events → may need the
  one-time Automation TCC grant; denial maps to `403 AUTOMATION_DENIED` with a "Privacy & Security →
  Automation" hint (handled gracefully, not faked).

### Frontend (`view-maintenance`, card layout — sidebar label "Performance")
The sidebar tab is named **"Performance"** (view id stays `maintenance`). Two glass cards, modern
macOS-settings look, **Login Items on top, Maintenance below**:
- **Login Items** (top) — a **scrollable** list (`.mnt-scroll`, max-height) of rows: **real app icon**
  + app name + an **iOS-style toggle switch** (`.switch`); **no path shown**. Toggling calls
  `POST /api/maintenance/login-items`. **Disabling keeps the app listed as OFF** (not removed) —
  remembered server-side in `maintenance.json` and merged back as `enabled:false`.
- **Quick actions** (below) — Flush DNS / Rebuild Launch Services rows, each an **icon tile** + title +
  description + a **primary "Run" button** (matches the Dashboard's main CTA) + inline status.
- **App icons:** `GET /api/maintenance/app-icon?path=<app.app>` (path-guarded) renders the bundle's
  `.icns` → 64px PNG via `sips` (named in Info.plist, else first `.icns` in Resources); 404 →
  frontend falls back to a tinted **letter tile** (`onerror="this.remove()"`).
- Reuses `api`/`toast`/`icon`/`escapeHtml`. (Card layout — not the open-hero — is right for a
  list/settings tool. **Toggle switches & icon/avatar tiles are the standard for any future list UI.**)

## 5. Files category ✅ (pure remap — almost no new code)

The mega-menu only **re-groups** existing tabs under "Files"; `switchView` keys off `data-view`, so
every view id, endpoint, and handler is reused unchanged. **Nothing removed or broken.**

| View | Under Files | Change |
|---|---|---|
| Treemap, Grid, Duplicates, Compare, Trends | yes | none |
| Dashboard | stays app/Smart-Scan landing | none |
| Clean Up modal | **stays a modal** (cross-cutting action); optional Files entry re-opens it | none |

### NEW tool: "Large & Old Files" (`large` tab + `#view-large`)
- **No backend change.** Reuse `GET /api/large-files?scanId=&limit=1000&minSize=1` (returns
  `{name,path,size,extension,modifiedAt}`). Filter by size **and** age (`modifiedAt`) + sort
  **client-side**, exactly like `gridItems()`. (A server `olderThan` param would fight the
  size-bounded top-N collector — client-side is less code and more correct.)
- Frontend: `state.large = {items, minSize, olderDays, sort, selection:Set}`. Toolbar selects:
  Larger-than / Older-than (Any/30d/90d/180d/1y/2y) / Sort. Rows reuse Duplicates visual language +
  `formatBytes`/`formatDate`. Selection drives the shared `#selectionBar` — **generalize
  `updateSelectionBar()`** (currently hard-codes `state.grid.selection`) via a small
  `activeSelection()` helper so it serves both Grid and Large. Trash via `confirmTrash` → `trashPaths`.
  Clear selection on filter change. `switchView`: `if (name==='large' && state.scanId && state.root) loadLargeFiles();`
- **Shredder: OUT OF SCOPE** — secure overwrite both contradicts the trash-only/recoverable guarantee
  **and is obsolete** on modern macOS (`srm`/Secure Empty Trash removed; `secureErase` unreliable on
  SSDs due to wear-leveling). Apple's model is FileVault per-file encryption — recommend that instead.

## 6. Smart Scan ✅ (default Cleaner landing — orchestrator)

**No new backend aggregator** — the frontend orchestrates the sibling endpoints and sums client-side
(it needs each category's paths for `DELETE /api/files` anyway).

- **Authorization mechanic:** during the scan phase, `startScan()` each present junk category's dir
  → its completed `root.size` *is* the reclaimable total, and registering it authorizes the later
  delete. **Run the category scans sequentially** (each already uses an 8-worker pool internally;
  parallel top-level scans oversubscribe disk I/O and make progress unattributable) → clean
  "3 of 6 · Application caches" progress via one `EventSource` per category.
- **UX:** landing CTA (mirror `#emptyState`) → progress → aggregated results (one toggle row per
  category, recoverable ones on by default, 0-byte rows disabled) → sticky footer grand total +
  "Clean X GB" → result summary with per-category breakdown + failures.
- **Clean:** recoverable categories via `trashPaths(paths,{silent:true})` (chunking + `failed[]`
  handling reused). **Empty Bin is a separate, off-by-default, danger-styled checkbox** with its own
  non-recoverable confirm modal (distinct copy from the standard "you can restore" one); runs **last**,
  after recoverable moves, so the default one-click path stays 100% reversible.
- **Edge cases:** nothing-to-clean empty state; partial failures don't abort; non-macOS renders only
  what the resolver returns; 30-min TTL → detect `OUTSIDE_SCAN_ROOT` on Clean and re-scan; single-flight
  guard. `state.smart = {categories, scans, status}`.

## Cross-cutting integration notes

- **Route namespace:** standardize new cleaner endpoints under `/api/cleaner/*` (Cleanup agent),
  `/api/apps/*`, `/api/maintenance/*`. Smart Scan consumes `/api/cleaner/system-junk` for the catalog.
- **Shared pattern everywhere:** trash-anything = `startScan(target)` to register → `DELETE /api/files`.
  Surface 30-min scan-TTL expiry uniformly (re-fetch/re-register on `OUTSIDE_SCAN_ROOT`).
- **Full Disk Access onboarding (cross-cutting, best-practice #5):** without FDA, many `~/Library`
  cache/log deletes fail EPERM. Add a one-time check + a "Grant Full Disk Access" panel (deep-link to
  System Settings) shown when the Cleaner is first opened on macOS, and treat per-path EPERM as
  "skipped (needs Full Disk Access)" in results rather than a hard error.
- **New view-id contract** (nav shell depends on these): `view-fastclean`, `view-systemjunk`,
  `view-trashbins`, `view-speed` (`optimization`/`maintenance` may fold into one Speed view),
  `view-uninstaller`/`view-apps`, `view-updater`, `view-large`, `view-smartscan`.
- **One open product question:** does Smart Scan reuse `#view-dashboard` as its landing, or get its
  own `#view-smartscan`? (Nav agent leaned toward a dedicated Smart Scan view; Dashboard stays the
  post-folder-scan overview.)

---

## 7. Dashboard activity hub ✔️ v1 SHIPPED (2026-06-30)

> **Status: built & verified.** Persisted activity + Dashboard surface are live.
> - **Backend:** `src/services/activity.ts` (`getActivity`, `recordActivity`, `isActivityKind`) over
>   the shared `storage.ts` JSON pattern → `activity.json` in the app-data dir. `src/api/activityRoutes.ts`
>   (`GET /api/activity`, `POST /api/activity {kind,label?,bytes?,items?}` — kind allowlisted, numbers
>   floored ≥0). Mounted in `server.ts`. Summary = `{firstRecordedAt, totalBytesRecovered,
>   junkItemsCleaned, appsUninstalled, programsUpdated, log[≤200]}`. Counters: uninstall→appsUninstalled,
>   update→programsUpdated, else→junkItemsCleaned; bytes always sum into totalBytesRecovered.
> - **Recording hooks (record only on confirmed success):** `trashApp()` onDone
>   (`uninstall`, bytes = Σ deleted sizes, items = deleted count), `runUpgrade()` success (`update`),
>   Fast Clean finish (`fast-clean`, bytes + cache item count). Fire-and-forget `recordActivity()` JS helper.
> - **Dashboard UI:** right column now leads with a **"Lifetime impact"** card (4 tiles: Moved to Trash /
>   Junk items cleaned / Apps uninstalled / Updates applied, "since {date}") + a **"Recent activity"**
>   card (`.act-log`, last 15 events, per-kind chip/verb + relative time). `loadActivity()` runs on every
>   `switchView('dashboard')` and after each record.
> - **Pending polish (not blocking):** before/after disk-ring re-animation after a clean (§ payoff);
>   wiring System Junk / Large & Old once those tools ship.

The brief requires the Dashboard to show, beyond System + File Types, **cumulative activity**: junk
cleaned, space recovered since first use, programs uninstalled, programs updated. Currently
"recovered" exists only as an **ephemeral toast** — nothing is persisted.

- **Persistence — backend `activity.json` via the existing `src/services/storage.ts`** (the same
  dependency-free JSON pattern as `snapshots.ts`/`settings.ts`). Chosen over `localStorage` because it
  survives across browsers and matches the app's existing model. New `src/services/activity.ts`:
  `{ firstRecordedAt, totalBytesRecovered, junkItemsCleaned, appsUninstalled, programsUpdated, log: [] }`.
- **Endpoints:** `GET /api/activity` (read), `POST /api/activity` (increment a delta). The frontend
  already computes `recovered` bytes after each `trashPaths`/uninstall, so it POSTs the delta + an
  event `{kind:'fast-clean'|'system-junk'|'uninstall'|'large-old', bytes, items, label}` on success.
  `firstRecordedAt` is stamped on the first write → drives "since {date}".
- **UI (`#view-dashboard`, additive):** a top **"Lifetime impact"** row of 4 stat tiles (reuse
  `.stat-tile`/`.chip` markup): *Junk cleaned*, *Recovered since {date}*, *Apps uninstalled*,
  *Updates applied* (shows "—" until Updater ships, never a fake 0). Plus a **"Recent activity"**
  glass card: reverse-chron `.clean-item` rows (~15) — "Trashed 1.2 GB of caches · Fast Clean · 2h ago".
- **Honesty:** label it **"moved to Trash"** (provisional until the user empties the Bin), not a hard
  "recovered", to avoid overstating — except bytes that went through Empty Bin, which are final.
- **Payoff:** after a clean, re-drive the existing Dashboard **disk-ring** (`#ringFg` stroke-dashoffset)
  old%→new% as a before/after animation (DaisyDisk-style), reusing the existing count-up animator.

## Review corrections & canonical decisions (3 cold-context reviews applied)

**Canonical view-ids** (nav depends on exact strings; reconciled from earlier inconsistencies):
`dashboard`, `smartscan`, `fastclean`, `systemjunk`, `trash`, `speed`, `apps`, `large`,
`treemap`, `grid`, `duplicates`, `compare`, `trends`. (Uninstaller+Updater live in one `apps` view;
Optimization+Maintenance fold into one `speed` view.)

**Landing decision (resolved):** **Dashboard is the default landing** (has content pre-scan: system +
lifetime stats) with a prominent "Smart Scan" CTA card. **Smart Scan is a dedicated `#view-smartscan`
tool**, not the Dashboard. (Settles the §1/§6 contradiction.)

**"Reuse macClean.ts" reframed:** `macClean.ts`/`MacCleanCategoryResult` are currently **dead, unwired
scaffolding**, and the existing "Smart Suggestions" pane is a *different* folder-rules feature. So §2/§6
are **"build the route + view"**, not "reuse a UI." **Namespace:** new endpoints are `/api/cleaner/*`
— deliberately distinct from the pre-existing `/api/cleanup/suggestions` (folder rules). Documented to
avoid the `cleaner`/`cleanup` confusion.

**Technical corrections (from adversarial review):**
- **R1 (critical):** don't seed `state.pathIndex` with stubs for Applications/cleaner paths — it's
  cleared by `indexTree()`/`rescan()`. Instead add an optional **`sizeHint` map** arg to
  `confirmTrash`/`trashPaths` so non-scan-tree paths show correct sizes without mutating shared state.
- **R3 (high):** trashing a cache dir's contents can be **>500 children** → sequential `osascript`
  round-trips look frozen. Add a **`trashMany` that batches paths into one AppleScript `delete {…}`
  list**, and show **trash-phase progress** (not just scan progress).
- **R2 (high):** the rate limiter is **20-token cap / 10-per-s** (`rateLimiter.ts`). Fanning out
  scan-POST + one SSE + polls per category trips 429. **Sequence and stagger** scan kick-offs/SSE opens.
- **R6 (medium):** building a full in-memory `FileNode` tree just to size `~/Library/Caches` is heavy.
  **Size with `du -sk` for display; `startScan` lazily on "Clean"** (right before the DELETE) to
  register the root for authorization. Reconciles the Apps-uses-`du` vs cleaner-builds-trees mismatch.
- **R5 (medium):** handle **both** `OUTSIDE_SCAN_ROOT` (403, DELETE) **and** `SCAN_NOT_FOUND` (404,
  result poll) when a 30-min-evicted scan must be re-registered.
- **§3:** size apps **lazily/on-demand** (not `du -sk × N` on first paint); detect running apps by
  **exact executable/bundle-id**, not `pgrep -f` (false positives).

**UX foundations (apply across all cleaner views):**
- **Trust affordances:** "Reveal in Finder" on every cleaner row (reuse ctx-menu + `external` icon);
  success toast says **"Moved X to Trash · [Show in Finder]"**; **danger-styled** permanent-op confirm
  (red `--danger` tokens, visually distinct from the soft "you can restore" modal); real **empty
  states** per tool ("Bin already empty", "No leftovers — clean install", "No files over 100 MB").
- **Identity:** carry the signature **teal→amber→red `sizeColor()` scale** into reclaimable-size bars
  so "lots of junk" glows like big files do in the treemap.
- **Smart Scan = 4 explicit states:** idle landing → scanning (animated per-category fill + count-up
  total) → reviewable results (sticky footer total) → before/after summary.
- **Naming:** Smart Scan = the recommended one-click; **System Junk = the granular/expert pane**;
  **Fast Clean** overlaps both — keep it as the *v1 slice* but consider folding into a Smart Scan
  preset later. Label the bin tool **"Trash"** (singular); Speed → **"Maintenance"** with named action
  rows. Permanent actions grouped under a "Permanent actions" subheading.
- **Icons (per-tool):** Smart Scan `scan` · Cleanup/Fast Clean `broom`/`zap` · System Junk `broom` ·
  Trash `trash` · Speed/Maintenance `gauge`/`wrench` · Apps `box` · Updater `refresh` · Large & Old
  `clock` · Files `folder`; new SVG paths to author: `scan`, `broom`, `gauge`, `wrench`, `chevronDown`.
  **Gotcha:** `data-icon` hydration runs **once at load** over static HTML — dynamically-injected menu
  markup must call `icon()` directly.

**Navigation decision (RESOLVED — user chose left SIDEBAR, CleanMyMac-style):** see §1. A persistent
left rail with grouped tool rows; Smart Scan pinned on top. Replaces the top tab bar. This is what
every leading Mac cleaner does and what the UX review recommended.
- **Accessibility:** `<aside>` + `role="navigation"`; rows are `<button>`/`<a>` with `aria-current`
  on the active tool.
- **Native feel:** reuse the app's `glass`/`--surface`/teal-amber-red tokens; selected row = a
  highlighted pill like the existing tab `aria-selected` style.
- **macOS gating:** Cleanup/Speed/Applications group rows are disabled + "macOS only" tooltip on
  non-darwin; Smart Scan + Files always enabled.
- **Dynamic markup:** any sidebar/tool rows built in JS must call `icon()` directly (the `data-icon`
  hydration runs once at load).

## Verification (end-to-end, this Mac)

1. `npm run build` clean.
2. Restart `npm start`, reload http://127.0.0.1:4280.
3. `curl /api/cleaner/fast-clean` returns scanId; `/api/scan/<id>/result` resolves.
4. UI: mega-menu shows 5 categories; Files = all existing views unchanged; Cleanup → Fast Clean
   shows Bin + cache sizes.
5. Run Fast Clean on a low-risk state: caches land in Trash (recoverable), Bin emptied (permanent).
6. Sanity: a delete for a path outside any scanned root still 403s `OUTSIDE_SCAN_ROOT`.

## PR framing for upstream

Lead with: **"Everything you built is unchanged"** — Files contains all existing views as-is; this
adds a mega-menu layer above the nav + a Cleaner suite that reuses the existing scan + trash
pipeline with **no change to the delete-safety model.** Ship as focused PRs (Fast Clean first).

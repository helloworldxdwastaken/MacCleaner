import os from 'os';
import path from 'path';
import { promises as fsp } from 'fs';
import { execFile } from 'child_process';

/**
 * macClean — the catalog of well-known macOS junk locations behind the
 * "Clean the Mac" view.
 *
 * Every entry is:
 *  - user-owned (no sudo, lives under the home directory),
 *  - safe to clear (apps/tools regenerate it on demand), and
 *  - reversible — the frontend trashes contents through the normal
 *    DELETE /api/files path, so everything lands in the system Trash.
 *
 * Categories are deliberately non-overlapping subtrees so a folder is never
 * counted (or offered for deletion) under two categories at once.
 */

/**
 * Vendor roots — cache dirs named after the VENDOR rather than the app, whose
 * per-app cache sits one level down (~/Library/Caches/Google/Chrome,
 * /BraveSoftware/Brave-Browser), which name the browser directly under a
 * binary-style basename (~/Library/Caches/Chromium ↔ org.chromium.Chromium),
 * or which hold a whole suite's shared caches (~/Library/Caches/Adobe).
 * Unlike the safelist below they are NOT permanent excludes: they are skipped
 * only while their apps are running — the running-app guard matches their
 * own basename AND their immediate child dirs' basenames (Adobe's children
 * never fold to com.adobe.* ids, so its root is guarded through the alias
 * runs in NAME_ALIAS_RUNS below) — and they are cleared like any other cache
 * once the apps are closed.
 */
export const CACHE_VENDOR_ROOTS = new Set<string>(['Google', 'Chromium', 'BraveSoftware', 'Adobe']);

/**
 * Cache subfolder names whose contents are NOT cheaply regenerable, or which
 * hold data trashing would actually cost the user (offline content, message
 * history, license/auth tokens, Safari offline data). Clearing these is a real
 * re-download, a re-login, or data loss — so they're excluded from the fast
 * clean entirely (a "Safety Database" analog, matching how CleanMyMac keeps
 * Spotify/Gradle/messaging caches out by default). Matched case-insensitively:
 * an entry matches a `~/Library/Caches` child if the child's basename equals it
 * OR begins with it + '.' (so "com.apple.Safari" also covers
 * "com.apple.Safari.SafeBrowsing"). See cacheExcluded().
 */
export const CACHE_EXCLUDE = new Set<string>([
  // Offline media / large re-downloads
  'com.spotify.client', // Spotify offline song cache — re-downloads gigabytes
  'com.apple.bird', // iCloud Drive local cache — re-syncs from the cloud
  'com.apple.CloudDocs', // iCloud Drive sync staging — trashing it forces a multi-GB cloud re-sync
  'cloudkit', // CloudKit caches
  'com.apple.cloudkit',
  // Safari holds Reading List offline data + favicons here
  'com.apple.Safari',
  'com.apple.WebKit',
  'SafariBookmarksSyncer', // Safari bookmark sync state — trashing it risks duplicated/lost bookmarks until a full re-sync
  // Messaging apps — caches include attachments / message media
  'com.apple.messages',
  'com.apple.iChat',
  'com.tinyspeck.slackmacgap', // Slack
  'com.hnc.Discord', // Discord
  'ru.keepcoder.Telegram', // Telegram
  'org.whispersystems.signal-desktop', // Signal
  'net.whatsapp.WhatsApp', // WhatsApp
  'com.microsoft.teams', // Microsoft Teams
  'us.zoom.xos', // Zoom
  // License / token / auth caches — clearing forces a re-activation or re-login
  'com.apple.HomeKit', // not a regenerable app cache
  'com.apple.homed',
  'com.apple.identityservicesd', // iMessage/FaceTime identity
  'com.apple.accountsd',
  'com.apple.AppleAccount',
  'FamilyCircle',
  'com.adobe', // Adobe license/activation caches (prefix)
  // Group-container-scoped caches (shared app data, not throwaway)
  'Group Containers',
  // Vendor roots — conditional excludes, see CACHE_VENDOR_ROOTS above.
  ...CACHE_VENDOR_ROOTS,
]);

/**
 * True when a `~/Library/Caches` child basename should be PERMANENTLY excluded
 * from the fast clean: exact match against the safelist, or a reverse-DNS
 * prefix match (basename === entry or basename starts with entry + '.').
 * Prefix matching lets one safelist entry (e.g. "com.adobe") cover a whole
 * vendor's cache dirs without sweeping an unrelated sibling ("com.adobexyz"
 * never matches "com.adobe"). Vendor roots (CACHE_VENDOR_ROOTS) are part of
 * CACHE_EXCLUDE as a catalog/report of conditional excludes but never match
 * here — skipping them while their browser runs is buildCachePlan's job.
 */
export function cacheExcluded(basename: string): boolean {
  const b = basename.toLowerCase();
  for (const raw of CACHE_EXCLUDE) {
    // Vendor roots live in the set only as the catalog/report of conditional
    // excludes — they must never match as PERMANENT excludes here. Iteration
    // yields the stored spellings, so exact membership is sufficient.
    if (CACHE_VENDOR_ROOTS.has(raw)) continue;
    const e = raw.toLowerCase();
    if (b === e || b.startsWith(e + '.')) return true;
  }
  return false;
}

export interface MacCleanCategory {
  id: string;
  title: string;
  description: string;
  /** Absolute directory this category scans and offers to clear. */
  path: string;
}

function catalog(): MacCleanCategory[] {
  const home = os.homedir();
  const j = (...parts: string[]): string => path.join(home, ...parts);

  return [
    {
      id: 'app-caches',
      title: 'Application caches',
      description: 'Caches apps rebuild on demand — clearing them just slows the next launch a little',
      path: j('Library', 'Caches'),
    },
    {
      id: 'app-logs',
      title: 'Application logs',
      description: 'Diagnostic logs written by apps and the system',
      path: j('Library', 'Logs'),
    },
    {
      id: 'xcode-derived',
      title: 'Xcode DerivedData',
      description: 'Build intermediates Xcode regenerates on the next build',
      path: j('Library', 'Developer', 'Xcode', 'DerivedData'),
    },
    {
      id: 'ios-device-support',
      title: 'iOS DeviceSupport',
      description: 'Debug symbols cached for connected iOS devices — re-fetched when needed',
      path: j('Library', 'Developer', 'Xcode', 'iOS DeviceSupport'),
    },
    {
      id: 'simulator-caches',
      title: 'Simulator caches',
      description: 'Caches left by the iOS / iPadOS simulators',
      path: j('Library', 'Developer', 'CoreSimulator', 'Caches'),
    },
    {
      id: 'npm-cache',
      title: 'npm cache',
      description: 'Downloaded npm packages — re-fetched on the next install',
      path: j('.npm', '_cacache'),
    },
  ];
}

/* ---------- Fast-clean cache plan (safe contents-only clearing) ---------- */

function execFileP(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : stdout); // best-effort; empty on failure
    });
  });
}

/**
 * Lower-cased bundle ids of every currently-running app, via `lsappinfo list`.
 * Used to SKIP clearing the caches of apps that are open — a live app may be
 * actively reading/writing its cache, and clearing it can corrupt state or lose
 * in-flight data. Best-effort: on any failure we return an empty set (nothing
 * is treated as running), which is the same behavior as before this guard.
 */
export async function runningBundleIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  if (process.platform !== 'darwin') return ids;
  const out = await execFileP('/usr/bin/lsappinfo', ['list'], 8000);
  for (const m of out.matchAll(/bundleID="([^"]+)"/g)) ids.add(m[1].toLowerCase());
  return ids;
}

/**
 * A running bundle id. `segs` is a caller's pre-split convenience (plain
 * split('.')) — matchesRunningBundle re-derives FOLDED segments from `id`
 * (hyphens/whitespace are segment breaks, like cache-dir names), so `segs`
 * need not be pre-folded; `id` is the source of truth.
 */
export interface RunningId {
  id: string;
  segs: string[];
}

/**
 * Fold a cache-dir basename into the dot-separated token run used for
 * bundle-id matching: lower-cased, with hyphens/whitespace read as dot
 * segments, so "Brave-Browser" compares like the reverse-DNS run
 * "brave.browser".
 */
function nameRun(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[\s-]+/g, '.')
    .split('.')
    .filter(Boolean);
}

/**
 * Does one token run match a bundle id's segment list? Single tokens must END
 * the id so background updaters can't trip the guard (e.g. the vendor root
 * "Google" must not match com.google.keystone.agent); multi-token runs match
 * anywhere contiguous, which vendor-nested names require ("Brave-Browser" ↔
 * com.brave.Browser.browser, "Adobe Creative Cloud" ↔
 * com.adobe.adobe-creative-cloud).
 */
function runMatches(run: string[], segs: string[]): boolean {
  if (run.length === 0 || run.length > segs.length) return false;
  if (run.length === 1) return segs[segs.length - 1] === run[0];
  outer: for (let i = 0; i <= segs.length - run.length; i++) {
    for (let k = 0; k < run.length; k++) {
      if (segs[i + k] !== run[k]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Interactive Adobe suite apps — the token right after "com.adobe." in the
 * bundle id of an app the user actively launches. Background Adobe agents
 * (com.adobe.AdobeIPCBroker, com.adobe.acc.*, com.adobe.headlights.*,
 * com.adobe.ccd.helper) run nearly always and are deliberately NOT here: they
 * must never pin the shared ~/Library/Caches/Adobe root, or it would never be
 * clearable on an Adobe machine.
 */
const ADOBE_INTERACTIVE_APPS = [
  'photoshop',
  'aftereffects',
  'illustrator',
  'premierepro',
  'lightroom',
  'lightroomclassic',
  'audition',
  'mediaencoder',
  'indesign',
  'dreamweaver',
  'animate',
  'bridge',
  'acrobat',
  'incopy',
  'xd',
];

/**
 * Cache-dir basenames whose real-world bundle ids can't be reached by the
 * generic fold rules — each maps the lower-cased basename to EXTRA token runs,
 * each tested with the same predicates as the primary run (single token →
 * id's last segment; multi-token → contiguous anywhere). WHY per entry:
 *  - "Microsoft Edge": Edge's macOS bundle id is com.microsoft.edgemac, but
 *    the folded name run ["microsoft","edge"] is NOT a contiguous segment run
 *    of it ("edgemac" is one segment). The alias run ["microsoft","edgemac"]
 *    matches contiguously, and also matches the helper id
 *    com.microsoft.edgemac.helper.
 *  - "Adobe": the shared Adobe cache root must be skipped while the Creative
 *    Cloud desktop app or an interactive suite app is running — its children
 *    are shared component caches those apps actively use, and child dirs like
 *    "After Effects" fold to ["after","effects"], which can never be a
 *    contiguous run of com.adobe.AfterEffects.application. The 3-token run
 *    ["adobe","creative","cloud"] matches BOTH spellings of the CC desktop
 *    app (com.adobe.adobe-creative-cloud and the newer
 *    com.adobe.Creative-Cloud-Desktop-App) because it is contiguous in both,
 *    and the 2-token ["adobe",<app>] runs match com.adobe.<App>… ids.
 */
const NAME_ALIAS_RUNS: ReadonlyMap<string, string[][]> = new Map([
  ['microsoft edge', [['microsoft', 'edgemac']]],
  [
    'adobe',
    [
      ['adobe', 'creative', 'cloud'],
      ...ADOBE_INTERACTIVE_APPS.map((app) => ['adobe', app]),
    ],
  ],
]);

/**
 * Does a cache-dir basename belong to one of the currently-running bundle ids?
 * Keeps the original guard's relations (basename IS the id, or either side is
 * the other plus trailing segments — helper ids like com.foo.Bar.Helper), and
 * adds a token-run rule so binary-style names match their reverse-DNS ids,
 * which is exactly what vendor-nested caches need:
 *   "Chrome"        → com.google.Chrome          (single token = id's last segment)
 *   "Brave-Browser" → com.brave.Browser.browser  (multi-token run anywhere)
 *   "Firefox"       → org.mozilla.firefox        (same single-token rule)
 * Names listed in NAME_ALIAS_RUNS are additionally tested against their alias
 * runs, so a vendor root or display-spelled dir matches ids the fold rules
 * alone can't reach ("Microsoft Edge" → com.microsoft.edgemac; the "Adobe"
 * root → the Creative Cloud desktop app / interactive suite apps while they
 * run, never the background agents). A single token must END the id so
 * background updaters can't trip the guard; a multi-token run matches
 * anywhere contiguous, which Brave's duplicated trailing segment
 * ("…Browser.browser") requires. Exported so the match contract stays
 * verifiable (and reusable by other running-app guards).
 */
export function matchesRunningBundle(basename: string, running: RunningId[]): boolean {
  const lname = basename.toLowerCase();
  const runs = [nameRun(basename), ...(NAME_ALIAS_RUNS.get(lname) ?? [])];
  return running.some((entry) => {
    // runningBundleIds() already lower-cases ids, but normalize defensively —
    // a mixed-case caller must not silently break the string relations. The
    // run-matching segments are RE-FOLDED from the id (hyphens/whitespace
    // count as segment breaks, exactly like cache-dir names): without this,
    // a hyphenated id like com.adobe.adobe-creative-cloud keeps
    // "adobe-creative-cloud" as ONE segment and no multi-token run could
    // ever match it contiguously.
    const id = entry.id.toLowerCase();
    const segs = nameRun(id);
    if (id === lname || lname.startsWith(id + '.') || id.startsWith(lname + '.')) return true;
    return runs.some((run) => runMatches(run, segs));
  });
}

/** One cache directory and the child paths whose contents are safe to trash. */
export interface CachePlanEntry {
  /** The per-app cache root, e.g. ~/Library/Caches/com.foo.Bar (kept, not trashed). */
  dir: string;
  /** The bundle-id-ish basename of `dir`. */
  name: string;
  /** Absolute paths of `dir`'s immediate children — these are the trash targets. */
  contents: string[];
}

export interface CachePlan {
  /** The ~/Library/Caches root. */
  root: string;
  /** Cache dirs whose contents will be cleared (root dir itself is preserved). */
  entries: CachePlanEntry[];
  /** Basenames skipped because they're on the safelist. */
  excluded: string[];
  /** Basenames skipped because the owning app is currently running. */
  skippedRunning: string[];
}

/**
 * Build the fast-clean cache plan for ~/Library/Caches. For each per-app cache
 * dir that is NOT safelisted and whose app is NOT running, we return the dir's
 * immediate children as trash targets — clearing the cache *contents* while
 * leaving the cache root dir in place (so the app finds its expected dir on next
 * launch, and we never trash a whole subtree that might hold non-cache data).
 * Loose files directly under Caches are included as their own targets.
 *
 * The running-app guard matches two levels deep: the dir's own basename
 * (well-behaved apps register their cache dir AS their bundle id) AND the
 * immediate child dirs' basenames, because vendor roots like Google/Chrome
 * carry the app's name only at depth 1 — the basename "Google" can never
 * match com.google.Chrome. The Adobe vendor root is the opposite case (its
 * children — 'After Effects', 'Color', 'Fonts' — never fold to com.adobe.*
 * ids), so IT is guarded by alias runs on its own basename: skipped only
 * while the Creative Cloud desktop app or an interactive suite app runs
 * (see NAME_ALIAS_RUNS), never by the background agents that run almost
 * constantly. The guard errs generous: matching too little would trash a
 * live app's cache, matching too much only skips a clearable dir until its
 * app quits.
 *
 * The caller must still `startScan()` each returned target (or a covering root)
 * so DELETE /api/files authorizes it — this function only decides WHAT is safe
 * to clear, not the authorization.
 */
export async function buildCachePlan(): Promise<CachePlan> {
  const root = path.join(os.homedir(), 'Library', 'Caches');
  const plan: CachePlan = { root, entries: [], excluded: [], skippedRunning: [] };

  let children: import('fs').Dirent[];
  try {
    children = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return plan; // no Caches dir / unreadable
  }
  const running = await runningBundleIds();
  const runningIds: RunningId[] = [...running].map((id) => ({ id, segs: id.split('.') }));

  for (const child of children) {
    const name = child.name;
    if (name.startsWith('.')) continue;
    const full = path.join(root, name);

    if (cacheExcluded(name)) {
      plan.excluded.push(name);
      continue;
    }

    if (child.isDirectory() && !child.isSymbolicLink()) {
      // One readdir serves both the running-app guard (child-dir basenames)
      // and the trash targets (every child, files included).
      let kids: import('fs').Dirent[];
      try {
        kids = await fsp.readdir(full, { withFileTypes: true });
      } catch {
        continue; // unreadable cache dir — skip
      }
      // Guard on the dir's own basename AND its immediate child dirs (vendor
      // roots): skip if either belongs to a running app.
      const runningMatch =
        matchesRunningBundle(name, runningIds) ||
        kids.some((k) => k.isDirectory() && matchesRunningBundle(k.name, runningIds));
      if (runningMatch) {
        plan.skippedRunning.push(name);
        continue;
      }
      // Clear this cache dir's CONTENTS, keeping the dir itself.
      if (kids.length > 0) plan.entries.push({ dir: full, name, contents: kids.map((k) => path.join(full, k.name)) });
    } else {
      // Loose file (or symlink) directly under Caches — clear the file itself.
      if (matchesRunningBundle(name, runningIds)) {
        plan.skippedRunning.push(name);
        continue;
      }
      plan.entries.push({ dir: root, name, contents: [full] });
    }
  }
  return plan;
}

/** Catalog entries whose directory actually exists on this machine. */
export async function resolveMacCleanCategories(): Promise<MacCleanCategory[]> {
  const present: MacCleanCategory[] = [];
  for (const category of catalog()) {
    try {
      const stat = await fsp.stat(category.path);
      if (stat.isDirectory()) present.push(category);
    } catch {
      /* not installed on this machine — skip silently */
    }
  }
  return present;
}

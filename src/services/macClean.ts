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
  'cloudkit', // CloudKit caches
  'com.apple.cloudkit',
  // Safari holds Reading List offline data + favicons here
  'com.apple.Safari',
  'com.apple.WebKit',
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
]);

/**
 * True when a `~/Library/Caches` child basename should be excluded from the
 * fast clean: exact match against the safelist, or a reverse-DNS prefix match
 * (basename === entry or basename starts with entry + '.'). Prefix matching lets
 * one safelist entry (e.g. "com.adobe") cover a whole vendor's cache dirs
 * without sweeping an unrelated sibling ("com.adobexyz" never matches "com.adobe").
 */
export function cacheExcluded(basename: string): boolean {
  const b = basename.toLowerCase();
  for (const raw of CACHE_EXCLUDE) {
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

  for (const child of children) {
    const name = child.name;
    if (name.startsWith('.')) continue;
    const full = path.join(root, name);

    if (cacheExcluded(name)) {
      plan.excluded.push(name);
      continue;
    }
    // The cache dir's basename is the app's bundle id for well-behaved apps.
    // Skip if that app is running (exact id or a child id under its prefix).
    const lname = name.toLowerCase();
    const isRunning = [...running].some((id) => id === lname || lname.startsWith(id + '.') || id.startsWith(lname + '.'));
    if (isRunning) {
      plan.skippedRunning.push(name);
      continue;
    }

    if (!child.isDirectory()) {
      // A loose file directly under Caches — clear the file itself.
      plan.entries.push({ dir: root, name, contents: [full] });
      continue;
    }
    // Clear this cache dir's CONTENTS, keeping the dir itself.
    let grand: string[];
    try {
      grand = (await fsp.readdir(full)).map((g) => path.join(full, g));
    } catch {
      continue; // unreadable cache dir — skip
    }
    if (grand.length > 0) plan.entries.push({ dir: full, name, contents: grand });
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

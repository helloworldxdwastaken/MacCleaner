import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { recordActivity } from './activity';
import { isAppRunning } from './apps';

/**
 * privacy — backing data for the Privacy & Security screen.
 *
 * Full Disk Access (FDA) is probed passively: listing a TCC-protected
 * directory (~/Library/Safari) fails with EPERM/EACCES when the app lacks the
 * grant, while an absent probe directory proves nothing either way (reported
 * as unknown). We never read file contents, and a readdir does not trigger a
 * consent prompt, so the check is side-effect free.
 *
 * Browser cache sizes are computed by a capped walk (node + time budget) so a
 * huge cache can't stall the request. Cleaning itself does NOT happen here —
 * it reuses the standard scan → DELETE /api/files pipeline (see privacyRoutes),
 * keeping the Trash-only, pathGuard-authorized safety model untouched.
 */

/* ---- Full Disk Access probe ---- */

/** Well-known TCC-protected directory: readable only with FDA granted. */
const FDA_PROBE_DIR = ['Library', 'Safari'];

export interface PrivacyStatus {
  platform: string;
  /**
   * True when the app can read TCC-protected directories, false when TCC
   * blocks the probe, null when the probe is inconclusive (probe dir absent —
   * no denial observed, but access is not proven either).
   */
  fullDiskAccess: boolean | null;
  /** The directory used for the probe (for diagnostics). */
  probePath: string;
}

/**
 * Probe Full Disk Access by listing a protected directory (no prompt, no read).
 * EPERM/EACCES → TCC block (false); ENOENT → probe dir absent, which proves
 * nothing either way (null); a successful readdir → granted (true).
 */
export async function fullDiskAccessStatus(): Promise<PrivacyStatus> {
  const probePath = path.join(os.homedir(), ...FDA_PROBE_DIR);
  let granted: boolean | null = true;
  try {
    await fs.promises.readdir(probePath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    granted = code === 'ENOENT' ? null : false;
  }
  return { platform: process.platform, fullDiskAccess: granted, probePath };
}

/* ---- Browser cache catalog ---- */

interface BrowserCacheDef {
  id: string;
  name: string;
  /** Path relative to ~/Library/Caches (empty segments for space-prefixed names). */
  rel: string[];
  /** Bundle/app name for the "is it running?" guard. */
  app: string | null;
  /** Reading this cache requires Full Disk Access. */
  needsFda: boolean;
}

const BROWSERS: BrowserCacheDef[] = [
  { id: 'chrome', name: 'Google Chrome', rel: ['Google', 'Chrome'], app: 'Google Chrome', needsFda: false },
  { id: 'edge', name: 'Microsoft Edge', rel: ['Microsoft Edge'], app: 'Microsoft Edge', needsFda: false },
  { id: 'brave', name: 'Brave', rel: ['BraveSoftware'], app: 'Brave Browser', needsFda: false },
  { id: 'firefox', name: 'Firefox', rel: ['Firefox'], app: 'firefox', needsFda: false },
  { id: 'arc', name: 'Arc', rel: ['Arc'], app: 'Arc', needsFda: false },
  { id: 'chromium', name: 'Chromium', rel: ['Chromium'], app: 'Chromium', needsFda: false },
  // `app: 'Safari'` puts Safari under the same isAppRunning guard as the other
  // browsers (pgrep -x matches the Safari process name) — its cache is just as
  // hot while the browser runs, FDA or not.
  { id: 'safari', name: 'Safari', rel: ['com.apple.Safari'], app: 'Safari', needsFda: true },
];

export interface BrowserCacheItem {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  sizeBytes: number;
  /** True when the size walk hit its node/time budget — sizeBytes is a floor ("≥"). */
  truncated: boolean;
  /** True when the browser is running — the UI must block cleaning it. */
  running: boolean;
  /** Readable only with Full Disk Access. */
  needsFda: boolean;
  /** Access failed (TCC) — size unknown unless FDA is granted. */
  accessDenied: boolean;
}

/** Caps so a monster cache can't dominate the request: walk budget per browser. */
const WALK_NODE_CAP = 120_000;
const WALK_TIME_MS = 5000;

/** Result of the capped size walk. */
interface DirSize {
  bytes: number;
  /** True when the walk stopped on its node/time budget — bytes is a lower bound. */
  truncated: boolean;
}

/**
 * Sum file sizes under `root` with a bounded, iterative walk (no recursion;
 * sizes only, never file contents). Stops early on the caps and reports it,
 * so the UI can present the total as "≥" instead of pretending it is exact.
 */
async function dirSizeCapped(root: string): Promise<DirSize> {
  let total = 0;
  let nodes = 0;
  let truncated = false;
  const deadline = Date.now() + WALK_TIME_MS;
  const stack: string[] = [root];
  while (stack.length > 0) {
    if (nodes >= WALK_NODE_CAP || Date.now() > deadline) {
      truncated = true; // budget exhausted — what we counted is a floor
      break;
    }
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable subtree — skip it, keep counting the rest
    }
    nodes += entries.length;
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += (await fs.promises.stat(p)).size;
        } catch {
          /* vanished mid-walk — ignore */
        }
      }
    }
  }
  return { bytes: total, truncated };
}

/** 60s cache: sizes change constantly and the walk is not free. */
let cacheListCache: { at: number; items: BrowserCacheItem[] } | null = null;
const LIST_CACHE_MS = 60_000;

/** List known browser caches with live sizes and running-app guards. */
export async function browserCaches(): Promise<BrowserCacheItem[]> {
  if (cacheListCache && Date.now() - cacheListCache.at < LIST_CACHE_MS) return cacheListCache.items;
  const cachesRoot = path.join(os.homedir(), 'Library', 'Caches');
  const items = await Promise.all(BROWSERS.map((b) => buildItem(b, path.join(cachesRoot, ...b.rel))));
  cacheListCache = { at: Date.now(), items };
  return items;
}

async function buildItem(b: BrowserCacheDef, full: string): Promise<BrowserCacheItem> {
  const item: BrowserCacheItem = {
    id: b.id,
    name: b.name,
    path: full,
    exists: false,
    sizeBytes: 0,
    truncated: false,
    running: false,
    needsFda: b.needsFda,
    accessDenied: false,
  };
  try {
    await fs.promises.readdir(full);
    item.exists = true;
    const sized = await dirSizeCapped(full);
    item.sizeBytes = sized.bytes;
    item.truncated = sized.truncated;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') item.accessDenied = true;
    else if (code === 'ENOENT') item.exists = false;
  }
  if (b.app) {
    try {
      item.running = await isAppRunning(b.app);
    } catch {
      item.running = false;
    }
  }
  return item;
}

/**
 * Fresh "is this browser running?" probe by catalog id — deliberately NOT the
 * 60s-cached `running` flag from browserCaches(), which can be stale right
 * when it matters (a browser launched after the list was cached).
 */
export async function isBrowserRunning(id: string): Promise<boolean> {
  const def = BROWSERS.find((b) => b.id === id);
  if (!def?.app) return false;
  try {
    return await isAppRunning(def.app);
  } catch {
    return false;
  }
}

/** Display name for a catalog browser id, or null when the id is unknown. */
export function browserName(id: string): string | null {
  return BROWSERS.find((b) => b.id === id)?.name ?? null;
}

/** Invalidate the browser-cache listing cache (call after a clean). */
export function invalidateBrowserCacheList(): void {
  cacheListCache = null;
}

/** Record a completed browser-cache clean in the activity feed. */
export async function recordBrowserCacheClean(bytes: number, browserName: string): Promise<void> {
  await recordActivity({ kind: 'system-junk', label: `${browserName} cache`, bytes, items: 1 });
}

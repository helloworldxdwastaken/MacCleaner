import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { startScan } from './diskScanner';
import { getAppIconPng } from './maintenance';
import { AppSummary, AppLeftover, AppLeftoversResult } from '../models/types';

/**
 * apps — the macOS "Uninstaller". Lists installed applications and finds the
 * support files an app leaves behind under ~/Library (AppCleaner-style).
 *
 * Safety spine (unchanged): nothing here deletes. The route trashes through the
 * normal `DELETE /api/files` path, which is authorized by `requireInsideScanRoot`.
 * To make that authorization hold, `findLeftovers` runs a real `startScan()` on
 * the app bundle and every candidate leftover before returning — registering each
 * path as a scan root. That same scan also yields the sizes shown in the UI.
 *
 * Only user-space app folders are ever touched: /Applications and ~/Applications.
 * /System/Applications (Apple's built-ins) is never enumerated or accepted.
 */

interface ExecResult {
  stdout: string;
  stderr: string;
}

function execFileP(cmd: string, args: string[], timeoutMs = 15000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          (err as NodeJS.ErrnoException & ExecResult).stdout = stdout;
          (err as NodeJS.ErrnoException & ExecResult).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      }
    );
  });
}

/** The only two directories we treat as app sources (never /System/Applications). */
export function appRoots(): string[] {
  return ['/Applications', path.join(os.homedir(), 'Applications')];
}

/** Run an async mapper over items with a bounded number of concurrent workers. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The app icon as a base64 PNG data URI, or null if none/unconvertible.
 * Reuses Maintenance's `getAppIconPng` (the single shared .icns→PNG extractor)
 * so both features stay consistent; we deliver it inline (not via a per-icon
 * endpoint) to avoid a request burst when listing dozens of apps at once.
 */
export async function appIconDataUri(appPath: string): Promise<string | null> {
  try {
    const png = await getAppIconPng(appPath);
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null; // no icon, non-macOS, or sips failed — fall back to a letter tile
  }
}

/**
 * readAppMeta results cached for the process lifetime, keyed by path and
 * invalidated by the bundle's mtime. Each uncached read spawns plutil PLUS the
 * .icns→PNG extractor — a 100-app listing costs ~200 child processes, and
 * installed bundles change rarely, so caching takes most listings and panel
 * refreshes from memory. Mtime (not TTL) keys invalidation: a changed bundle
 * is picked up immediately, and process lifetime bounds the map.
 */
const appMetaCache = new Map<string, { mtimeMs: number; meta: AppSummary }>();

/** Read an app bundle's Info.plist into an AppSummary (best-effort, with icon). */
async function readAppMeta(appPath: string): Promise<AppSummary> {
  let mtimeMs = -1;
  try {
    mtimeMs = (await fsp.stat(appPath)).mtimeMs;
  } catch {
    /* vanished since listing — fall through; the uncached read degrades anyway */
  }
  const hit = appMetaCache.get(appPath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.meta;
  const meta = await readAppMetaUncached(appPath);
  appMetaCache.set(appPath, { mtimeMs, meta });
  return meta;
}

/** Uncached readAppMeta body — plutil parse + MAS receipt probe + icon. */
async function readAppMetaUncached(appPath: string): Promise<AppSummary> {
  const base = path.basename(appPath).replace(/\.app$/i, '');
  let info: Record<string, unknown> = {};
  try {
    // plutil converts binary or XML plists to JSON we can parse without a dep.
    const { stdout } = await execFileP(
      'plutil',
      ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')],
      8000
    );
    info = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    /* missing/unreadable plist — fall back to the filename */
  }
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v : null;

  const bundleId = str(info.CFBundleIdentifier);
  // Mac App Store apps carry a receipt; everything else self-updates / unknown.
  const masReceipt = path.join(appPath, 'Contents', '_MASReceipt', 'receipt');
  const isMas = await fsp
    .access(masReceipt)
    .then(() => true)
    .catch(() => false);

  return {
    name: base,
    path: appPath,
    bundleId,
    version: str(info.CFBundleShortVersionString) ?? str(info.CFBundleVersion),
    executable: str(info.CFBundleExecutable),
    icon: await appIconDataUri(appPath),
    updateSource: isMas ? 'mas' : 'self',
    website: websiteFromBundleId(bundleId),
  };
}

/** Best-effort vendor website from a reverse-DNS bundle id (com.google.Chrome → https://google.com). */
function websiteFromBundleId(bundleId: string | null): string | null {
  if (!bundleId) return null;
  const parts = bundleId.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  const TLDS = new Set(['com', 'org', 'net', 'io', 'co', 'app', 'dev', 'me', 'ai']);
  const tld = parts[0].toLowerCase();
  if (!TLDS.has(tld)) return null;
  const domain = parts[1].toLowerCase();
  if (!domain || domain === 'apple') return null; // Apple bundles have no useful vendor page
  return `https://${domain}.${tld}`;
}

/** List installed apps. macOS only; cheap (no per-app sizing on this path). */
export async function listInstalledApps(): Promise<AppSummary[]> {
  if (process.platform !== 'darwin') return [];

  const seen = new Set<string>();
  const bundles: string[] = [];
  for (const dir of appRoots()) {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue; // ~/Applications often doesn't exist — skip silently
    }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.app')) continue;
      if (name.startsWith('.')) continue; // hidden helper bundles — Finder hides these
      const full = path.join(dir, name);
      if (seen.has(full)) continue;
      seen.add(full);
      bundles.push(full);
    }
  }

  const apps = await mapPool(bundles, 8, readAppMeta);
  apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return apps;
}

/** True when a process whose name exactly equals `executable` is running. */
export async function isAppRunning(executable: string | null): Promise<boolean> {
  if (!executable) return false;
  try {
    // pgrep -x matches the process name exactly (no false positives from
    // substrings, unlike `pgrep -f`). Exit 0 = at least one match.
    await execFileP('pgrep', ['-x', executable], 5000);
    return true;
  } catch {
    return false; // exit 1 (no match) or pgrep missing
  }
}

interface Candidate {
  path: string;
  category: string;
  /**
   * true = matched by app NAME only (not by bundle id), so the path could
   * belong to an unrelated app that shares the name. Surfaced to the UI as an
   * `uncertain` flag on the returned leftover object (the flag is added at the
   * object level — AppLeftover in models/types.ts is shared, so the field is
   * documented here instead of declared in the interface).
   */
  nameOnly?: boolean;
}

/**
 * Vendor name hints for vendor-named support directories: Homebrew-style
 * nesting like `~/Library/Application Support/Google/Chrome` puts the vendor
 * ("Google") one level above the app's own folder. Derived from the bundle
 * id's second reverse-DNS segment (com.google.Chrome → "google") and the first
 * word of the display name ("Google Chrome" → "google"), lowercased.
 */
function vendorHints(bundleId: string | null, displayName: string): string[] {
  const hints = new Set<string>();
  if (bundleId) {
    const seg = bundleId.split('.')[1];
    if (seg) hints.add(seg.toLowerCase());
  }
  const first = displayName.split(/[\s.]+/)[0];
  if (first) hints.add(first.toLowerCase());
  return [...hints];
}

/**
 * Build the list of ~/Library leftover paths for an app, matched by bundle id
 * (exact + prefixed) and by exact app name. Only existing paths are returned.
 */
async function collectLeftovers(
  bundleId: string | null,
  displayName: string,
  fileBase: string
): Promise<Candidate[]> {
  const home = os.homedir();
  const L = (...p: string[]): string => path.join(home, 'Library', ...p);

  const names = new Set<string>();
  for (const n of [displayName, fileBase]) if (n) names.add(n.toLowerCase());

  const out: Candidate[] = [];

  const pushIfExists = async (full: string, category: string): Promise<void> => {
    try {
      await fsp.lstat(full);
      out.push({ path: full, category });
    } catch {
      /* not present */
    }
  };

  const matchInDir = async (
    dir: string,
    category: string,
    pred: (name: string) => boolean,
    extra?: Partial<Candidate>
  ): Promise<void> => {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (pred(name)) out.push({ path: path.join(dir, name), category, ...extra });
    }
  };

  // Exact bundle-id-named items (no readdir needed).
  if (bundleId) {
    await pushIfExists(L('Application Support', bundleId), 'Application Support');
    await pushIfExists(L('Caches', bundleId), 'Caches');
    await pushIfExists(L('Preferences', `${bundleId}.plist`), 'Preferences');
    await pushIfExists(L('Containers', bundleId), 'Containers');
    await pushIfExists(L('Saved Application State', `${bundleId}.savedState`), 'Saved State');
    await pushIfExists(L('HTTPStorages', bundleId), 'HTTPStorages');
    await pushIfExists(L('HTTPStorages', `${bundleId}.binarycookies`), 'HTTPStorages');
    await pushIfExists(L('WebKit', bundleId), 'WebKit');
    await pushIfExists(L('Logs', bundleId), 'Logs');
    await pushIfExists(L('Cookies', `${bundleId}.binarycookies`), 'Cookies');
  }

  // Prefix + boundary matches that need a directory listing. Boundary matching
  // means "com.foo.bar" matches "com.foo.bar" and "com.foo.bar.*", but NEVER
  // "com.foo.barbaz" — a plain substring/includes test would over-match and
  // could sweep a sibling app's data (the audit's #6 concern).
  const lowerId = bundleId ? bundleId.toLowerCase() : null;
  // True when `name` equals the id or is the id followed by a separator we treat
  // as a boundary (dot for reverse-DNS, or the group-container "group." style).
  const idBoundaryMatch = (name: string): boolean => {
    if (lowerId === null) return false;
    const n = name.toLowerCase();
    if (n === lowerId) return true;
    // Next char after the id must be a boundary, not a continuation of a token.
    if (n.startsWith(lowerId)) {
      const next = n.charAt(lowerId.length);
      return next === '.' || next === '-' || next === '_';
    }
    // Group Containers are often "<teamid>.com.foo.bar" — allow the id as a
    // dot-bounded suffix too (…".com.foo.bar" or a trailing ".com.foo.bar.*").
    return n.endsWith('.' + lowerId) || n.includes('.' + lowerId + '.');
  };
  await matchInDir(L('Preferences'), 'Preferences', (n) => {
    const l = n.toLowerCase();
    return lowerId !== null && l.startsWith(lowerId + '.') && l.endsWith('.plist');
  });
  await matchInDir(L('Preferences', 'ByHost'), 'Preferences', (n) =>
    lowerId !== null ? n.toLowerCase().startsWith(lowerId + '.') : false
  );
  await matchInDir(L('LaunchAgents'), 'LaunchAgents', (n) => {
    const l = n.toLowerCase();
    return l.endsWith('.plist') && idBoundaryMatch(l.replace(/\.plist$/, ''));
  });
  await matchInDir(L('Group Containers'), 'Group Containers', (n) => idBoundaryMatch(n));

  // Name-matched folders (some apps name support dirs by their human name).
  // Name-only matching can't tell two vendors' same-named apps apart, so every
  // top-level name hit is flagged `nameOnly` → surfaced as `uncertain` to the
  // UI. One exception (vendor-prefix confirmation): a hit one level BELOW a
  // directory named after the app's vendor (`…/Application Support/Google/Chrome`
  // for Google Chrome) is confirmed by the vendor path prefix and reported as
  // a certain match. KNOWN MISS (documented in the result's `notes`): nesting
  // deeper than one vendor level, or a renamed child (e.g. `…/Google/Drive`
  // for "Google Drive"), is not matched.
  const hints = vendorHints(bundleId, displayName);
  for (const dir of ['Application Support', 'Caches', 'Logs']) {
    await matchInDir(L(dir), dir, (n) => names.has(n.toLowerCase()), { nameOnly: true });
    // Vendor-named dir: confirm matches one level inside it.
    let vendorEntries: string[];
    try {
      vendorEntries = await fsp.readdir(L(dir));
    } catch {
      continue;
    }
    for (const entry of vendorEntries) {
      if (!hints.includes(entry.toLowerCase()) || entry.startsWith('.')) continue;
      const nested = path.join(L(dir), entry);
      let inner: string[];
      try {
        inner = await fsp.readdir(nested);
      } catch {
        continue; // file, or unreadable dir — nothing to match inside
      }
      for (const n of inner) {
        if (names.has(n.toLowerCase())) out.push({ path: path.join(nested, n), category: dir });
      }
    }
  }

  // Dedupe — a path can match more than one rule.
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)));
}

/** Register a path as a scan root and return its size once the scan settles. */
async function registerAndSize(target: string): Promise<number> {
  let scan;
  try {
    // Internal utility scans (sizing + delete authorization for the uninstall
    // flow) must NOT write Trends snapshots — they probe arbitrary support
    // directories the user never asked to track, which would pollute Trends
    // history with noise.
    scan = await startScan(target, { snapshot: false });
  } catch {
    return 0; // vanished between discovery and scan — not offered for delete
  }
  const deadline = Date.now() + 45000; // generous cap for large bundles
  while (scan.status === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 60));
  }
  return scan.root ? scan.root.size : 0;
}

/**
 * Analyze one app: read its metadata, find leftovers, register every path for
 * deletion authorization, and return sizes inline.
 */
export async function findLeftovers(appPath: string): Promise<AppLeftoversResult> {
  const meta = await readAppMeta(appPath);
  const fileBase = path.basename(appPath).replace(/\.app$/i, '');
  const running = await isAppRunning(meta.executable);

  const candidates = await collectLeftovers(meta.bundleId, meta.name, fileBase);

  // Register + size the bundle and each leftover. DELETE /api/files only
  // authorizes COMPLETED scans, so registerAndSize awaits each scan settling
  // (and gives us accurate sizes in the same pass).
  const targets = [appPath, ...candidates.map((c) => c.path)];
  const sizes = await Promise.all(targets.map(registerAndSize));

  const appSize = sizes[0];
  // `uncertain` is added at the object level (AppLeftover in models/types.ts is
  // shared): name-only matches could belong to an unrelated same-named app, so
  // the UI must ask before treating them as this app's data. Bundle-id and
  // vendor-prefix-confirmed matches stay flag-free = certain.
  const leftovers: AppLeftover[] = candidates.map((c, i) => {
    const item: AppLeftover & { uncertain?: boolean } = {
      name: path.basename(c.path),
      path: c.path,
      category: c.category,
      size: sizes[i + 1],
    };
    if (c.nameOnly) item.uncertain = true;
    return item;
  });
  const totalSize = sizes.reduce((s, v) => s + v, 0);

  const result: AppLeftoversResult = {
    app: {
      name: meta.name,
      path: appPath,
      bundleId: meta.bundleId,
      version: meta.version,
      icon: meta.icon,
      size: appSize,
      running,
    },
    leftovers,
    totalSize,
    warning: running
      ? `${meta.name} is running. Quit it before uninstalling — trashing a live app's files can corrupt its state.`
      : undefined,
  };

  // `notes` is likewise added at the object level (not declared on
  // AppLeftoversResult). It documents the matcher's coverage caveats so the UI
  // can show exactly what this analysis can and cannot see.
  const notes = [
    candidates.some((c) => c.nameOnly)
      ? 'Items marked "uncertain" were matched by app name only — verify each path belongs to this app before deleting.'
      : null,
    'Matching covers top-level ~/Library folders plus one level inside a directory named after the app\'s vendor (e.g. "Google" for Google Chrome); deeper or renamed nesting (e.g. "Google/Drive" for "Google Drive") can be missed.',
  ]
    .filter((s): s is string => s !== null)
    .join(' ');
  const withNotes = { ...result, notes };
  return withNotes;
}

import { execFile } from 'child_process';
import { promises as fsp, constants as fsConstants } from 'fs';
import path from 'path';
import { appRoots, appIconDataUri, listInstalledApps, isAppRunning } from './apps';
import { BrewUpgradeResult, MasUpdate, AppUpdate, AppUpdateInfo, AppSummary } from '../models/types';
import { AppError } from '../middleware/errorHandler';

/**
 * updater — the macOS "Updater". A deliberately small, honest panel built on
 * Homebrew + the App Store (the two update mechanisms we can query without
 * bundling per-vendor network catalogs). If `brew`/`mas` isn't installed the
 * corresponding part of the feature reports unavailable; we never fabricate
 * update data.
 *
 * Read path:  the Homebrew cask catalog (formulae.brew.sh, fetched + cached
 *             24h) matched against installed apps, `mas outdated` for App
 *             Store apps, and each app's own Sparkle appcast. `brew outdated`
 *             is NOT used: it only sees casks Homebrew already owns, while the
 *             catalog also detects updates for manually-installed apps. Casks
 *             marked `version :latest` (vendor self-updates) are skipped —
 *             offering them is noise/false "updates" we can't action.
 * Write path: `brew install --cask --force <token>` / `mas upgrade <id>`,
 *             each explicitly user-triggered and guarded (see
 *             upgradeCaskAdopt / upgradeMas). The /api/updater response
 *             carries `degraded` + `degradedReasons` so "no updates" is
 *             distinguishable from "couldn't check" (see appUpdates).
 *
 * No new dependency: `brew` is the user's own tool, invoked via execFile (argv
 * array, no shell) so a token can never be interpreted as shell syntax.
 */

interface ExecResult {
  stdout: string;
  stderr: string;
}

function execFileP(cmd: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
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

const BREW_CANDIDATES = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];

/* ---------- brew write serialization ----------
 * brew holds one global lock; two concurrent installs/upgrades race it and one
 * fails (or interleaves stage dirs). Chain every brew WRITE through this
 * promise queue so they run one at a time, in request order — concurrent
 * requests simply wait their turn. `brewWritesInFlight` counts queued + running
 * writes so the Terminal handoff (which runs brew OUTSIDE this process, where
 * the queue has no reach) can refuse instead of starting over a live write. */
let brewChain: Promise<unknown> = Promise.resolve();
let brewWritesInFlight = 0;

function withBrewLock<T>(fn: () => Promise<T>): Promise<T> {
  brewWritesInFlight++;
  const run = brewChain.then(fn);
  // Never let a failure poison the queue — the next caller still runs.
  brewChain = run.then(
    () => {
      brewWritesInFlight--;
    },
    () => {
      brewWritesInFlight--;
    }
  );
  return run;
}

// Cache the resolved brew path (or null) for the process lifetime.
let cachedBrew: string | null | undefined;

async function brewPath(): Promise<string | null> {
  if (cachedBrew !== undefined) return cachedBrew;
  if (process.platform !== 'darwin') {
    cachedBrew = null;
    return null;
  }
  for (const candidate of BREW_CANDIDATES) {
    try {
      await fsp.access(candidate, fsConstants.X_OK);
      cachedBrew = candidate;
      return candidate;
    } catch {
      /* not here — try the next */
    }
  }
  try {
    const { stdout } = await execFileP('/usr/bin/which', ['brew'], 4000);
    const resolved = stdout.trim();
    if (resolved) {
      cachedBrew = resolved;
      return resolved;
    }
  } catch {
    /* not on PATH */
  }
  cachedBrew = null;
  return null;
}

export async function brewAvailable(): Promise<boolean> {
  return (await brewPath()) !== null;
}

/** Collapse a name/token to alphanumerics for fuzzy app↔cask matching. */
function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Best-effort: find the installed .app a cask token corresponds to, for its icon. */
async function caskIcon(token: string): Promise<string | null> {
  const norm = normalizeToken(token);
  for (const dir of appRoots()) {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.app') || name.startsWith('.')) continue;
      if (normalizeToken(name.replace(/\.app$/i, '')) === norm) {
        return appIconDataUri(path.join(dir, name));
      }
    }
  }
  return null;
}

/** Last non-empty line of a multi-line string (brew's most relevant message). */
function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

/* ---------- Mac App Store (optional, via the `mas` CLI) ---------- */

const MAS_CANDIDATES = ['/opt/homebrew/bin/mas', '/usr/local/bin/mas'];
let cachedMas: string | null | undefined;

async function masPath(): Promise<string | null> {
  if (cachedMas !== undefined) return cachedMas;
  if (process.platform !== 'darwin') {
    cachedMas = null;
    return null;
  }
  for (const candidate of MAS_CANDIDATES) {
    try {
      await fsp.access(candidate, fsConstants.X_OK);
      cachedMas = candidate;
      return candidate;
    } catch {
      /* try next */
    }
  }
  try {
    const { stdout } = await execFileP('/usr/bin/which', ['mas'], 4000);
    const resolved = stdout.trim();
    if (resolved) {
      cachedMas = resolved;
      return resolved;
    }
  } catch {
    /* not on PATH */
  }
  cachedMas = null;
  return null;
}

export async function masAvailable(): Promise<boolean> {
  return (await masPath()) !== null;
}

/** Read-honesty result of `mas outdated`: `failed` = the mas command itself
 *  errored; `unparsed` = non-empty output lines that didn't match the expected
 *  "<id> <name> (<cur> -> <latest>)" shape. Both let appUpdates() distinguish
 *  "no App Store updates" from "couldn't check the App Store". */
interface MasOutdatedResult {
  updates: MasUpdate[];
  unparsed: number;
  failed: boolean;
}

/** `mas outdated` → one MasUpdate per line `<id> <name> (<cur> -> <latest>)`,
 *  with parse/command failures reported instead of silently swallowed. */
export async function outdatedMasApps(): Promise<MasOutdatedResult> {
  const mas = await masPath();
  if (!mas) return { updates: [], unparsed: 0, failed: false };
  let stdout = '';
  let failed = false;
  try {
    ({ stdout } = await execFileP(mas, ['outdated'], 60000));
  } catch (err) {
    failed = true;
    stdout = (err as ExecResult).stdout || '';
  }
  const out: MasUpdate[] = [];
  let unparsed = 0;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*(\d+)\s+(.+?)\s+\((.+?)\s*->\s*(.+?)\)\s*$/);
    if (!m) {
      unparsed++; // counted, not dropped — a format change must not read as "no updates"
      continue;
    }
    const name = m[2].trim();
    out.push({
      id: m[1],
      name,
      installedVersion: m[3].trim(),
      latestVersion: m[4].trim(),
      icon: await caskIcon(name), // matches the installed .app by name
    });
  }
  return { updates: out, unparsed, failed };
}

/** `mas info <id>` → the app's bundle id when mas exposes one. The `mas
 *  outdated` listing doesn't carry it, and output formats vary across mas
 *  versions, so parse leniently. Null when unavailable — callers fall back to
 *  name matching (see upgradeMas's guard). */
async function masBundleId(mas: string, id: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(mas, ['info', id], 10000);
    const m = stdout.match(/^\s*Bundle\s*Id:\s*(\S+)\s*$/im);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function upgradeMas(id: string): Promise<BrewUpgradeResult> {
  const mas = await masPath();
  if (!mas) return { ok: false, token: id, message: 'mas is not installed' };
  if (!/^\d+$/.test(id)) return { ok: false, token: id, message: 'Invalid App Store id' };
  // Same running-app guard as the cask path: `mas upgrade` swaps the .app in
  // place, which breaks (or silently corrupts state of) a running app.
  const hit = (await outdatedMasApps()).updates.find((m) => m.id === id);
  if (hit) {
    // Locate the installed app behind the outdated id — by bundle id when mas
    // exposes one (`mas info`), else by name. If it can't be located at all we
    // can't run the running-app guard, so fail closed instead of upgrading
    // blind (an unidentified target may be mid-run).
    const apps = await listInstalledApps();
    const bundleId = await masBundleId(mas, id);
    const app =
      (bundleId && apps.find((a) => (a.bundleId ?? '').toLowerCase() === bundleId)) ||
      apps.find((a) => normalizeToken(a.name) === normalizeToken(hit.name));
    if (!app) {
      throw new AppError(
        409,
        'UNKNOWN_TARGET',
        `Installed app for App Store id ${id} could not be located — update it from the App Store app instead.`
      );
    }
    if (await isAppRunning(app.executable)) {
      throw new AppError(409, 'APP_RUNNING', `Quit ${app.name} first, then run the update again.`);
    }
  }
  try {
    const { stdout } = await execFileP(mas, ['upgrade', id], 10 * 60 * 1000);
    return { ok: true, token: id, message: lastLine(stdout) || 'Updated' };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & ExecResult;
    return { ok: false, token: id, message: lastLine(e.stderr || '') || (e.message || 'upgrade failed').trim() };
  }
}

/** Launch a .app so it runs its own updater (Sparkle/built-in). Caller validates the path. */
export async function openApp(appPath: string): Promise<void> {
  await execFileP('/usr/bin/open', [appPath], 10000);
}

/* ---------- Sparkle update detection (read each app's appcast feed) ----------
 * Most non-App-Store macOS apps use Sparkle: their Info.plist has an `SUFeedURL`
 * pointing to an appcast (RSS/XML) that lists the latest version + download. We
 * read that feed and compare its newest `sparkle:version` (= CFBundleVersion) to
 * the installed build to detect a real available update — exactly how MacUpdater /
 * Latest detect updates. Applying is left to the app's own updater (launch it).
 * NOTE: this makes outbound HTTPS requests to each vendor's own appcast server.   */

interface PlistInfo { feedURL: string | null; build: string | null; shortVersion: string | null; }

async function readPlistInfo(appPath: string): Promise<PlistInfo> {
  try {
    const { stdout } = await execFileP(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')],
      5000
    );
    const j = JSON.parse(stdout) as Record<string, unknown>;
    const feed = typeof j.SUFeedURL === 'string' ? j.SUFeedURL : null;
    return {
      feedURL: feed && /^https?:\/\//i.test(feed) ? feed : null,
      build: j.CFBundleVersion != null ? String(j.CFBundleVersion) : null,
      shortVersion: j.CFBundleShortVersionString != null ? String(j.CFBundleShortVersionString) : null,
    };
  } catch {
    return { feedURL: null, build: null, shortVersion: null };
  }
}

/**
 * Compare dotted version strings. Numeric segments compare numerically; when the
 * numeric parts tie, a version carrying a pre-release/channel suffix
 * (e.g. "-beta", "rc", "alpha", " (build 5)") sorts BELOW the same version with
 * none — standard semver precedence. This stops a beta appcast whose newest item
 * is "2.0.0-beta" from being advertised as an update over an installed "2.0.0",
 * and prevents same-version items from ever counting as an update.
 */
function cmpVersion(a: string, b: string): number {
  const PRERELEASE = /(alpha|beta|rc|dev|pre|nightly|canary|eap|snapshot|preview)/i;
  // Detect a pre-release BEFORE stripping numbers — matches "-beta", "beta1",
  // "rc2", " (beta)", etc. A bare "b<n>"/"a<n>" only counts as pre-release when
  // it directly abuts the version core (e.g. "2.0.0b1"), never a standalone word.
  const hasPrerelease = (s: string): boolean =>
    PRERELEASE.test(s) || /\d[ab]\d/i.test(s);
  // Take only the numeric CORE — everything up to the first pre-release marker —
  // so "2.0.0-beta1" and "2.0.0b1" both reduce to [2,0,0], not [2,0,0,1].
  const core = (s: string): string => {
    const str = String(s);
    const m = str.match(PRERELEASE);
    let cut = m && m.index !== undefined ? m.index : str.length;
    const ab = str.match(/\d([ab])\d/i);
    if (ab && ab.index !== undefined) cut = Math.min(cut, ab.index + 1);
    return str.slice(0, cut);
  };
  const nums = (s: string): number[] => core(s).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pa = nums(a);
  const pb = nums(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  // Numeric cores equal → the one with a pre-release suffix is the lower one.
  const preA = hasPrerelease(a);
  const preB = hasPrerelease(b);
  if (preA && !preB) return -1;
  if (!preA && preB) return 1;
  return 0;
}

// Current macOS product version (e.g. "26.3"), resolved once per process. Used
// to drop appcast items whose sparkle:minimumSystemVersion the OS can't satisfy.
let cachedOsVersion: string | null | undefined;
async function currentOsVersion(): Promise<string | null> {
  if (cachedOsVersion !== undefined) return cachedOsVersion;
  if (process.platform !== 'darwin') {
    cachedOsVersion = null;
    return null;
  }
  try {
    const { stdout } = await execFileP('/usr/bin/sw_vers', ['-productVersion'], 4000);
    cachedOsVersion = stdout.trim() || null;
  } catch {
    cachedOsVersion = null;
  }
  return cachedOsVersion;
}

/**
 * Newest RUNNABLE item in a Sparkle appcast (by sparkle:version). Items whose
 * `sparkle:minimumSystemVersion` exceeds the current macOS are skipped, so we
 * never advertise an update the OS can't install. When `osVersion` is null
 * (couldn't determine) the filter is a no-op — we don't hide real updates on a
 * best-effort miss.
 */
function parseAppcastLatest(xml: string, osVersion: string | null): { build: string; short: string | null } | null {
  const grab = (s: string, attr: RegExp, el: RegExp): string | null => {
    const m = s.match(attr) || s.match(el);
    return m ? m[1].trim() : null;
  };
  const items = xml.split(/<item[\s>]/i).slice(1);
  let best: { build: string; short: string | null } | null = null;
  for (const it of items) {
    const build = grab(it, /sparkle:version="([^"]+)"/i, /<sparkle:version>([^<]+)<\/sparkle:version>/i);
    if (!build) continue;
    // Respect minimumSystemVersion — skip items this Mac's OS is too old to run.
    const minOs = grab(
      it,
      /sparkle:minimumSystemVersion="([^"]+)"/i,
      /<sparkle:minimumSystemVersion>([^<]+)<\/sparkle:minimumSystemVersion>/i
    );
    if (osVersion && minOs && cmpVersion(minOs, osVersion) > 0) continue; // OS too old
    const short = grab(
      it,
      /sparkle:shortVersionString="([^"]+)"/i,
      /<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/i
    );
    if (!best || cmpVersion(build, best.build) > 0) best = { build, short };
  }
  return best;
}

// Appcast fetches are cached 5 min — BOTH successes and failures (a dead feed
// shouldn't be re-polled on every panel refresh either). Each uncached panel
// refresh would otherwise fire an outbound HTTPS request to every Sparkle
// app's vendor server; vendor feeds are third-party, keep the traffic rare.
const APPCAST_TTL = 5 * 60 * 1000;
const APPCAST_CACHE_MAX = 512;
const appcastCache = new Map<string, { at: number; xml: string | null }>();

async function fetchAppcast(url: string): Promise<string | null> {
  const hit = appcastCache.get(url);
  if (hit && Date.now() - hit.at < APPCAST_TTL) return hit.xml;
  let xml: string | null = null;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'MacCleaner-Updater', Accept: 'application/rss+xml, application/xml, text/xml' },
    });
    if (res.ok) xml = await res.text();
  } catch {
    /* network hiccup — cached as null so a dead feed isn't re-polled either */
  }
  if (appcastCache.size >= APPCAST_CACHE_MAX) {
    // Bound memory: drop expired entries first; if an install somehow exceeds
    // 512 live feeds, a wholesale clear is fine (they just refetch).
    const now = Date.now();
    for (const [k, v] of appcastCache) if (now - v.at >= APPCAST_TTL) appcastCache.delete(k);
    if (appcastCache.size >= APPCAST_CACHE_MAX) appcastCache.clear();
  }
  appcastCache.set(url, { at: Date.now(), xml });
  return xml;
}

/* ---------- Homebrew cask catalog (real updates for most apps) ----------
 * Homebrew's cask database (~7.7k apps) is a curated app → latest-version map.
 * We fetch it (cached 24h), match installed apps by name, and update via
 * `brew install --cask --force <token>` — which installs the latest build over
 * the existing app (`--adopt` is deliberately not used — see
 * upgradeCaskAdopt). Real one-click updates for most mainstream apps, no
 * per-vendor logic. Failures are NOT cached for the full day — see
 * CASK_CATALOG_FAILURE_TTL.                                     */

interface CaskInfo {
  token: string;
  version: string;
  /**
   * Bundle ids the cask declares (from `uninstall`/`zap` quit/launchctl/pkgutil
   * keys and Preferences/Caches paths). Used to CONFIRM a name-based match maps
   * to the same vendor before we ever offer to overwrite the user's app.
   */
  bundleIds: string[];
}

/** Cask catalog read result. `failed` = the fetch didn't succeed this cycle —
 *  callers surface it as `degraded` so "no cask updates" isn't mistaken for
 *  "couldn't check the catalog". */
interface CaskCatalogResult {
  map: Map<string, CaskInfo>;
  failed: boolean;
}

let caskCatalogCache: { at: number; result: CaskCatalogResult } | null = null;
const CASK_CATALOG_TTL = 24 * 60 * 60 * 1000;
/** A FAILED fetch is remembered only briefly — the old code cached the empty
 *  map for a full day, so one transient network error suppressed every cask
 *  update for 24 hours without any signal. */
const CASK_CATALOG_FAILURE_TTL = 5 * 60 * 1000;

/** A plausible reverse-DNS bundle id (com.vendor.App, at least 3 segments). */
function looksLikeBundleId(s: string): boolean {
  return /^[A-Za-z0-9]+(\.[A-Za-z0-9-]+){2,}$/.test(s);
}

/** Pull candidate bundle ids out of a cask's artifacts (uninstall/zap blocks). */
function bundleIdsFromArtifacts(artifacts: Array<Record<string, unknown>>): string[] {
  const ids = new Set<string>();
  const addId = (v: unknown): void => {
    if (typeof v === 'string' && looksLikeBundleId(v)) ids.add(v.toLowerCase());
  };
  const addFrom = (block: unknown): void => {
    if (!block || typeof block !== 'object') return;
    const b = block as Record<string, unknown>;
    // Direct id-bearing keys.
    for (const key of ['quit', 'launchctl', 'signal']) addId(b[key]);
    const pk = b.pkgutil;
    if (Array.isArray(pk)) pk.forEach(addId);
    else addId(pk);
    // trash paths like ~/Library/Preferences/com.vendor.App.plist reveal the id.
    const trash = b.trash;
    const paths = Array.isArray(trash) ? trash : typeof trash === 'string' ? [trash] : [];
    for (const p of paths) {
      if (typeof p !== 'string') continue;
      const m = p.match(/\/(?:Preferences|Caches|HTTPStorages|WebKit|Containers)\/([A-Za-z0-9][A-Za-z0-9.\-]+?)(?:\.plist|\.binarycookies|\/|$)/);
      if (m && looksLikeBundleId(m[1])) ids.add(m[1].toLowerCase());
    }
  };
  for (const art of artifacts) {
    for (const key of ['uninstall', 'zap']) {
      const list = (art as Record<string, unknown>)[key];
      if (Array.isArray(list)) list.forEach(addFrom);
    }
  }
  return [...ids];
}

async function caskCatalog(): Promise<CaskCatalogResult> {
  if (caskCatalogCache) {
    const ttl = caskCatalogCache.result.failed ? CASK_CATALOG_FAILURE_TTL : CASK_CATALOG_TTL;
    if (Date.now() - caskCatalogCache.at < ttl) return caskCatalogCache.result;
  }
  const map = new Map<string, CaskInfo>();
  let failed = true;
  try {
    const res = await fetch('https://formulae.brew.sh/api/cask.json', {
      signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': 'MacCleaner-Updater' },
    });
    if (res.ok) {
      const casks = (await res.json()) as Array<{
        token?: string;
        version?: string;
        name?: string[];
        artifacts?: Array<Record<string, unknown>>;
      }>;
      for (const c of casks) {
        if (!c.token || !c.version || c.version === 'latest') continue;
        const info: CaskInfo = {
          token: c.token,
          version: String(c.version).split(',')[0].trim(),
          bundleIds: bundleIdsFromArtifacts(c.artifacts || []),
        };
        for (const art of c.artifacts || []) {
          const appList = (art as { app?: unknown }).app;
          if (!Array.isArray(appList)) continue;
          for (const an of appList) {
            const nm = typeof an === 'string' ? an : Array.isArray(an) && typeof an[0] === 'string' ? an[0] : null;
            if (nm && nm.toLowerCase().endsWith('.app')) map.set(normalizeToken(nm.replace(/\.app$/i, '')), info);
          }
        }
        for (const nm of c.name || []) {
          if (typeof nm === 'string') {
            const k = normalizeToken(nm);
            if (!map.has(k)) map.set(k, info);
          }
        }
      }
      failed = false;
    }
  } catch {
    /* offline / blocked — no cask matches this run, reported as degraded */
  }
  const result: CaskCatalogResult = { map, failed };
  caskCatalogCache = { at: Date.now(), result };
  return result;
}

/**
 * Resolve a cask token back to the installed app it was matched to — the
 * reverse of the name→cask lookup appUpdates() makes when it builds the offer.
 * Needed so the apply path can run pre/post checks on the actual bundle.
 */
async function installedAppForCask(token: string): Promise<AppSummary | null> {
  const [apps, catalog] = await Promise.all([listInstalledApps(), caskCatalog()]);
  const names = new Set<string>();
  for (const [key, info] of catalog.map) if (info.token === token) names.add(key);
  if (names.size === 0) return null;
  return apps.find((a) => names.has(normalizeToken(a.name))) ?? null;
}

/** Fail-closed resolution of the installed app behind a cask token. A null
 *  match used to silently skip every downstream guard and let an unchecked
 *  `brew install --cask --force` run — that command overwrites whatever
 *  Homebrew thinks the token maps to, so no target = no write. */
async function resolveCaskApp(token: string): Promise<AppSummary> {
  const app = await installedAppForCask(token);
  if (!app) {
    // Distinguish "nothing matches" from "we couldn't check": a failed catalog
    // fetch caches empty for 5 min, and the honest error points at that.
    const catalog = caskCatalogCache?.result;
    const degraded = catalog?.failed;
    throw new AppError(
      409,
      'UNKNOWN_TARGET',
      degraded
        ? `The cask catalog is unavailable right now, so "${token}" can't be verified against an installed app — refusing to run an unchecked force-install. Try again in a few minutes.`
        : `No installed app matches the cask "${token}" — refusing to run an unchecked force-install. Update it via brew directly instead.`
    );
  }
  return app;
}

/** The guards that make a cask force-install safe. Re-run immediately before
 *  exec (inside the brew lock) so they hold at exec time, not just request time. */
async function guardCaskTarget(app: AppSummary): Promise<void> {
  if (!app.path.startsWith('/Applications/')) {
    throw new AppError(
      409,
      'APP_OUTSIDE_APPLICATIONS',
      `${app.name} is in ${path.dirname(app.path)}, but Homebrew installs into /Applications — a cask update would install a duplicate next to the old copy. Move the app to /Applications first.`
    );
  }
  if (await isAppRunning(app.executable)) {
    throw new AppError(409, 'APP_RUNNING', `Quit ${app.name} first, then run the update again.`);
  }
}

/**
 * Post-update verification. brew exiting 0 is not proof the app was actually
 * replaced (permission-locked bundles can survive a "successful" install), so
 * the bundle at `app.path` is re-read after the install. Hard-fail when the
 * .app is missing from /Applications or its version didn't move to the cask's
 * version; codesign failures only log a warning — several mainstream casks
 * ship known signature quirks and still run fine, so we don't fail the update
 * over them.
 *
 * The already-resolved `app` is passed in by the caller (it was resolved and
 * guarded before exec) instead of re-running the installed-app discovery here.
 */
async function verifyCaskInstall(
  token: string,
  app: AppSummary,
  previousVersion: string | null
): Promise<string | null> {
  // The bundle must still exist at the guarded path after brew's run.
  const stillThere = await fsp.stat(app.path).catch(() => null);
  if (!stillThere || !app.path.startsWith('/Applications/')) {
    return 'The update reported success, but the app could not be found in /Applications afterwards — the install may not have completed.';
  }
  const info = await readPlistInfo(app.path);
  const installed = info.shortVersion || info.build;
  let expected: string | null = null;
  for (const c of (await caskCatalog()).map.values()) {
    if (c.token === token) {
      expected = c.version;
      break;
    }
  }
  if (installed) {
    // An unchanged version used to hard-fail unconditionally — wrong for
    // build-suffixed cask versions (cask "19.0.0-54779", bundle short version
    // "19.0.0": the build number moves, the short version doesn't, and the
    // install DID succeed). So "still the same version" is a failure only when
    // the catalog gives no expected version to compare against; otherwise the
    // cmpVersion check below decides.
    if (previousVersion && installed === previousVersion && !expected) {
      return `Update incomplete: ${app.name} is still version ${installed}. Try updating again, or finish in Terminal.`;
    }
    if (expected) {
      // The bundle only exposes the marketing version, so strip a trailing
      // numeric build suffix from the cask's version before the "older than
      // expected" comparison — otherwise an installed "19.0.0" reads as older
      // than cask "19.0.0-54779" and a successful install is misreported as
      // incomplete. Word suffixes (beta/rc/…) are NOT stripped: cmpVersion
      // already ranks those below the plain release, which is the right
      // direction for "is the installed build behind?".
      const expectedCore = expected.replace(/-v?\d+$/, '');
      if (cmpVersion(installed, expectedCore) < 0) {
        return `Update incomplete: ${app.name} is version ${installed}, expected ${expected}. Try updating again, or finish in Terminal.`;
      }
    }
  } else {
    console.warn(`[updater] could not read a version from ${app.path} after update — skipping the version check`);
  }
  try {
    await execFileP('/usr/bin/codesign', ['--verify', '--deep', app.path], 60000);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & ExecResult;
    console.warn(`[updater] codesign --verify failed for ${app.path}:`, lastLine(e.stderr || '') || e.message);
  }
  return null;
}

/** `brew install --cask --force <token>` — install the latest over the existing
 *  app (works whether or not brew installed it; `--force` overwrites). `--adopt`
 *  can't be combined with `--force`, and we want the newest version anyway.
 *
 *  Guards (the reasons apps used to break after updating through here):
 *   - the app must NOT be running — replacing a live bundle corrupts its state;
 *   - the app must live in /Applications — brew always installs there, so
 *     "updating" a ~/Applications app would leave the old copy and drop a
 *     duplicate into /Applications.
 *  After brew succeeds, the install is verified (bundle present, version moved,
 *  codesign advisory). */
export async function upgradeCaskAdopt(token: string): Promise<BrewUpgradeResult> {
  const brew = await brewPath();
  if (!brew) return { ok: false, token, message: 'Homebrew is not installed' };

  // Resolve + guard BEFORE taking the lock, so a bad request fails fast
  // without queueing behind other brew writes...
  const app = await resolveCaskApp(token);
  await guardCaskTarget(app);

  try {
    let fresh: AppSummary = app;
    const { stdout } = await withBrewLock(async () => {
      // ...then re-resolve + re-guard INSIDE the lock, immediately before
      // exec: another request can quit/move/uninstall the app while we waited
      // on the brew chain, and the guards must hold at exec time, not just
      // request time.
      fresh = await resolveCaskApp(token);
      await guardCaskTarget(fresh);
      return execFileP(brew, ['install', '--cask', '--force', token], 10 * 60 * 1000);
    });
    const problem = await verifyCaskInstall(token, fresh, fresh.version);
    if (problem) return { ok: false, token, message: problem };
    return { ok: true, token, message: lastLine(stdout) || 'Updated' };
  } catch (err) {
    // Our guards throw AppError — those are deliberate 409 responses, not
    // "upgrade failed" results; let them surface untouched.
    if (err instanceof AppError) throw err;
    const e = err as NodeJS.ErrnoException & ExecResult;
    const detail = (e.stderr || '') + (e.stdout || '');
    // pkg/system casks need an admin password, and replacing a permission-locked
    // or root-owned bundle needs elevated rights — neither is possible from the
    // background server. Both are finished interactively in Terminal instead.
    // Deliberately narrow: only password/sudo phrasing routes here — generic
    // permission errors (EACCES, "not writable", …) often mean a locked bundle
    // that even a sudo Terminal session won't fix, and mislabeling those
    // "needs admin" sends users down a dead end.
    if (/password is required|requires? a password|sudo[: ]/i.test(detail)) {
      return { ok: false, token, message: 'Needs admin permission — finishing in Terminal.', needsTerminal: true };
    }
    return { ok: false, token, message: lastLine(e.stderr || '') || (e.message || 'upgrade failed').trim() };
  }
}

/** Open Terminal and run the cask update there, so the user can enter their
 *  admin password interactively. Token is validated by the caller. */
export async function upgradeCaskInTerminal(token: string): Promise<void> {
  // The Terminal session runs brew OUTSIDE this process, where our write queue
  // has no reach — so refuse to open it while any brew write is running or
  // queued (two concurrent writers race brew's global lock and corrupt the
  // staging dirs), and take the write lock around the handoff itself so a
  // queued in-process write can't start mid-handoff and race the Terminal's
  // brew.
  if (brewWritesInFlight > 0) {
    throw new AppError(
      409,
      'BREW_BUSY',
      'A Homebrew operation is already running — wait for it to finish, then try again.'
    );
  }
  await withBrewLock(async () => {
    const brew = (await brewPath()) || 'brew';
    const cmd = `${brew} install --cask --force ${token}`;
    const esc = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await execFileP('/usr/bin/osascript', [
      '-e', 'tell application "Terminal"',
      '-e', 'activate',
      '-e', `do script "${esc}"`,
      '-e', 'end tell',
    ], 10000);
  });
}

/**
 * Decide whether a name-matched cask is safe to offer for a one-click update,
 * and with what confidence. Name-only fuzzy matching can map an installed app
 * to the WRONG cask, and `brew install --cask --force` would then overwrite it
 * with a different vendor's binary — so we gate:
 *
 *  1. If the cask declares bundle ids and the installed app has a bundle id, we
 *     CONFIRM they agree (exact, or the app id is under the cask id's vendor
 *     prefix). Match → confident. Disagree → reject the match entirely (this is
 *     the dangerous mis-map case; do not offer it at all).
 *  2. If the cask declares NO bundle ids (or the app has none), we can't confirm
 *     the vendor — offer it but mark `uncertain` so the UI requires explicit
 *     confirmation instead of one-click, and only when the version string is
 *     plausibly newer (already checked by the caller via cmpVersion).
 */
function gateCaskMatch(
  cask: CaskInfo,
  appBundleId: string | null,
  appVersion: string
): AppUpdateInfo | null {
  const base = { kind: 'cask' as const, token: cask.token, latestVersion: cask.version };
  const appId = appBundleId ? appBundleId.toLowerCase() : null;

  if (cask.bundleIds.length > 0 && appId) {
    const idMatch = cask.bundleIds.some(
      (cid) => appId === cid || appId.startsWith(cid + '.') || cid.startsWith(appId + '.')
    );
    if (idMatch) return base; // bundle-id confirmed → confident one-click
    // The cask names a different vendor than the installed app → this is a
    // mis-map. Refuse it outright rather than offer to overwrite the app.
    return null;
  }

  // No bundle-id confirmation available. Version already known newer by the
  // caller; still, name-only is not enough to auto-apply — flag as uncertain.
  return {
    ...base,
    uncertain: true,
    uncertainReason: appId
      ? "Matched by app name only — this cask doesn't publish a bundle id to confirm it's the same app."
      : "Matched by app name only — the installed app has no bundle id to confirm against.",
  };
}

/**
 * Every installed app, each tagged with an update if one is detectable.
 * Returns `degraded` + `degradedReasons` alongside the list: a source that
 * could not be CHECKED this pass (cask catalog fetch failed, mas errored or
 * printed unparseable output) makes those sources' updates invisible, so the
 * panel must be able to distinguish "no updates" from "couldn't check" —
 * silently swallowing a failed read path used to look exactly like "up to
 * date".
 */
export async function appUpdates(): Promise<{
  apps: AppUpdate[];
  degraded: boolean;
  degradedReasons: string[];
}> {
  if (process.platform !== 'darwin') {
    return { apps: [], degraded: false, degradedReasons: [] };
  }
  const [apps, catalog, hasMas, osVersion] = await Promise.all([
    listInstalledApps(), caskCatalog(), masAvailable(), currentOsVersion(),
  ]);
  const reasons: string[] = [];
  if (catalog.failed) {
    reasons.push('Could not fetch the Homebrew cask catalog (formulae.brew.sh) — cask updates may be missing.');
  }
  const masMap = new Map<string, MasUpdate>();
  if (hasMas) {
    const masOut = await outdatedMasApps();
    if (masOut.failed) {
      reasons.push('The mas CLI could not list App Store updates (not signed in, or it errored).');
    } else if (masOut.unparsed > 0) {
      reasons.push(
        `App Store update listing had ${masOut.unparsed} unparseable line${masOut.unparsed === 1 ? '' : 's'} — App Store updates may be missing.`
      );
    }
    for (const m of masOut.updates) masMap.set(normalizeToken(m.name), m);
  }

  const out: AppUpdate[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < apps.length; i += CONCURRENCY) {
    const batch = apps.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (a): Promise<AppUpdate> => {
        let update: AppUpdateInfo | null = null;

        // Cask offers are withheld in two cases:
        //  - MAS apps (App Store receipt): a receipt-less brew build would
        //    silently replace the app and break its App Store update channel.
        //  - apps outside /Applications: brew always installs into
        //    /Applications, so "updating" a ~/Applications app would leave the
        //    old copy in place and add a duplicate.
        const cask =
          a.updateSource === 'mas' || !a.path.startsWith('/Applications/')
            ? undefined
            : catalog.map.get(normalizeToken(a.name));
        if (cask && a.version && cmpVersion(cask.version, a.version) > 0) {
          update = gateCaskMatch(cask, a.bundleId, a.version);
        }
        if (!update && hasMas) {
          const m = masMap.get(normalizeToken(a.name));
          if (m) update = { kind: 'mas', id: m.id, latestVersion: m.latestVersion || '' };
        }
        if (!update && a.updateSource === 'self') {
          const info = await readPlistInfo(a.path);
          if (info.feedURL && info.build) {
            const xml = await fetchAppcast(info.feedURL);
            const latest = xml ? parseAppcastLatest(xml, osVersion) : null;
            if (latest && cmpVersion(latest.build, info.build) > 0) {
              update = { kind: 'sparkle', latestVersion: latest.short || latest.build };
            }
          }
        }
        return { name: a.name, path: a.path, icon: a.icon, source: a.updateSource, currentVersion: a.version, update };
      })
    );
    out.push(...results);
  }
  out.sort((x, y) => Number(!!y.update) - Number(!!x.update) || x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
  return { apps: out, degraded: reasons.length > 0, degradedReasons: reasons };
}

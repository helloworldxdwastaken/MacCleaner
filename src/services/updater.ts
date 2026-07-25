import { execFile } from 'child_process';
import { promises as fsp, constants as fsConstants } from 'fs';
import path from 'path';
import { appRoots, appIconDataUri, listInstalledApps, isAppRunning } from './apps';
import {
  OutdatedCask, BrewUpgradeResult, UpdaterOtherApp, MasUpdate, SparkleUpdate, AppUpdate, AppUpdateInfo,
  AppSummary,
} from '../models/types';
import { AppError } from '../middleware/errorHandler';

/**
 * updater — the macOS "Updater". A deliberately small, honest panel built on
 * Homebrew (the one update mechanism we can query without bundling per-vendor
 * network catalogs). If `brew` isn't installed the whole feature reports
 * unavailable; we never fabricate update data.
 *
 * Read path:  `brew outdated --cask --json=v2`  (NOT `--greedy`: greedy also
 *             lists casks marked `auto_updates`/`version :latest`, which the app
 *             can't meaningfully action — the vendor updates them itself — so
 *             offering them is noise/false "updates". We only surface casks
 *             Homebrew itself considers outdated).
 * Write path: `brew upgrade --cask <token>` per app, explicitly user-triggered.
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
 * requests simply wait their turn. */
let brewChain: Promise<unknown> = Promise.resolve();

function withBrewLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = brewChain.then(fn);
  // Never let a failure poison the queue — the next caller still runs.
  brewChain = run.then(
    () => undefined,
    () => undefined
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

export async function outdatedCasks(): Promise<OutdatedCask[]> {
  const brew = await brewPath();
  if (!brew) return [];
  try {
    // No `--greedy`: it lists auto-updating casks (auto_updates / :latest) that
    // this app can't meaningfully update — the vendor's own updater handles them.
    // Offering those would be false/actionless "updates" (audit #7).
    const { stdout } = await execFileP(
      brew,
      ['outdated', '--cask', '--json=v2'],
      90000
    );
    const data = JSON.parse(stdout) as {
      casks?: Array<{
        name?: unknown;
        installed_versions?: unknown;
        current_version?: unknown;
      }>;
    };
    const casks = Array.isArray(data.casks) ? data.casks : [];
    const mapped = casks
      .map((c) => {
        const token = typeof c.name === 'string' ? c.name : '';
        const installed =
          Array.isArray(c.installed_versions) && c.installed_versions.length > 0
            ? String(c.installed_versions[0])
            : null;
        const latest = c.current_version != null ? String(c.current_version) : null;
        return { token, name: token, installedVersion: installed, latestVersion: latest };
      })
      .filter((c) => c.token.length > 0);
    return Promise.all(
      mapped.map(async (c) => ({ ...c, icon: await caskIcon(c.token) }))
    );
  } catch {
    // Network hiccup, brew error, or timeout — surface "no updates" rather than
    // a hard failure; the UI stays usable.
    return [];
  }
}

/**
 * Installed apps that aren't Homebrew casks, tagged with how they update
 * (Mac App Store vs self-updating). brew handles the actionable updates; this
 * list lets the UI offer an App Store / website link for everything else, since
 * most self-updating apps expose no externally-invokable update handler.
 */
export async function otherApps(casks: OutdatedCask[]): Promise<UpdaterOtherApp[]> {
  const apps = await listInstalledApps();
  const caskNames = new Set(casks.map((c) => normalizeToken(c.token)));
  return apps
    .filter((a) => !caskNames.has(normalizeToken(a.name)))
    .map((a) => ({
      name: a.name,
      path: a.path,
      icon: a.icon,
      source: a.updateSource,
      website: a.website,
    }));
}

export async function upgradeCask(token: string): Promise<BrewUpgradeResult> {
  const brew = await brewPath();
  if (!brew) return { ok: false, token, message: 'Homebrew is not installed' };
  try {
    const { stdout } = await withBrewLock(() =>
      execFileP(brew, ['upgrade', '--cask', token], 5 * 60 * 1000)
    );
    return { ok: true, token, message: lastLine(stdout) || 'Updated' };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & ExecResult;
    const detail = lastLine(e.stderr || '') || (e.message || 'upgrade failed').trim();
    return { ok: false, token, message: detail };
  }
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

/** `mas outdated` → one MasUpdate per line `<id> <name> (<cur> -> <latest>)`. */
export async function outdatedMasApps(): Promise<MasUpdate[]> {
  const mas = await masPath();
  if (!mas) return [];
  let stdout = '';
  try {
    ({ stdout } = await execFileP(mas, ['outdated'], 60000));
  } catch (err) {
    stdout = (err as ExecResult).stdout || '';
  }
  const out: MasUpdate[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s+\((.+?)\s*->\s*(.+?)\)\s*$/);
    if (!m) continue;
    const name = m[2].trim();
    out.push({
      id: m[1],
      name,
      installedVersion: m[3].trim(),
      latestVersion: m[4].trim(),
      icon: await caskIcon(name), // matches the installed .app by name
    });
  }
  return out;
}

export async function upgradeMas(id: string): Promise<BrewUpgradeResult> {
  const mas = await masPath();
  if (!mas) return { ok: false, token: id, message: 'mas is not installed' };
  if (!/^\d+$/.test(id)) return { ok: false, token: id, message: 'Invalid App Store id' };
  // Same running-app guard as the cask path: `mas upgrade` swaps the .app in
  // place, which breaks (or silently corrupts state of) a running app.
  const hit = (await outdatedMasApps()).find((m) => m.id === id);
  if (hit) {
    const app = (await listInstalledApps()).find(
      (a) => normalizeToken(a.name) === normalizeToken(hit.name)
    );
    if (app && (await isAppRunning(app.executable))) {
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

async function fetchAppcast(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'MacCleaner-Updater', Accept: 'application/rss+xml, application/xml, text/xml' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// Short-lived cache so re-opening the Updater doesn't re-poll every feed.
let sparkleCache: { at: number; data: SparkleUpdate[] } | null = null;
const SPARKLE_TTL = 5 * 60 * 1000;

export async function sparkleUpdates(): Promise<SparkleUpdate[]> {
  if (process.platform !== 'darwin') return [];
  if (sparkleCache && Date.now() - sparkleCache.at < SPARKLE_TTL) return sparkleCache.data;

  const apps = (await otherApps([])).filter((a) => a.source === 'self');
  const osVersion = await currentOsVersion();
  const out: SparkleUpdate[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < apps.length; i += CONCURRENCY) {
    const batch = apps.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (a): Promise<SparkleUpdate | null> => {
        const info = await readPlistInfo(a.path);
        if (!info.feedURL || !info.build) return null;
        const xml = await fetchAppcast(info.feedURL);
        if (!xml) return null;
        const latest = parseAppcastLatest(xml, osVersion);
        if (!latest || cmpVersion(latest.build, info.build) <= 0) return null; // up to date
        return {
          name: a.name,
          path: a.path,
          icon: a.icon,
          currentVersion: info.shortVersion || info.build,
          latestVersion: latest.short || latest.build,
        };
      })
    );
    for (const r of results) if (r) out.push(r);
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  sparkleCache = { at: Date.now(), data: out };
  return out;
}

/* ---------- Homebrew cask catalog (real updates for most apps) ----------
 * Homebrew's cask database (~7.7k apps) is a curated app → latest-version map.
 * We fetch it (cached 24h), match installed apps by name, and update via
 * `brew install --cask --adopt --force <token>` — which adopts a manually-
 * installed app into Homebrew and installs the latest build. Real one-click
 * updates for most mainstream apps, no per-vendor logic.                       */

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
let caskCatalogCache: { at: number; map: Map<string, CaskInfo> } | null = null;
const CASK_CATALOG_TTL = 24 * 60 * 60 * 1000;

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

async function caskCatalog(): Promise<Map<string, CaskInfo>> {
  if (caskCatalogCache && Date.now() - caskCatalogCache.at < CASK_CATALOG_TTL) return caskCatalogCache.map;
  const map = new Map<string, CaskInfo>();
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
    }
  } catch {
    /* offline / blocked — no cask matches this run */
  }
  caskCatalogCache = { at: Date.now(), map };
  return map;
}

/**
 * Resolve a cask token back to the installed app it was matched to — the
 * reverse of the name→cask lookup appUpdates() makes when it builds the offer.
 * Needed so the apply path can run pre/post checks on the actual bundle.
 */
async function installedAppForCask(token: string): Promise<AppSummary | null> {
  const [apps, catalog] = await Promise.all([listInstalledApps(), caskCatalog()]);
  const names = new Set<string>();
  for (const [key, info] of catalog) if (info.token === token) names.add(key);
  if (names.size === 0) return null;
  return apps.find((a) => names.has(normalizeToken(a.name))) ?? null;
}

/**
 * Post-update verification. brew exiting 0 is not proof the app was actually
 * replaced (permission-locked bundles can survive a "successful" install), so
 * re-read the bundle afterwards. Hard-fail when the .app is missing from
 * /Applications or its version didn't move to the cask's version; codesign
 * failures only log a warning — several mainstream casks ship known signature
 * quirks and still run fine, so we don't fail the update over them.
 */
async function verifyCaskInstall(token: string, previousVersion: string | null): Promise<string | null> {
  const app = await installedAppForCask(token);
  if (!app || !app.path.startsWith('/Applications/')) {
    return 'The update reported success, but the app could not be found in /Applications afterwards — the install may not have completed.';
  }
  const info = await readPlistInfo(app.path);
  const installed = info.shortVersion || info.build;
  let expected: string | null = null;
  for (const c of (await caskCatalog()).values()) {
    if (c.token === token) {
      expected = c.version;
      break;
    }
  }
  if (installed) {
    if (previousVersion && installed === previousVersion) {
      return `Update incomplete: ${app.name} is still version ${installed}. Try updating again, or finish in Terminal.`;
    }
    if (expected && cmpVersion(installed, expected) < 0) {
      return `Update incomplete: ${app.name} is version ${installed}, expected ${expected}. Try updating again, or finish in Terminal.`;
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

  const app = await installedAppForCask(token);
  if (app) {
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

  try {
    const { stdout } = await withBrewLock(() =>
      execFileP(brew, ['install', '--cask', '--force', token], 10 * 60 * 1000)
    );
    const problem = await verifyCaskInstall(token, app ? app.version : null);
    if (problem) return { ok: false, token, message: problem };
    return { ok: true, token, message: lastLine(stdout) || 'Updated' };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & ExecResult;
    const detail = (e.stderr || '') + (e.stdout || '');
    // pkg/system casks need an admin password, and replacing a permission-locked
    // or root-owned bundle needs elevated rights — neither is possible from the
    // background server. Both are finished interactively in Terminal instead.
    if (/password is required|sudo:|requires? a password|administrator|permission denied|apply2files|EACCES|not writable|Operation not permitted/i.test(detail)) {
      return { ok: false, token, message: 'Needs admin permission — finishing in Terminal.', needsTerminal: true };
    }
    return { ok: false, token, message: lastLine(e.stderr || '') || (e.message || 'upgrade failed').trim() };
  }
}

/** Open Terminal and run the cask update there, so the user can enter their
 *  admin password interactively. Token is validated by the caller. */
export async function upgradeCaskInTerminal(token: string): Promise<void> {
  const brew = (await brewPath()) || 'brew';
  const cmd = `${brew} install --cask --force ${token}`;
  const esc = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  await execFileP('/usr/bin/osascript', [
    '-e', 'tell application "Terminal"',
    '-e', 'activate',
    '-e', `do script "${esc}"`,
    '-e', 'end tell',
  ], 10000);
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

/** Every installed app, each tagged with an update if one is detectable. */
export async function appUpdates(): Promise<AppUpdate[]> {
  if (process.platform !== 'darwin') return [];
  const [apps, catalog, hasMas, osVersion] = await Promise.all([
    listInstalledApps(), caskCatalog(), masAvailable(), currentOsVersion(),
  ]);
  const masMap = new Map<string, MasUpdate>();
  if (hasMas) for (const m of await outdatedMasApps()) masMap.set(normalizeToken(m.name), m);

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
            : catalog.get(normalizeToken(a.name));
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
  return out;
}

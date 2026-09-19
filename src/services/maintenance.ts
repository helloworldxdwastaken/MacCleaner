import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { withFileLock } from './storage';
import { sanitizePath } from '../utils/pathSanitizer';
import { AppError } from '../middleware/errorHandler';
import { LaunchAgent } from '../models/types';

/**
 * maintenance — small, safe, no-sudo macOS upkeep actions for the "Maintenance"
 * tool. Nothing here is destructive or needs elevated privileges; commands that
 * *would* need root are reported as "skipped", never faked as success.
 *
 * Commands run through execFile (argv arrays, no shell), mirroring cleaner.ts.
 */

/**
 * A command hit its execFile timeout (Node killed the child with SIGTERM).
 * A distinct type so the API layer can answer with an honest code
 * (e.g. AUTOMATION_TIMEOUT) instead of a lying generic 500.
 */
export class CommandTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandTimeoutError';
  }
}

/**
 * Run a command via execFile (argv arrays, no shell). Rejects with
 * CommandTimeoutError when the `timeout` option fired (Node reports the kill
 * as killed+SIGTERM, or code ETIMEDOUT on some platforms) so callers can map
 * timeouts distinctly from ordinary command failures.
 */
function run(cmd: string, args: string[], timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        if ((err.killed && err.signal === 'SIGTERM') || err.code === 'ETIMEDOUT') {
          reject(new CommandTimeoutError(`${cmd} did not finish within ${timeoutMs}ms`));
        } else {
          reject(new Error((stderr || err.message || 'command failed').trim()));
        }
      } else {
        resolve(stdout);
      }
    });
  });
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
function appleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface MaintenanceResult {
  id: string;
  ok: boolean;
  message: string;
  /**
   * true = the action ran but could only do part of the work (e.g. DNS: the
   * resolver cache was cleared, but reloading mDNSResponder needs root and was
   * NOT done). The UI should show this honestly, not as a full success.
   */
  partial?: boolean;
  /**
   * When set, the action can be COMPLETED with elevated privileges by running
   * this in Terminal (mirrors the cask updater's Terminal-elevation path). The
   * UI can offer a "Finish in Terminal" button that POSTs to the elevate route.
   */
  elevate?: { action: string; hint: string };
}

/**
 * Flush the DNS cache honestly.
 *
 * On modern macOS the effective flush is `sudo killall -HUP mDNSResponder` —
 * `dscacheutil -flushcache` alone is largely a no-op, and `killall` without
 * root fails with "Operation not permitted". The background server is not root,
 * so we do NOT claim a full flush unless we actually reloaded mDNSResponder.
 *
 * If we can't reload it, we return `partial: true` with an honest message and
 * an `elevate` descriptor so the UI can offer to finish the real flush in
 * Terminal (same interactive-sudo pattern the cask updater uses). We never fake
 * success.
 */
export async function flushDns(): Promise<MaintenanceResult> {
  if (process.platform !== 'darwin') return { id: 'flush-dns', ok: false, message: 'macOS only' };
  const elevate = {
    action: 'flush-dns',
    hint: 'sudo killall -HUP mDNSResponder && sudo dscacheutil -flushcache',
  };
  try {
    // The unprivileged half — clears the directory-service resolver cache.
    await run('dscacheutil', ['-flushcache']);
  } catch (e) {
    // Even the resolver-cache clear failed — report it, offer the Terminal path.
    return {
      id: 'flush-dns',
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      elevate,
    };
  }
  // Reloading mDNSResponder is the part that actually flushes the cache, and it
  // needs root. Attempt it; if we're not privileged it fails — say so honestly.
  try {
    await run('killall', ['-HUP', 'mDNSResponder']);
    return { id: 'flush-dns', ok: true, message: 'DNS cache flushed.' };
  } catch {
    return {
      id: 'flush-dns',
      ok: true,
      partial: true,
      message:
        'Resolver cache cleared, but fully flushing DNS needs administrator rights. ' +
        'Click "Finish in Terminal" to reload mDNSResponder with sudo.',
      elevate,
    };
  }
}

/**
 * Open Terminal and run a maintenance action that needs interactive sudo, so
 * the user can type their admin password. Mirrors updater.upgradeCaskInTerminal.
 * Only a fixed allowlist of commands is ever run — the `action` is validated
 * here and never interpolated from arbitrary input.
 */
export async function runMaintenanceInTerminal(action: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('macOS only');
  const COMMANDS: Record<string, string> = {
    'flush-dns': 'sudo killall -HUP mDNSResponder; sudo dscacheutil -flushcache; echo "DNS cache flushed."',
  };
  const cmd = COMMANDS[action];
  if (!cmd) throw new Error(`No Terminal action for "${action}"`);
  const esc = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  await run('osascript', [
    '-e', 'tell application "Terminal"',
    '-e', 'activate',
    '-e', `do script "${esc}"`,
    '-e', 'end tell',
  ], 10000);
}

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export async function rebuildLaunchServices(): Promise<MaintenanceResult> {
  if (process.platform !== 'darwin') return { id: 'rebuild-launchservices', ok: false, message: 'macOS only' };
  try {
    // user + local domains → no sudo. Fixes duplicate / wrong "Open With" entries.
    // (`-kill` was removed on recent macOS — `-r` alone re-registers.)
    await run(LSREGISTER, ['-r', '-domain', 'local', '-domain', 'user'], 60000);
    return { id: 'rebuild-launchservices', ok: true, message: 'Launch Services rebuilt — "Open With" menus refreshed.' };
  } catch (e) {
    return { id: 'rebuild-launchservices', ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function runMaintenance(id: string): Promise<MaintenanceResult> {
  switch (id) {
    case 'flush-dns':
      return flushDns();
    case 'rebuild-launchservices':
      return rebuildLaunchServices();
    default:
      return { id, ok: false, message: 'Unknown action' };
  }
}

/* ---------- Login items (user "Open at Login" apps) ---------- */

export interface LoginItem {
  name: string;
  path: string;
  /** true = launches hidden. */
  hidden: boolean;
  /** Present in the login-items list = will open at login. */
  enabled: boolean;
  /**
   * 'login' = classic System Events "Open at Login" entry (toggleable here).
   * 'background' = modern Background Task Management item (SMAppService,
   * LaunchAgent/Daemon registered by the app) — macOS owns the switch, so
   * the UI shows these read-only. This is where Adobe & co. live.
   */
  kind: 'login' | 'background';
  /** Short provenance line, e.g. the developer name or item type. */
  detail?: string;
  /**
   * Raw BTM Disposition string (e.g. "[enabled, disallowed]") — background
   * items only. Surfaced so the UI (and humans) can see WHY an item is
   * considered blocked without re-deriving it from `enabled`.
   */
  dispositionRaw?: string;
}

/** Render a macOS .app bundle's icon as a small PNG buffer (for the UI). */
export async function getAppIconPng(appPath: string): Promise<Buffer> {
  if (process.platform !== 'darwin') throw new Error('macOS only');
  if (!appPath.endsWith('.app')) throw new Error('Not an app bundle');

  const resDir = path.join(appPath, 'Contents', 'Resources');
  let icns = '';
  // Prefer the icon named in Info.plist, else the first .icns in Resources.
  try {
    const named = (await run('defaults', ['read', path.join(appPath, 'Contents', 'Info'), 'CFBundleIconFile'])).trim();
    if (named) {
      const candidate = path.join(resDir, named.endsWith('.icns') ? named : `${named}.icns`);
      if (await pathExists(candidate)) icns = candidate;
    }
  } catch {
    /* no explicit icon name */
  }
  if (!icns) {
    const entries = await fsp.readdir(resDir).catch(() => [] as string[]);
    const found = entries.find((e) => e.toLowerCase().endsWith('.icns'));
    if (!found) throw new Error('No icon');
    icns = path.join(resDir, found);
  }

  const out = path.join(os.tmpdir(), `tm-icon-${crypto.randomUUID()}.png`);
  try {
    await run('sips', ['-s', 'format', 'png', '-Z', '64', icns, '--out', out]);
    return await fsp.readFile(out);
  } finally {
    fsp.unlink(out).catch(() => {});
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Apple/system items we never show or touch — only user apps are managed. */
function isUserLoginItem(name: string, path: string): boolean {
  // Case-insensitive on purpose: default APFS is case-insensitive, so a
  // "/SYSTEM/…" spelling would slip past an exact-match check.
  if (path.toLowerCase().startsWith('/system/')) return false;
  if (/^com\.apple\./i.test(name)) return false;
  return true;
}

/**
 * macOS "Open at Login" items have no native disabled state — an item is either
 * in the list or not. To keep a turned-off app *visible as disabled* (instead of
 * vanishing), we remember the ones the user disabled in a small JSON file and
 * merge them back into the list as `enabled:false`.
 */
const MAINT_FILE = 'maintenance.json';
interface MaintStore {
  disabledLoginItems: { name: string; path: string }[];
}
type DisabledEntry = MaintStore['disabledLoginItems'][number];
const EMPTY_MAINT_STORE: MaintStore = { disabledLoginItems: [] };

/**
 * Read→mutate→write the disabled-login-items store under the per-file lock
 * (storage.ts `withFileLock` convention) so concurrent toggles/listings can't
 * lose each other's changes. withFileLock performs the write itself — never
 * call writeJsonFile inside the callback (it would queue behind this very
 * lock and deadlock). When the on-disk file is unreadable the lock
 * quarantines it (bytes preserved) and flags `skipWrite`; like
 * settings.persistLocked we retry once — the file is gone after quarantine,
 * so the retry legitimately starts fresh — and throw only if the data dir is
 * truly unwritable. Corrupt-file content is never "read" as a fallback and
 * then overwritten.
 */
async function mutateDisabled(mutate: (list: DisabledEntry[]) => DisabledEntry[]): Promise<MaintStore> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let quarantined = false;
    const next = await withFileLock<MaintStore>(MAINT_FILE, EMPTY_MAINT_STORE, (store, ctx) => {
      // Snapshot the lock-set flag BEFORE mutating (mirrors settings.ts).
      quarantined = ctx.skipWrite;
      if (quarantined) return store; // unreadable — change nothing this cycle
      // Corrupt/legacy shapes may hold a non-array value — start from []
      // rather than crashing every login-item call.
      const list = Array.isArray(store.disabledLoginItems) ? store.disabledLoginItems : [];
      return { disabledLoginItems: mutate(list) };
    });
    if (!quarantined) return next;
  }
  throw new Error('maintenance.json was unreadable and could not be rewritten');
}

/**
 * System Events osascripts get a long leash: the FIRST call after install can
 * sit behind the macOS TCC Automation consent dialog until the user clicks
 * "Allow" (or "Don't Allow"), and a busy System Events can take seconds per
 * item. 120s covers both; a hit is surfaced as CommandTimeoutError, not a
 * generic failure.
 */
const SYSTEM_EVENTS_TIMEOUT_MS = 120_000;

/**
 * Login-items listing result. `classicError` is null when the classic
 * (System Events) source succeeded or wasn't requested; a message string
 * means the classic query failed (TCC denial, timeout, …) while the
 * consent-free BTM items were still delivered.
 */
export interface LoginItemsResult {
  items: LoginItem[];
  classicError: string | null;
}

const LOGIN_ITEMS_TTL_MS = 60_000;
let loginItemsCache: { at: number; classic: boolean; items: LoginItem[]; classicError: string | null } | null = null;

/** Drop the cached list (called after any enable/disable change). */
export function invalidateLoginItemsCache(): void {
  loginItemsCache = null;
}

/**
 * List login/background items. Two sources:
 *  - classic "Open at Login" apps via System Events (osascript) — this needs
 *    Automation consent from macOS (prompts / -1743 if denied), so it is
 *    OPT-IN (includeClassic) and only fetched when the user asks for it;
 *  - modern BTM background items via `sfltool dumpbtm` — needs NO consent,
 *    always included.
 * A classic-source failure does NOT fail the listing: the BTM items are
 * returned regardless and the reason is reported as `classicError`. Results
 * are cached for 60s so tab-hopping doesn't re-run the osascript prompt
 * (classic failures are never cached, so a retry right after the user grants
 * Automation consent takes effect immediately); the cache is invalidated by
 * setLoginItemEnabled.
 */
export async function listLoginItems(opts: { includeClassic?: boolean } = {}): Promise<LoginItemsResult> {
  const includeClassic = opts.includeClassic !== false;
  if (process.platform !== 'darwin') return { items: [], classicError: null };
  if (
    loginItemsCache &&
    loginItemsCache.classic === includeClassic &&
    Date.now() - loginItemsCache.at < LOGIN_ITEMS_TTL_MS
  ) {
    return { items: loginItemsCache.items, classicError: loginItemsCache.classicError };
  }

  const items: LoginItem[] = [];
  const activePaths = new Set<string>();
  let classicError: string | null = null;

  if (includeClassic) {
    try {
      const out = await run('osascript', [
        '-e', 'tell application "System Events"',
        '-e', 'set acc to ""',
        '-e', 'repeat with li in login items',
        '-e', 'set acc to acc & (name of li) & tab & (path of li) & tab & (hidden of li) & linefeed',
        '-e', 'end repeat',
        '-e', 'return acc',
        '-e', 'end tell',
      ], SYSTEM_EVENTS_TIMEOUT_MS);
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const [name, path, hidden] = line.split('\t');
        if (!name || !path) continue;
        if (!isUserLoginItem(name, path)) continue;
        items.push({ name, path, hidden: hidden === 'true', enabled: true, kind: 'login' });
        activePaths.add(path);
      }
    } catch (e) {
      // The classic list is best-effort: a System Events failure (missing
      // Automation consent, timeout) must not sink the whole response — the
      // BTM items below are still valid. Report the reason instead.
      classicError = e instanceof Error ? e.message : String(e);
    }
  }

  if (includeClassic && classicError === null) {
    // Merge the remembered-disabled apps back in and prune the ones that came
    // back active — one locked read→mutate→write cycle so a concurrent toggle
    // can't be lost. (Only on classic success: without the live active list a
    // prune could wrongly delete remembered entries.)
    await mutateDisabled((disabled) => {
      const stillDisabled = disabled.filter((d) => !activePaths.has(d.path));
      for (const d of stillDisabled) {
        if (!isUserLoginItem(d.name, d.path)) continue;
        items.push({ name: d.name, path: d.path, hidden: false, enabled: false, kind: 'login' });
      }
      return stillDisabled;
    });
  }

  // Modern background items (SMAppService / BTM — Adobe Creative Cloud & co.)
  // don't appear in System Events at all; merge them in read-only. sfltool
  // needs no Automation consent, so this runs on every load.
  for (const b of await listBackgroundItems()) {
    if (activePaths.has(b.path)) continue;
    if (items.some((i) => i.name === b.name && i.path === b.path)) continue;
    items.push(b);
  }

  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  if (classicError === null) {
    loginItemsCache = { at: Date.now(), classic: includeClassic, items, classicError };
  }
  return { items, classicError };
}

/* ---------- Background Task Management items (sfltool dumpbtm) ---------- */

interface BtmRecord {
  name: string;
  developer: string;
  type: string;
  disposition: string;
  identifier: string;
  url: string;
  executablePath: string;
  /** "Generation" field — bumped each time an app re-registers the item. */
  generation: number;
  /** UID section the record was printed under (null when the dump has none). */
  uid: number | null;
}

/**
 * Parse `sfltool dumpbtm` output. The dump is organized in per-user sections
 * and numbered records (real header shape: " Records for UID -2 : <uuid>",
 * UIDs may be negative):
 *    Records for UID 501 : …
 *     #3:
 *         UUID: …
 *         Name: DisplayLink Manager
 *         Type: app (0x2)
 *         Disposition: [enabled, allowed, notified] (0xb)
 *         URL: file:///Applications/DisplayLink%20Manager.app/
 * Each record remembers its section UID (so duplicates can be resolved in
 * favor of the current user) and its Generation (bumped on re-registration —
 * tie-breaker for duplicates). The literal "(null)" that dumps emit for
 * absent values is treated as an empty string for the text fields.
 */
function parseBtmDump(out: string): BtmRecord[] {
  const records: BtmRecord[] = [];
  let sectionUid: number | null = null;
  let current: BtmRecord | null = null;
  const flush = (): void => {
    if (current) records.push(current);
    current = null;
  };
  const clean = (v: string): string => (v === '(null)' ? '' : v);

  for (const line of out.split('\n')) {
    // Section headers look like " Records for UID -2 : <UUID>" — UIDs can be
    // negative (e.g. -2 = shared/system records) and the line carries a
    // leading space and a trailing dump UUID, so match only the prefix.
    const uidHeader = line.match(/^\s*Records for UID (-?\d+)/);
    if (uidHeader) {
      flush();
      sectionUid = Number(uidHeader[1]);
      continue;
    }
    const recordHeader = line.match(/^\s*#\d+:\s*$/);
    if (recordHeader) {
      flush();
      current = {
        name: '', developer: '', type: '', disposition: '', identifier: '',
        url: '', executablePath: '', generation: -1, uid: sectionUid,
      };
      continue;
    }
    if (!current) continue;
    const field = line.match(/^\s+([A-Za-z][A-Za-z0-9 ]*):\s*(.*)$/);
    if (!field) continue;
    const value = field[2].trim();
    switch (field[1]) {
      case 'Name': current.name = clean(value); break;
      case 'Developer Name': current.developer = clean(value); break;
      case 'Type': current.type = value; break;
      case 'Disposition': current.disposition = value; break;
      case 'Identifier': current.identifier = clean(value); break;
      case 'URL': current.url = clean(value); break;
      case 'Executable Path': current.executablePath = clean(value); break;
      case 'Generation': {
        const n = parseInt(value, 10);
        current.generation = Number.isFinite(n) ? n : -1;
        break;
      }
      default:
        break; // fields we don't use (UUID, …)
    }
  }
  flush();
  return records;
}

/**
 * Derive the on-disk path from a BTM record: the payload URL when it is a
 * proper file:// URL (percent-decoded; an optional localhost host is
 * stripped), else the record's Executable Path. Bundle-relative or
 * foreign-scheme URLs are not usable paths, so they fall back too. A trailing
 * slash is stripped so e.g. the BTM bundle URL "/Applications/Foo.app/"
 * matches the classic System Events path "/Applications/Foo.app" and the two
 * sources dedupe into one entry (DisplayLink case).
 */
function btmRecordPath(r: BtmRecord): string {
  let p = '';
  if (/^file:\/\//i.test(r.url)) {
    try {
      let rest = r.url.slice('file://'.length);
      if (/^localhost(?=\/)/i.test(rest)) rest = rest.slice('localhost'.length);
      p = decodeURIComponent(rest);
    } catch {
      p = ''; // malformed percent-encoding — fall through to the executable path
    }
  }
  if (!p) p = r.executablePath;
  if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
  return p;
}

/**
 * Whether a BTM record actually runs. Its disposition must say "enabled" AND
 * NOT "disallowed" — live dumps contain "[enabled, disallowed]" to mean the
 * app registered itself but the item is blocked, so a naive enabled-substring
 * check would misreport it as on.
 */
function btmEnabled(disposition: string): boolean {
  const d = disposition.toLowerCase();
  return d.includes('enabled') && !d.includes('disallowed');
}

/**
 * Whether record `a` beats incumbent `b` when a dump contains duplicate BTM
 * records (same identifier): records from the CURRENT user's UID section beat
 * other users'; a higher Generation (bumped on re-registration) beats older
 * ones; still tied → the incumbent (first seen) wins.
 */
function preferBtmRecord(a: BtmRecord, b: BtmRecord, myUid: number): boolean {
  const aMine = a.uid === myUid;
  const bMine = b.uid === myUid;
  if (aMine !== bMine) return aMine;
  return a.generation > b.generation;
}

/**
 * List non-Apple Background Task Management items (System Settings → General
 * → Login Items & Extensions). Modern apps register here via SMAppService —
 * they never show up in System Events "login items", which is why the
 * classic list alone misses things like Adobe Creative Cloud. macOS owns
 * the on/off switch for these; they are reported read-only.
 */
export async function listBackgroundItems(): Promise<LoginItem[]> {
  if (process.platform !== 'darwin') return [];
  let out: string;
  try {
    out = await run('sfltool', ['dumpbtm'], 15000);
  } catch {
    return []; // older macOS without sfltool, or BTM unavailable — not fatal
  }
  // dumpbtm repeats records per UID section (console user + other local
  // users). Dedupe preferring THIS process's uid, then the highest
  // Generation, then first-seen — see preferBtmRecord.
  const myUid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const best = new Map<string, { r: BtmRecord; p: string }>();

  for (const r of parseBtmDump(out)) {
    if (!r.name) continue;
    if (/apple/i.test(r.developer) || /^com\.apple\./i.test(r.identifier)) continue;
    // Records without a payload URL/executable are containers — skip them.
    const p = btmRecordPath(r);
    if (!p) continue;
    const key = r.identifier || `${r.name}|${p}`;
    const prev = best.get(key);
    if (!prev || preferBtmRecord(r, prev.r, myUid)) best.set(key, { r, p });
  }

  const items: LoginItem[] = [];
  for (const { r, p } of best.values()) {
    // developer was already "(null)"-cleaned by the parser.
    const dev = r.developer && r.developer !== r.name ? r.developer : '';
    items.push({
      name: r.name,
      path: p,
      hidden: false,
      enabled: btmEnabled(r.disposition),
      kind: 'background',
      detail: dev ? `${dev} — ${btmTypeLabel(r.type)}` : btmTypeLabel(r.type),
      dispositionRaw: r.disposition || undefined,
    });
  }
  return items;
}

/** Human label for the BTM "Type:" field. */
function btmTypeLabel(type: string): string {
  if (type.startsWith('app')) return 'App background item';
  if (type.includes('daemon')) return 'Background daemon';
  if (type.includes('agent')) return 'Background agent';
  if (type.startsWith('developer')) return 'Background item';
  if (type.startsWith('login')) return 'Login item';
  return 'Background item';
}

/**
 * Enable or disable a login item. Disabling removes it from System Events but
 * *remembers* it so it stays listed as off; enabling re-adds it by path and
 * forgets it. macOS only; refuses Apple/system paths and macOS-owned BTM
 * items with typed errors (409) so the route never has to guess.
 */
export async function setLoginItemEnabled(name: string, path: string, enabled: boolean): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Login items are managed on macOS only');
  // The route's guardBodyPath already sanitized, but this service is exported
  // and callable directly — apply the shared sanitizer here too so traversal
  // and blocklist rules always hold (PathRejectedError → 400 upstream), and
  // work on the resolved absolute path (also expands a leading ~).
  const cleanPath = sanitizePath(path);
  if (!isUserLoginItem(name, cleanPath)) {
    throw new AppError(409, 'LOGIN_ITEM_SYSTEM', 'Refusing to modify a system login item');
  }
  // Only classic .app login items are toggleable through System Events.
  // Background (BTM) items point at executables/plists and are owned by macOS.
  if (!cleanPath.endsWith('.app')) {
    throw new AppError(
      409,
      'LOGIN_ITEM_BTM',
      'Background items are managed by macOS — toggle them in System Settings → General → Login Items & Extensions'
    );
  }

  if (enabled) {
    await run('osascript', [
      '-e',
      `tell application "System Events" to make new login item at end with properties {path:"${appleScriptString(
        cleanPath
      )}", hidden:false}`,
    ], SYSTEM_EVENTS_TIMEOUT_MS);
    // Re-enabled → forget the remembered entry (one locked cycle).
    await mutateDisabled((disabled) => disabled.filter((d) => d.path !== cleanPath));
  } else {
    // Delete by EXACT path, not by name: `whose name is X` removed EVERY
    // same-named item (different apps can share a display name) while only
    // the toggled path was remembered afterwards. Enumerate the matches
    // first so EVERY deleted entry lands in the disabled store, then delete
    // them all.
    const esc = appleScriptString(cleanPath);
    const out = await run('osascript', [
      '-e', 'tell application "System Events"',
      '-e', 'set acc to ""',
      '-e', `repeat with li in (every login item whose path is "${esc}")`,
      '-e', 'set acc to acc & (name of li) & tab & (path of li) & linefeed',
      '-e', 'end repeat',
      '-e', `delete (every login item whose path is "${esc}")`,
      '-e', 'return acc',
      '-e', 'end tell',
    ], SYSTEM_EVENTS_TIMEOUT_MS);

    const removed: DisabledEntry[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [n, p] = line.split('\t');
      if (!p) continue;
      removed.push({ name: n || name, path: p });
    }
    // Guarantee the toggled entry is remembered even when the enumeration
    // came back empty (System Events may return nothing for the specifier).
    if (!removed.some((r) => r.path === cleanPath)) removed.push({ name, path: cleanPath });
    await mutateDisabled((disabled) => {
      // Drop any remembered entries for the deleted paths, then append —
      // deduped by path so deleting duplicates of one app can't double-book
      // the store.
      const keep = disabled.filter((d) => !removed.some((r) => r.path === d.path));
      const merged: DisabledEntry[] = [];
      const seen = new Set<string>();
      for (const e of [...keep, ...removed]) {
        if (seen.has(e.path)) continue;
        seen.add(e.path);
        merged.push(e);
      }
      return merged;
    });
  }
  invalidateLoginItemsCache();
}

/* ---------- User LaunchAgents (~/Library/LaunchAgents) ---------- */

/**
 * Parse a .plist (binary or XML) into a plain object via plutil→json. Returns
 * {} on any failure so a single unreadable agent can't sink the listing.
 */
async function readPlistJson(plistPath: string): Promise<Record<string, unknown>> {
  try {
    const out = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], 5000);
    const j = JSON.parse(out);
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Whether a user LaunchAgent is currently loaded/enabled for this GUI session.
 * `launchctl print gui/<uid>/<label>` exits 0 and prints a job block when the
 * agent is bootstrapped; it exits non-zero when the label isn't loaded. We fall
 * back to the plist's own `Disabled` key when launchctl can't answer (e.g. the
 * label differs). Returns null when nothing is conclusive.
 */
async function launchAgentEnabled(label: string, disabledKey: boolean): Promise<boolean | null> {
  const uid = os.userInfo().uid;
  try {
    await run('launchctl', ['print', `gui/${uid}/${label}`], 5000);
    return true; // present in the domain → loaded
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // "Could not find service" / nonzero → not loaded. Any other error is
    // inconclusive, so defer to the plist's Disabled key.
    if (/could not find|no such|not find service|113|3:|165/i.test(msg)) return !disabledKey ? false : false;
    return disabledKey ? false : null;
  }
}

/**
 * List the user's LaunchAgents from ~/Library/LaunchAgents (read-only).
 * Read-only enumeration — a later UI wave renders these; enable/disable goes
 * through setLaunchAgentEnabled. Apple/system labels are kept out (only the
 * user's own agents live in ~/Library/LaunchAgents, but we still filter
 * com.apple.* defensively). macOS only.
 */
export async function listLaunchAgents(): Promise<LaunchAgent[]> {
  if (process.platform !== 'darwin') return [];
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return []; // directory absent — the user has no per-user agents
  }
  const plists = entries.filter((n) => n.toLowerCase().endsWith('.plist'));

  const agents: LaunchAgent[] = [];
  for (const file of plists) {
    const full = path.join(dir, file);
    const j = await readPlistJson(full);
    const label = typeof j.Label === 'string' && j.Label.trim() ? j.Label.trim() : file.replace(/\.plist$/i, '');
    if (/^com\.apple\./i.test(label)) continue; // Apple agents — never manage

    let program: string | null = null;
    const args = j.ProgramArguments;
    if (Array.isArray(args) && typeof args[0] === 'string') program = args[0];
    else if (typeof j.Program === 'string') program = j.Program;

    const disabledKey = j.Disabled === true;
    agents.push({
      label,
      path: full,
      program,
      runAtLoad: j.RunAtLoad === true,
      keepAlive: j.KeepAlive === true || (j.KeepAlive != null && typeof j.KeepAlive === 'object'),
      enabled: await launchAgentEnabled(label, disabledKey),
    });
  }
  agents.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  return agents;
}

/**
 * Enable or disable a user LaunchAgent via launchctl bootstrap/bootout in the
 * GUI domain (gui/<uid>). Read/modify is confined to ~/Library/LaunchAgents —
 * the caller passes a path already pinned there. Disabling records a
 * `launchctl disable` override (so the agent stays off across logins) before
 * unloading it. macOS only, no sudo (user agents live in the user's own
 * domain).
 */
export async function setLaunchAgentEnabled(agentPath: string, enabled: boolean): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('LaunchAgents are managed on macOS only');
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  // Defense in depth: only ever act on a plist directly inside the user's
  // LaunchAgents dir (the route also validates this).
  if (path.dirname(agentPath) !== dir || !agentPath.toLowerCase().endsWith('.plist')) {
    throw new Error('Refusing to manage a LaunchAgent outside ~/Library/LaunchAgents');
  }
  if (!(await pathExists(agentPath))) throw new Error('LaunchAgent not found');
  const uid = os.userInfo().uid;
  if (enabled) {
    // `enable` clears any disabled override, then bootstrap loads it now.
    const j = await readPlistJson(agentPath);
    const label = typeof j.Label === 'string' && j.Label.trim() ? j.Label.trim() : path.basename(agentPath, '.plist');
    await run('launchctl', ['enable', `gui/${uid}/${label}`], 8000).catch(() => {});
    await run('launchctl', ['bootstrap', `gui/${uid}`, agentPath], 8000);
  } else {
    // Read the Label the same way the enable branch does, then record the
    // disable BEFORE booting out: `bootout` only unloads the agent for the
    // current session, while `launchctl disable` writes the override that
    // keeps it off across logouts/reboots. After bootout the label is gone
    // from the domain, so the order matters. A failed disable step (e.g.
    // already-disabled) must not block the unload.
    const j = await readPlistJson(agentPath);
    const label = typeof j.Label === 'string' && j.Label.trim() ? j.Label.trim() : path.basename(agentPath, '.plist');
    await run('launchctl', ['disable', `gui/${uid}/${label}`], 8000).catch(() => {});
    await run('launchctl', ['bootout', `gui/${uid}`, agentPath], 8000);
  }
}

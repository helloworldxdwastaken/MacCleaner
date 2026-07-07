import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { readJsonFile, writeJsonFile } from './storage';
import { LaunchAgent } from '../models/types';

/**
 * maintenance — small, safe, no-sudo macOS upkeep actions for the "Maintenance"
 * tool. Nothing here is destructive or needs elevated privileges; commands that
 * *would* need root are reported as "skipped", never faked as success.
 *
 * Commands run through execFile (argv arrays, no shell), mirroring cleaner.ts.
 */

function run(cmd: string, args: string[], timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || 'command failed').trim()));
      else resolve(stdout);
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
  if (path.startsWith('/System/')) return false;
  if (/^com\.apple\./i.test(name)) return false;
  return true;
}

/**
 * List the user's "Open at Login" items via System Events. These are user apps
 * (Dropbox, Rectangle, …), not Apple system daemons. Requires Automation
 * permission for System Events the first time (macOS will prompt / -1743 if denied).
 */
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
async function getDisabled(): Promise<{ name: string; path: string }[]> {
  const s = await readJsonFile<MaintStore>(MAINT_FILE, { disabledLoginItems: [] });
  return Array.isArray(s.disabledLoginItems) ? s.disabledLoginItems : [];
}
async function setDisabled(list: { name: string; path: string }[]): Promise<void> {
  await writeJsonFile(MAINT_FILE, { disabledLoginItems: list });
}

/**
 * List the user's "Open at Login" items via System Events (these are user apps,
 * not Apple daemons), merged with the apps the user disabled (shown as off).
 * Requires Automation permission for System Events (macOS prompts / -1743 if denied).
 */
export async function listLoginItems(): Promise<LoginItem[]> {
  if (process.platform !== 'darwin') return [];
  const out = await run('osascript', [
    '-e', 'tell application "System Events"',
    '-e', 'set acc to ""',
    '-e', 'repeat with li in login items',
    '-e', 'set acc to acc & (name of li) & tab & (path of li) & tab & (hidden of li) & linefeed',
    '-e', 'end repeat',
    '-e', 'return acc',
    '-e', 'end tell',
  ]);
  const items: LoginItem[] = [];
  const activePaths = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [name, path, hidden] = line.split('\t');
    if (!name || !path) continue;
    if (!isUserLoginItem(name, path)) continue;
    items.push({ name, path, hidden: hidden === 'true', enabled: true });
    activePaths.add(path);
  }
  // Merge back remembered-disabled apps that aren't currently active.
  const disabled = await getDisabled();
  for (const d of disabled) {
    if (activePaths.has(d.path) || !isUserLoginItem(d.name, d.path)) continue;
    items.push({ name: d.name, path: d.path, hidden: false, enabled: false });
  }
  // Prune any remembered-disabled that are active again (re-enabled elsewhere).
  const stillDisabled = disabled.filter((d) => !activePaths.has(d.path));
  if (stillDisabled.length !== disabled.length) await setDisabled(stillDisabled);

  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return items;
}

/**
 * Enable or disable a login item. Disabling removes it from System Events but
 * *remembers* it so it stays listed as off; enabling re-adds it by path and
 * forgets it. macOS only; refuses Apple/system paths.
 */
export async function setLoginItemEnabled(name: string, path: string, enabled: boolean): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Login items are managed on macOS only');
  if (!isUserLoginItem(name, path)) throw new Error('Refusing to modify a system login item');
  const disabled = await getDisabled();

  if (enabled) {
    await run('osascript', [
      '-e',
      `tell application "System Events" to make new login item at end with properties {path:"${appleScriptString(
        path
      )}", hidden:false}`,
    ]);
    await setDisabled(disabled.filter((d) => d.path !== path));
  } else {
    await run('osascript', [
      '-e',
      `tell application "System Events" to delete (every login item whose name is "${appleScriptString(name)}")`,
    ]);
    if (!disabled.some((d) => d.path === path)) {
      disabled.push({ name, path });
      await setDisabled(disabled);
    }
  }
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
 * the caller passes a path already pinned there. macOS only, no sudo (user
 * agents live in the user's own domain).
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
    await run('launchctl', ['bootout', `gui/${uid}`, agentPath], 8000);
  }
}

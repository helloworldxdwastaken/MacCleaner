import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';

/**
 * Storage — tiny JSON-file persistence in the platform's app-data directory.
 * Used for scan snapshots (Trends) and user settings (schedules, ignore list).
 * Plain JSON keeps the stack dependency-free; the data volumes here are tiny
 * (a few KB), so a database would be pure overhead.
 */

/** Per-OS app-data directory, created on demand. */
export function appDataDir(): string {
  // MACCLEANER_DATA_DIR is the current override; TREEMAP_DATA_DIR is still
  // honored as a fallback so existing setups keep working after the rebrand.
  if (process.env.MACCLEANER_DATA_DIR) return process.env.MACCLEANER_DATA_DIR;
  if (process.env.TREEMAP_DATA_DIR) return process.env.TREEMAP_DATA_DIR;
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'MacCleaner');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'MacCleaner');
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'maccleaner');
  }
}

/** The legacy (pre-rebrand) TreeMap app-data directory for the current OS. */
function legacyAppDataDir(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'TreeMap');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'TreeMap');
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'treemap');
  }
}

/**
 * One-time migration of app data from the pre-rebrand TreeMap directory to the
 * new MacCleaner directory. Runs on startup: if the new dir is missing and an
 * old TreeMap dir exists, MOVE it across (fast rename(2)). On a cross-device
 * error (EXDEV — e.g. the two live on different volumes) fall back to a
 * recursive copy and leave the old directory in place. Skipped entirely when a
 * data-dir env override is set, since the user chose that path explicitly.
 */
export async function migrateLegacyDataDir(): Promise<void> {
  if (process.env.MACCLEANER_DATA_DIR || process.env.TREEMAP_DATA_DIR) return;
  const newDir = appDataDir();
  const oldDir = legacyAppDataDir();
  if (newDir === oldDir) return; // nothing to do (custom env, or same path)

  // Only migrate when the new dir is absent and the old one is present.
  try {
    await fsp.access(newDir);
    return; // new dir already exists — leave everything alone
  } catch {
    /* new dir missing — continue */
  }
  try {
    await fsp.access(oldDir);
  } catch {
    return; // no legacy data to migrate
  }

  try {
    await fsp.mkdir(path.dirname(newDir), { recursive: true });
    await fsp.rename(oldDir, newDir);
    console.log(`[treemap] migrated app data ${oldDir} → ${newDir}`);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EXDEV') {
      // Different volumes: copy the tree and leave the old dir untouched.
      try {
        await fsp.cp(oldDir, newDir, { recursive: true });
        console.log(`[treemap] copied app data ${oldDir} → ${newDir} (cross-device; old dir kept)`);
      } catch (copyErr: unknown) {
        console.error('[treemap] app-data migration copy failed:', copyErr);
      }
    } else {
      console.error('[treemap] app-data migration failed:', err);
    }
  }
}

/** Serialize writes per file so two near-simultaneous saves can't interleave. */
const writeQueues = new Map<string, Promise<void>>();

/** Outcome of reading one app-data JSON file. */
type ReadStatus = 'ok' | 'missing' | 'quarantined';

/**
 * Move an unreadable data file aside instead of destroying it: the bytes are
 * preserved as `<name>.corrupt-<ts>` so nothing is silently lost, and the next
 * read sees ENOENT (a legitimate fresh start) instead of the same failure.
 * Best-effort — a failed quarantine (e.g. EBUSY on Windows) must never break
 * the caller; the file simply stays in place and we retry next cycle.
 */
async function quarantineFile(file: string): Promise<void> {
  try {
    const dest = `${file}.corrupt-${Date.now()}`;
    await fsp.rename(file, dest);
    console.error(`[storage] quarantined unreadable data file → ${path.basename(dest)}`);
  } catch (err: unknown) {
    console.error('[storage] could not quarantine unreadable data file:', err);
  }
}

/**
 * Read a JSON file and report HOW the value was obtained. Only ENOENT counts
 * as "missing" (a plain first run). A corrupt parse or an unreadable file
 * (EACCES/EBUSY/…) is quarantined and reported as such, so callers can avoid
 * writing fallback-derived data over content they never actually read.
 */
async function readJsonStatus<T>(name: string, fallback: T): Promise<{ status: ReadStatus; value: T }> {
  const file = path.join(appDataDir(), name);
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', value: fallback };
    await quarantineFile(file); // unreadable for another reason — preserve the bytes
    return { status: 'quarantined', value: fallback };
  }
  try {
    return { status: 'ok', value: JSON.parse(raw) as T };
  } catch {
    await quarantineFile(file); // corrupt JSON — preserve the bytes for recovery
    return { status: 'quarantined', value: fallback };
  }
}

/**
 * Read a JSON file from the app-data dir; returns `fallback` when the file is
 * missing (ENOENT). Any other read failure (corrupt JSON, EACCES, EBUSY…)
 * quarantines the file as `<name>.corrupt-<ts>` and returns `fallback` WITHOUT
 * writing anything back — the original bytes stay recoverable on disk.
 */
export async function readJsonFile<T>(name: string, fallback: T): Promise<T> {
  const { value } = await readJsonStatus(name, fallback);
  return value;
}

/** The write itself (tmp + rename) — only ever called through the per-file queue. */
async function writeNow(name: string, data: unknown): Promise<void> {
  const dir = appDataDir();
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/** Atomically write a JSON file (tmp + rename) in the app-data dir. */
export function writeJsonFile(name: string, data: unknown): Promise<void> {
  const prev = writeQueues.get(name) ?? Promise.resolve();
  const next = prev
    .catch(() => {
      /* an earlier failed write must not poison the queue */
    })
    .then(() => writeNow(name, data));
  writeQueues.set(name, next);
  return next;
}

/** Context handed to withFileLock callbacks; `skipWrite` suppresses persisting. */
export interface FileLockContext {
  /**
   * Set by the lock when this cycle must NOT persist: the read failed for a
   * non-ENOENT reason (the file was quarantined or is unreadable), and writing
   * fallback-derived data would clobber content we never actually read — a
   * permanent-loss footgun on transient errors like EACCES/EBUSY. Callbacks
   * may also set it themselves to opt out of the write for this cycle.
   */
  skipWrite: boolean;
}

/**
 * Run a whole read→mutate→write cycle for one file under the same per-path
 * promise chain, so concurrent callers can't lose each other's changes.
 * `fn` receives the current content (or `fallback` when missing) plus a lock
 * context whose `skipWrite` flag suppresses the write for this cycle; either
 * way the value `fn` returns resolves the returned promise. Do NOT call
 * writeJsonFile inside `fn` — it would queue behind the lock itself and
 * deadlock.
 */
export function withFileLock<T>(
  name: string,
  fallback: T,
  fn: (current: T, ctx: FileLockContext) => T | Promise<T>
): Promise<T> {
  const prev = writeQueues.get(name) ?? Promise.resolve();
  const next = prev
    .catch(() => {
      /* an earlier failed write must not poison the queue */
    })
    .then(async () => {
      const { status, value } = await readJsonStatus<T>(name, fallback);
      const ctx: FileLockContext = { skipWrite: status === 'quarantined' };
      const updated = await fn(value, ctx);
      if (!ctx.skipWrite) await writeNow(name, updated);
      return updated;
    });
  // The queue tracks completion only; a failure must not poison later writes.
  writeQueues.set(name, next.then(() => undefined, () => undefined));
  return next;
}

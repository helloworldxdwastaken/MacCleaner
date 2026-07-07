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

/** Read a JSON file from the app-data dir; returns `fallback` when missing/corrupt. */
export async function readJsonFile<T>(name: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(path.join(appDataDir(), name), 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback; // ENOENT on first run, or unreadable JSON — start fresh
  }
}

/** Atomically write a JSON file (tmp + rename) in the app-data dir. */
export function writeJsonFile(name: string, data: unknown): Promise<void> {
  const prev = writeQueues.get(name) ?? Promise.resolve();
  const next = prev
    .catch(() => {
      /* an earlier failed write must not poison the queue */
    })
    .then(async () => {
      const dir = appDataDir();
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, name);
      const tmp = file + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fsp.rename(tmp, file);
    });
  writeQueues.set(name, next);
  return next;
}

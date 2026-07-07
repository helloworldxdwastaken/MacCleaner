import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { CleanResult } from '../models/types';

/**
 * Cleaner — moves files to the system trash and opens paths in the OS.
 * Nothing here ever hard-deletes: every removal goes through the platform's
 * native trash so the user can undo from Finder/Files/Explorer.
 *
 * All commands run through execFile (argv arrays, no shell) so paths with
 * quotes, spaces or $(...) can never be interpreted as shell syntax.
 */

function run(cmd: string, args: string[], timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || 'command failed').trim();
        reject(new Error(detail));
      } else {
        resolve();
      }
    });
  });
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
function appleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Logical size of a path in bytes: the file's own size, or (for a directory)
 * the recursive sum of its contents. Symlinks are counted as their own link
 * size and never followed — mirrors diskScanner's lstat-based, no-follow policy
 * so we never double-count or loop. Unreadable entries contribute 0. Used to
 * report authoritative freed bytes: we measure BEFORE trashing.
 */
async function measureSize(p: string): Promise<number> {
  let stat;
  try {
    stat = await fsp.lstat(p);
  } catch {
    return 0; // vanished / unreadable
  }
  if (!stat.isDirectory()) return stat.size; // files + symlinks: own size, no follow
  let total = 0;
  let entries: string[];
  try {
    entries = await fsp.readdir(p);
  } catch {
    return total; // permission-denied dir — count nothing beneath it
  }
  for (const name of entries) {
    total += await measureSize(path.join(p, name));
  }
  return total;
}

async function trashOne(p: string): Promise<void> {
  // Confirm the path still exists (and learn file-vs-dir for Windows).
  const stat = await fsp.lstat(p); // throws ENOENT -> caught by caller

  switch (process.platform) {
    case 'darwin': {
      const script = `tell application "Finder" to delete POSIX file "${appleScriptString(p)}"`;
      await run('osascript', ['-e', script]);
      return;
    }
    case 'win32': {
      const method = stat.isDirectory() ? 'DeleteDirectory' : 'DeleteFile';
      // FileIO.FileSystem routes through the Recycle Bin natively.
      const ps = [
        'Add-Type -AssemblyName Microsoft.VisualBasic;',
        `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}(`,
        `[string]$env:TREEMAP_TRASH_TARGET,`,
        `'OnlyErrorDialogs', 'SendToRecycleBin')`,
      ].join(' ');
      await new Promise<void>((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', ps],
          { timeout: 20000, windowsHide: true, env: { ...process.env, TREEMAP_TRASH_TARGET: p } },
          (err, _stdout, stderr) => {
            if (err) reject(new Error((stderr || err.message).trim()));
            else resolve();
          }
        );
      });
      return;
    }
    default: {
      // Linux & friends: freedesktop trash via gio (GLib), present on all
      // mainstream desktop distros.
      await run('gio', ['trash', p]);
      return;
    }
  }
}

/** Move every path to the system trash; per-path failures don't abort the batch. */
export async function moveToTrash(paths: string[]): Promise<CleanResult> {
  // macOS: batch into a single Finder `delete {…}` per chunk so clearing a
  // cache folder with hundreds of subfolders doesn't fire hundreds of slow
  // osascript round-trips (which makes the UI look frozen). Falls back to
  // per-path on a batch failure so one bad item never sinks the whole batch.
  if (process.platform === 'darwin') return moveToTrashDarwin(paths);

  const deleted: string[] = [];
  const failed: { path: string; reason: string }[] = [];
  const freedBytes: Record<string, number> = {};

  // Sequential on purpose: parallel powershell/gio invocations are flaky.
  for (const p of paths) {
    // Measure BEFORE trashing so the number reflects what's actually removed.
    const size = await measureSize(p);
    try {
      await trashOne(p);
      deleted.push(p);
      freedBytes[p] = size;
    } catch (err) {
      failed.push({ path: p, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  const totalFreedBytes = Object.values(freedBytes).reduce((s, v) => s + v, 0);
  return { deleted, failed, freedBytes, totalFreedBytes };
}

/** macOS batched trash. Verifies existence first, then deletes in chunks. */
async function moveToTrashDarwin(paths: string[]): Promise<CleanResult> {
  const deleted: string[] = [];
  const failed: { path: string; reason: string }[] = [];
  const freedBytes: Record<string, number> = {};

  // Confirm existence up front so a vanished path is reported, not silently
  // lost, and measure each present path's size BEFORE trashing (once trashed,
  // the source path is gone and can't be re-measured).
  const present: string[] = [];
  const sizeOf = new Map<string, number>();
  for (const p of paths) {
    try {
      await fsp.lstat(p);
      present.push(p);
      sizeOf.set(p, await measureSize(p));
    } catch (err) {
      failed.push({ path: p, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const CHUNK = 50; // keep the AppleScript command a sane length
  for (let i = 0; i < present.length; i += CHUNK) {
    const batch = present.slice(i, i + CHUNK);
    const list = batch.map((p) => `POSIX file "${appleScriptString(p)}"`).join(', ');
    try {
      await run('osascript', ['-e', `tell application "Finder" to delete {${list}}`]);
      for (const p of batch) {
        deleted.push(p);
        freedBytes[p] = sizeOf.get(p) ?? 0;
      }
    } catch {
      // A batch failed (e.g. one protected item). Retry the batch per-path so
      // we still trash the good ones and learn exactly which failed.
      for (const p of batch) {
        try {
          await trashOne(p);
          deleted.push(p);
          freedBytes[p] = sizeOf.get(p) ?? 0;
        } catch (err) {
          failed.push({ path: p, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }
  const totalFreedBytes = Object.values(freedBytes).reduce((s, v) => s + v, 0);
  return { deleted, failed, freedBytes, totalFreedBytes };
}

/**
 * Empty the system Trash. PERMANENT and irreversible — callers must confirm
 * with the user first. macOS only; the scripted Finder verb does not prompt and
 * empties every mounted volume's trash. Takes no path argument, so there is no
 * user input to sanitize and no scan-root guard applies.
 */
export interface EmptyTrashResult {
  removed: number;
  failed: number;
  /** Authoritative bytes freed: measured (recursively) BEFORE each rm. */
  freedBytes: number;
  /** Per-trash-directory breakdown (home Bin + each mounted volume's .Trashes). */
  trashes: { path: string; removed: number; failed: number; freedBytes: number }[];
}

/**
 * Empty ONE trash directory's contents: measure each child's size, then rm it.
 * Per-child errors are counted, never thrown, so one locked item can't abort
 * the rest. A missing directory yields an all-zero result.
 */
async function emptyOneTrashDir(
  trashDir: string
): Promise<{ path: string; removed: number; failed: number; freedBytes: number }> {
  let entries: string[];
  try {
    entries = await fsp.readdir(trashDir);
  } catch {
    // ENOENT (nothing to empty) or EACCES (unreadable volume trash) — skip.
    return { path: trashDir, removed: 0, failed: 0, freedBytes: 0 };
  }

  let removed = 0;
  let failed = 0;
  let freedBytes = 0;
  for (const name of entries) {
    const child = path.join(trashDir, name);
    const size = await measureSize(child); // BEFORE rm — the source is about to vanish
    try {
      await fsp.rm(child, { recursive: true, force: true });
      removed++;
      freedBytes += size;
    } catch {
      failed++; // locked / SIP-protected items — skip, don't abort
    }
  }
  return { path: trashDir, removed, failed, freedBytes };
}

/**
 * Enumerate every trash directory we should empty: the home-volume Bin
 * (~/.Trash) plus each mounted volume's per-user trash (/Volumes/<vol>/.Trashes/<uid>).
 * External-disk and network-volume trashes are what make Finder's "Empty Bin"
 * free more than the home Bin alone. Unreadable/absent volumes are simply not
 * returned (they're guarded per-volume in emptyOneTrashDir anyway).
 */
async function trashDirs(): Promise<string[]> {
  const dirs = [path.join(os.homedir(), '.Trash')];
  const uid = String(os.userInfo().uid);
  let volumes: string[];
  try {
    volumes = await fsp.readdir('/Volumes');
  } catch {
    return dirs; // no /Volumes (unusual) — home Bin only
  }
  for (const vol of volumes) {
    if (vol.startsWith('.')) continue;
    const perUser = path.join('/Volumes', vol, '.Trashes', uid);
    try {
      // Only include a volume trash that actually exists and is a directory;
      // most mounted volumes won't have one until something is trashed there.
      const st = await fsp.lstat(perUser);
      if (st.isDirectory() && !st.isSymbolicLink()) dirs.push(perUser);
    } catch {
      /* no per-user trash on this volume — skip */
    }
  }
  return dirs;
}

export async function emptyTrash(): Promise<EmptyTrashResult> {
  if (process.platform !== 'darwin') {
    throw new Error('Emptying the Trash is only supported on macOS');
  }
  // "Empty the Bin" is the one PERMANENT, non-recoverable operation in the app,
  // and the caller has already confirmed it with the user. We delete each Bin's
  // contents directly: Finder's scripted `empty trash` is unreliable across
  // macOS versions (it pops a dialog a script can't answer, or the relevant
  // properties are removed), and there is no "move the Trash to the Trash".
  // This is the deliberate, sole exception to the trash-only delete rule.
  //
  // Scope: the home-volume Bin (~/.Trash) AND each mounted volume's per-user
  // trash (/Volumes/*/.Trashes/<uid>) so external-disk trash is emptied too,
  // matching Finder. If the home Bin itself is unreadable (no Full Disk Access),
  // surface that as an error the route maps to FULL_DISK_ACCESS_REQUIRED.
  const homeTrash = path.join(os.homedir(), '.Trash');
  try {
    await fsp.readdir(homeTrash);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; // EPERM/EACCES → route maps it
  }

  const dirs = await trashDirs();
  const trashes = [];
  let removed = 0;
  let failed = 0;
  let freedBytes = 0;
  for (const dir of dirs) {
    const r = await emptyOneTrashDir(dir);
    trashes.push(r);
    removed += r.removed;
    failed += r.failed;
    freedBytes += r.freedBytes;
  }
  return { removed, failed, freedBytes, trashes };
}

/** Open System Settings at the Full Disk Access pane (macOS). */
export async function openFullDiskAccessSettings(): Promise<void> {
  if (process.platform !== 'darwin') return;
  await run('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles']);
}

/** True when this process can read the home-volume Bin (proxy for Full Disk Access). */
export async function canAccessTrash(): Promise<boolean> {
  try {
    await fsp.readdir(path.join(os.homedir(), '.Trash'));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true; // missing = nothing to empty
    return false; // EPERM/EACCES = no Full Disk Access
  }
}

/**
 * Open a file/folder with the OS default handler.
 * With `reveal`, highlights the item in Finder/Explorer instead of opening it.
 */
export async function openPath(p: string, reveal = false): Promise<void> {
  await fsp.lstat(p); // throws ENOENT for missing paths

  switch (process.platform) {
    case 'darwin':
      await run('open', reveal ? ['-R', p] : [p]);
      return;
    case 'win32':
      if (reveal) {
        await run('explorer.exe', ['/select,', p]).catch(() => {
          /* explorer returns nonzero exit codes even on success */
        });
      } else {
        // `start` is a cmd builtin; empty title arg guards paths with spaces.
        await run('cmd.exe', ['/c', 'start', '', p]).catch(() => {
          /* same quirk as explorer */
        });
      }
      return;
    default:
      await run('xdg-open', [p]);
      return;
  }
}

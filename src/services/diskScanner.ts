import { promises as fsp, Dirent } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { FileNode, ScanResult, LargeFolder, EmptyFoldersResult, CompareEntry } from '../models/types';
import { saveSnapshot } from './snapshots';
import { getIgnoreMatchers } from './settings';
import { CompiledIgnore, matchesAny } from '../utils/glob';
import { PathRejectedError, sanitizePath } from '../utils/pathSanitizer';

/**
 * DiskScanner — asynchronous recursive directory walker.
 *
 * Design:
 *  - A queue of directory nodes is drained by up to CONCURRENCY workers.
 *  - Each worker readdir()s one directory, lstat()s its file entries in
 *    small parallel batches, and pushes child directories back on the queue.
 *  - Everything is promise-based, so the event loop is never blocked; the
 *    batch size keeps the number of in-flight fs operations bounded
 *    (back-pressure) instead of fanning out the whole tree at once.
 *  - Directory sizes are summed bottom-up in a single pass at the end.
 */

const CONCURRENCY = 8;
const STAT_BATCH = 32;
/** Yield to the event loop after this many entries so SSE stays responsive. */
const YIELD_EVERY = 2000;

const SCAN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const EVICT_INTERVAL_MS = 60 * 1000;

/** In-memory store of all scans, auto-evicted after 30 minutes. */
const scans = new Map<string, ScanResult>();

let evictTimer: NodeJS.Timeout | null = null;

function ensureEvictor(): void {
  if (evictTimer) return;
  evictTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, scan] of scans) {
      if (now - scan.createdAt > SCAN_TTL_MS) {
        scan.cancelled = true;
        scans.delete(id);
      }
    }
  }, EVICT_INTERVAL_MS);
  // Don't let the evictor keep the process alive on shutdown.
  evictTimer.unref();
}

export function getScan(scanId: string): ScanResult | undefined {
  return scans.get(scanId);
}

export function allScans(): ScanResult[] {
  return [...scans.values()];
}

export function cancelAllScans(): void {
  for (const scan of scans.values()) scan.cancelled = true;
}

/**
 * Reject roots so broad that a scan would authorize deletion over the whole
 * disk: the filesystem root itself (and Windows drive roots like C:\), plus
 * the macOS firmlinked data volume, which is the whole disk by another name.
 * The home directory stays allowed — scanning ~ is an advertised feature.
 */
function assertScanRootAllowed(rootPath: string): void {
  if (path.parse(rootPath).root === rootPath) {
    throw new PathRejectedError(
      `Scanning the filesystem root "${rootPath}" is not allowed — pick a folder inside it`,
      'ROOT_TOO_BROAD'
    );
  }
  if (rootPath.toLowerCase() === '/system/volumes/data') {
    throw new PathRejectedError(
      'Scanning "/System/Volumes/Data" (the entire data volume) is not allowed — pick a folder inside it',
      'ROOT_TOO_BROAD'
    );
  }
}

/**
 * Kick off a scan of `rootPath`. Returns the scan record immediately;
 * the walk continues in the background and mutates the record as it goes.
 */
export async function startScan(rootPath: string): Promise<ScanResult> {
  ensureEvictor();

  assertScanRootAllowed(rootPath);

  // Resolve symlinks in the root itself: the registered root grants deletion
  // authorization over everything beneath it, so it must name the real
  // location — a symlinked root must not alias past assertScanRootAllowed or
  // the blocklist (e.g. ~/link -> /System/Volumes/Data).
  const realRoot = await fsp.realpath(rootPath);
  assertScanRootAllowed(realRoot);
  sanitizePath(realRoot); // blocklist check on the resolved location
  rootPath = realRoot;

  // Fail fast on unreadable/nonexistent roots so the API can 4xx properly.
  const rootStat = await fsp.lstat(rootPath);

  // User-configured "don't scan" patterns; a settings problem never blocks a scan.
  const ignore = await getIgnoreMatchers('scan').catch(() => [] as CompiledIgnore[]);

  const scan: ScanResult = {
    scanId: crypto.randomUUID(),
    rootPath,
    status: 'running',
    scanned: 0,
    fileCount: 0,
    dirCount: 0,
    currentPath: rootPath,
    startedAt: Date.now(),
    createdAt: Date.now(),
    cancelled: false,
  };
  scans.set(scan.scanId, scan);

  // Fire and forget — errors land on the record, never as unhandled rejections.
  void walk(scan, rootStat.isDirectory(), ignore).catch((err: unknown) => {
    scan.status = 'error';
    scan.error = err instanceof Error ? err.message : String(err);
    scan.finishedAt = Date.now();
  });

  return scan;
}

function makeNode(fullPath: string, name: string, isDir: boolean, size: number, mtimeMs: number): FileNode {
  const node: FileNode = {
    name,
    path: fullPath,
    size: isDir ? 0 : size,
    type: isDir ? 'dir' : 'file',
    modifiedAt: Math.round(mtimeMs),
    isHidden: name.startsWith('.'),
  };
  if (isDir) {
    node.children = [];
  } else {
    const ext = path.extname(name).toLowerCase().replace(/^\./, '');
    if (ext) node.extension = ext;
  }
  return node;
}

async function walk(scan: ScanResult, rootIsDir: boolean, ignore: CompiledIgnore[]): Promise<void> {
  const rootStat = await fsp.lstat(scan.rootPath);
  const root = makeNode(
    scan.rootPath,
    path.basename(scan.rootPath) || scan.rootPath,
    rootIsDir,
    rootStat.size,
    rootStat.mtimeMs
  );
  scan.scanned = 1;
  if (rootIsDir) scan.dirCount = 1;
  else scan.fileCount = 1;

  if (rootIsDir) {
    await drainQueue(scan, [root], ignore);
  }
  if (scan.cancelled) return;

  sumDirSizes(root);
  pruneTree(root);
  scan.root = root;
  scan.status = 'complete';
  scan.finishedAt = Date.now();
  scan.currentPath = scan.rootPath;

  // Record a history snapshot so Trends works without any user action.
  // Failures here must never fail the scan itself.
  void saveSnapshot(scan).catch((err: unknown) => {
    console.error('[treemap] snapshot save failed:', err);
  });
}

/**
 * Worker pool: up to CONCURRENCY directories are listed at the same time.
 * Resolves when the queue is empty and every worker has finished.
 */
function drainQueue(scan: ScanResult, initial: FileNode[], ignore: CompiledIgnore[]): Promise<void> {
  const queue: FileNode[] = [...initial];
  let active = 0;

  return new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      if (scan.cancelled) {
        if (active === 0) resolve();
        return;
      }
      while (active < CONCURRENCY && queue.length > 0) {
        const dirNode = queue.shift()!;
        active++;
        processDirectory(scan, dirNode, queue, ignore)
          .catch((err: unknown) => reject(err))
          .finally(() => {
            active--;
            if (queue.length === 0 && active === 0) resolve();
            else pump();
          });
      }
      if (queue.length === 0 && active === 0) resolve();
    };
    pump();
  });
}

/**
 * List one directory, stat its entries, attach children, enqueue subdirs.
 * Permission errors are swallowed per-directory: the dir simply stays empty
 * rather than failing the whole scan.
 */
async function processDirectory(
  scan: ScanResult,
  dirNode: FileNode,
  queue: FileNode[],
  ignore: CompiledIgnore[]
): Promise<void> {
  if (scan.cancelled) return;

  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dirNode.path, { withFileTypes: true });
  } catch {
    return; // EACCES / EPERM / ENOENT(race) — skip silently
  }

  scan.currentPath = dirNode.path;
  const children = dirNode.children!;

  // Honor the user's "don't scan" list before paying for any lstat calls.
  if (ignore.length > 0) {
    entries = entries.filter((ent) => !matchesAny(ignore, path.join(dirNode.path, ent.name), ent.name));
  }

  for (let i = 0; i < entries.length; i += STAT_BATCH) {
    if (scan.cancelled) return;
    const batch = entries.slice(i, i + STAT_BATCH);

    const settled = await Promise.allSettled(
      batch.map(async (ent) => {
        const fullPath = path.join(dirNode.path, ent.name);

        if (ent.isDirectory() && !ent.isSymbolicLink()) {
          const stat = await fsp.lstat(fullPath);
          return makeNode(fullPath, ent.name, true, 0, stat.mtimeMs);
        }
        // Files, symlinks (not followed — lstat reports the link itself),
        // sockets, fifos: record as a leaf with whatever size lstat reports.
        const stat = await fsp.lstat(fullPath);
        return makeNode(fullPath, ent.name, false, stat.size, stat.mtimeMs);
      })
    );

    for (const result of settled) {
      if (result.status !== 'fulfilled') continue; // entry vanished mid-scan
      const child = result.value;
      children.push(child);
      scan.scanned++;
      if (child.type === 'dir') {
        scan.dirCount++;
        queue.push(child);
      } else {
        scan.fileCount++;
      }
    }

    if (scan.scanned % YIELD_EVERY < STAT_BATCH) {
      // Explicit yield so progress SSE and other requests get CPU time
      // even while crunching one enormous directory.
      await new Promise<void>((r) => setImmediate(r));
    }
  }
}

/** Bottom-up recursive sum: directory size = Σ children sizes. */
function sumDirSizes(node: FileNode): number {
  if (node.type === 'file' || !node.children) return node.size;
  let total = 0;
  for (const child of node.children) total += sumDirSizes(child);
  node.size = total;
  return total;
}

/**
 * Cap on nodes retained per completed scan. The full tree is held in memory
 * for the scan's TTL and JSON.stringify'd whole into the SSE 'complete'
 * frame; ~500k nodes keeps that serialized frame in the tens of MB.
 */
const MAX_TREE_NODES = 500_000;

/** Live node count of a subtree, honoring already-collapsed directories. */
function liveCount(node: FileNode): number {
  let n = 1;
  if (node.children) for (const c of node.children) n += liveCount(c);
  return n;
}

/**
 * Bound a completed tree to ~MAX_TREE_NODES nodes by collapsing the deepest
 * directories into their parent: the parent keeps its aggregated size but
 * drops its children and is marked `truncated` so renderers can tell detail
 * was hidden. A single post-processing pass at completion — the walker is
 * unchanged, and leaf-dir handling elsewhere already tolerates a dir with
 * no children.
 */
function pruneTree(root: FileNode): void {
  // One DFS to count nodes and index every directory with its depth.
  let count = 0;
  const dirs: { node: FileNode; depth: number }[] = [];
  const index = (node: FileNode, depth: number): void => {
    count++;
    if (node.type !== 'dir' || !node.children) return;
    dirs.push({ node, depth });
    for (const c of node.children) index(c, depth + 1);
  };
  index(root, 0);
  if (count <= MAX_TREE_NODES) return;

  // Collapse deepest first. Descendants are processed before their ancestors,
  // so a dir is never detached by an earlier collapse, and liveCount() (which
  // sees earlier collapses below) is never double-subtracted.
  dirs.sort((a, b) => b.depth - a.depth);
  for (const { node } of dirs) {
    if (count <= MAX_TREE_NODES) break;
    if (node === root || !node.children) continue;
    count -= liveCount(node) - 1;
    node.children = undefined;
    node.truncated = true;
  }
}

/* ---------- Aggregations over a completed scan ---------- */

export function collectLargestFiles(root: FileNode, limit: number, minSize: number) {
  const top: FileNode[] = [];
  // Simple bounded insertion keeps memory flat even for huge trees.
  const visit = (node: FileNode): void => {
    if (node.type === 'file') {
      if (node.size < minSize) return;
      if (top.length < limit) {
        top.push(node);
        if (top.length === limit) top.sort((a, b) => b.size - a.size);
      } else if (node.size > top[top.length - 1].size) {
        top[top.length - 1] = node;
        top.sort((a, b) => b.size - a.size);
      }
      return;
    }
    if (node.children) for (const c of node.children) visit(c);
  };
  visit(root);
  top.sort((a, b) => b.size - a.size);
  return top.map((f) => ({
    name: f.name,
    path: f.path,
    size: f.size,
    extension: f.extension,
    modifiedAt: f.modifiedAt,
  }));
}

export function collectLargestFolders(root: FileNode, limit: number, minSize: number): LargeFolder[] {
  const found: LargeFolder[] = [];
  // Recursive visit returns the subtree's file count so each folder's
  // recursive count is computed in the same single pass as the walk.
  const visit = (node: FileNode): number => {
    if (node.type === 'file') return 1;
    let count = 0;
    if (node.children) for (const c of node.children) count += visit(c);
    if (node !== root && node.size >= minSize) {
      found.push({
        name: node.name,
        path: node.path,
        size: node.size,
        fileCount: count,
        modifiedAt: node.modifiedAt,
      });
    }
    return count;
  };
  visit(root);
  return found.sort((a, b) => b.size - a.size).slice(0, limit);
}

/** Junk files that don't stop a folder from counting as empty. */
const JUNK_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.localized']);
const EMPTY_FOLDERS_CAP = 1000;

/**
 * Find recursively-empty directories: no files anywhere below (only other
 * empty dirs). With `ignoreJunk`, OS metadata files like .DS_Store don't
 * count as content. Returns only the topmost empty dirs — trashing those
 * removes everything beneath them anyway.
 */
export function collectEmptyFolders(root: FileNode, ignoreJunk: boolean): EmptyFoldersResult {
  const isJunk = (n: FileNode): boolean => ignoreJunk && JUNK_FILES.has(n.name.toLowerCase());
  const emptyDirs = new Set<FileNode>();

  // Pass 1, bottom-up: a dir is empty when every child is junk or an empty dir.
  const compute = (node: FileNode): boolean => {
    if (node.type === 'file') return isJunk(node);
    // A truncated dir hides real content dropped by the tree cap — never
    // report it (or anything above it) as empty.
    if (node.truncated) return false;
    let empty = true;
    if (node.children) {
      for (const c of node.children) {
        if (!compute(c)) empty = false;
      }
    }
    if (empty) emptyDirs.add(node);
    return empty;
  };
  compute(root);
  emptyDirs.delete(root); // never offer to trash the scanned root itself

  // Pass 2, top-down: report only topmost empty dirs (their whole subtree is
  // empty, so trashing the top one is sufficient) and stop descending there.
  const topmost: { name: string; path: string }[] = [];
  let truncated = false;
  const walk = (node: FileNode): void => {
    if (!node.children) return;
    for (const c of node.children) {
      if (c.type !== 'dir') continue;
      if (emptyDirs.has(c)) {
        if (topmost.length < EMPTY_FOLDERS_CAP) topmost.push({ name: c.name, path: c.path });
        else truncated = true;
      } else {
        walk(c);
      }
    }
  };
  walk(root);

  return { folders: topmost, totalCount: emptyDirs.size, truncated };
}

const COMPARE_CAP = 1000;

/**
 * Structural diff of two scans of the same root. Subtrees present in only
 * one scan collapse to a single added/removed entry (a new node_modules is
 * one row, not ten thousand); files present in both are emitted when their
 * size changed. Directories present in both are never emitted themselves —
 * their change is fully explained by the child entries.
 */
export function compareTrees(rootA: FileNode, rootB: FileNode): { entries: CompareEntry[]; truncated: boolean } {
  const entries: CompareEntry[] = [];

  const emit = (node: FileNode, sizeA: number | null, sizeB: number | null): void => {
    const delta = (sizeB ?? 0) - (sizeA ?? 0);
    if (delta === 0 && sizeA !== null && sizeB !== null) return;
    entries.push({
      path: node.path,
      name: node.name,
      type: node.type,
      sizeA,
      sizeB,
      delta,
      change: sizeA === null ? 'added' : sizeB === null ? 'removed' : delta > 0 ? 'grew' : 'shrank',
    });
  };

  const recurse = (a: FileNode, b: FileNode): void => {
    const aChildren = new Map<string, FileNode>();
    for (const c of a.children ?? []) aChildren.set(c.name, c);

    for (const cb of b.children ?? []) {
      const ca = aChildren.get(cb.name);
      if (!ca) {
        emit(cb, null, cb.size); // appeared between scans
        continue;
      }
      aChildren.delete(cb.name);
      if (ca.type === 'dir' && cb.type === 'dir') {
        recurse(ca, cb);
      } else if (ca.size !== cb.size || ca.type !== cb.type) {
        emit(cb, ca.size, cb.size);
      }
    }
    for (const ca of aChildren.values()) {
      emit(ca, ca.size, null); // disappeared between scans
    }
  };

  recurse(rootA, rootB);
  entries.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return { entries: entries.slice(0, COMPARE_CAP), truncated: entries.length > COMPARE_CAP };
}

export function collectFileTypes(root: FileNode) {
  const byExt = new Map<string, { count: number; totalSize: number }>();
  const visit = (node: FileNode): void => {
    if (node.type === 'file') {
      const ext = node.extension ?? '(none)';
      const entry = byExt.get(ext) ?? { count: 0, totalSize: 0 };
      entry.count++;
      entry.totalSize += node.size;
      byExt.set(ext, entry);
      return;
    }
    if (node.children) for (const c of node.children) visit(c);
  };
  visit(root);
  return [...byExt.entries()]
    .map(([ext, v]) => ({ ext, count: v.count, totalSize: v.totalSize }))
    .sort((a, b) => b.totalSize - a.totalSize);
}

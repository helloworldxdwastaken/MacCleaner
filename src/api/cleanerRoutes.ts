import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { allScans, startScan } from '../services/diskScanner';
import { emptyTrash, canAccessTrash, openFullDiskAccessSettings } from '../services/cleaner';
import { CACHE_EXCLUDE, buildCachePlan, CachePlanEntry } from '../services/macClean';
import { AppError } from '../middleware/errorHandler';
import { FileNode, ScanResult } from '../models/types';

/**
 * cleanerRoutes — the macOS "Cleaner" suite. v1 ships "Fast Clean": clear
 * application caches (to Trash, recoverable) and empty the Bin (permanent).
 *
 * Caches are cleared through the SAME pipeline as everything else: we run a
 * real `startScan()` of the cache directory, which registers it as a scan root,
 * so the existing `DELETE /api/files` (requireInsideScanRoot) authorizes the
 * trash once the scan completes — with no change to the safety model. The
 * frontend polls `GET /api/scan/:id/result` (202 until the scan is complete)
 * for sizes + the child paths to trash. All scans here pass
 * `{ snapshot: false }` — these are internal utility probes, not user-facing
 * scans, and must not create Trends rows or scheduler baselines.
 *
 * Emptying the Bin is a separate, permanent verb with a two-step confirm
 * token and no path input (see POST /api/cleaner/empty-trash below).
 */

export const cleanerRouter = Router();

function requireMac(): void {
  if (process.platform !== 'darwin') {
    throw new AppError(409, 'NOT_MACOS', 'Clean the Mac is only available on macOS');
  }
}

/** Max age of a scan a repeat cache-plan poll may adopt (see reusableScan). */
const SCAN_REUSE_MS = 10 * 60 * 1000;

/**
 * A recent live-or-complete scan of `root` (same realpath), if any. The
 * cache-plan 202 contract invites the frontend to re-poll this endpoint while
 * the authorizing scan is still walking ~/Library/Caches; without reuse every
 * poll would start a fresh (potentially minute-long) walk. Scans are keyed by
 * scanId, so match on the realpath'd root the way startScan registers it.
 * Errored/cancelled/stale scans are never adopted.
 */
async function reusableScan(root: string): Promise<ScanResult | undefined> {
  try {
    const real = await fsp.realpath(root);
    // Scan newest-first so an adopted tree is as fresh as possible.
    return [...allScans()]
      .reverse()
      .find(
        (s) =>
          s.rootPath === real &&
          !s.cancelled &&
          s.status !== 'error' &&
          Date.now() - s.createdAt < SCAN_REUSE_MS
      );
  } catch {
    return undefined; // unreadable root — let startScan produce the error
  }
}

/**
 * Per-content sizes for the cache plan, read from the COMPLETED Caches scan
 * tree (which already measured every subtree bottom-up) and keyed by the
 * plan's trashable content paths, so the frontend can show accurate
 * estimates without a second walk. Content nodes are looked up by basename
 * at the two levels that matter (Caches child → its children). Content paths
 * whose node is missing (raced away mid-scan) or whose tree was truncated
 * (children pruned) get no entry — the frontend treats that as unknown size.
 */
function contentSizes(root: FileNode | undefined, entries: CachePlanEntry[]): Record<string, number> {
  const sizes: Record<string, number> = {};
  if (!root?.children) return sizes;
  const byName = new Map(root.children.map((c) => [c.name, c]));
  for (const entry of entries) {
    const dirNode = byName.get(entry.name);
    if (!dirNode) continue;
    if (dirNode.type !== 'dir') {
      // Loose file directly under Caches: the entry has exactly one target.
      sizes[entry.contents[0]] = dirNode.size;
      continue;
    }
    if (!dirNode.children) continue; // truncated — per-child attribution unavailable
    const kids = new Map(dirNode.children.map((c) => [c.name, c]));
    for (const content of entry.contents) {
      const kid = kids.get(path.basename(content));
      if (kid) sizes[content] = kid.size;
    }
  }
  return sizes;
}

/**
 * GET /api/cleaner/fast-clean
 * Kicks off scans of ~/Library/Caches and ~/.Trash and returns a scanId for
 * each (poll /api/scan/:id/result for sizes), plus the cache exclude list.
 * trash.scanId is null when ~/.Trash does not exist yet (nothing to size or
 * empty) — not an error.
 */
cleanerRouter.get('/cleaner/fast-clean', async (_req: Request, res: Response) => {
  requireMac();
  const home = os.homedir();
  const cachePath = path.join(home, 'Library', 'Caches');
  const trashPath = path.join(home, '.Trash');

  const [cacheScan, trashAccessible] = await Promise.all([
    startScan(cachePath, { snapshot: false }),
    canAccessTrash(),
  ]);

  // The Bin can legitimately not exist yet (fresh account, nothing ever
  // trashed): that's an ENOENT, not an access failure — degrade to no trash
  // scan (scanId null, accessible stays true, matching canAccessTrash's
  // ENOENT → true) instead of failing the whole request.
  let trashScanId: string | null = null;
  try {
    trashScanId = (await startScan(trashPath, { snapshot: false })).scanId;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  res.json({
    cache: { path: cachePath, scanId: cacheScan.scanId },
    // trashAccessible=false → the Bin is TCC-protected and we lack Full Disk
    // Access, so its size reads as 0 and emptying will fail until granted.
    // scanId=null → the Bin does not exist yet — nothing to size or empty.
    trash: { path: trashPath, scanId: trashScanId, accessible: trashAccessible },
    exclude: [...CACHE_EXCLUDE],
  });
});

/**
 * GET /api/cleaner/cache-plan
 * The SAFE fast-clean plan for ~/Library/Caches: contents-only clearing that
 * (a) skips the safelist, (b) skips caches of currently-running apps, and
 * (c) targets each cache dir's CONTENTS (never the cache root dir itself).
 *
 * We `startScan()` the Caches root first so every returned content path is
 * authorized by the existing DELETE /api/files (requireInsideScanRoot) with no
 * change to the safety model. The scan passes `{ snapshot: false }` — it is a
 * utility probe and must never create a Trends row or scheduler baseline. The
 * frontend trashes `flatPaths` via that endpoint
 * and credits the server's authoritative freedBytes (see DELETE response).
 */
cleanerRouter.get('/cleaner/cache-plan', async (_req: Request, res: Response) => {
  requireMac();
  const plan = await buildCachePlan();
  // Register the Caches root as a scan root so the child content paths validate.
  // Repeat polls (the 202 loop below) adopt the in-flight scan instead of
  // starting another walk of the same directory.
  const scan = (await reusableScan(plan.root)) ?? (await startScan(plan.root, { snapshot: false }));
  // flatPaths are trashable the moment we respond, but DELETE /api/files only
  // authorizes COMPLETED scans — wait for this one to settle first.
  const deadline = Date.now() + 60000; // generous cap for a large Caches dir
  while (scan.status === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 60));
  }
  if (scan.status !== 'complete') {
    // The authorizing scan didn't settle: returning flatPaths now would hand
    // the frontend a list DELETE /api/files would reject wholesale. Accept
    // the request instead (202) and hand back the scan — the frontend polls
    // and retries once the scan completes or reports an error.
    res.status(202).json({ scanId: scan.scanId, status: scan.status });
    return;
  }
  const flatPaths = plan.entries.flatMap((e) => e.contents);
  res.json({
    root: plan.root,
    scanId: scan.scanId,
    entries: plan.entries,
    flatPaths,
    excluded: plan.excluded,
    skippedRunning: plan.skippedRunning,
    // Real per-entry sizes, measured by the scan itself (see contentSizes).
    sizes: contentSizes(scan.root, plan.entries),
  });
});

/** POST /api/cleaner/open-fda — open the Full Disk Access settings pane. */
cleanerRouter.post('/cleaner/open-fda', async (_req: Request, res: Response) => {
  requireMac();
  try {
    await openFullDiskAccessSettings();
    res.json({ opened: true });
  } catch (err) {
    // `open` failing (missing binary, spawn error, timeout) must surface as a
    // clean, recognizable JSON error — not a raw 500 INTERNAL.
    throw new AppError(500, 'OPEN_FDA_FAILED', err instanceof Error ? err.message : String(err));
  }
});

/**
 * POST /api/cleaner/empty-trash — PERMANENT, two-step confirmed.
 *
 * This is the app's ONLY irreversible operation, so it never sits one POST
 * away from destruction. The caller must run BOTH steps:
 *
 *   Step 1  POST with NO body (or a body without a valid confirmToken)
 *           → 200 { confirmToken } … nothing is emptied.
 *   Step 2  POST with body { confirmToken: <token from step 1> }
 *           → 200 { emptied: true, removed, failed, freedBytes, trashes }
 *           … the Trash is emptied NOW and cannot be undone.
 *
 * Rules:
 *  - Tokens are single-use, held only in this process's memory (they die with
 *    the launch, like the API token) and expire 30 s after issuance
 *    (EMPTY_TRASH_CONFIRM_TTL_MS). Issuance prunes expired tokens so the map
 *    stays bounded.
 *  - Step 2 with a missing / unknown / already-used / expired token is
 *    rejected with 409 { error, code: 'EMPTY_TRASH_CONFIRM_REQUIRED' } and
 *    does nothing — run step 1 again for a fresh token.
 *  - No path input → no path guards apply (nothing to sanitize).
 */
const EMPTY_TRASH_CONFIRM_TTL_MS = 30_000;
/** Issued confirm tokens: token → issued-at epoch ms. */
const emptyTrashConfirmTokens = new Map<string, number>();

/** Drop expired confirm tokens so the in-memory map can't grow unbounded. */
function pruneEmptyTrashConfirmTokens(now: number): void {
  for (const [token, issuedAt] of emptyTrashConfirmTokens) {
    if (now - issuedAt >= EMPTY_TRASH_CONFIRM_TTL_MS) emptyTrashConfirmTokens.delete(token);
  }
}

cleanerRouter.post('/cleaner/empty-trash', async (req: Request, res: Response) => {
  requireMac();
  const now = Date.now();
  const supplied = typeof req.body?.confirmToken === 'string' ? req.body.confirmToken : '';

  if (supplied) {
    // Step 2: consume the token FIRST — single-use even when expired, so a
    // replayed stale token can never fire the destructive verb twice.
    const issuedAt = emptyTrashConfirmTokens.get(supplied);
    emptyTrashConfirmTokens.delete(supplied);
    if (issuedAt === undefined || now - issuedAt >= EMPTY_TRASH_CONFIRM_TTL_MS) {
      throw new AppError(
        409,
        'EMPTY_TRASH_CONFIRM_REQUIRED',
        'Missing, expired or already-used confirmToken — POST /api/cleaner/empty-trash with no body first to get a fresh one.'
      );
    }
    try {
      const result = await emptyTrash();
      res.json({ emptied: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/EPERM|EACCES|not permitted/i.test(msg)) {
        throw new AppError(
          403,
          'FULL_DISK_ACCESS_REQUIRED',
          'MacCleaner needs Full Disk Access to empty the Bin. Grant it in System Settings → Privacy & Security → Full Disk Access.'
        );
      }
      throw new AppError(500, 'EMPTY_TRASH_FAILED', msg);
    }
    return;
  }

  // Step 1: issue a fresh single-use confirm token. Nothing is touched —
  // emptying only happens on the matching second POST.
  pruneEmptyTrashConfirmTokens(now);
  const confirmToken = randomUUID();
  emptyTrashConfirmTokens.set(confirmToken, now);
  res.json({ confirmToken });
});

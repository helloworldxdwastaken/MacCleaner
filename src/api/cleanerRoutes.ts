import { Router, Request, Response } from 'express';
import os from 'os';
import path from 'path';
import { startScan } from '../services/diskScanner';
import { emptyTrash, canAccessTrash, openFullDiskAccessSettings } from '../services/cleaner';
import { CACHE_EXCLUDE, buildCachePlan } from '../services/macClean';
import { AppError } from '../middleware/errorHandler';

/**
 * cleanerRoutes — the macOS "Cleaner" suite. v1 ships "Fast Clean": clear
 * application caches (to Trash, recoverable) and empty the Bin (permanent).
 *
 * Caches are cleared through the SAME pipeline as everything else: we run a
 * real `startScan()` of the cache directory, which registers it as a scan root,
 * so the existing `DELETE /api/files` (requireInsideScanRoot) authorizes the
 * trash once the scan completes — with no change to the safety model. The
 * frontend polls `GET /api/scan/:id/result` (202 until the scan is complete)
 * for sizes + the child paths to trash.
 *
 * Emptying the Bin is a separate, permanent osascript verb with no path input
 * (see emptyTrash()).
 */

export const cleanerRouter = Router();

function requireMac(): void {
  if (process.platform !== 'darwin') {
    throw new AppError(409, 'NOT_MACOS', 'Clean the Mac is only available on macOS');
  }
}

/**
 * GET /api/cleaner/fast-clean
 * Kicks off scans of ~/Library/Caches and ~/.Trash and returns a scanId for
 * each (poll /api/scan/:id/result for sizes), plus the cache exclude list.
 */
cleanerRouter.get('/cleaner/fast-clean', async (_req: Request, res: Response) => {
  requireMac();
  const home = os.homedir();
  const cachePath = path.join(home, 'Library', 'Caches');
  const trashPath = path.join(home, '.Trash');

  const [cacheScan, trashScan, trashAccessible] = await Promise.all([
    startScan(cachePath),
    startScan(trashPath),
    canAccessTrash(),
  ]);

  res.json({
    cache: { path: cachePath, scanId: cacheScan.scanId },
    // trashAccessible=false → the Bin is TCC-protected and we lack Full Disk
    // Access, so its size reads as 0 and emptying will fail until granted.
    trash: { path: trashPath, scanId: trashScan.scanId, accessible: trashAccessible },
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
 * change to the safety model. The frontend trashes `flatPaths` via that endpoint
 * and credits the server's authoritative freedBytes (see DELETE response).
 */
cleanerRouter.get('/cleaner/cache-plan', async (_req: Request, res: Response) => {
  requireMac();
  const plan = await buildCachePlan();
  // Register the Caches root as a scan root so the child content paths validate.
  const scan = await startScan(plan.root);
  // flatPaths are trashable the moment we respond, but DELETE /api/files only
  // authorizes COMPLETED scans — wait for this one to settle first.
  const deadline = Date.now() + 60000; // generous cap for a large Caches dir
  while (scan.status === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 60));
  }
  const flatPaths = plan.entries.flatMap((e) => e.contents);
  res.json({
    root: plan.root,
    scanId: scan.scanId,
    entries: plan.entries,
    flatPaths,
    excluded: plan.excluded,
    skippedRunning: plan.skippedRunning,
  });
});

/** POST /api/cleaner/open-fda — open the Full Disk Access settings pane. */
cleanerRouter.post('/cleaner/open-fda', async (_req: Request, res: Response) => {
  requireMac();
  await openFullDiskAccessSettings();
  res.json({ opened: true });
});

/**
 * POST /api/cleaner/empty-trash
 * PERMANENT. No path input → no guards apply (nothing to sanitize). The
 * frontend must confirm with the user before calling this.
 */
cleanerRouter.post('/cleaner/empty-trash', async (_req: Request, res: Response) => {
  requireMac();
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
});

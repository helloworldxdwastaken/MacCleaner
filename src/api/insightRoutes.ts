import { Router, Request, Response } from 'express';
import { requireScan, clampInt } from './scanRoutes';
import {
  collectLargestFolders,
  collectEmptyFolders,
} from '../services/diskScanner';
import {
  getDuplicateJob,
  getDuplicateJobRecord,
  getDuplicateTreeTruncated,
  groupIdsFullyTrashed,
} from '../services/duplicateFinder';
import {
  listSnapshots,
  listSnapshotRoots,
  listAllSnapshotsSlim,
  getSnapshot,
  diffSnapshots,
} from '../services/snapshots';
import { guardQueryPath } from '../middleware/pathGuard';
import { AppError } from '../middleware/errorHandler';
import { ScanResult } from '../models/types';

/**
 * insightRoutes — analysis endpoints layered on top of completed scans:
 * duplicates, largest folders, empty folders, and snapshot history (the
 * storage-trend chart on the Dashboard).
 */

export const insightRouter = Router();

/**
 * Upper bound on the paths accepted by POST /duplicates/validate-delete. The
 * global 1 MB JSON body limit already caps request size; a count cap keeps
 * the Set build and the per-group membership scan trivially cheap.
 */
const MAX_VALIDATE_PATHS = 10_000;

function requireCompleteScan(req: Request, idSource: unknown): ScanResult & { root: NonNullable<ScanResult['root']> } {
  const scan = requireScan(req, idSource);
  if (scan.status === 'running') {
    throw new AppError(409, 'SCAN_RUNNING', 'Scan is still running — try again when it completes');
  }
  if (scan.status === 'error' || !scan.root) {
    throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  }
  return scan as ScanResult & { root: NonNullable<ScanResult['root']> };
}

/**
 * GET /api/duplicates?scanId=&minSize=
 * First call starts the hashing job; poll until status === 'complete'.
 * 202 + progress while hashing, 200 + groups when done, 500 when the job
 * failed (jobs are error-sticky in the service — no silent restart).
 * Groups list EVERY path (list-all-paths / count-by-distinct-inode design)
 * and carry an additive `sharedInode: boolean` (≥2 paths share one inode —
 * trashing all paths of that inode frees nothing until the group's other
 * inodes go). Additive fields only: existing keys keep their meaning
 * (`count` is the distinct-inode count), so older clients stay compatible.
 */
insightRouter.get('/duplicates', (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  // Floor of 256 bytes: below that, "duplicates" are noise (symlink stubs,
  // linker crumbs) and the staging overhead per file dwarfs any win.
  const minSize = clampInt(req.query.minSize, 1024, 256, Number.MAX_SAFE_INTEGER);

  const job = getDuplicateJob(scan, minSize);
  if (job.status === 'running') {
    res.status(202).json({ status: 'running', hashed: job.hashed, toHash: job.toHash });
    return;
  }
  if (job.status === 'error') {
    throw new AppError(500, 'DUPLICATES_FAILED', job.error ?? 'Duplicate detection failed');
  }
  // The service keeps the FULL group list on the job (validate-delete must
  // check every group, not just the visible ones); the response-size guard
  // (top 500 by reclaimable) applies here, at the serialization boundary.
  res.json({
    status: 'complete',
    scanId: scan.scanId,
    minSize: job.minSize,
    treeTruncated: getDuplicateTreeTruncated(scan.scanId),
    groups: (job.groups ?? []).slice(0, 500),
    groupCount: job.groupCount ?? 0,
    totalReclaimable: job.totalReclaimable ?? 0,
    tookMs: (job.finishedAt ?? job.startedAt) - job.startedAt,
  });
});

/**
 * POST /api/duplicates/validate-delete?scanId=   body: { paths: string[] }
 * Server-side keep-one guard WITHOUT touching the delete route: given the
 * paths the frontend is about to trash, returns the ids of duplicate groups
 * whose EVERY member is in that set. A non-empty `groupsFullyTrashed` means
 * the last reachable copy of that content would land in the Trash — the
 * frontend must refuse to proceed. Read-only: never starts a hashing job.
 */
insightRouter.post('/duplicates/validate-delete', (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  const raw = (req.body as { paths?: unknown } | undefined)?.paths;
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_VALIDATE_PATHS ||
    raw.some((p) => typeof p !== 'string' || p.length === 0)
  ) {
    throw new AppError(
      400,
      'BAD_PATHS',
      `body must be { paths: string[] } with 1–${MAX_VALIDATE_PATHS} non-empty entries`
    );
  }
  const job = getDuplicateJobRecord(scan.scanId);
  if (!job || job.status !== 'complete') {
    throw new AppError(
      409,
      'DUPLICATES_NOT_READY',
      'Duplicate results are not ready — poll GET /api/duplicates until status is complete'
    );
  }
  res.json({ groupsFullyTrashed: groupIdsFullyTrashed(job.groups, raw as string[]) });
});

/** GET /api/large-folders?scanId=&limit=20&minSize=1048576 */
insightRouter.get('/large-folders', (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  const limit = clampInt(req.query.limit, 20, 1, 500);
  const minSize = clampInt(req.query.minSize, 1_048_576, 0, Number.MAX_SAFE_INTEGER);
  res.json({ folders: collectLargestFolders(scan.root, limit, minSize) });
});

/** GET /api/empty-folders?scanId=&ignoreJunk=true */
insightRouter.get('/empty-folders', (req: Request, res: Response) => {
  const scan = requireCompleteScan(req, req.query.scanId);
  const ignoreJunk = String(req.query.ignoreJunk ?? 'true') !== 'false';
  res.json(collectEmptyFolders(scan.root, ignoreJunk));
});

/**
 * GET /api/snapshots            -> roots that have history
 * GET /api/snapshots?path=<dir> -> snapshots for that root, oldest first
 * GET /api/snapshots?all=true   -> every snapshot, slim (no topEntries)
 */
insightRouter.get('/snapshots', guardQueryPath('path'), async (req: Request, res: Response) => {
  const rootPath = req.query.path as string | undefined;
  if (rootPath) {
    res.json({ rootPath, snapshots: await listSnapshots(rootPath) });
  } else if (String(req.query.all ?? '') === 'true') {
    res.json({ snapshots: await listAllSnapshotsSlim() });
  } else {
    res.json({ roots: await listSnapshotRoots() });
  }
});

/** GET /api/snapshots/compare?a=<id>&b=<id> — deltas between two snapshots. */
insightRouter.get('/snapshots/compare', async (req: Request, res: Response) => {
  const [a, b] = await Promise.all([
    getSnapshot(String(req.query.a ?? '')),
    getSnapshot(String(req.query.b ?? '')),
  ]);
  if (!a || !b) throw new AppError(404, 'SNAPSHOT_NOT_FOUND', 'Unknown snapshot id');
  if (a.rootPath !== b.rootPath) {
    throw new AppError(400, 'ROOT_MISMATCH', 'Snapshots must cover the same root path');
  }
  res.json(diffSnapshots(a, b));
});

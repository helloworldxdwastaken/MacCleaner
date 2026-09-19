import { Router, Request, Response } from 'express';
import { startScan, getScan, collectLargestFiles, collectFileTypes } from '../services/diskScanner';
import { buildTreemap, findNodeByPath } from '../utils/treemap';
import { isInside } from '../utils/pathSanitizer';
import { guardBodyPath, guardQueryPath } from '../middleware/pathGuard';
import { AppError } from '../middleware/errorHandler';
import { ScanResult, ScanEvent } from '../models/types';

export const scanRouter = Router();

/* ---------- SSE client registry (drained on graceful shutdown) ---------- */

interface SseClient {
  res: Response;
  timer: NodeJS.Timeout;
}
const sseClients = new Set<SseClient>();

/**
 * Wire payload accepted by sseSend. Deliberately a superset of ScanEvent: the
 * SSE 'complete' frame intentionally drops `root` (see finish()) and carries
 * `scanId` instead, so the stream stays tiny without widening the shared
 * ScanEvent contract in models/types.ts.
 */
type SseEvent = ScanEvent | { type: 'complete'; scanId: string };

/**
 * Guarded stream write. A client can die between our timer ticks, and writing
 * to an ended/destroyed socket throws (ERR_STREAM_WRITE_AFTER_END / EPIPE);
 * without this guard the throw unwinds out of the scan-completion path
 * (finish → sseSend) or the keep-alive tick as an uncaught exception and can
 * kill the whole server. A dropped frame is harmless: the client's 'close'
 * handler (closeClient) does the cleanup.
 */
function sseWrite(res: Response, chunk: string): void {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(chunk);
  } catch {
    /* socket died mid-write — nothing to salvage */
  }
}

function sseSend(res: Response, event: SseEvent): void {
  // JSON.stringify never emits raw newlines, so one data: line is enough.
  sseWrite(res, `data: ${JSON.stringify(event)}\n\n`);
}

function closeClient(client: SseClient): void {
  clearInterval(client.timer);
  sseClients.delete(client);
  try {
    client.res.end();
  } catch {
    /* already gone */
  }
}

/** Called from index.ts on SIGTERM/SIGINT: tell clients, then close streams. */
export function drainSseClients(): void {
  for (const client of [...sseClients]) {
    try {
      sseSend(client.res, { type: 'shutdown' });
    } catch {
      /* socket already dead */
    }
    closeClient(client);
  }
}

export function activeSseCount(): number {
  return sseClients.size;
}

/* ------------------------------ Routes ------------------------------ */

/** Shared with insightRoutes: resolve a scanId or 404 cleanly. */
export function requireScan(_req: Request, idSource: unknown): ScanResult {
  const scan = getScan(String(idSource ?? ''));
  if (!scan) {
    throw new AppError(404, 'SCAN_NOT_FOUND', 'Unknown or expired scanId');
  }
  return scan;
}

/** POST /api/scan  { path } -> { scanId } */
scanRouter.post('/scan', guardBodyPath, async (req: Request, res: Response) => {
  const { path: scanPath } = req.body as { path: string };
  const scan = await startScan(scanPath); // lstat failures -> errorHandler maps to 404/403
  res.status(202).json({ scanId: scan.scanId });
});

/**
 * DELETE /api/scan/:scanId — user-reachable cancel. Only a RUNNING scan is
 * cancelled: the walker is cooperative (checks `cancelled` between batches)
 * and flipping status to 'error' makes any open SSE progress stream emit its
 * terminal frame and close. WHY not mutate terminated scans: a completed
 * scan's status is what authorizes deletes inside its root
 * (requireInsideScanRoot), so it must stay 'complete'; cancelling an
 * already-terminated scan is a no-op that just reports current state.
 */
scanRouter.delete('/scan/:scanId', (req: Request, res: Response) => {
  const scan = requireScan(req, req.params.scanId);
  if (scan.status === 'running') {
    scan.cancelled = true;
    scan.status = 'error';
    scan.error = 'cancelled';
    scan.finishedAt = Date.now();
  }
  res.json({ scanId: scan.scanId, status: scan.status });
});

/** GET /api/scan/:scanId/progress — Server-Sent Events stream. */
scanRouter.get('/scan/:scanId/progress', (req: Request, res: Response) => {
  // Bound the live-stream registry: each client holds a 150ms timer + a socket.
  // Authenticated local surface only, but 10 req/s of new streams could still
  // pile up fds/memory — refuse beyond 50 concurrent streams.
  if (activeSseCount() >= 50) {
    res.status(429).json({ error: 'Too many live scan streams', code: 'SSE_LIMIT' });
    return;
  }
  const scan = requireScan(req, req.params.scanId);

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let lastScanned = -1;
  let lastBeat = Date.now();

  const finish = (): void => {
    if (scan.status === 'complete' && scan.root) {
      // WHY no `root` here: this frame used to JSON.stringify the ENTIRE pruned
      // tree once PER connected SSE client — a tens-of-MB string allocation
      // multiplied by every open tab on each scan completion. Clients don't
      // need it: on a root-less 'complete' the frontend fetches the tree once
      // via GET /api/scan/:scanId/result (shared fetch, one copy), enabled by
      // the scanId below. This keeps tree serialization out of the SSE path.
      sseSend(res, { type: 'complete', scanId: scan.scanId });
    } else {
      sseSend(res, { type: 'error', message: scan.error ?? 'Scan failed' });
    }
    closeClient(client);
  };

  const timer = setInterval(() => {
    if (scan.status !== 'running') {
      finish();
      return;
    }
    if (scan.scanned !== lastScanned) {
      lastScanned = scan.scanned;
      sseSend(res, { type: 'progress', scanned: scan.scanned, currentPath: scan.currentPath });
      lastBeat = Date.now();
    } else if (Date.now() - lastBeat > 10_000) {
      sseWrite(res, ': keep-alive\n\n'); // comment frame, ignored by EventSource
      lastBeat = Date.now();
    }
  }, 150);

  const client: SseClient = { res, timer };
  sseClients.add(client);

  // Send an immediate first frame so the UI updates without waiting a tick.
  if (scan.status === 'running') {
    sseSend(res, { type: 'progress', scanned: scan.scanned, currentPath: scan.currentPath });
    lastScanned = scan.scanned;
  } else {
    finish();
  }

  req.on('close', () => closeClient(client));
});

/** GET /api/scan/:scanId/result -> FileNode tree, or 202 while running. */
scanRouter.get('/scan/:scanId/result', (req: Request, res: Response) => {
  const scan = requireScan(req, req.params.scanId);
  if (scan.status === 'running') {
    res.status(202).json({
      status: 'running',
      scanned: scan.scanned,
      currentPath: scan.currentPath,
    });
    return;
  }
  if (scan.status === 'error') {
    throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  }
  res.json({
    status: 'complete',
    scanId: scan.scanId,
    rootPath: scan.rootPath,
    fileCount: scan.fileCount,
    dirCount: scan.dirCount,
    startedAt: scan.startedAt,
    finishedAt: scan.finishedAt,
    root: scan.root,
  });
});

/**
 * GET /api/scan/:scanId/treemap?maxDepth=3&minSize=10240&root=<subpath>
 * Pre-computed squarified layout, coordinates in percent.
 */
scanRouter.get('/scan/:scanId/treemap', guardQueryPath('root'), (req: Request, res: Response) => {
  const scan = requireScan(req, req.params.scanId);
  if (scan.status === 'running') {
    res.status(202).json({ status: 'running', scanned: scan.scanned });
    return;
  }
  if (scan.status === 'error' || !scan.root) {
    throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  }

  const maxDepth = clampInt(req.query.maxDepth, 3, 1, 8);
  const minSize = clampInt(req.query.minSize, 10_240, 0, Number.MAX_SAFE_INTEGER);

  let root = scan.root;
  const rootParam = req.query.root as string | undefined;
  if (rootParam && rootParam !== scan.rootPath) {
    if (!isInside(scan.rootPath, rootParam)) {
      throw new AppError(403, 'OUTSIDE_SCAN_ROOT', 'root must be inside the scanned folder');
    }
    const found = findNodeByPath(scan.root, rootParam);
    if (!found) throw new AppError(404, 'PATH_NOT_FOUND', 'That path is not in this scan');
    if (found.type !== 'dir') throw new AppError(400, 'NOT_A_DIRECTORY', 'Treemap root must be a directory');
    root = found;
  }

  const nodes = buildTreemap(root, { maxDepth, minSize, maxNodes: 20_000 });
  res.json({
    scanId: scan.scanId,
    root: { name: root.name, path: root.path, size: root.size, modifiedAt: root.modifiedAt },
    scanRootPath: scan.rootPath,
    maxDepth,
    minSize,
    nodes,
  });
});

/** GET /api/large-files?scanId=x&limit=50&minSize=1048576 */
scanRouter.get('/large-files', (req: Request, res: Response) => {
  const scan = requireScan(req, String(req.query.scanId ?? ''));
  if (scan.status === 'running') {
    res.status(202).json({ status: 'running' });
    return;
  }
  if (!scan.root) throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');

  const limit = clampInt(req.query.limit, 50, 1, 1000);
  const minSize = clampInt(req.query.minSize, 1_048_576, 0, Number.MAX_SAFE_INTEGER);
  res.json({ files: collectLargestFiles(scan.root, limit, minSize) });
});

/** GET /api/file-types?scanId=x */
scanRouter.get('/file-types', (req: Request, res: Response) => {
  const scan = requireScan(req, String(req.query.scanId ?? ''));
  if (scan.status === 'running') {
    res.status(202).json({ status: 'running' });
    return;
  }
  if (!scan.root) throw new AppError(500, 'SCAN_FAILED', scan.error ?? 'Scan failed');
  res.json({ types: collectFileTypes(scan.root) });
});

export function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

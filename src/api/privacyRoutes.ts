import os from 'os';
import { Router, Request, Response } from 'express';
import { startScan } from '../services/diskScanner';
import { diskUsage } from '../services/diskUsage';
import { sanitizePath } from '../utils/pathSanitizer';
import {
  fullDiskAccessStatus,
  browserCaches,
  isBrowserRunning,
  browserName,
  invalidateBrowserCacheList,
  recordBrowserCacheClean,
} from '../services/privacy';
import { AppError } from '../middleware/errorHandler';

/**
 * privacyRoutes — Privacy & Security screen.
 *
 * READ endpoints (status / browser caches) are passive probes only.
 * Cleaning reuses the standard safety pipeline exactly like the Fast Clean
 * cache plan: we register the browser cache directory as a scan root via
 * startScan(), wait for it to complete, and hand back CONTENT paths. The
 * frontend then trashes those paths through the existing DELETE /api/files,
 * which enforces requireInsideScanRoot + Trash-only semantics. No new delete
 * path is introduced.
 */

export const privacyRouter = Router();

function requireMac(): void {
  if (process.platform !== 'darwin') {
    throw new AppError(409, 'NOT_MACOS', 'Privacy tools are only available on macOS');
  }
}

/** GET /api/privacy/status — Full Disk Access probe (passive, no prompt). */
privacyRouter.get('/privacy/status', async (_req: Request, res: Response) => {
  // The probe only means something on macOS (and ~/Library/Safari doesn't
  // exist elsewhere) — answer 409 instead of a misleading null status.
  requireMac();
  res.json(await fullDiskAccessStatus());
});

/** GET /api/privacy/browser-caches — sizes + running guards for known browsers. */
privacyRouter.get('/privacy/browser-caches', async (_req: Request, res: Response) => {
  requireMac();
  res.json({ items: await browserCaches() });
});

/**
 * POST /api/privacy/browser-cache-plan  body: { id }
 * Registers the browser's cache dir as a scan root, waits for completion, and
 * returns its CONTENT paths for trash via DELETE /api/files. Refuses when the
 * browser is running (its cache files are hot) — same rule as Fast Clean.
 */
privacyRouter.post('/privacy/browser-cache-plan', async (req: Request, res: Response) => {
  requireMac();
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  const item = (await browserCaches()).find((b) => b.id === id);
  if (!item) throw new AppError(404, 'BROWSER_CACHE_NOT_FOUND', 'Unknown browser cache');
  // FDA guidance BEFORE the exists check: a TCC-blocked cache can look just
  // like a missing directory, and "Unknown browser cache" would send the user
  // hunting for a bug instead of the System Settings toggle.
  if (item.accessDenied) {
    throw new AppError(
      403,
      'FULL_DISK_ACCESS_REQUIRED',
      'Full Disk Access is required to read this cache. Grant it in System Settings → Privacy & Security → Full Disk Access.',
    );
  }
  if (!item.exists) throw new AppError(404, 'BROWSER_CACHE_NOT_FOUND', 'No cache directory found for this browser');
  // TOCTOU: item.running comes from the 60s-cached listing and can be stale
  // (browser launched after the cache was built) — re-probe fresh right here.
  if (await isBrowserRunning(id)) {
    throw new AppError(409, 'BROWSER_RUNNING', `Quit ${item.name} before clearing its cache.`);
  }

  // Sanitize + register as a scan root so every returned path is authorized.
  const root = sanitizePath(item.path);
  const scan = await startScan(root, { snapshot: false });
  const deadline = Date.now() + 60_000;
  while (scan.status === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 60));
  }
  if (scan.status !== 'complete' || !scan.root) {
    // Distinguish the failure modes: a scanner error carries its own message,
    // a lapsed poll deadline is a timeout, anything else is a generic failure.
    if (scan.status === 'error') {
      throw new AppError(500, 'SCAN_FAILED', scan.error || 'Cache scan failed');
    }
    if (scan.status === 'running') {
      throw new AppError(504, 'SCAN_TIMEOUT', 'Cache scan timed out — try again.');
    }
    throw new AppError(500, 'SCAN_INCOMPLETE', 'Cache scan did not finish in time — try again.');
  }

  // Contents-only: never the cache root itself (same rule as Fast Clean).
  const contents = (scan.root.children ?? []).map((c) => c.path);
  res.json({ root, scanId: scan.scanId, contents, browser: item.name, sizeBytes: scan.root.size });
});

/**
 * POST /api/privacy/browser-cache-credit  body: { id, bytes }
 * Bookkeeping only — records a completed clean in the activity feed after the
 * frontend's DELETE calls succeed. Never performs filesystem work itself.
 *
 * The browser is identified by its CATALOG id (never a free-form name the
 * client could invent), and the credited bytes are sanity-capped against the
 * volume's total capacity: a browser cache cannot exceed the whole disk, so
 * anything larger is a buggy or lying client and gets rejected rather than
 * poisoning the activity feed.
 */
privacyRouter.post('/privacy/browser-cache-credit', async (req: Request, res: Response) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  const name = browserName(id);
  if (!name) {
    throw new AppError(400, 'UNKNOWN_BROWSER', '"id" must be a browser id from GET /api/privacy/browser-caches');
  }
  const bytes = Math.max(0, Math.floor(Number(req.body?.bytes) || 0));
  if (bytes > 0) {
    const usage = await diskUsage(os.homedir());
    if (bytes > usage.total) {
      throw new AppError(400, 'IMPLAUSIBLE_SIZE', '"bytes" exceeds the disk total — refusing to record it');
    }
  }
  await recordBrowserCacheClean(bytes, name);
  invalidateBrowserCacheList();
  res.json({ recorded: true });
});

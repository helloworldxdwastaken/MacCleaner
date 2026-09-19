import { Router, Request, Response } from 'express';
import { AppError } from '../middleware/errorHandler';
import {
  readStatus,
  helperState,
  boostSource,
  getRules,
  saveRules,
  startBoost,
  stopBoost,
  installHelper,
  uninstallHelper,
} from '../services/fans';

/**
 * fanRoutes — the Fan Control feature.
 *
 * Reads (GET /fans/status) work unprivileged via the bundled helper binary.
 * Writes (boost/auto) require the root LaunchDaemon; install/uninstall each
 * cost exactly one osascript admin prompt. See services/fans.ts for the
 * safety model (boost-only clamping, daemon-side 10s watchdog).
 */

export const fanRouter = Router();

function requireMac(): void {
  if (process.platform !== 'darwin') {
    throw new AppError(409, 'NOT_MACOS', 'Fan control is only available on macOS');
  }
}

/**
 * GET /api/fans/status
 * Live fans + temps + helper state + persisted rules config, in one call so
 * the UI can poll a single endpoint. helperState and boostSource are derived
 * from what the daemon itself reports — in particular, 'active-boost' is only
 * ever reported when the daemon confirms an active boost, and a manual-pinned
 * fan owned by a third-party tool surfaces as boostSource 'external' rather
 * than being claimed as a user boost.
 */
fanRouter.get('/fans/status', async (_req: Request, res: Response) => {
  requireMac();
  let status;
  try {
    status = await readStatus();
  } catch (err) {
    throw new AppError(
      503,
      'FAN_HELPER_UNAVAILABLE',
      err instanceof Error ? err.message : 'fan helper binary failed'
    );
  }
  const [state, src, rulesConfig] = await Promise.all([
    helperState(),
    boostSource(status.fans),
    getRules(),
  ]);
  res.json({ fans: status.fans, temps: status.temps, helperState: state, boostSource: src, rulesConfig });
});

/**
 * POST /api/fans/boost  { fan: number | "all", percent: 0–100 }
 * Starts (or retargets) a boost. Percent is relative to each fan's [min,max]
 * span, with backend-side corrections: percent 0 is a no-op that releases the
 * fan(s) to auto, and the effective request is floored at the fan's CURRENT
 * automatic target (additive-only — never below what the firmware is doing
 * now). The daemon additionally clamps to [F(i)Mn, F(i)Mx] and rejects
 * anything below the hardware minimum.
 */
fanRouter.post('/fans/boost', async (req: Request, res: Response) => {
  requireMac();
  const { fan, percent } = (req.body ?? {}) as { fan?: unknown; percent?: unknown };

  const fanOk = fan === 'all' || (typeof fan === 'number' && Number.isInteger(fan) && fan >= 0 && fan < 8);
  if (!fanOk) throw new AppError(400, 'BAD_FAN', 'fan must be "all" or a fan index (0–7)');
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new AppError(400, 'BAD_PERCENT', 'percent must be a number between 0 and 100');
  }

  const state = await helperState();
  if (state === 'not-installed') {
    throw new AppError(409, 'HELPER_NOT_INSTALLED', 'Install the fan helper first (POST /api/fans/install-helper)');
  }

  const result = await startBoost({ fan: fan as number | 'all', percent });
  if (!result.ok && result.applied.every((a) => !a.ok)) {
    const detail = result.applied.map((a) => a.error).filter(Boolean).join('; ') || 'boost rejected';
    throw new AppError(502, 'BOOST_FAILED', detail);
  }
  res.json({ ok: result.ok, applied: result.applied, helperState: await helperState() });
});

/** POST /api/fans/auto — restore automatic fan control (clears any boost). */
fanRouter.post('/fans/auto', async (_req: Request, res: Response) => {
  requireMac();
  await stopBoost();
  res.json({ ok: true, mode: 'auto', helperState: await helperState() });
});

/** GET /api/fans/rules — the persisted auto-boost rules config. */
fanRouter.get('/fans/rules', async (_req: Request, res: Response) => {
  requireMac();
  res.json(await getRules());
});

/**
 * PUT /api/fans/rules
 * Replace the rules config. Body: { enabled, rules:[{domain,threshold,
 * targetPercent}], pollSeconds }. Values are sanitized/clamped server-side;
 * the sanitized config is echoed back.
 */
fanRouter.put('/fans/rules', async (req: Request, res: Response) => {
  requireMac();
  if (typeof req.body !== 'object' || req.body === null) {
    throw new AppError(400, 'BAD_RULES', 'body must be a rules config object');
  }
  res.json(await saveRules(req.body));
});

/**
 * POST /api/fans/install-helper  { dryRun?: boolean }
 * ONE osascript admin prompt installs the root LaunchDaemon. Distinct result
 * statuses: installed | user-cancelled | failed | dry-run (dry-run returns the
 * exact command without prompting).
 */
fanRouter.post('/fans/install-helper', async (req: Request, res: Response) => {
  requireMac();
  const dryRun = (req.body as { dryRun?: unknown } | undefined)?.dryRun === true;
  const result = await installHelper({ dryRun });
  res.status(result.status === 'failed' ? 500 : 200).json(result);
});

/** POST /api/fans/uninstall-helper  { dryRun?: boolean } — mirror of install. */
fanRouter.post('/fans/uninstall-helper', async (req: Request, res: Response) => {
  requireMac();
  const dryRun = (req.body as { dryRun?: unknown } | undefined)?.dryRun === true;
  const result = await uninstallHelper({ dryRun });
  res.status(result.status === 'failed' ? 500 : 200).json(result);
});

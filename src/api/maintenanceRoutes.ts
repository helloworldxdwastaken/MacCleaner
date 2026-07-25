import { Router, Request, Response } from 'express';
import {
  runMaintenance, runMaintenanceInTerminal, listLoginItems, setLoginItemEnabled, getAppIconPng,
  listLaunchAgents, setLaunchAgentEnabled,
} from '../services/maintenance';
import { guardQueryPath, guardBodyPath } from '../middleware/pathGuard';
import { AppError } from '../middleware/errorHandler';

/**
 * maintenanceRoutes — the macOS "Maintenance" (Speed) tool: a few safe, no-sudo
 * upkeep actions plus user login-item management. No new delete path; nothing
 * destructive. macOS only.
 */

export const maintenanceRouter = Router();

const RUN_ACTIONS = new Set(['flush-dns', 'rebuild-launchservices']);
/** Maintenance actions that can be finished with interactive sudo in Terminal. */
const ELEVATE_ACTIONS = new Set(['flush-dns']);

function requireMac(): void {
  if (process.platform !== 'darwin') {
    throw new AppError(409, 'NOT_MACOS', 'Maintenance is only available on macOS');
  }
}

function isAutomationDenied(msg: string): boolean {
  return /-1743|not authori|not allowed to send/i.test(msg);
}

/** POST /api/maintenance/run { action } → { id, ok, message } */
maintenanceRouter.post('/maintenance/run', async (req: Request, res: Response) => {
  requireMac();
  const action = String((req.body as { action?: unknown })?.action ?? '');
  if (!RUN_ACTIONS.has(action)) {
    throw new AppError(400, 'UNKNOWN_ACTION', `Unknown maintenance action "${action}"`);
  }
  res.json(await runMaintenance(action));
});

/**
 * POST /api/maintenance/elevate { action } → { opened: true }
 * Finish a maintenance action that needs root by opening Terminal and running
 * the (fixed, allowlisted) sudo command there, so the user can type their admin
 * password. Same interactive-elevation pattern as the cask updater.
 */
maintenanceRouter.post('/maintenance/elevate', async (req: Request, res: Response) => {
  requireMac();
  const action = String((req.body as { action?: unknown })?.action ?? '');
  if (!ELEVATE_ACTIONS.has(action)) {
    throw new AppError(400, 'UNKNOWN_ACTION', `No Terminal action for "${action}"`);
  }
  await runMaintenanceInTerminal(action);
  res.json({ opened: true });
});

/** GET /api/maintenance/app-icon?path=<app.app> → image/png (404 if none). */
maintenanceRouter.get('/maintenance/app-icon', guardQueryPath('path'), async (req: Request, res: Response) => {
  const appPath = req.query.path as string | undefined;
  if (!appPath) { res.status(400).end(); return; }
  try {
    const png = await getAppIconPng(appPath);
    res.type('png').set('Cache-Control', 'public, max-age=3600').send(png);
  } catch {
    res.status(404).end(); // frontend falls back to a letter tile
  }
});

/**
 * GET /api/maintenance/login-items → { items, classic }
 * Default (`classic` absent) returns only consent-free sources (BTM via
 * sfltool + nothing from System Events) so simply opening the tab never
 * triggers an Automation prompt. `?classic=1` additionally queries System
 * Events "Open at Login" apps — the only call that can prompt for
 * Automation consent (or fail with -1743).
 */
maintenanceRouter.get('/maintenance/login-items', async (req: Request, res: Response) => {
  requireMac();
  const includeClassic = req.query.classic === '1' || req.query.classic === 'true';
  try {
    res.json({ items: await listLoginItems({ includeClassic }), classic: includeClassic });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isAutomationDenied(msg)) {
      throw new AppError(
        403,
        'AUTOMATION_DENIED',
        'MacCleaner needs permission to control System Events. Allow it in System Settings → Privacy & Security → Automation.'
      );
    }
    throw new AppError(500, 'LOGIN_ITEMS_FAILED', msg);
  }
});

/** POST /api/maintenance/login-items { name, path, enabled } → { ok } */
maintenanceRouter.post('/maintenance/login-items', async (req: Request, res: Response) => {
  requireMac();
  const { name, path, enabled } = (req.body ?? {}) as { name?: string; path?: string; enabled?: boolean };
  if (!name || !path) {
    throw new AppError(400, 'LOGIN_ITEM_INVALID', 'name and path are required');
  }
  try {
    await setLoginItemEnabled(name, path, enabled !== false);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isAutomationDenied(msg)) {
      throw new AppError(
        403,
        'AUTOMATION_DENIED',
        'MacCleaner needs permission to control System Events. Allow it in System Settings → Privacy & Security → Automation.'
      );
    }
    throw new AppError(500, 'LOGIN_ITEM_FAILED', msg);
  }
});

/** GET /api/maintenance/launch-agents → { agents } (user ~/Library/LaunchAgents). */
maintenanceRouter.get('/maintenance/launch-agents', async (_req: Request, res: Response) => {
  requireMac();
  try {
    res.json({ agents: await listLaunchAgents() });
  } catch (err) {
    throw new AppError(500, 'LAUNCH_AGENTS_FAILED', err instanceof Error ? err.message : String(err));
  }
});

/** POST /api/maintenance/launch-agents { path, enabled } → { ok } */
maintenanceRouter.post('/maintenance/launch-agents', guardBodyPath, async (req: Request, res: Response) => {
  requireMac();
  const { path: agentPath, enabled } = (req.body ?? {}) as { path?: string; enabled?: boolean };
  if (!agentPath) {
    throw new AppError(400, 'LAUNCH_AGENT_INVALID', 'path is required');
  }
  try {
    await setLaunchAgentEnabled(agentPath, enabled !== false);
    res.json({ ok: true });
  } catch (err) {
    throw new AppError(500, 'LAUNCH_AGENT_FAILED', err instanceof Error ? err.message : String(err));
  }
});

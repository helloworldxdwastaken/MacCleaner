import express from 'express';
import path from 'path';
import fs from 'fs';
import http from 'http';
import crypto from 'crypto';
import { scanRouter, drainSseClients, activeSseCount } from './api/scanRoutes';
import { fileRouter } from './api/fileRoutes';
import { systemRouter } from './api/systemRoutes';
import { insightRouter } from './api/insightRoutes';
import { settingsRouter } from './api/settingsRoutes';
import { cleanerRouter } from './api/cleanerRoutes';
import { appRouter } from './api/appRoutes';
import { maintenanceRouter } from './api/maintenanceRoutes';
import { activityRouter } from './api/activityRoutes';
import { fanRouter } from './api/fanRoutes';
import { privacyRouter } from './api/privacyRoutes';
import { rateLimiter } from './middleware/rateLimiter';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { generateToken, hostGuard, createTokenGuard, hasValidQueryToken } from './middleware/auth';
import { cancelAllScans } from './services/diskScanner';
import { cancelAllDuplicateJobs } from './services/duplicateFinder';
import { startScheduler, stopScheduler } from './services/scheduler';
import { migrateLegacyDataDir } from './services/storage';

/*
 * Scan-eviction → duplicate-hash cleanup: no wiring needed here. The
 * scanner exposes a `setOnScanEvicted(fn)` hook (it cannot import
 * duplicateFinder without a cycle), and duplicateFinder registers its own
 * `cancelDuplicateJobsForScan` there at module load — which always runs,
 * because this module statically imports it for shutdown. server.ts stays
 * out of the middle; both hosts get the wiring for free.
 */

/* ---- CSP hash hardening helpers ---- */

/** Base64 sha256 digest of `text`, formatted as a CSP hash source. */
function cspHash(text: string): string {
  return `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/**
 * CSP hash source for every inline <script> block in `html`.
 *
 * The digest covers the EXACT bytes between the <script> and </script> tags —
 * no tags, no trimming — because that is precisely what the browser hashes
 * when evaluating a CSP hash source. Blocks whose opening tag carries a `src`
 * attribute are external scripts (nothing is executed inline) and are skipped.
 */
function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    hashes.push(cspHash(m[2]));
  }
  return hashes;
}

/**
 * Builds the Express app. Kept separate from the listen() call so the same
 * app can be started by the standalone server (src/index.ts) and embedded
 * inside the Electron desktop app (electron/main.js), which serves the
 * frontend from a different on-disk location.
 *
 * @param publicDir Absolute path to the folder holding index.html.
 * @param token     Per-launch API token (generateToken()). Injected into the
 *                  served index.html and required on every /api request.
 */
export function createApp(publicDir: string, token: string): express.Express {
  const app = express();

  // This is a local tool; trust no proxies (req.ip = socket address).
  app.set('trust proxy', false);
  app.disable('x-powered-by');

  // Baseline defense-in-depth headers on EVERY response — mounted ahead of
  // hostGuard so nothing later in the chain (including GET /, which dispenses
  // the token, and the static assets) can skip them.
  app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  // Loopback Host headers only — on every route, so a DNS-rebound page can
  // neither call the API nor fetch the HTML carrying the token.
  app.use(hostGuard);

  app.use(express.json({ limit: '1mb' }));
  app.use('/api', rateLimiter);
  // Per-launch token on /api, headers only — EXCEPT two raw-URL consumers that
  // cannot set headers (EventSource SSE, <img> app-icon), which may present the
  // token as `?token=` on exactly their paths. The allowlist wrapper re-enters
  // the header-only guard for everything else.
  const QUERY_TOKEN_PATH = /^(\/api\/scan\/[^/]+\/progress|\/api\/maintenance\/app-icon)$/;
  const headerGuard = createTokenGuard(token);
  const apiTokenGuard: express.RequestHandler = (req, res, next) => {
    // req.path is mount-relative under app.use('/api', …) — rebuild the full
    // path so the allowlist matches the wire-level route.
    const fullPath = req.baseUrl + req.path;
    if (QUERY_TOKEN_PATH.test(fullPath) && hasValidQueryToken(req, token)) return next();
    headerGuard(req, res, next);
  };
  app.use('/api', apiTokenGuard);

  app.use('/api', scanRouter);
  app.use('/api', fileRouter);
  app.use('/api', systemRouter);
  app.use('/api', insightRouter);
  app.use('/api', settingsRouter);
  app.use('/api', cleanerRouter);
  app.use('/api', appRouter);
  app.use('/api', maintenanceRouter);
  app.use('/api', activityRouter);
  app.use('/api', fanRouter);
  app.use('/api', privacyRouter);

  // Frontend: the single-file UI, with the per-launch token injected so its
  // fetch/EventSource calls can authenticate. Read once; it never changes
  // while the server runs.
  const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

  /* ---- CSP hardening ----
   * Tighten the meta CSP by replacing `script-src 'unsafe-inline'` with hashes
   * of every inline script block found in the ORIGINAL file bytes, plus one
   * more hash for the token script injected below (its exact text is known).
   * All three blocks then pass the tightened policy; any future inline block
   * added to index.html without updating the server is blocked (fail-closed).
   * `style-src 'unsafe-inline'` is left as-is — the app uses inline styles
   * extensively. FAIL-OPEN: if the file contains zero inline blocks or the
   * expected CSP directive is missing, the original CSP is left untouched
   * ('unsafe-inline' still permits everything; we only lose the hardening,
   * never the ability to serve the page).
   */
  const tokenScriptInner = `window.MACCLEANER_TOKEN=${JSON.stringify(token)};`;
  const tokenScript = `<script>${tokenScriptInner}</script>`;
  const scriptHashes = inlineScriptHashes(indexHtml);
  scriptHashes.push(cspHash(tokenScriptInner));
  const CSP_SCRIPT_SRC_UNSAFE = "script-src 'unsafe-inline'";
  let injected: string;
  if (scriptHashes.length > 1 && indexHtml.includes(CSP_SCRIPT_SRC_UNSAFE)) {
    // Function replacer so `$` sequences in base64 can never be misread as
    // replacement patterns (they can't appear in base64, but belt-and-braces).
    injected = indexHtml.replace(
      CSP_SCRIPT_SRC_UNSAFE,
      () => `script-src ${scriptHashes.join(' ')}`,
    );
  } else {
    console.warn(
      "[server] CSP hardening skipped: no inline <script> blocks or no `script-src 'unsafe-inline'` in index.html — original CSP kept",
    );
    injected = indexHtml;
  }
  injected = injected.includes('<head>')
    ? injected.replace('<head>', `<head>\n${tokenScript}`)
    : tokenScript + injected;
  app.get('/', (_req, res) => {
    // The HTML carries the per-launch token — it must never persist in any
    // disk cache (browser back/forward, intermediaries, anything).
    res.set('Cache-Control', 'no-store');
    res.type('html').send(injected);
  });
  // The raw public/index.html (original CSP, cacheable) must not be reachable
  // beside the hardened copy — serve the token-injected, hash-locked version
  // for this exact path too. (Only / gets it from static being index:false.)
  app.get('/index.html', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(injected);
  });
  app.use(express.static(publicDir, { index: false }));

  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  return app;
}

export interface RunningServer {
  server: http.Server;
  port: number;
  /** Per-launch API token; required on every /api request. */
  token: string;
  /** Drains SSE streams, cancels scans, and closes the server. */
  shutdown: () => void;
}

export interface StartOptions {
  publicDir: string;
  /** Port to bind. Use 0 to let the OS pick a free port (best for desktop). */
  port?: number;
  host?: string;
}

/** Start listening and resolve once the socket is bound. */
export function startServer(opts: StartOptions): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  const token = generateToken();
  const app = createApp(opts.publicDir, token);
  const server = http.createServer(app);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopScheduler(); // no new scheduled scans
    cancelAllScans(); // stop walkers cooperatively
    cancelAllDuplicateJobs(); // stop background hashing
    drainSseClients(); // send 'shutdown' event, then end each stream
    server.close();
    // Idle keep-alive sockets would otherwise hold the listener open past
    // close() until their own timeout (Node ≥ 18.2 provides the hook).
    server.closeIdleConnections();
    // Don't process.exit here — the caller (CLI or Electron) decides that.
  };

  return new Promise<RunningServer>((resolve, reject) => {
    // Migrate any pre-rebrand TreeMap app data before anything reads it, then
    // start the scheduler and bind the socket. A migration failure is logged
    // (inside migrateLegacyDataDir) and non-fatal — the app still starts fresh.
    migrateLegacyDataDir().finally(() => {
      // Recurring scans (and their growth alerts) live for the server's lifetime.
      startScheduler();

      server.once('error', reject);
      server.listen(opts.port ?? 0, host, () => {
        server.removeListener('error', reject);
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);
        resolve({ server, port, token, shutdown });
      });
    });
  });
}

export { activeSseCount };

import express from 'express';
import path from 'path';
import fs from 'fs';
import http from 'http';
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
import { rateLimiter } from './middleware/rateLimiter';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { generateToken, hostGuard, createTokenGuard } from './middleware/auth';
import { cancelAllScans } from './services/diskScanner';
import { cancelAllDuplicateJobs } from './services/duplicateFinder';
import { startScheduler, stopScheduler } from './services/scheduler';
import { migrateLegacyDataDir } from './services/storage';

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

  // Loopback Host headers only — on every route, so a DNS-rebound page can
  // neither call the API nor fetch the HTML carrying the token.
  app.use(hostGuard);

  app.use(express.json({ limit: '1mb' }));
  app.use('/api', rateLimiter);
  app.use('/api', createTokenGuard(token));

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

  // Frontend: the single-file UI, with the per-launch token injected so its
  // fetch/EventSource calls can authenticate. Read once; it never changes
  // while the server runs.
  const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const tokenScript = `<script>window.MACCLEANER_TOKEN=${JSON.stringify(token)};</script>`;
  const injected = indexHtml.includes('<head>')
    ? indexHtml.replace('<head>', `<head>\n${tokenScript}`)
    : tokenScript + indexHtml;
  app.get('/', (_req, res) => {
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

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

/**
 * Local-access guard for the /api surface.
 *
 * "localhost" is not an authorization boundary: any local process can reach
 * the port, and a malicious website can reach it too via DNS rebinding. Two
 * layers close that:
 *
 * 1. hostGuard — applied to *every* request (including the HTML that carries
 *    the token). Rejects anything whose Host header isn't loopback, which
 *    breaks DNS rebinding: a rebound page keeps the attacker's hostname in
 *    the Host header, so it can neither call the API nor read the token.
 * 2. requireToken — applied to /api. Requires a per-launch random bearer
 *    token that only the served page (and the Electron shell) knows.
 *
 * The `?token=` query variant exists ONLY for endpoints a raw browser client
 * hits (EventSource SSE, <img> src) — those cannot set request headers. It
 * must be granted per-route via createQueryTokenGuard, never globally: query
 * strings leak into logs, Referer headers and browser history.
 */

/** Generate the per-launch API token. Never persisted to disk. */
export function generateToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Reject requests with a missing or non-loopback Host header (DNS-rebinding
 *  defense). HTTP/1.1 requires Host and every real client here (browser,
 *  Electron net) sends one — an absent Host is treated as hostile. */
export function hostGuard(req: Request, res: Response, next: NextFunction): void {
  const raw = req.headers.host ?? '';
  // Bracketed IPv6 ("[::1]:4280") keeps its brackets; everything else splits
  // at the first colon to drop the port.
  const host = raw.startsWith('[')
    ? raw.slice(0, raw.indexOf(']') + 1).toLowerCase()
    : raw.split(':')[0].toLowerCase();
  if (!host || !LOOPBACK_HOSTS.has(host)) {
    res.status(403).json({ error: 'Forbidden host', code: 'HOST_REJECTED' });
    return;
  }
  next();
}

function sha256(s: string): Buffer {
  return crypto.createHash('sha256').update(s).digest();
}

/** Token presented in a header — `Authorization: Bearer …` or the dedicated
 *  `X-MacCleaner-Token` — or null when neither is present. */
function headerToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  return typeof req.headers['x-maccleaner-token'] === 'string'
    ? (req.headers['x-maccleaner-token'] as string)
    : null;
}

/** True when the request presents the per-launch token via a header.
 *  The query string is deliberately NOT consulted — see createQueryTokenGuard. */
export function hasValidToken(req: Request, token: string): boolean {
  const presented = headerToken(req);
  if (!presented) return false;
  // Compare digests so timingSafeEqual never sees mismatched lengths.
  return crypto.timingSafeEqual(sha256(presented), sha256(token));
}

/** hasValidToken, plus the `?token=` query escape hatch (string values only —
 *  `?token=a&token=b` or `?token[a]=b` parse to arrays/objects and are ignored). */
function hasValidTokenWithQuery(req: Request, token: string): boolean {
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
  const presented = headerToken(req) ?? queryToken;
  if (!presented) return false;
  return crypto.timingSafeEqual(sha256(presented), sha256(token));
}

/** Shared middleware body for both guards (createTokenGuard /
 *  createQueryTokenGuard) — only the accepted token sources differ. */
function createGuard(token: string, allowQueryToken: boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ok = allowQueryToken ? hasValidTokenWithQuery(req, token) : hasValidToken(req, token);
    if (!ok) {
      res.status(401).json({ error: 'Missing or invalid API token', code: 'UNAUTHORIZED' });
      return;
    }
    next();
  };
}

/** Express middleware enforcing the per-launch token on /api routes.
 *  Default guard: headers ONLY. Mount this on the whole /api surface. */
export function createTokenGuard(token: string) {
  return createGuard(token, false);
}

/** Strict `?token=` query check (single string value only — `?token=a&token=b`
 *  or `?token[a]=b` parse to arrays/objects and are rejected). Used by the
 *  server's allowlist wrapper for exactly the two raw-URL consumers
 *  (EventSource SSE, <img> app-icon); never expose it on other paths. */
export function hasValidQueryToken(req: Request, token: string): boolean {
  const q = req.query.token;
  if (typeof q !== 'string' || q.length === 0) return false;
  return crypto.timingSafeEqual(sha256(q), sha256(token));
}

/** Route-scoped token guard for endpoints raw browser clients hit directly
 *  (EventSource SSE streams, <img> src) — accepts headers OR `?token=`.
 *  NOTE: mounting this per-route does NOT bypass a later global guard
 *  (Express chains `next()` into it), so the server applies the query-token
 *  escape hatch via a path-allowlist wrapper around the global guard instead
 *  (see server.ts). Kept exported for completeness. */
export function createQueryTokenGuard(token: string) {
  return createGuard(token, true);
}

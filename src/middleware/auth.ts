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

/** True when the request carries the per-launch token (header or SSE query). */
export function hasValidToken(req: Request, token: string): boolean {
  const auth = req.headers.authorization;
  const presented =
    auth && auth.startsWith('Bearer ')
      ? auth.slice('Bearer '.length)
      : typeof req.headers['x-maccleaner-token'] === 'string'
        ? (req.headers['x-maccleaner-token'] as string)
        : typeof req.query.token === 'string'
          ? req.query.token // EventSource can't set headers; the SSE URL carries it
          : null;
  if (!presented) return false;
  // Compare digests so timingSafeEqual never sees mismatched lengths.
  return crypto.timingSafeEqual(sha256(presented), sha256(token));
}

/** Express middleware enforcing the per-launch token on /api routes. */
export function createTokenGuard(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!hasValidToken(req, token)) {
      res.status(401).json({ error: 'Missing or invalid API token', code: 'UNAUTHORIZED' });
      return;
    }
    next();
  };
}

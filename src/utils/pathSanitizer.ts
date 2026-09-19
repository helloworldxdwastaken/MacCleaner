import path from 'path';
import os from 'os';

/**
 * Path validation shared by the pathGuard middleware and the services.
 * Throws PathRejectedError for anything suspicious; returns the resolved
 * absolute path otherwise.
 */

export class PathRejectedError extends Error {
  readonly code: string;
  constructor(message: string, code = 'PATH_REJECTED') {
    super(message);
    this.name = 'PathRejectedError';
    this.code = code;
  }
}

/** Virtual / volatile filesystems and OS internals we refuse to touch.
 *  Compared case-insensitively: default APFS is case-insensitive, so a
 *  case-sensitive check would let "/PRIVATE/VAR/db" slip past. Over-blocking
 *  on case-sensitive volumes is the safe direction. */
const UNIX_BLOCKLIST = [
  // Virtual / volatile filesystems.
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/boot',
  // OS-managed trees.
  '/usr',
  '/bin',
  '/sbin',
  '/system',
  '/library',
  '/system/volumes/vm',
  // macOS: /etc, /var and /tmp are symlinks into /private — block the
  // sensitive targets under BOTH spellings, since matching is lexical.
  // (All of /var is NOT blocked: /var/folders holds user temp + caches,
  // which are legitimate scan/clean targets.)
  '/etc',
  '/private/etc',
  '/var/db',
  '/private/var/db',
  '/var/root',
  '/private/var/root',
  // Per-user secrets and OS-managed credential stores.
  `${os.homedir()}/.ssh`,
  `${os.homedir()}/.gnupg`,
  `${os.homedir()}/.aws`,
  `${os.homedir()}/library/keychains`,
].map((b) => b.toLowerCase());
const WINDOWS_BLOCKLIST = [
  'c:\\windows\\system32',
  'c:\\windows\\syswow64',
  'c:\\windows\\winsxs',
  'c:\\$recycle.bin',
  'c:\\system volume information',
];

function isBlocked(resolved: string): boolean {
  if (process.platform === 'win32') {
    const lower = resolved.toLowerCase();
    return WINDOWS_BLOCKLIST.some((b) => lower === b || lower.startsWith(b + path.sep));
  }
  const lower = resolved.toLowerCase();
  return UNIX_BLOCKLIST.some((b) => lower === b || lower.startsWith(b + '/'));
}

/**
 * Validate and normalize a user-supplied path.
 * - rejects non-strings, empty strings and null bytes
 * - expands a leading "~" to the home directory
 * - resolves to an absolute path (eliminating ../ traversal segments)
 * - rejects blocked system directories
 */
export function sanitizePath(input: unknown): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new PathRejectedError('Path must be a non-empty string', 'PATH_INVALID');
  }
  if (input.includes('\0')) {
    throw new PathRejectedError('Path contains a null byte', 'PATH_INVALID');
  }
  // Reject absurd lengths early — nothing real is this long, and oversized
  // input otherwise churns resolve/realpath and bloats error bodies (1MB JSON
  // body limit would allow ~1MB paths).
  if (input.length > 4096) {
    throw new PathRejectedError('Path is too long', 'PATH_INVALID');
  }

  let p = input.trim();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(1));
  }

  const resolved = path.resolve(p);
  if (isBlocked(resolved)) {
    throw new PathRejectedError(`Scanning "${resolved}" is not allowed`, 'PATH_BLOCKED');
  }
  return resolved;
}

/** True when `child` is `parent` itself or located anywhere beneath it. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

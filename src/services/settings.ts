import crypto from 'crypto';
import { AppSettings, IgnoreEntry, ScheduleConfig, IgnoreScope } from '../models/types';
import { readJsonFile, withFileLock, FileLockContext } from './storage';
import { compileIgnoreList, CompiledIgnore } from '../utils/glob';

/**
 * Settings — the user's ignore list and scheduled scans, persisted to
 * settings.json in the app-data dir. Cached in memory; every mutation goes
 * through the storage per-file lock (rebuild-from-disk inside the lock, then
 * persist) so concurrent writers — e.g. the scheduler's bookkeeping and a
 * simultaneous user edit — can never lose each other's changes.
 */

const SETTINGS_FILE = 'settings.json';
const MAX_IGNORE = 100;
const MAX_SCHEDULES = 20;
const SCOPES: IgnoreScope[] = ['scan', 'suggest', 'both'];

let cache: AppSettings | null = null;

/** Canonical empty settings — also the withFileLock fallback for a fresh file. */
const EMPTY_SETTINGS: AppSettings = { ignore: [], schedules: [] };

function normalizeIgnore(raw: unknown): IgnoreEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: IgnoreEntry[] = [];
  for (const entry of raw.slice(0, MAX_IGNORE)) {
    const e = entry as Partial<IgnoreEntry>;
    if (typeof e?.pattern !== 'string') continue;
    const pattern = e.pattern.trim().slice(0, 500);
    if (!pattern || pattern.includes('\0')) continue;
    out.push({ pattern, scope: SCOPES.includes(e.scope as IgnoreScope) ? (e.scope as IgnoreScope) : 'both' });
  }
  return out;
}

function normalizeSchedules(raw: unknown): ScheduleConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: ScheduleConfig[] = [];
  for (const entry of raw.slice(0, MAX_SCHEDULES)) {
    const e = entry as Partial<ScheduleConfig>;
    if (typeof e?.path !== 'string' || !e.path.trim()) continue;
    const hours = Number(e.intervalHours);
    out.push({
      id: typeof e.id === 'string' && e.id ? e.id : crypto.randomUUID(),
      path: e.path.trim(),
      intervalHours: Number.isFinite(hours) ? Math.min(720, Math.max(1, Math.round(hours))) : 24,
      thresholdPct: clampOptional(e.thresholdPct, 0, 100000),
      thresholdBytes: clampOptional(e.thresholdBytes, 0, Number.MAX_SAFE_INTEGER),
      enabled: e.enabled !== false,
      lastRunAt: typeof e.lastRunAt === 'number' ? e.lastRunAt : undefined,
    });
  }
  return out;
}

function clampOptional(v: unknown, min: number, max: number): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(max, Math.max(min, n));
}

/** Normalize raw (untrusted, possibly non-conforming) on-disk JSON into AppSettings. */
function normalizeSettings(raw: unknown): AppSettings {
  const r = (raw ?? {}) as Partial<AppSettings>;
  return { ignore: normalizeIgnore(r.ignore), schedules: normalizeSchedules(r.schedules) };
}

export async function getSettings(): Promise<AppSettings> {
  if (!cache) {
    const raw = await readJsonFile<Partial<AppSettings>>(SETTINGS_FILE, {});
    cache = { ignore: normalizeIgnore(raw.ignore), schedules: normalizeSchedules(raw.schedules) };
  }
  return cache;
}

/**
 * Mutate settings under the per-file lock: rebuild from what is actually on
 * disk INSIDE the lock, apply `mutate`, and let the lock persist the result.
 * The old read-cache → writeJsonFile flow could lose a concurrent writer's
 * change (e.g. the scheduler's lastRunAt vs a user edit); the lock cannot.
 *
 * The in-memory cache is kept coherent by only swapping it in once the lock
 * has persisted the new value.
 *
 * If the on-disk file was unreadable, the lock quarantines it and skips the
 * write for that cycle; we retry once (the file is gone after quarantine, so
 * the retry legitimately writes a fresh file) and only give up — without
 * touching the cache — if the data dir is truly unwritable.
 */
async function persistLocked(mutate: (current: AppSettings, ctx: FileLockContext) => AppSettings): Promise<AppSettings> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let quarantined = false;
    const next = await withFileLock<AppSettings>(SETTINGS_FILE, EMPTY_SETTINGS, (raw, ctx) => {
      // Only a lock-set flag counts as quarantine here (the read failed for a
      // non-ENOENT reason); snapshot it BEFORE mutate so a callback-set flag
      // could never be mistaken for one.
      quarantined = ctx.skipWrite;
      // Rebuild from disk — never from the module cache, which may be stale
      // relative to another writer's just-persisted state.
      return mutate(normalizeSettings(raw), ctx);
    });
    if (!quarantined) {
      cache = next; // write persisted (or was deliberately skipped) — cache and disk agree
      return next;
    }
  }
  throw new Error('settings.json was unreadable and could not be rewritten');
}

/** Replace ignore list and/or schedules (input is re-validated here). */
export async function updateSettings(patch: { ignore?: unknown; schedules?: unknown }): Promise<AppSettings> {
  return persistLocked((current) => {
    const next: AppSettings = {
      ignore: patch.ignore !== undefined ? normalizeIgnore(patch.ignore) : current.ignore,
      schedules: patch.schedules !== undefined ? normalizeSchedules(patch.schedules) : current.schedules,
    };
    // Preserve lastRunAt across edits that didn't intend to reset it.
    if (patch.schedules !== undefined) {
      for (const sched of next.schedules) {
        if (sched.lastRunAt === undefined) {
          const prev = current.schedules.find((s) => s.id === sched.id);
          if (prev?.lastRunAt) sched.lastRunAt = prev.lastRunAt;
        }
      }
    }
    return next;
  });
}

/** Internal helper for the scheduler: update one schedule's bookkeeping. */
export async function patchSchedule(id: string, patch: Partial<ScheduleConfig>): Promise<void> {
  await persistLocked((current) => {
    if (!current.schedules.some((s) => s.id === id)) return current; // unknown id — nothing to change
    return { ...current, schedules: current.schedules.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
  });
}

/** Compiled matchers for a scope, ready for the scanner / suggester. */
export async function getIgnoreMatchers(scope: 'scan' | 'suggest'): Promise<CompiledIgnore[]> {
  const settings = await getSettings();
  const patterns = settings.ignore
    .filter((e) => e.scope === scope || e.scope === 'both')
    .map((e) => e.pattern);
  return compileIgnoreList(patterns);
}

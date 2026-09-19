import { execFile } from 'child_process';
import os from 'os';
import { SystemStats } from '../models/types';

/**
 * systemStats — live macOS system data for the Performance gauges.
 *
 * Assembled from cheap, read-only sources: `sw_vers` (OS version + build),
 * `sysctl` (model identifier, CPU marketing string), `os.uptime()`,
 * `os.hostname()`, a ~500ms `os.cpus()` delta (busy %), `vm_stat` page
 * accounting (used-memory estimate), and `pmset -g batt` (battery state).
 * Every external command runs via execFile with a 4s timeout and degrades to
 * null/fallback on any failure, so a missing binary or a machine without a
 * battery never turns into a failed route.
 *
 * The whole snapshot is cached ~2s (mirroring fans.ts STATUS_CACHE_MS): the
 * CPU sample itself takes ~500ms, and caching the in-flight promise means
 * concurrent UI polls share one sample instead of each re-sampling.
 */

/* ───────────────────────────── Constants ───────────────────────────── */

/** Timeout for every external command spawned here. */
const CMD_TIMEOUT_MS = 4_000;
/** Window over which the cumulative os.cpus() counters are diffed. */
const CPU_SAMPLE_MS = 500;
/** How long a snapshot stays fresh; matches fans.ts STATUS_CACHE_MS. */
const STATS_CACHE_MS = 2_000;

const SW_VERS = '/usr/bin/sw_vers';
const SYSCTL = '/usr/sbin/sysctl';
const VM_STAT = '/usr/bin/vm_stat';
const PMSET = '/usr/bin/pmset';

/* ───────────────────────── exec plumbing ───────────────────────────── */

interface ExecResult {
  stdout: string;
  stderr: string;
}

function execFileP(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: CMD_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          (err as NodeJS.ErrnoException & ExecResult).stdout = stdout;
          (err as NodeJS.ErrnoException & ExecResult).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      }
    );
  });
}

/** Trimmed stdout of a command, or null on any failure (missing binary, timeout, non-zero exit). */
async function execText(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP(cmd, args);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/* ─────────────────────────── CPU sampling ─────────────────────────── */

/** Cumulative os.cpus() tick counters summed across all cores. */
function cpuTicks(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const ms of Object.values(cpu.times)) total += ms;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

/**
 * Busy CPU percentage as a DELTA of the cumulative os.cpus() counters over a
 * short window. os.cpus() alone only exposes since-boot averages, which stay
 * flat and useless for a live gauge — the diff is what makes it live.
 */
async function sampleCpuPercent(): Promise<number> {
  const before = cpuTicks();
  await new Promise((resolve) => setTimeout(resolve, CPU_SAMPLE_MS));
  const after = cpuTicks();
  const idleDelta = after.idle - before.idle;
  const totalDelta = after.total - before.total;
  if (totalDelta <= 0) return 0;
  const busyPercent = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.max(0, Math.min(100, Math.round(busyPercent)));
}

/* ─────────────────────────── Memory ────────────────────────────────── */

interface MemoryUsage {
  totalBytes: number;
  usedBytes: number;
}

/** Default Mach page size per CPU architecture (fallback when vm_stat's header is absent). */
function defaultPageSize(): number {
  return os.arch() === 'arm64' ? 16_384 : 4_096;
}

/**
 * Used memory. Source is `vm_stat` page accounting:
 *   used = total − (free + speculative [+ purgeable] [+ file-backed]) × pageSize
 * Speculative pages are clean readahead; purgeable and file-backed pages are
 * the OS's reclaimable cache. Discounting them gets close to how Activity
 * Monitor presents "Memory Used", but the two will never match to the byte —
 * AM slices cached files differently, and vm_stat exposes no clean/dirty split
 * for file-backed pages. When vm_stat fails, can't be parsed, or doesn't
 * report those cache pages, we keep whatever accounting vm_stat did allow and
 * degrade to the rougher os.freemem() heuristic (which counts wired +
 * compressed memory as used) only when its mandatory lines are missing.
 * Never throws.
 *
 * NOTE: `vm_stat -q` is NOT supported (illegal option on current macOS); the
 * plain output is parsed instead — it carries everything needed.
 */
async function readMemoryUsage(): Promise<MemoryUsage> {
  const totalBytes = os.totalmem();
  const fallback: MemoryUsage = { totalBytes, usedBytes: totalBytes - os.freemem() };
  if (process.platform !== 'darwin') return fallback;

  try {
    const { stdout } = await execFileP(VM_STAT, []);
    const header = stdout.match(/page size of (\d+) bytes/);
    const pageSize = header ? parseInt(header[1], 10) : defaultPageSize();
    // Lines look like "Pages free:            1082393." — plain or comma-grouped
    // integers with a trailing period.
    const pages = (label: string): number | null => {
      const m = stdout.match(new RegExp(`^${label}:\\s*([\\d,]+)\\.?`, 'm'));
      return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
    };
    const freePages = pages('Pages free');
    const speculativePages = pages('Pages speculative');
    if (freePages === null || speculativePages === null) return fallback;
    // Reclaimable cache pages — subtracted only when vm_stat actually reports
    // them (labels vary across macOS releases; older ones omit these lines).
    let notUsedPages = freePages + speculativePages;
    const purgeablePages = pages('Pages purgeable');
    if (purgeablePages !== null) notUsedPages += purgeablePages;
    const fileBackedPages = pages('File-backed pages');
    if (fileBackedPages !== null) notUsedPages += fileBackedPages;
    const used = totalBytes - notUsedPages * pageSize;
    if (!Number.isFinite(used)) return fallback;
    // On a mostly idle machine the cache pages can outweigh the remainder —
    // report 0 rather than a nonsense negative gauge.
    return { totalBytes, usedBytes: Math.max(0, Math.round(used)) };
  } catch {
    return fallback;
  }
}

/* ─────────────────────────── Battery ───────────────────────────────── */

/**
 * Battery state from `pmset -g batt`. The data line looks like:
 *   -InternalBattery-0 (id=7077987)  34%; charging; 12:19 remaining present: true
 * Desktops (no InternalBattery line) and parse/spawn failures get null, which
 * the UI treats as "no battery".
 */
async function readBattery(): Promise<SystemStats['battery']> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileP(PMSET, ['-g', 'batt']);
    const line = stdout.split('\n').find((l) => l.includes('InternalBattery'));
    if (!line) return null;
    const percentMatch = line.match(/(\d+)%/);
    if (!percentMatch) return null;
    const timeMatch = line.match(/(\d+):(\d+)\s+remaining/i);
    return {
      percent: parseInt(percentMatch[1], 10),
      // AC adapter attached or actively charging — what a gauge bolt icon means.
      // (Word-bounded so "discharging"/"charged" never match.)
      charging: /'AC Power'/.test(stdout) || /\bcharging\b/i.test(line),
      timeRemaining: timeMatch ? parseInt(timeMatch[1], 10) * 60 + parseInt(timeMatch[2], 10) : null,
    };
  } catch {
    return null;
  }
}

/* ─────────────────────── Snapshot assembly ─────────────────────────── */

/** In-flight/recent snapshot, mirroring fans.ts readStatus caching. */
let statsCache: { at: number; value: Promise<SystemStats> } | null = null;

async function buildStats(): Promise<SystemStats> {
  const isMac = process.platform === 'darwin';
  // All sources run concurrently; the CPU sampler is the long pole (~500ms).
  const [osVersion, osBuild, modelName, chip, cpuPercent, memory, battery] = await Promise.all([
    isMac ? execText(SW_VERS, ['-productVersion']) : Promise.resolve(null),
    isMac ? execText(SW_VERS, ['-buildVersion']) : Promise.resolve(null),
    isMac ? execText(SYSCTL, ['-n', 'hw.model']) : Promise.resolve(null),
    isMac ? execText(SYSCTL, ['-n', 'machdep.cpu.brand_string']) : Promise.resolve(null),
    sampleCpuPercent(),
    readMemoryUsage(),
    readBattery(),
  ]);

  return {
    osVersion,
    osBuild,
    modelName,
    chip,
    uptimeSeconds: Math.floor(os.uptime()),
    hostname: os.hostname(),
    cpuPercent,
    memory,
    battery,
  };
}

/**
 * Live system snapshot for GET /api/system/stats. Cached ~2s so concurrent
 * requests share one CPU sample and one round of command spawns. Never rejects:
 * every source degrades to null/fallback on failure.
 */
export function getSystemStats(): Promise<SystemStats> {
  const now = Date.now();
  if (statsCache && now - statsCache.at < STATS_CACHE_MS) return statsCache.value;

  const value = buildStats();
  statsCache = { at: now, value };
  // Drop a failed read from the cache so the next call retries immediately
  // (buildStats is designed not to reject; this is belt-and-braces).
  value.catch(() => {
    if (statsCache?.value === value) statsCache = null;
  });
  return value;
}

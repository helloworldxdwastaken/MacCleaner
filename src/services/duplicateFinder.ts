import { createHash } from 'crypto';
import { createReadStream, promises as fsp } from 'fs';
import { FileNode, ScanResult, DuplicateGroup, DuplicateJob } from '../models/types';
import { getScan, setOnScanEvicted } from './diskScanner';

/**
 * DuplicateFinder — true (content-equal) duplicate detection over a completed
 * scan, cheap-to-expensive in three stages:
 *
 *   1. group by exact size            (free — sizes come from the scan tree)
 *   2. hash the first 64 KiB          (catches most false positives quickly)
 *   3. stream a full SHA-256          (only for files still matching)
 *
 * Files whose entire content fits in the stage-2 read (size ≤ 64 KiB) skip
 * stage 3: their partial digest already covers the whole file, so it IS the
 * full hash and re-reading would be a wasted second pass.
 *
 * Groups are hardlink/clone-aware but list EVERY path ("list all paths,
 * count by distinct inode"): entries sharing an inode (FileNode.ino) are one
 * physical copy on disk, so `count` is the DISTINCT-inode count and
 * reclaimable bytes are size × (distinct inodes − 1) — while every sibling
 * link stays listed so the user can trash any/all copies (the earlier
 * one-representative-per-inode view hid sibling links, which kept inodes
 * alive after a keep-one trash and made the advertised bytes unreachable).
 * Groups where ≥2 paths share one inode carry `sharedInode: true`: trashing
 * all paths of one inode still frees nothing until the group's other inodes
 * go, which the UI surfaces. Scans without inode data fall back to per-path
 * counting (the pre-inode behavior).
 *
 * Hashing runs as a background job per scanId; the API polls the job record,
 * mirroring how scans themselves report progress. Progress counts hashing
 * PASSES: a file ≤ 64 KiB is hashed once, a larger file twice (partial, then
 * full), so `toHash` grows once — by the stage-3 count — after stage 2
 * completes. Every pass increments `hashed`, so the UI never sits at 0/N
 * while stage 2 churns through huge size buckets.
 *
 * Jobs are error-sticky: a failed job is returned as-is (the API surfaces the
 * error as a 500) instead of being silently restarted on the next poll.
 * Each job also has a wall-clock timeout so a pathological tree fails with a
 * clear message instead of hashing forever.
 */

const PARTIAL_BYTES = 64 * 1024;
/** How many files are hashed concurrently. */
const HASH_CONCURRENCY = 4;
/**
 * Wall-clock budget for one duplicate job. Hashing is I/O bound and
 * cooperative, so the budget is enforced between files/buckets (not with a
 * timer) — a 10-minute job means 10 minutes of real hashing work, and huge
 * scans fail with guidance instead of spinning.
 */
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

const jobs = new Map<string, DuplicateJob>();

/**
 * Whether a scan's tree dropped children to honor the node cap, per scanId.
 * Kept beside the job (not on it) because DuplicateJob is a shared contract
 * type; cleaned up everywhere the job itself is cleaned up.
 */
const treeTruncatedByScan = new Map<string, boolean>();

/**
 * Group shape actually produced here: the group and each of its members carry
 * a stable id (the content hash) so the frontend can correlate a set of paths
 * about to be trashed with the groups they would fully empty
 * (POST /api/duplicates/validate-delete). DuplicateGroup in types.ts is a
 * shared contract and stays id-free; the extra fields simply serialize.
 * `sharedInode` (also not in the shared contract — documented here, per the
 * apps.ts precedent) is true when ≥2 listed paths share one inode
 * (hardlinks / APFS clones): trashing every path of that inode still frees
 * nothing until the group's other inodes go — the UI surfaces this note.
 */
export type DuplicateGroupWithId = DuplicateGroup & {
  groupId: string;
  sharedInode: boolean;
  files: (DuplicateGroup['files'][number] & { groupId: string })[];
};

/**
 * Scan-eviction hook: when the scanner TTLs a finished scan, its duplicate
 * job must die with it or the map would leak jobs for forgotten scans.
 * Registered once at module load; diskScanner deliberately cannot import this
 * module (would be a cyclic, policy-bearing dependency).
 */
setOnScanEvicted((scanId) => cancelDuplicateJobsForScan(scanId));

export function cancelAllDuplicateJobs(): void {
  for (const job of jobs.values()) job.cancelled = true;
  jobs.clear();
  treeTruncatedByScan.clear();
}

/**
 * Cancel + drop the duplicate job of ONE scan (the eviction-hook target).
 * Other scans' jobs are never touched — cancelling everything here would kill
 * hashing for scans that are still alive.
 */
export function cancelDuplicateJobsForScan(scanId: string): void {
  const job = jobs.get(scanId);
  if (job) job.cancelled = true;
  jobs.delete(scanId);
  treeTruncatedByScan.delete(scanId);
}

/**
 * Read-only job lookup for API routes that must NOT start a job
 * (validate-delete). Starting hashing as a side effect of a validation call
 * would make the endpoint non-idempotent and spend I/O the caller didn't ask
 * for.
 */
export function getDuplicateJobRecord(scanId: string): DuplicateJob | undefined {
  return jobs.get(scanId);
}

/** True when the scanned tree dropped children (node cap) — surfaced on the API response. */
export function getDuplicateTreeTruncated(scanId: string): boolean {
  return treeTruncatedByScan.get(scanId) ?? false;
}

/**
 * Group ids whose EVERY member path is contained in `paths` — i.e. groups the
 * caller is about to trash the last reachable copy of. The frontend must
 * refuse to proceed while this is non-empty. Checks the FULL group list (not
 * just the top slice the UI shows) so a match can never be missed — missing a
 * fully-trashed group would allow an unsafe delete, the one direction we must
 * never fail in. The check is per PATH, and since groups now list every
 * sibling link (list-all-paths design), "fully trashed" is exact: it fires
 * only when every known link of the content is being trashed, not merely the
 * representatives the UI happened to show.
 */
export function groupIdsFullyTrashed(groups: DuplicateGroup[] | undefined, paths: readonly string[]): string[] {
  const selected = new Set(paths);
  const fullyTrashed: string[] = [];
  for (const group of groups ?? []) {
    if (group.files.length > 0 && group.files.every((f) => selected.has(f.path))) {
      fullyTrashed.push((group as DuplicateGroupWithId).groupId);
    }
  }
  return fullyTrashed;
}

/**
 * Get (or start) the duplicate job for a scan. Re-uses the finished result on
 * subsequent calls; jobs die with their scan (eviction hook above, plus a
 * belt-and-braces sweep here in case the hook was not registered).
 */
export function getDuplicateJob(scan: ScanResult, minSize: number): DuplicateJob {
  // Evict jobs whose scan has been evicted so the map can't grow forever.
  for (const [scanId, job] of jobs) {
    if (!getScan(scanId)) {
      job.cancelled = true;
      jobs.delete(scanId);
      treeTruncatedByScan.delete(scanId);
    }
  }

  const existing = jobs.get(scan.scanId);
  // Error jobs are STICKY for the same minSize: auto-restarting them made the
  // API's error branch unreachable (every poll silently kicked off a fresh
  // job) and could burn I/O re-running a deterministic failure. Changing
  // minSize starts a genuinely different job — that is the supported retry.
  if (existing && existing.minSize === minSize) {
    return existing;
  }
  if (existing) existing.cancelled = true;

  const job: DuplicateJob = {
    scanId: scan.scanId,
    status: 'running',
    minSize,
    hashed: 0,
    toHash: 0,
    cancelled: false,
    startedAt: Date.now(),
  };
  jobs.set(scan.scanId, job);

  void findDuplicates(scan, job).catch((err: unknown) => {
    job.status = 'error';
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = Date.now();
  });

  return job;
}

/* ------------------------------ job body ------------------------------ */

function isTimedOut(job: DuplicateJob): boolean {
  return Date.now() - job.startedAt > JOB_TIMEOUT_MS;
}

/** Terminal timeout state with actionable guidance (checked between files/buckets). */
function failTimedOut(job: DuplicateJob): void {
  job.status = 'error';
  job.error = `Duplicate detection timed out after ${Math.round(JOB_TIMEOUT_MS / 60_000)} minutes — narrow the scan root or raise the minimum file size`;
  job.finishedAt = Date.now();
}

async function findDuplicates(scan: ScanResult, job: DuplicateJob): Promise<void> {
  if (!scan.root) throw new Error('Scan has no result tree');

  // Stage 1 — bucket every file by size; only same-size files can be equal.
  // The same walk also picks up truncation markers so the API can tell the
  // UI that sizes/paths below a truncated dir may be missing.
  const bySize = new Map<number, FileNode[]>();
  let treeTruncated = false;
  const stack: FileNode[] = [scan.root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.truncated) treeTruncated = true;
    if (node.type === 'file') {
      if (node.size >= job.minSize) {
        const bucket = bySize.get(node.size);
        if (bucket) bucket.push(node);
        else bySize.set(node.size, [node]);
      }
      continue;
    }
    if (node.children) for (const c of node.children) stack.push(c);
  }
  treeTruncatedByScan.set(scan.scanId, treeTruncated);

  const candidates: FileNode[][] = [];
  for (const bucket of bySize.values()) {
    if (bucket.length > 1) candidates.push(bucket);
  }
  job.toHash = candidates.reduce((sum, b) => sum + b.length, 0);

  // Stage 2 — partial hash inside each size bucket. `hashed` advances per
  // bucket (not per stage) so progress is visible inside one huge bucket.
  const digestByNode = new Map<FileNode, string>();
  const partialGroups: FileNode[][] = [];
  for (const bucket of candidates) {
    if (job.cancelled) return;
    if (isTimedOut(job)) return failTimedOut(job);
    const hashes = await mapConcurrent(
      bucket,
      HASH_CONCURRENCY,
      (f) => hashRegularFile(f.path, PARTIAL_BYTES).catch(() => null),
      () => job.cancelled || isTimedOut(job)
    );
    if (job.cancelled) return;
    if (isTimedOut(job)) return failTimedOut(job);
    job.hashed += bucket.length;
    const byPartial = new Map<string, FileNode[]>();
    bucket.forEach((file, i) => {
      const h = hashes[i];
      if (h == null) return; // unreadable / non-regular / vanished — drop it
      digestByNode.set(file, h);
      const group = byPartial.get(h);
      if (group) group.push(file);
      else byPartial.set(h, [file]);
    });
    for (const group of byPartial.values()) {
      if (group.length > 1) partialGroups.push(group);
    }
  }

  // Split stage-3 input: files ≤ PARTIAL_BYTES were fully covered by their
  // stage-2 read, so that digest IS the full hash — reuse it and skip the
  // second read entirely. Only larger files need a full streaming pass.
  const byFull = new Map<string, FileNode[]>();
  const stage3Groups: FileNode[][] = [];
  for (const group of partialGroups) {
    const larges: FileNode[] = [];
    for (const file of group) {
      if (file.size <= PARTIAL_BYTES) {
        pushInto(byFull, `${file.size}:${digestByNode.get(file)}`, file);
      } else {
        larges.push(file);
      }
    }
    if (larges.length > 0) stage3Groups.push(larges);
  }

  // Progress semantics: every hashing PASS counts once, so `toHash` is
  // rescaled once here by the stage-3 pass count (known only after stage 2)
  // and stage 3 keeps incrementing `hashed` per bucket. Monotonic and honest.
  job.toHash += stage3Groups.reduce((sum, g) => sum + g.length, 0);

  // Stage 3 — full hash for groups that still match.
  for (const group of stage3Groups) {
    if (job.cancelled) return;
    if (isTimedOut(job)) return failTimedOut(job);
    const hashes = await mapConcurrent(
      group,
      HASH_CONCURRENCY,
      (f) => hashRegularFile(f.path).catch(() => null),
      () => job.cancelled || isTimedOut(job)
    );
    if (job.cancelled) return;
    if (isTimedOut(job)) return failTimedOut(job);
    job.hashed += group.length;
    group.forEach((file, i) => {
      const h = hashes[i];
      if (h == null) return;
      pushInto(byFull, `${file.size}:${h}`, file);
    });
  }

  /* ---------------------- group assembly (inode-aware) ---------------------- */

  const groups: DuplicateGroupWithId[] = [];
  for (const [key, files] of byFull) {
    if (files.length < 2) continue;
    const size = files[0].size;
    const hash = key.slice(key.indexOf(':') + 1);

    // Hardlink / APFS-clone awareness — "list all paths, count by distinct
    // inode". Entries sharing an inode are the SAME physical bytes on disk,
    // so `count` and `reclaimable` are computed over DISTINCT inodes only
    // (size × (distinct − 1)); but EVERY path stays listed so the user can
    // trash any/all copies — the earlier one-representative-per-inode view
    // hid sibling links, which kept inodes alive after a keep-one trash and
    // made the advertised bytes unreachable. `sharedInode` flags groups where
    // ≥2 paths share one inode: trashing all paths of that inode still frees
    // nothing until the group's other inodes go (the UI surfaces this).
    // Scans without inode data (older scans) fall back to per-path counting
    // (the pre-inode behavior) — partial inode data falls back too, since a
    // mixed set can't be trusted to partition physical copies. A group with
    // a single distinct inode has zero keep-one reclaimable bytes and is
    // dropped, as before.
    const allHaveIno = files.every((f) => typeof f.ino === 'number');
    let distinctInodes: number;
    let sharedInode: boolean;
    if (allHaveIno) {
      const pathsPerIno = new Map<number, number>();
      for (const f of files) {
        pathsPerIno.set(f.ino!, (pathsPerIno.get(f.ino!) ?? 0) + 1);
      }
      distinctInodes = pathsPerIno.size;
      // ≥2 paths share an inode exactly when some inode holds more than one
      // of the group's paths — equivalently, total paths > distinct inodes.
      sharedInode = files.length > pathsPerIno.size;
    } else {
      distinctInodes = files.length;
      sharedInode = false;
    }
    if (distinctInodes < 2) continue;

    groups.push({
      hash,
      size,
      // Distinct physical copies; files.length ≥ count — the extras are
      // sibling links of an already-counted inode, surfaced via sharedInode.
      count: distinctInodes,
      reclaimable: size * (distinctInodes - 1),
      groupId: hash,
      sharedInode,
      files: files
        .map((f) => ({ name: f.name, path: f.path, modifiedAt: f.modifiedAt, groupId: hash }))
        .sort((a, b) => b.modifiedAt - a.modifiedAt),
    });
  }
  groups.sort((a, b) => b.reclaimable - a.reclaimable);

  // The FULL group list lives on the job; the API layer slices it for the
  // response. validate-delete needs every group — validating only the visible
  // top slice could miss a fully-trashed group and allow an unsafe delete.
  job.groups = groups;
  job.groupCount = groups.length;
  job.totalReclaimable = groups.reduce((sum, g) => sum + g.reclaimable, 0);
  job.status = 'complete';
  job.finishedAt = Date.now();
}

/* ------------------------------ helpers ------------------------------ */

function pushInto(map: Map<string, FileNode[]>, key: string, file: FileNode): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(file);
  else map.set(key, [file]);
}

/**
 * SHA-256 of a file — the whole file, or just the first `limit` bytes — but
 * only for REGULAR files. The scanner records symlinks as leaf nodes (lstat
 * reports the link itself), and hashing one would either hash the tiny link
 * or follow it and report the target's bytes twice; non-regular files (fifos,
 * sockets, devices) must never be opened at all — a fifo would block the
 * worker forever. One lstat per hashed file is the same I/O order as the open
 * the hash performs anyway, so this stays cheap and bounded.
 */
async function hashRegularFile(filePath: string, limit?: number): Promise<string | null> {
  try {
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile()) return null;
  } catch {
    return null; // vanished between scan and hash
  }
  return hashFile(filePath, limit);
}

/** SHA-256 of a file — the whole file, or just the first `limit` bytes. */
function hashFile(filePath: string, limit?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath, limit ? { start: 0, end: limit - 1 } : {});
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Run `fn` over `items` with at most `limit` in flight; results keep order.
 * `shouldStop` is re-checked per FILE inside the worker loop so a cancel or
 * timeout lands within milliseconds even mid-way through one enormous bucket
 * — waiting for the whole bucket would leave a huge job unresponsive.
 * Stopped workers leave holes (undefined) in `results`; callers bail out
 * before consuming them whenever `shouldStop` fired.
 */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  shouldStop?: () => boolean
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !(shouldStop?.() ?? false)) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

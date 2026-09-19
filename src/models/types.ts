/**
 * MacCleaner — shared TypeScript interfaces.
 * Every shape that crosses a service or API boundary lives here.
 */

/** A single file or directory in the scanned tree. */
export interface FileNode {
  name: string;
  path: string;
  /** Bytes. For directories this is the recursive sum of all children. */
  size: number;
  type: 'file' | 'dir';
  /** Present only for directories. */
  children?: FileNode[];
  /** Lower-cased extension without the dot, e.g. "png". Files only. */
  extension?: string;
  /** Unix epoch milliseconds of last modification. */
  modifiedAt: number;
  isHidden: boolean;
  /**
   * Set on a directory whose children were dropped to cap the retained tree
   * size; `size` stays the full recursive total. Renderers should treat such
   * a dir as a leaf that hides detail.
   */
  truncated?: boolean;
  /**
   * Inode number from lstat, when the platform provides one. Lets consumers
   * (duplicate finder, hardlink-aware aggregations) distinguish two directory
   * entries that point at the same physical file from content copies.
   * Optional — absent on paths where lstat ran but the scanner recorded no
   * inode, and on nodes persisted by older versions.
   */
  ino?: number;
}

export type ScanStatus = 'running' | 'complete' | 'error';

/** Mutable record of one scan, kept in the in-memory store. */
export interface ScanResult {
  scanId: string;
  rootPath: string;
  status: ScanStatus;
  /** Total filesystem entries seen so far (files + dirs). */
  scanned: number;
  fileCount: number;
  dirCount: number;
  /** Path the scanner most recently touched — used for progress UI. */
  currentPath: string;
  /** Populated once status === 'complete'. */
  root?: FileNode;
  /** Populated once status === 'error'. */
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /** Used by the TTL evictor. */
  createdAt: number;
  /** Cooperative cancellation flag (set on shutdown/eviction). */
  cancelled: boolean;
}

/** One rectangle of the squarified treemap, coordinates in percent (0–100). */
export interface TreemapNode {
  name: string;
  path: string;
  size: number;
  type: 'file' | 'dir';
  extension?: string;
  modifiedAt: number;
  depth: number;
  /** Whether this dir's children were also emitted (false = leaf in this view). */
  expanded: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Events streamed over the SSE progress endpoint. */
export type ScanEvent =
  | { type: 'progress'; scanned: number; currentPath: string }
  | { type: 'complete'; root: FileNode }
  | { type: 'error'; message: string }
  | { type: 'shutdown' };

/** A batch trash operation. */
export interface CleanJob {
  paths: string[];
}

export interface CleanResult {
  deleted: string[];
  failed: { path: string; reason: string }[];
  /**
   * Authoritative bytes freed, keyed by the paths in `deleted`. Each value is
   * the size measured (recursively for dirs) by stat-ing the path BEFORE it was
   * trashed. Only successfully-trashed paths appear here. The frontend must
   * credit these numbers — never pre-scan estimates.
   */
  freedBytes: Record<string, number>;
  /** Sum of `freedBytes` over all successfully-trashed paths. */
  totalFreedBytes: number;
}

export interface SystemInfo {
  platform: NodeJS.Platform;
  hostname: string;
  totalDisk: number;
  freeDisk: number;
  homeDir: string;
  commonDirs: string[];
}

export interface FileTypeStat {
  ext: string;
  count: number;
  totalSize: number;
}

export interface LargeFile {
  name: string;
  path: string;
  size: number;
  extension?: string;
  modifiedAt: number;
}

export interface LargeFolder {
  name: string;
  path: string;
  size: number;
  /** Recursive file count. */
  fileCount: number;
  modifiedAt: number;
  /**
   * True when this folder (or something beneath it) was truncated by the
   * tree cap: `fileCount` is then a lower bound (≥1) and the UI should show
   * "≥" instead of presenting it as an exact count.
   */
  truncated?: boolean;
}

/* ---------- Duplicate finder ---------- */

/** One group of content-identical files. */
export interface DuplicateGroup {
  /** Full SHA-256 of the content (hex). */
  hash: string;
  /** Size of one copy, bytes. */
  size: number;
  count: number;
  /** Bytes freed by keeping a single copy: size × (count − 1). */
  reclaimable: number;
  /** Newest first. */
  files: { name: string; path: string; modifiedAt: number }[];
}

export type DuplicateJobStatus = 'running' | 'complete' | 'error';

/** Mutable record of one background hashing job (per scanId). */
export interface DuplicateJob {
  scanId: string;
  status: DuplicateJobStatus;
  /** Files below this many bytes were not considered. */
  minSize: number;
  /** Hashing progress for the UI. */
  hashed: number;
  toHash: number;
  cancelled: boolean;
  /** Populated once status === 'complete' (top groups by reclaimable). */
  groups?: DuplicateGroup[];
  groupCount?: number;
  totalReclaimable?: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

/* ---------- Empty folders ---------- */

export interface EmptyFoldersResult {
  /** Topmost recursively-empty dirs (parents themselves not empty). */
  folders: { name: string; path: string }[];
  /** All empty dirs found, including those nested inside the ones above. */
  totalCount: number;
  truncated: boolean;
}

/* ---------- Snapshots (size history / Trends) ---------- */

export interface SnapshotTopEntry {
  name: string;
  path: string;
  size: number;
  type: 'file' | 'dir';
}

/** Lightweight persisted record of one completed scan. */
export interface Snapshot {
  id: string;
  rootPath: string;
  takenAt: number;
  totalSize: number;
  fileCount: number;
  dirCount: number;
  /** Direct children of the root at scan time, largest first. */
  topEntries: SnapshotTopEntry[];
}

export interface SnapshotRef {
  id: string;
  takenAt: number;
  totalSize: number;
}

export interface SnapshotDeltaEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  /** null = entry did not exist in that snapshot. */
  sizeA: number | null;
  sizeB: number | null;
  delta: number;
}

export interface SnapshotDiff {
  a: SnapshotRef;
  b: SnapshotRef;
  rootPath: string;
  totalDelta: number;
  entries: SnapshotDeltaEntry[];
}

/* ---------- Scan comparison ---------- */

export type CompareChange = 'added' | 'removed' | 'grew' | 'shrank';

export interface CompareEntry {
  path: string;
  name: string;
  type: 'file' | 'dir';
  sizeA: number | null;
  sizeB: number | null;
  delta: number;
  change: CompareChange;
}

export interface CompareResult {
  scanIdA: string;
  scanIdB: string;
  rootPath: string;
  totalDelta: number;
  entries: CompareEntry[];
  truncated: boolean;
}

/* ---------- Settings: ignore list + scheduled scans ---------- */

export type IgnoreScope = 'scan' | 'suggest' | 'both';

export interface IgnoreEntry {
  /** Absolute path, path glob, or bare name glob (e.g. "node_modules", "*.iso"). */
  pattern: string;
  /** 'scan' = skip while walking; 'suggest' = hide from cleanup suggestions. */
  scope: IgnoreScope;
}

export interface ScheduleConfig {
  id: string;
  path: string;
  /** Hours between runs, e.g. 24 = daily. */
  intervalHours: number;
  /** Alert when growth since the previous snapshot exceeds either bound. */
  thresholdPct?: number;
  thresholdBytes?: number;
  enabled: boolean;
  lastRunAt?: number;
}

export interface AppSettings {
  ignore: IgnoreEntry[];
  schedules: ScheduleConfig[];
}

/** Emitted when a scheduled scan crosses its growth threshold. */
export interface GrowthNotification {
  id: string;
  path: string;
  at: number;
  message: string;
  prevSize: number;
  newSize: number;
  delta: number;
}

/* ---------- Smart cleanup suggestions ---------- */

export interface CleanupSuggestionItem {
  name: string;
  path: string;
  size: number;
  type: 'file' | 'dir';
  modifiedAt: number;
}

export interface CleanupSuggestionGroup {
  id: string;
  title: string;
  description: string;
  items: CleanupSuggestionItem[];
  totalSize: number;
}

/* ---------- Clean the Mac (well-known macOS junk locations) ---------- */

/** One macOS junk category, paired with the scan that backs its deletes. */
export interface MacCleanCategoryResult {
  id: string;
  title: string;
  description: string;
  /** Absolute directory this category scanned. */
  path: string;
  /** Scan whose root is `path`; poll /api/scan/:scanId/result for sizes. */
  scanId: string;
}

/* ---------- Applications: Uninstaller + Updater ---------- */

/**
 * One user LaunchAgent (~/Library/LaunchAgents/*.plist). These are the modern
 * per-user background items (the surface macOS 13+ "Login Items & Extensions"
 * and CleanMyMac show) that the legacy System Events login-items list misses.
 */
export interface LaunchAgent {
  /** The plist's Label (or the filename stem if it has none). */
  label: string;
  /** Absolute path to the .plist. */
  path: string;
  /** First entry of ProgramArguments, or the Program key — what it launches. */
  program: string | null;
  /** RunAtLoad key (launches at login). */
  runAtLoad: boolean;
  /** KeepAlive key (relaunched if it exits). */
  keepAlive: boolean;
  /**
   * Whether the agent is currently loaded/enabled for the user session, from
   * `launchctl print gui/<uid>/<label>` (falls back to the plist's Disabled key
   * when launchctl can't be queried). null = couldn't determine.
   */
  enabled: boolean | null;
}

/** One installed macOS application (top-level *.app in /Applications or ~/Applications). */
export interface AppSummary {
  /** Display name (the .app filename without the extension). */
  name: string;
  /** Absolute path to the .app bundle. */
  path: string;
  /** CFBundleIdentifier, or null if the Info.plist lacks one. */
  bundleId: string | null;
  /** CFBundleShortVersionString (falls back to CFBundleVersion), or null. */
  version: string | null;
  /** CFBundleExecutable — used for exact running-process detection. */
  executable: string | null;
  /** Base64 PNG data URI of the app's icon, or null if none. */
  icon: string | null;
  /** How this app updates: 'mas' = Mac App Store, 'self' = self-updating/unknown. */
  updateSource: 'mas' | 'self';
  /** Best-effort vendor website (from the bundle id), or null. */
  website: string | null;
}

/** One non-Homebrew app in the Updater's "other apps" group. */

/** One support-file an app leaves behind under ~/Library. */
export interface AppLeftover {
  /** Basename of the leftover file/folder. */
  name: string;
  /** Absolute path (always inside ~/Library). */
  path: string;
  /** Which ~/Library subfolder it lives in, e.g. "Caches", "Preferences". */
  category: string;
  /** Bytes, from the registered scan. */
  size: number;
}

/** Result of analyzing one app for uninstall: the bundle + its leftovers. */
export interface AppLeftoversResult {
  app: {
    name: string;
    path: string;
    bundleId: string | null;
    version: string | null;
    icon: string | null;
    size: number;
    /** True when a process with the bundle's executable name is running. */
    running: boolean;
  };
  leftovers: AppLeftover[];
  /** App bundle + every leftover, bytes. */
  totalSize: number;
  /**
   * Present when the app is currently RUNNING. The UI should require the user to
   * quit the app before uninstalling — trashing a live app's bundle/containers
   * can corrupt open state or leave the process orphaned. A gentle block/flag,
   * not a hard server refusal (delete still routes through Trash).
   */
  warning?: string;
}

/** One Homebrew cask with an available update. */

/** How an installed app can be updated, when a newer version is available. */
export interface AppUpdateInfo {
  /** cask = `brew install --cask --adopt`, mas = `mas upgrade`, sparkle = launch the app. */
  kind: 'cask' | 'mas' | 'sparkle';
  /** Homebrew cask token (kind 'cask'). */
  token?: string;
  /** App Store id (kind 'mas'). */
  id?: string;
  latestVersion: string;
  /**
   * kind 'cask' only. true = the installed app was matched to this cask by name
   * ALONE, without a bundle-id confirmation, so `brew install --cask --force`
   * could overwrite the app with a different vendor's binary. The UI must NOT
   * one-click these — require explicit user confirmation first.
   */
  uncertain?: boolean;
  /** Human reason a cask match is uncertain (shown on the confirm prompt). */
  uncertainReason?: string;
}

/** One installed app in the Updater, with an update if one is available. */
export interface AppUpdate {
  name: string;
  path: string;
  icon: string | null;
  source: 'mas' | 'self';
  currentVersion: string | null;
  update: AppUpdateInfo | null;
}

/** A self-updating (Sparkle) app with a newer version available per its appcast. */

/** One Mac App Store app with an available update (via the `mas` CLI). */
export interface MasUpdate {
  /** App Store numeric id (used for `mas upgrade <id>`). */
  id: string;
  name: string;
  installedVersion: string | null;
  latestVersion: string | null;
  icon: string | null;
}

/** Outcome of a single `brew upgrade --cask` run. */
export interface BrewUpgradeResult {
  ok: boolean;
  token: string;
  /** Last line of brew's stdout (success) or stderr (failure). */
  message: string;
  /** Update needs an admin password — finish it interactively in Terminal. */
  needsTerminal?: boolean;
}

/* ---------- Activity hub (Dashboard lifetime stats) ---------- */

export type ActivityKind = 'fast-clean' | 'system-junk' | 'uninstall' | 'update' | 'large-old';

/** One recorded cleaner action. */
export interface ActivityEvent {
  /** Unix epoch ms. */
  at: number;
  kind: ActivityKind;
  /** Human label, e.g. an app name or "application caches". */
  label: string;
  /** Bytes moved to Trash / recovered (0 for updates). */
  bytes: number;
  /** Count of items affected (paths trashed, casks updated, …). */
  items: number;
}

/** Persisted cumulative activity + recent log. */
export interface ActivitySummary {
  /** When the first event was recorded (drives "since {date}"); null when empty. */
  firstRecordedAt: number | null;
  totalBytesRecovered: number;
  junkItemsCleaned: number;
  appsUninstalled: number;
  programsUpdated: number;
  /** Newest first, capped. */
  log: ActivityEvent[];
}

/** Uniform API error body. */
export interface ApiError {
  error: string;
  code: string;
}

/* ---------- Live system stats (Performance gauges) ---------- */

/**
 * Live macOS system snapshot for the Performance section (GET /api/system/stats).
 * Externally sourced fields degrade to null on failure — the route never fails.
 */
export interface SystemStats {
  /** macOS product version, e.g. "15.3". */
  osVersion: string | null;
  /** macOS build number, e.g. "24D60". */
  osBuild: string | null;
  /** Raw hardware model identifier, e.g. "MacBookPro18,1". */
  modelName: string | null;
  /** CPU marketing string, e.g. "Apple M1 Max". */
  chip: string | null;
  /** Seconds since boot. */
  uptimeSeconds: number;
  hostname: string;
  /** CPU busy percent (0–100), sampled as an os.cpus() delta over ~500ms. */
  cpuPercent: number;
  memory: {
    totalBytes: number;
    usedBytes: number;
  };
  /** Battery state, or null on machines without a battery (and on non-macOS). */
  battery: {
    /** Charge percent (0–100). */
    percent: number;
    /** True when the AC adapter is attached or the battery is actively charging. */
    charging: boolean;
    /** Estimated minutes left per pmset; null when pmset gives no estimate. */
    timeRemaining: number | null;
  } | null;
}

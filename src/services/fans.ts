import { execFile } from 'child_process';
import net from 'net';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import { readJsonFile, writeJsonFile } from './storage';

/**
 * Fans — SMC fan monitoring + boost control via the native helper.
 *
 * Three capability tiers, degrading gracefully:
 *  1. READ (always, unprivileged): spawn the bundled `maccleaner-fanhelperd
 *     status` binary — fan RPMs + temperature domains with no daemon and no
 *     root. Cached ~2s to tolerate UI polling.
 *  2. BOOST (daemon installed): persistent unix-socket session to the root
 *     LaunchDaemon — `{"op":"boost",fan,rpm}` + `{"op":"heartbeat"}` every 3s.
 *     The daemon enforces boost-only clamping to [F(i)Mn, F(i)Mx] and owns a
 *     10-second watchdog that restores auto if our heartbeats stop, so a boost
 *     can never outlive an app crash.
 *  3. RULES (auto-boost engine): user-defined temperature rules persisted in
 *     the app-data dir; while enabled + daemon installed, poll temps and boost
 *     when a rule's domain exceeds its threshold, releasing with 5°C
 *     hysteresis. The engine only ever escalates — it never lowers a HIGHER
 *     boost the user set manually.
 *
 * The UI speaks percent (0–100); this module maps percent → RPM as
 *   rpm = minRpm + (maxRpm − minRpm) × percent/100
 * per fan, using the live min/max read from the hardware.
 *
 * Test overrides (dev only, see native/fanhelper/README.md):
 *   MACCLEANER_FANHELPER_BIN     path to the helper binary
 *   MACCLEANER_FANHELPER_DIR     dir holding binary+scripts+plist (install kit)
 *   MACCLEANER_FANHELPER_SOCKET  daemon socket path (pairs with the daemon's
 *                                own FANHELPER_SOCKET env var)
 */

/* ────────────────────────────── Types ────────────────────────────── */
// Defined locally (not in models/types.ts) — that file is owned by another
// concurrent workstream.

export type FanMode = 'auto' | 'manual' | 'thermal';

export interface FanInfo {
  id: number;
  label: string;
  actualRpm: number;
  minRpm: number;
  maxRpm: number;
  targetRpm: number;
  mode: FanMode;
}

export interface FanTemps {
  cpuPerf?: number;
  cpuEff?: number;
  gpu?: number;
  battery?: number;
  ssd?: number;
  ambient?: number;
  hottest?: { key: string; value: number };
}

export interface FanStatus {
  ok: boolean;
  fans: FanInfo[];
  temps: FanTemps;
}

export type HelperState = 'not-installed' | 'installed' | 'active-boost';

export type FanRuleDomain = 'cpuPerf' | 'cpuEff' | 'gpu' | 'ssd' | 'battery' | 'hottest';

export interface FanRule {
  domain: FanRuleDomain;
  /** Trigger when the domain average reaches this °C. Released at −5°C. */
  threshold: number;
  /** Boost target as percent of each fan's [min,max] span. */
  targetPercent: number;
}

export interface FanRulesConfig {
  enabled: boolean;
  rules: FanRule[];
  /** Engine poll cadence in seconds (5–120). */
  pollSeconds: number;
}

export type HelperActionStatus =
  | 'installed'
  | 'uninstalled'
  | 'user-cancelled'
  | 'failed'
  | 'dry-run';

export interface HelperActionResult {
  status: HelperActionStatus;
  message?: string;
  /** dry-run only: the exact shell command osascript would run as root. */
  command?: string;
}

export interface BoostRequest {
  fan: number | 'all';
  percent: number;
}

export interface BoostResult {
  ok: boolean;
  applied: Array<{ fan: number; rpm: number; ok: boolean; error?: string }>;
}

/* ─────────────────────────── Constants ─────────────────────────── */

const HELPER_LABEL = 'com.dronx.maccleaner.fanhelper';
const SOCKET_PATH =
  process.env.MACCLEANER_FANHELPER_SOCKET || `/var/run/${HELPER_LABEL}.sock`;
const RULES_FILE = 'fans.json';
const HEARTBEAT_MS = 3_000;
const RECONNECT_MS = 2_000;
const STATUS_CACHE_MS = 2_000;
const HYSTERESIS_C = 5;
/** After an explicit user "auto", the rules engine holds off this long. */
const ENGINE_SUPPRESS_MS = 60_000;

const RULE_DOMAINS: FanRuleDomain[] = ['cpuPerf', 'cpuEff', 'gpu', 'ssd', 'battery', 'hottest'];

const DEFAULT_RULES: FanRulesConfig = { enabled: false, rules: [], pollSeconds: 15 };

/* ──────────────────────── Helper binary discovery ──────────────────────── */

interface ExecResult {
  stdout: string;
  stderr: string;
}

function execFileP(cmd: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
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

/**
 * Directory holding the helper install kit (binary, install.sh, uninstall.sh,
 * plist). Packaged: Contents/Resources/fanhelper (via build.extraResources).
 * Dev: native/fanhelper in the repo (binary under build/).
 */
function helperKitDir(): { dir: string; binary: string } | null {
  if (process.env.MACCLEANER_FANHELPER_DIR) {
    const dir = process.env.MACCLEANER_FANHELPER_DIR;
    return { dir, binary: process.env.MACCLEANER_FANHELPER_BIN || path.join(dir, 'maccleaner-fanhelperd') };
  }
  // Packaged Electron app: extraResources land in process.resourcesPath.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const dir = path.join(resourcesPath, 'fanhelper');
    if (fs.existsSync(path.join(dir, 'maccleaner-fanhelperd'))) {
      return { dir, binary: path.join(dir, 'maccleaner-fanhelperd') };
    }
  }
  // Dev checkout: dist/services/fans.js → ../../native/fanhelper
  const devDir = path.join(__dirname, '..', '..', 'native', 'fanhelper');
  const devBin =
    process.env.MACCLEANER_FANHELPER_BIN || path.join(devDir, 'build', 'maccleaner-fanhelperd');
  if (fs.existsSync(devBin)) return { dir: devDir, binary: devBin };
  return null;
}

/** Path of the helper binary used for unprivileged `status` reads. */
export function helperBinaryPath(): string | null {
  return helperKitDir()?.binary ?? null;
}

/* ───────────────────────── readStatus (tier 1) ───────────────────────── */

let statusCache: { at: number; value: Promise<FanStatus> } | null = null;

/** Unprivileged fan+temp snapshot via the bundled binary. Cached ~2s. */
export function readStatus(): Promise<FanStatus> {
  if (process.platform !== 'darwin') {
    return Promise.reject(new Error('Fan control is only available on macOS'));
  }
  const now = Date.now();
  if (statusCache && now - statusCache.at < STATUS_CACHE_MS) return statusCache.value;

  const bin = helperBinaryPath();
  if (!bin) return Promise.reject(new Error('fan helper binary not found'));

  const value = execFileP(bin, ['status'], 8_000).then(({ stdout }) => {
    const parsed = JSON.parse(stdout) as FanStatus;
    if (!parsed || !Array.isArray(parsed.fans)) throw new Error('malformed helper status output');
    return parsed;
  });
  // Cache the in-flight promise so a poll burst spawns one process; drop a
  // failed read from the cache so the next call retries immediately.
  statusCache = { at: now, value };
  value.catch(() => {
    if (statusCache?.value === value) statusCache = null;
  });
  return value;
}

/* ───────────────────── Daemon session (tier 2) ───────────────────── */

interface DaemonReply {
  ok: boolean;
  error?: string;
  fans?: FanInfo[];
  temps?: FanTemps;
  appliedRpm?: number;
  mode?: string;
}

interface PendingReq {
  resolve: (r: DaemonReply) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One persistent control connection to the daemon. Requests are
 * newline-delimited JSON answered in order, so a FIFO of resolvers pairs
 * replies with requests.
 */
class DaemonSession {
  private socket: net.Socket | null = null;
  private buffer = '';
  private pending: PendingReq[] = [];
  private connecting: Promise<void> | null = null;

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      // Created ref'd (default) so the in-flight connect holds the event loop;
      // unref'd once established and idle (see onData) so an idle session
      // never keeps the process alive on its own.
      const sock = net.createConnection(SOCKET_PATH);
      sock.setEncoding('utf8');

      const onConnectError = (err: Error) => {
        this.connecting = null;
        reject(err);
      };
      sock.once('error', onConnectError);
      sock.once('connect', () => {
        sock.removeListener('error', onConnectError);
        this.socket = sock;
        this.connecting = null;

        sock.on('data', (chunk: string) => this.onData(chunk));
        const onGone = () => this.teardown(new Error('daemon connection lost'));
        sock.once('error', onGone);
        sock.once('close', onGone);
        if (this.pending.length === 0) sock.unref();
        resolve();
      });
    });
    return this.connecting;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      const req = this.pending.shift();
      if (!req) continue; // unsolicited line — ignore
      clearTimeout(req.timer);
      try {
        req.resolve(JSON.parse(line) as DaemonReply);
      } catch {
        req.reject(new Error('malformed daemon reply'));
      }
    }
    // Idle again: stop holding the event loop open.
    if (this.pending.length === 0 && this.socket) this.socket.unref();
  }

  private teardown(err: Error): void {
    const sock = this.socket;
    this.socket = null;
    this.buffer = '';
    if (sock && !sock.destroyed) sock.destroy();
    for (const req of this.pending.splice(0)) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    onSessionLost();
  }

  async send(op: Record<string, unknown>, timeoutMs = 5_000): Promise<DaemonReply> {
    await this.connect();
    const sock = this.socket;
    if (!sock) throw new Error('daemon not connected');
    return new Promise<DaemonReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A missed reply desynchronizes the FIFO — drop the connection so the
        // reconnect path re-establishes clean state.
        this.teardown(new Error('daemon request timed out'));
      }, timeoutMs);
      timer.unref();
      this.pending.push({ resolve, reject, timer });
      // Hold the event loop open while a reply is outstanding — the socket is
      // otherwise unref'd so an idle session never keeps the process alive.
      sock.ref();
      sock.write(JSON.stringify(op) + '\n');
    });
  }

  close(): void {
    const sock = this.socket;
    this.socket = null;
    for (const req of this.pending.splice(0)) {
      clearTimeout(req.timer);
      req.reject(new Error('session closed'));
    }
    if (sock && !sock.destroyed) {
      sock.removeAllListeners('close');
      sock.removeAllListeners('error');
      sock.on('error', () => {});
      sock.end();
      sock.destroy();
    }
  }
}

const session = new DaemonSession();

/* ─────────────────── Desired-boost state + application ─────────────────── */

/** User-requested boost (percent applies per the `fan` selector). */
let userBoost: BoostRequest | null = null;
/** Rules-engine boost percent (applies to all fans), or null when released. */
let engineBoostPercent: number | null = null;
/** Fans we most recently commanded, to detect shrinking sets. */
let lastCommandedFans = new Set<number>();
let heartbeatTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let engineSuppressedUntil = 0;

function percentToRpm(fan: FanInfo, percent: number): number {
  const p = Math.min(100, Math.max(0, percent));
  const span = Math.max(0, fan.maxRpm - fan.minRpm);
  return Math.round(fan.minRpm + (span * p) / 100);
}

/** Effective per-fan percent: max of user and engine demands (boost-only). */
function desiredPercents(fans: FanInfo[]): Map<number, number> {
  const desired = new Map<number, number>();
  for (const f of fans) {
    let p = -1;
    if (userBoost && (userBoost.fan === 'all' || userBoost.fan === f.id)) {
      p = Math.max(p, userBoost.percent);
    }
    if (engineBoostPercent !== null) p = Math.max(p, engineBoostPercent);
    if (p >= 0) desired.set(f.id, p);
  }
  return desired;
}

function anyBoostDesired(): boolean {
  return userBoost !== null || engineBoostPercent !== null;
}

/**
 * Push the current desired state to the daemon: boost every desired fan, or
 * restore auto when nothing is desired. Also (re)arms the heartbeat.
 */
async function applyDesired(): Promise<BoostResult> {
  const status = await readStatus();
  const desired = desiredPercents(status.fans);

  if (desired.size === 0) {
    stopHeartbeat();
    lastCommandedFans = new Set();
    if (session.connected) {
      try {
        await session.send({ op: 'auto' });
      } catch {
        /* daemon gone — its own failsafe restores auto */
      }
      session.close();
    }
    return { ok: true, applied: [] };
  }

  // If the desired set shrank (e.g. per-fan boost replaced an all-fan one),
  // reset to auto first so no fan is left pinned by a stale target.
  const shrank = [...lastCommandedFans].some((id) => !desired.has(id));
  if (shrank && session.connected) {
    try {
      await session.send({ op: 'auto' });
    } catch {
      /* handled below by the per-fan sends */
    }
  }

  const applied: BoostResult['applied'] = [];
  let allOk = true;
  for (const fan of status.fans) {
    const percent = desired.get(fan.id);
    if (percent === undefined) continue;
    const rpm = percentToRpm(fan, percent);
    try {
      const reply = await session.send({ op: 'boost', fan: fan.id, rpm });
      applied.push({ fan: fan.id, rpm, ok: reply.ok, error: reply.error });
      if (!reply.ok) allOk = false;
    } catch (err) {
      applied.push({ fan: fan.id, rpm, ok: false, error: err instanceof Error ? err.message : String(err) });
      allOk = false;
    }
  }
  lastCommandedFans = new Set(applied.filter((a) => a.ok).map((a) => a.fan));
  if (applied.some((a) => a.ok)) startHeartbeat();
  return { ok: allOk, applied };
}

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    void session
      .send({ op: 'heartbeat' }, 4_000)
      .catch(() => {
        /* onSessionLost handles reconnect */
      });
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();
}

function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/** Socket dropped: if a boost should be active, reconnect and re-assert. */
function onSessionLost(): void {
  stopHeartbeat();
  if (!anyBoostDesired() || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!anyBoostDesired()) return;
    applyDesired().catch(() => onSessionLost()); // keep retrying while desired
  }, RECONNECT_MS);
  reconnectTimer.unref();
}

/* ───────────────────────── Public boost API ───────────────────────── */

/** Start (or retarget) a user boost. Percent 0–100 maps into [min,max]. */
export async function startBoost(req: BoostRequest): Promise<BoostResult> {
  if (typeof req.percent !== 'number' || !Number.isFinite(req.percent)) {
    throw new Error('percent must be a number');
  }
  userBoost = { fan: req.fan, percent: Math.min(100, Math.max(0, req.percent)) };
  return applyDesired();
}

/**
 * User-requested restore of automatic control. Clears the user boost AND the
 * engine's current demand (with a short suppression window so the engine
 * doesn't immediately re-trigger against the user's explicit intent).
 */
export async function stopBoost(): Promise<void> {
  userBoost = null;
  engineBoostPercent = null;
  engineLatched.clear();
  engineSuppressedUntil = Date.now() + ENGINE_SUPPRESS_MS;
  await applyDesired();
}

/* ─────────────────────── Helper state detection ─────────────────────── */

let probeCache: { at: number; value: Promise<boolean> } | null = null;

/** Can we reach a live daemon on the socket right now? Cached ~2s. */
function probeDaemon(): Promise<boolean> {
  const now = Date.now();
  if (probeCache && now - probeCache.at < STATUS_CACHE_MS) return probeCache.value;
  const value = new Promise<boolean>((resolve) => {
    const sock = net.createConnection(SOCKET_PATH);
    sock.setEncoding('utf8');
    const done = (result: boolean) => {
      sock.removeAllListeners();
      sock.on('error', () => {});
      sock.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done(false), 1_000);
    timer.unref();
    sock.once('error', () => {
      clearTimeout(timer);
      done(false);
    });
    sock.once('connect', () => {
      sock.write('{"op":"status"}\n');
      sock.once('data', (chunk: string) => {
        clearTimeout(timer);
        try {
          done((JSON.parse(chunk.split('\n')[0]) as DaemonReply).ok === true);
        } catch {
          done(false);
        }
      });
    });
  });
  probeCache = { at: now, value };
  return value;
}

export async function helperState(): Promise<HelperState> {
  if (anyBoostDesired() && session.connected) return 'active-boost';
  const installed = await probeDaemon();
  if (!installed) return 'not-installed';
  // A fan in true manual mode means a boost is active (possibly asserted by
  // the daemon on our behalf before a restart of this server).
  try {
    const status = await readStatus();
    if (status.fans.some((f) => f.mode === 'manual')) return 'active-boost';
  } catch {
    /* status read failure shouldn't mask "installed" */
  }
  return 'installed';
}

/* ───────────────────────── Rules persistence ───────────────────────── */

function sanitizeRules(raw: unknown): FanRulesConfig {
  const cfg = (raw ?? {}) as Partial<FanRulesConfig>;
  const rules: FanRule[] = Array.isArray(cfg.rules)
    ? cfg.rules
        .filter(
          (r): r is FanRule =>
            !!r &&
            RULE_DOMAINS.includes((r as FanRule).domain) &&
            typeof (r as FanRule).threshold === 'number' &&
            typeof (r as FanRule).targetPercent === 'number'
        )
        .slice(0, 16)
        .map((r) => ({
          domain: r.domain,
          threshold: Math.min(110, Math.max(30, r.threshold)),
          targetPercent: Math.min(100, Math.max(0, r.targetPercent)),
        }))
    : [];
  const pollSeconds =
    typeof cfg.pollSeconds === 'number' && Number.isFinite(cfg.pollSeconds)
      ? Math.min(120, Math.max(5, Math.round(cfg.pollSeconds)))
      : DEFAULT_RULES.pollSeconds;
  return { enabled: cfg.enabled === true, rules, pollSeconds };
}

export async function getRules(): Promise<FanRulesConfig> {
  return sanitizeRules(await readJsonFile<unknown>(RULES_FILE, DEFAULT_RULES));
}

export async function saveRules(raw: unknown): Promise<FanRulesConfig> {
  const cfg = sanitizeRules(raw);
  await writeJsonFile(RULES_FILE, cfg);
  restartEngine(cfg);
  return cfg;
}

/* ─────────────────────── Auto-boost rules engine ─────────────────────── */

let engineTimer: NodeJS.Timeout | null = null;
/** Rule indexes currently latched (triggered and not yet released). */
const engineLatched = new Set<number>();

function domainTemp(temps: FanTemps, domain: FanRuleDomain): number | undefined {
  if (domain === 'hottest') return temps.hottest?.value;
  return temps[domain];
}

async function engineTick(cfg: FanRulesConfig): Promise<void> {
  if (!cfg.enabled || cfg.rules.length === 0) return;
  if (!(await probeDaemon())) return; // daemon not installed — engine is inert

  const status = await readStatus();
  const suppressed = Date.now() < engineSuppressedUntil;

  let demand: number | null = null;
  cfg.rules.forEach((rule, idx) => {
    const temp = domainTemp(status.temps, rule.domain);
    if (temp === undefined) {
      engineLatched.delete(idx);
      return;
    }
    if (engineLatched.has(idx)) {
      // Already boosting for this rule: release below threshold − hysteresis.
      if (temp <= rule.threshold - HYSTERESIS_C) engineLatched.delete(idx);
    } else if (!suppressed && temp >= rule.threshold) {
      engineLatched.add(idx);
    }
    if (engineLatched.has(idx)) {
      demand = demand === null ? rule.targetPercent : Math.max(demand, rule.targetPercent);
    }
  });

  if (demand !== engineBoostPercent) {
    engineBoostPercent = demand;
    await applyDesired();
  }
}

function restartEngine(cfg: FanRulesConfig): void {
  if (engineTimer) clearInterval(engineTimer);
  engineTimer = null;
  if (process.platform !== 'darwin') return;
  if (!cfg.enabled || cfg.rules.length === 0) {
    // Rules turned off: drop any engine demand (user boost is untouched).
    engineLatched.clear();
    if (engineBoostPercent !== null) {
      engineBoostPercent = null;
      applyDesired().catch(() => {});
    }
    return;
  }
  engineTimer = setInterval(() => {
    engineTick(cfg).catch((err) => {
      console.error('[maccleaner] fan rules engine tick failed:', err instanceof Error ? err.message : err);
    });
  }, cfg.pollSeconds * 1_000);
  engineTimer.unref();
}

/** Load persisted rules and start the engine. Called once at module load. */
async function initEngine(): Promise<void> {
  if (process.platform !== 'darwin') return;
  restartEngine(await getRules());
}
void initEngine();

/* ─────────────────── Install / uninstall (osascript) ─────────────────── */

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function appleScriptQuote(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const USER_CANCELLED_RE = /user cancell?ed|-128/i;

/**
 * Stage the install kit into a fresh dir under /tmp and return its paths.
 * CRITICAL: osascript-elevated shells get "Operation not permitted" running
 * scripts from TCC-protected paths (Desktop/Documents/app translocation), so
 * everything is copied to /tmp first.
 */
async function stageKit(files: string[]): Promise<{ stagedDir: string; staged: Map<string, string> }> {
  const kit = helperKitDir();
  if (!kit) throw new Error('fan helper kit not found (build native/fanhelper first)');
  const stagedDir = await fsp.mkdtemp('/tmp/maccleaner-fanhelper-');
  const staged = new Map<string, string>();
  for (const name of files) {
    const src =
      name === 'maccleaner-fanhelperd'
        ? kit.binary
        : path.join(kit.dir, name);
    const dst = path.join(stagedDir, name);
    await fsp.copyFile(src, dst);
    await fsp.chmod(dst, name.endsWith('.plist') ? 0o644 : 0o755);
    staged.set(name, dst);
  }
  return { stagedDir, staged };
}

async function runAsAdmin(command: string): Promise<{ cancelled: boolean; error?: string }> {
  const script = `do shell script "${appleScriptQuote(command)}" with administrator privileges`;
  try {
    await execFileP('/usr/bin/osascript', ['-e', script], 180_000);
    return { cancelled: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & ExecResult;
    const detail = `${e.stderr || ''} ${e.message || ''}`;
    if (USER_CANCELLED_RE.test(detail)) return { cancelled: true };
    return { cancelled: false, error: (e.stderr || e.message || 'osascript failed').trim() };
  }
}

/**
 * Install the LaunchDaemon via ONE admin prompt. `dryRun` performs the staging
 * and returns the exact command without prompting (used by tests/UI preview).
 */
export async function installHelper(opts: { dryRun?: boolean } = {}): Promise<HelperActionResult> {
  if (process.platform !== 'darwin') return { status: 'failed', message: 'macOS only' };
  let stagedDir: string | null = null;
  try {
    const kitFiles = ['maccleaner-fanhelperd', 'install.sh', 'uninstall.sh', `${HELPER_LABEL}.plist`];
    const { stagedDir: dir, staged } = await stageKit(kitFiles);
    stagedDir = dir;
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const command = `${shellQuote(staged.get('install.sh')!)} ${shellQuote(staged.get('maccleaner-fanhelperd')!)} ${uid}`;

    // dry-run: staging + command construction were exercised; report the exact
    // command without prompting. (Staging is recreated on a real install, and
    // the finally block below removes this staging dir either way.)
    if (opts.dryRun) return { status: 'dry-run', command };

    const result = await runAsAdmin(command);
    if (result.cancelled) return { status: 'user-cancelled', message: 'Admin prompt was cancelled' };
    if (result.error) return { status: 'failed', message: result.error };

    probeCache = null; // force a fresh state probe
    const live = await probeDaemon();
    return live
      ? { status: 'installed' }
      : { status: 'failed', message: 'installer ran but the daemon socket is not answering' };
  } catch (err) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  } finally {
    if (stagedDir) fsp.rm(stagedDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Uninstall via ONE admin prompt: restores auto, boots out, removes files. */
export async function uninstallHelper(opts: { dryRun?: boolean } = {}): Promise<HelperActionResult> {
  if (process.platform !== 'darwin') return { status: 'failed', message: 'macOS only' };
  let stagedDir: string | null = null;
  try {
    // Local session state is void once the daemon goes away.
    userBoost = null;
    engineBoostPercent = null;
    engineLatched.clear();
    stopHeartbeat();
    session.close();

    const { stagedDir: dir, staged } = await stageKit(['uninstall.sh']);
    stagedDir = dir;
    const command = shellQuote(staged.get('uninstall.sh')!);

    if (opts.dryRun) return { status: 'dry-run', command };

    const result = await runAsAdmin(command);
    if (result.cancelled) return { status: 'user-cancelled', message: 'Admin prompt was cancelled' };
    if (result.error) return { status: 'failed', message: result.error };

    probeCache = null;
    return { status: 'uninstalled' };
  } catch (err) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  } finally {
    if (stagedDir) fsp.rm(stagedDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ───────────────────────────── Shutdown ───────────────────────────── */

/**
 * Best-effort synchronous-ish teardown for app quit (Electron before-quit does
 * not await): fire an `auto` at the daemon and close everything. The daemon's
 * 10s watchdog is the backstop if this write never lands.
 */
export function shutdownFans(): void {
  if (engineTimer) clearInterval(engineTimer);
  engineTimer = null;
  stopHeartbeat();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const hadBoost = anyBoostDesired();
  userBoost = null;
  engineBoostPercent = null;
  engineLatched.clear();
  if (hadBoost && session.connected) {
    // Fire-and-forget; do not wait for the reply.
    session.send({ op: 'auto' }, 1_000).catch(() => {});
    setTimeout(() => session.close(), 250).unref();
  } else {
    session.close();
  }
}

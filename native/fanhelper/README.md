# maccleaner-fanhelperd

A tiny native SMC fan-control helper for MacCleaner. It reads fan speeds and
temperatures with no privileges, and — when installed as a root LaunchDaemon —
lets the (non-root) app **boost** the fans above the firmware auto minimum, with
a hardware-side failsafe that always restores automatic control.

Target: Apple Silicon (developed and tested on **MacBook Pro 18,2 / M1 Max /
macOS 26**). Reads work on any Mac with an `AppleSMC` device; writes require the
root daemon.

---

## Binary & subcommands

One binary, `maccleaner-fanhelperd`, with four subcommands:

| Subcommand | Root? | Purpose |
|------------|-------|---------|
| `status`   | no    | Print a JSON snapshot of fans + temperatures to stdout. |
| `daemon`   | yes   | LaunchDaemon mode: unix-socket JSON server + failsafe watchdog. |
| `auto`     | yes   | Restore automatic fan control immediately. |
| `selftest` | yes   | Supervised boost self-test (boost fan 0, confirm RPM rises, restore auto). |

### `status` output

```json
{
  "ok": true,
  "fans": [
    {"id":0,"label":"Fan 1","actualRpm":1521,"minRpm":1499,"maxRpm":5348,"targetRpm":1522,"mode":"auto"},
    {"id":1,"label":"Fan 2","actualRpm":1633,"minRpm":1499,"maxRpm":5776,"targetRpm":1643,"mode":"auto"}
  ],
  "temps": {
    "cpuPerf": 73.4, "cpuEff": 69.8, "gpu": 56.6,
    "battery": 35.3, "ssd": 38.3, "ambient": 32.9,
    "hottest": {"key":"Tp0E","value":79.9}
  }
}
```

`mode` is one of `auto`, `manual`, `thermal`. Temperatures are per-domain
averages of the M1 Max `T*` `flt` sensor clusters; domains whose keys are absent
on a given machine are omitted.

---

## Daemon protocol

The daemon listens on a unix domain socket:

```
/var/run/com.dronx.maccleaner.fanhelper.sock
```

Messages are **newline-delimited JSON** (one request per line, one reply per
line).

### Requests

| Request | Effect |
|---------|--------|
| `{"op":"status"}` | Returns `{ok,fans,temps}` (same shape as the CLI). |
| `{"op":"boost","fan":0,"rpm":4000}` | Forces fan `0` to manual and targets `rpm` (clamped to `[F0Mn, F0Mx]`). Resets the watchdog. Reply includes `appliedRpm`. |
| `{"op":"heartbeat"}` | Resets the failsafe watchdog; re-asserts a diverged manual target. |
| `{"op":"auto"}` | Restores automatic control for all fans and clears active boosts. |

### Replies

All replies are objects with `"ok": true|false`. On error:
`{"ok":false,"error":"..."}`. `status`/`boost` replies also carry `fans` and
`temps`.

### Client lifecycle (for `src/services/fans.ts`)

1. Connect to the socket. The daemon verifies your uid with `getpeereid()` and
   accepts only **root** or the uid recorded at install time.
2. Send `{"op":"boost",...}` to start a boost.
3. While boosting, send `{"op":"heartbeat"}` at least every few seconds
   (watchdog window is **10 s**).
4. Send `{"op":"auto"}` (or just disconnect) to stop.

---

## Safety model

Boost is **additive-only** — it can only raise the fan floor, never cap it below
the firmware's automatic target.

- **Range clamp.** Every requested RPM is clamped to `[F(i)Mn, F(i)Mx]`. A value
  below the auto minimum is **rejected** outright (boost-only).
- **10-second failsafe watchdog.** The daemon owns a timer. Any `boost` or
  `heartbeat` resets it. On expiry it restores auto by itself — so a boost can
  never outlive an app crash, hang, or quit.
- **Restore auto on every exit path.** Socket disconnect, `SIGTERM`/`SIGINT`/
  `SIGHUP`, and `atexit` all restore automatic control.
- **Re-assert after wake.** On `NSWorkspace.didWakeNotification` (and on each
  heartbeat) the daemon checks whether a boosted fan's mode diverged back to
  auto/thermal; if so it re-applies the recorded target.
- **Peer verification.** The socket is `root:<user>` mode `0660`; the real gate
  is `getpeereid()`, which admits only root or the installed uid.

Restore sequence is `F(i)Md = 0` for every fan plus `FS! = 0` (clear the legacy
forced bitmask). Boost sequence is `F(i)Md = 1` then `F(i)Tg = <rpm>`; on an
initial write rejection the daemon defensively writes `Ftst = 1` (harmless on
M1, needed on some M3+ firmware) and retries once.

---

## SMC protocol notes

- IOKit user client: `IOServiceMatching("AppleSMC")` → `IOServiceOpen` →
  `IOConnectCallStructMethod(conn, 2, …)`. Selector **2** is
  `kSMCHandleYPCEvent`; the operation lives in the struct's `data8` field:
  **5** = read bytes, **6** = write bytes, **8** = key-from-index, **9** =
  key-info.
- The command struct (`SMCParamStruct` / `SMCKeyData_t`) is **80 bytes**.
- 4-char keys are packed big-endian into a `UInt32`.
- **Apple Silicon values are little-endian IEEE-754 `flt` (4 bytes)**, not
  Intel's `fpe2`. The helper probes each key's `dataType` at runtime and decodes
  `flt` / `fpe2` / `sp78` / `ui8` / `ui16` / `ui32` accordingly, and encodes fan
  targets back into `flt` (with an `fpe2` fallback).

---

## Development testing (no root)

Two hooks exist purely for unprivileged development testing of the socket
protocol; neither affects an installed daemon (the LaunchDaemon plist sets no
environment, and the production daemon runs as root):

- **`FANHELPER_SOCKET=<path>`** — the daemon binds this socket instead of
  `/var/run/...`. Pair it with the backend's `MACCLEANER_FANHELPER_SOCKET`
  (see `src/services/fans.ts`).
- **Test-mode peer rule** — when the daemon itself runs as a non-root user, it
  additionally accepts socket peers with its own uid (so `getpeereid()` checks
  still pass without the installed `allowed-uid` file).

Note: an unprivileged daemon can serve `status`, but every `boost` fails with
`kIOReturnNotPrivileged` — SMC writes are firmware-gated to root. That failure
reply is itself useful for protocol tests.

---

## Build

```sh
./build.sh
```

Produces `build/maccleaner-fanhelperd`. The script builds an arm64 slice and an
x86_64 slice and `lipo`s them into a **universal** binary (it falls back to
arm64-only and says so if the x86_64 slice can't be built). It also ad-hoc code
signs the result for local LaunchDaemon use.

Requires a full Xcode toolchain (`swiftc`). Frameworks: `IOKit`, `AppKit`
(NSWorkspace wake notification), `Foundation`.

## Install / uninstall

Both scripts are meant to be run **as root by a single osascript admin prompt**
from the app.

```sh
# install: copy binary + plist, chown root:wheel, record allowed uid, bootstrap
sudo ./install.sh /path/to/build/maccleaner-fanhelperd <uid>

# uninstall: restore auto, bootout, remove all files
sudo ./uninstall.sh
```

`install.sh` writes the authorized client uid to
`/Library/Application Support/com.dronx.maccleaner.fanhelper/allowed-uid` and
loads `/Library/LaunchDaemons/com.dronx.maccleaner.fanhelper.plist`
(`RunAtLoad`, `KeepAlive`). `uninstall.sh` restores automatic fan control first,
then boots out the daemon and removes everything.

---

## Credits & license

This helper is an **original Swift implementation**. Its SMC protocol handling
and fan-control semantics are adapted, with thanks, from these **MIT-licensed**
projects:

- [**exelban/stats**](https://github.com/exelban/stats) (MIT) — `SMC/smc.swift`,
  `SMC/Helper/main.swift`: the IOKit call structure, operation codes, and
  value decoding.
- [**beltex/SMCKit**](https://github.com/beltex/SMCKit) (MIT) — the exact
  80-byte `SMCParamStruct` field layout.
- [**raminsharifi/MacFanControl**](https://github.com/raminsharifi/MacFanControl)
  (MIT) — Apple-Silicon `flt` encoding, the defensive `Ftst` unlock, and the
  auto-restore guard concept.

No code was copied from any GPL project (e.g. smcFanControl, iSMC); those were
consulted only as documentation.

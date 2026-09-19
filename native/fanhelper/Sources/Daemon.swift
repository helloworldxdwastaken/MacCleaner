// Daemon.swift — LaunchDaemon mode: unix-socket JSON server + failsafe watchdog
//
// ATTRIBUTION: the daemon-owned auto-restore watchdog concept (survives app
// crash/quit) is inspired by raminsharifi/MacFanControl and the discussion in
// exelban/stats #2094. Original implementation. No GPL code used.
//
// Protocol: newline-delimited JSON over a unix domain socket at
//   /var/run/com.dronx.maccleaner.fanhelper.sock
// Requests:  {"op":"status"} | {"op":"boost","fan":0,"rpm":4000}
//            {"op":"auto"}   | {"op":"heartbeat"}
// Replies:   {"ok":true,...} | {"ok":false,"error":"..."}
// `status` and `heartbeat` replies carry "active":[{"fan":N,"rpm":R},...] —
// the daemon-side set of fans currently pinned by a boost. Clients compare it
// against their own desired state: after watchdog expiry (suspend, hiccup)
// the daemon has silently restored auto, and a client that keeps believing it
// holds a boost would be phantom-boosting. `boost` replies add "appliedRpm".
//
// Security:
//   * Socket mode 0660 (owner rw, group root). Peer verified with
//     getpeereid(): only root (uid 0) or the uid recorded at install time in
//     /Library/Application Support/com.dronx.maccleaner.fanhelper/allowed-uid
//     is accepted.
//   * Boost is boost-only and clamped to [F(i)Mn, F(i)Mx].
//   * 10-second failsafe watchdog: any boost/heartbeat resets it; on expiry,
//     socket disconnect, SIGTERM/SIGINT, or daemon exit -> restore auto.
//   * Startup restores auto BEFORE serving clients, so a pin left behind by a
//     SIGKILLed predecessor cannot outlive it.
//   * After wake (or on each heartbeat) a diverged boost is re-pinned when the
//     firmware merely reverted to auto — but a firmware thermal-manager
//     takeover (mode 3) is always YIELDED to, never overridden.
//   * Per-connection request buffers are capped at 64 KB; oversized peers are
//     dropped (this is a root daemon — no unbounded buffering).

import Foundation
import Darwin
import AppKit

// Global reference used by the C atexit() handler to restore auto on exit.
// atexit accepts only a bare C function pointer (no captured context), so the
// live FanController is reached through this file-scope variable.
private var gExitFans: FanController?

// FANHELPER_SOCKET overrides the socket path — intended ONLY for unprivileged
// development testing (e.g. a /tmp socket under the developer's own uid). The
// production LaunchDaemon plist sets no environment variables, so installed
// daemons always use the /var/run path.
let kSocketPath = ProcessInfo.processInfo.environment["FANHELPER_SOCKET"]
    ?? "/var/run/com.dronx.maccleaner.fanhelper.sock"
let kAllowedUIDPath =
    "/Library/Application Support/com.dronx.maccleaner.fanhelper/allowed-uid"
let kWatchdogSeconds: TimeInterval = 10.0

final class Daemon {
    private let smc: SMC
    private let fans: FanController
    private var listenFd: Int32 = -1

    private let stateQueue = DispatchQueue(label: "fanhelper.state")
    // Concurrent queue for per-connection I/O; fan mutations still funnel
    // through the serial stateQueue, so this only parallelizes socket reads.
    private let clientQueue = DispatchQueue(
        label: "fanhelper.clients", attributes: .concurrent)
    // Active boost state, guarded by stateQueue.
    private var activeBoost: [Int: Double] = [:]   // fan -> target rpm
    private var boostOwner: UInt64?                 // connId that started the boost
    private var lastPetAt: Date = .distantPast
    private var watchdogTimer: DispatchSourceTimer?
    private var wakeObserver: NSObjectProtocol?

    init(_ smc: SMC) {
        self.smc = smc
        self.fans = FanController(smc)
    }

    // MARK: - Lifecycle

    func run() -> Never {
        installSignalHandlers()
        // Restore auto BEFORE any client can connect. If this daemon was
        // SIGKILLed mid-boost, its atexit/SIGTERM restores never ran and
        // KeepAlive restarts it within moments — without this, the fresh
        // daemon would inherit (and the heartbeat loop would keep re-asserting)
        // a stale manual pin no client actually demands anymore.
        stateQueue.sync { fans.restoreAllAuto() }
        setupSocket()
        installWakeObserver()
        startWatchdog()
        // Accept connections on a background queue: the main thread must keep
        // draining its run loop for NSWorkspace.didWakeNotification to ever be
        // delivered (AppKit posts it on the main thread; a main thread parked
        // in accept() means the wake observer never fires).
        let acceptQueue = DispatchQueue(label: "fanhelper.accept")
        acceptQueue.async { [weak self] in self?.acceptLoop() }
        // Main run loop — never returns. AppKit posts wake notifications to
        // the main run loop, and running it also drains the main dispatch
        // queue; without it the wake observer installed above never fires.
        // (RunLoop.run() is typed Void even though it never returns here, so
        // the Never-check needs an explicit unreachable marker.)
        RunLoop.main.run()
        fatalError("unreachable: main run loop returned")
    }

    private func log(_ msg: String) {
        FileHandle.standardError.write(
            Data("[fanhelperd] \(msg)\n".utf8))
    }

    // MARK: - allowed uid

    private func allowedUID() -> uid_t? {
        guard let s = try? String(contentsOfFile: kAllowedUIDPath, encoding: .utf8)
        else { return nil }
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let n = UInt32(trimmed) else { return nil }
        return uid_t(n)
    }

    // MARK: - Socket setup

    private func setupSocket() {
        unlink(kSocketPath)

        listenFd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listenFd >= 0 else {
            log("socket() failed: \(String(cString: strerror(errno)))")
            exit(1)
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(kSocketPath.utf8)
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: 104) { c in
                for (i, b) in pathBytes.enumerated() where i < 103 {
                    c[i] = CChar(bitPattern: b)
                }
                c[min(pathBytes.count, 103)] = 0
            }
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bindRc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(listenFd, $0, len)
            }
        }
        guard bindRc == 0 else {
            log("bind() failed: \(String(cString: strerror(errno)))")
            exit(1)
        }

        // 0660: owner (the allowed client uid) rw, group root. The OWNER bit
        // alone gives the authorized app access, so the group is set to
        // wheel (root) instead of the user's primary group (usually 'staff',
        // which every local account is a member of) — no other local user can
        // reach the socket through group membership. The real authorization
        // gate remains getpeereid() in the accept loop.
        chmod(kSocketPath, 0o660)
        if let uid = allowedUID() {
            chown(kSocketPath, uid, 0) // group wheel — root-only, see above
            // Re-tighten after chown (chown can clear setuid-ish bits; keep 0660).
            chmod(kSocketPath, 0o660)
        }

        guard listen(listenFd, 8) == 0 else {
            log("listen() failed: \(String(cString: strerror(errno)))")
            exit(1)
        }
        log("listening on \(kSocketPath)")
    }

    // MARK: - Accept loop

    private func acceptLoop() -> Never {
        while true {
            let clientFd = accept(listenFd, nil, nil)
            if clientFd < 0 {
                if errno == EINTR { continue }
                // Back off before retrying: a persistently broken listener fd
                // must not spin the CPU (and flood the log) at full speed.
                Thread.sleep(forTimeInterval: 0.05)
                log("accept() failed: \(String(cString: strerror(errno)))")
                continue
            }
            // Verify peer identity before serving.
            var euid: uid_t = 0
            var egid: gid_t = 0
            if getpeereid(clientFd, &euid, &egid) != 0 {
                logReject("getpeereid failed; rejecting")
                close(clientFd)
                continue
            }
            if !isPeerAllowed(euid) {
                logReject("rejected peer uid=\(euid)")
                close(clientFd)
                continue
            }
            // Serve each client on its own queue so a long-lived boost/
            // heartbeat connection never blocks concurrent status polls. Shared
            // fan state remains serialized through stateQueue.
            let fd = clientFd
            clientQueue.async { [weak self] in
                self?.serve(fd)
            }
        }
    }

    // Peer rejections can arrive in bursts (a curious local process polling
    // the socket, a scanner). Rate-limit them so the stderr log can't grow
    // unbounded between newsyslog rotations. Accept-loop only (single thread).
    private var lastRejectLogAt: TimeInterval = 0
    private func logReject(_ msg: String) {
        let now = Date().timeIntervalSince1970
        guard now - lastRejectLogAt >= 1.0 else { return }
        lastRejectLogAt = now
        log(msg)
    }

    private func isPeerAllowed(_ uid: uid_t) -> Bool {
        if uid == 0 { return true }
        if let allowed = allowedUID(), uid == allowed { return true }
        // Test mode: when the daemon itself runs unprivileged (dev testing via
        // FANHELPER_SOCKET), accept peers with the daemon's own uid. Never
        // applies to the production daemon, which runs as root.
        if getuid() != 0 && uid == getuid() { return true }
        return false
    }

    // MARK: - Per-connection serve

    private func serve(_ fd: Int32) {
        defer { close(fd) }
        let connId = nextConnId()
        var buffer = Data()
        var readBuf = [UInt8](repeating: 0, count: 4096)
        // Our ops are tiny (<~200 bytes); a complete request can't get close to
        // this. Exceeding it means one pathological oversized line from the
        // peer — drop the connection rather than let a client grow memory in a
        // root daemon without bound.
        let maxRequestBuffer = 64 * 1024

        while true {
            let n = read(fd, &readBuf, readBuf.count)
            if n == 0 { break }          // client disconnected
            if n < 0 {
                if errno == EINTR { continue }
                break
            }
            buffer.append(contentsOf: readBuf[0..<n])
            if buffer.count > maxRequestBuffer {
                log("connection \(connId): request buffer exceeded \(maxRequestBuffer) bytes; dropping")
                break
            }

            // Process complete newline-delimited messages.
            while let idx = buffer.firstIndex(of: 0x0a) {
                let lineData = buffer.subdata(in: buffer.startIndex..<idx)
                buffer.removeSubrange(buffer.startIndex...idx)
                if lineData.isEmpty { continue }
                let reply = handle(lineData, connId: connId)
                var out = reply
                out.append(0x0a)
                _ = out.withUnsafeBytes { write(fd, $0.baseAddress, out.count) }
            }
        }
        // On disconnect, restore auto only if THIS connection owns the active
        // boost — a stray status-poll connection closing must not cancel a boost
        // held by another connection. The 10s watchdog is the universal net.
        stateQueue.sync {
            if !activeBoost.isEmpty && boostOwner == connId {
                log("boost-owning client disconnected -> restoring auto")
                fans.restoreAllAuto()
                activeBoost.removeAll()
                boostOwner = nil
            }
        }
    }

    private var connCounter: UInt64 = 0
    private func nextConnId() -> UInt64 {
        stateQueue.sync { connCounter += 1; return connCounter }
    }

    // MARK: - Request handling

    private func handle(_ data: Data, connId: UInt64) -> Data {
        guard
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let op = obj["op"] as? String
        else {
            return jsonReply(["ok": false, "error": "bad request"])
        }

        switch op {
        case "status":
            // Every FanController/SMC touch funnels through the serial
            // stateQueue: the SMC user client and its keyInfoCache Dictionary
            // are not thread-safe, and concurrent reads racing a boost write
            // from another connection can crash this root daemon.
            let payload = stateQueue.sync { statusPayloadLocked(ok: true) }
            return jsonReply(payload)

        case "heartbeat":
            let reply: [String: Any] = stateQueue.sync {
                lastPetAt = Date()
                reassertLocked()
                return ["ok": true, "active": activePayloadLocked()]
            }
            return jsonReply(reply)

        case "auto":
            let reply: [String: Any] = stateQueue.sync {
                fans.restoreAllAuto()
                activeBoost.removeAll()
                boostOwner = nil
                return ["ok": true, "mode": "auto", "active": []]
            }
            return jsonReply(reply)

        case "boost":
            guard let fan = (obj["fan"] as? NSNumber)?.intValue,
                  let rpm = (obj["rpm"] as? NSNumber)?.doubleValue
            else {
                return jsonReply(["ok": false, "error": "boost needs fan,rpm"])
            }
            // Validation, clamping, SMC writes, and bookkeeping all run on
            // stateQueue — see the "status" case for why.
            let reply: [String: Any] = stateQueue.sync {
                guard fan < fans.fanCount() else {
                    return ["ok": false, "error": "invalid fan index"]
                }
                // SAFETY: never seize a fan the firmware thermal manager owns —
                // forcing manual mode over an active thermal response would
                // fight macOS's hottest-temperature handling.
                guard fans.readFan(fan).mode != .thermalMgr else {
                    return ["ok": false,
                            "error": "fan under firmware thermal management"]
                }
                guard let clamped = fans.clampBoost(fan: fan, rpm: rpm) else {
                    return ["ok": false,
                            "error": "rpm out of [min,max] (boost-only)"]
                }
                do {
                    try fans.setBoost(fan: fan, rpm: rpm)
                    activeBoost[fan] = clamped
                    boostOwner = connId
                    lastPetAt = Date()
                    var payload = statusPayloadLocked(ok: true)
                    payload["appliedRpm"] = Int(clamped.rounded())
                    return payload
                } catch {
                    return ["ok": false, "error": "\(error)"]
                }
            }
            return jsonReply(reply)

        default:
            return jsonReply(["ok": false, "error": "unknown op"])
        }
    }

    /// Fan+temps snapshot plus the daemon's active-boost set.
    /// MUST be called on stateQueue (SMC connection + activeBoost are guarded
    /// by it; SMC is additionally not thread-safe).
    private func statusPayloadLocked(ok: Bool) -> [String: Any] {
        [
            "ok": ok,
            "fans": fans.allFans().map { $0.json },
            "temps": fans.temperatures(),
            "active": activePayloadLocked(),
        ]
    }

    /// Active boosts as [{"fan":N,"rpm":R},...] so clients can detect when the
    /// watchdog has silently restored auto and re-assert instead of
    /// phantom-boosting. MUST be called on stateQueue.
    private func activePayloadLocked() -> [[String: Any]] {
        activeBoost
            .sorted { $0.key < $1.key }
            .map { ["fan": $0.key, "rpm": Int($0.value.rounded())] }
    }

    private func jsonReply(_ obj: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{\"ok\":false}".utf8)
    }

    // MARK: - Watchdog

    private func startWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: stateQueue)
        timer.schedule(deadline: .now() + 1, repeating: 1.0)
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            // Runs on stateQueue.
            guard !self.activeBoost.isEmpty else { return }
            if Date().timeIntervalSince(self.lastPetAt) > kWatchdogSeconds {
                self.log("watchdog expired -> restoring auto")
                self.fans.restoreAllAuto()
                self.activeBoost.removeAll()
                self.boostOwner = nil
            }
        }
        timer.resume()
        watchdogTimer = timer
    }

    // MARK: - Wake / divergence

    private func installWakeObserver() {
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil, queue: nil
        ) { [weak self] _ in
            self?.reassertIfDiverged()
        }
    }

    /// Entry point for off-queue callers (wake observer posts on the main
    /// thread): hops to the serial stateQueue.
    private func reassertIfDiverged() {
        stateQueue.sync { reassertLocked() }
    }

    /// Decide what to do with a recorded boost whose fan mode moved on while
    /// we weren't looking:
    ///  * `.auto`      — firmware merely reverted (typical after wake): re-pin
    ///                   our recorded target. That's the normal divergence.
    ///  * `.thermalMgr` — the firmware thermal manager has taken the fan over
    ///                   (thermal throttling). YIELD: drop our pin and let it
    ///                   do its job. Re-pinning over a thermal takeover would
    ///                   fight the firmware's hottest-temperature response,
    ///                   so it is never done.
    /// MUST be called on stateQueue (SMC access + activeBoost).
    private func reassertLocked() {
        guard !activeBoost.isEmpty else { return }
        var yieldFans: [Int] = []
        for (fan, target) in activeBoost {
            let current = fans.readFan(fan)
            switch current.mode {
            case .forced:
                continue // target still pinned — nothing to do
            case .auto:
                log("fan \(fan) diverged (mode=auto); re-asserting \(Int(target)) rpm")
                try? fans.setBoost(fan: fan, rpm: target)
            case .thermalMgr:
                // No SMC write here: overriding the thermal manager is
                // forbidden by the safety model. Clear our bookkeeping so the
                // watchdog/disconnect paths don't re-pin it later either.
                log("fan \(fan) under firmware thermal manager; yielding boost")
                yieldFans.append(fan)
            }
        }
        for fan in yieldFans {
            activeBoost.removeValue(forKey: fan)
        }
        if activeBoost.isEmpty { boostOwner = nil }
    }

    // MARK: - Signals / exit

    private func installSignalHandlers() {
        // A client can vanish between sending a request and reading the reply
        // (crash, abrupt exit). Writing that reply would then raise SIGPIPE,
        // whose default action kills the daemon silently. Ignore it — the
        // write() just returns EPIPE and the serve loop closes the connection.
        signal(SIGPIPE, SIG_IGN)

        // Restore auto on any exit path. atexit takes a C function pointer, so
        // we route through a global weak reference to the live FanController.
        gExitFans = fans
        atexit {
            gExitFans?.restoreAllAuto()
        }
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: stateQueue)
            src.setEventHandler { [weak self] in
                self?.log("caught signal \(sig) -> restoring auto and exiting")
                self?.fans.restoreAllAuto()
                exit(0)
            }
            src.resume()
            // Keep the source alive for process lifetime.
            signalSources.append(src)
        }
    }

    private var signalSources: [DispatchSourceSignal] = []
}

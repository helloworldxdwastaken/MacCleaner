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
//
// Security:
//   * Socket mode 0660 (owner+group rw). Peer verified with getpeereid():
//     only root (uid 0) or the uid recorded at install time in
//     /Library/Application Support/com.dronx.maccleaner.fanhelper/allowed-uid
//     is accepted.
//   * Boost is boost-only and clamped to [F(i)Mn, F(i)Mx].
//   * 10-second failsafe watchdog: any boost/heartbeat resets it; on expiry,
//     socket disconnect, SIGTERM/SIGINT, or daemon exit -> restore auto.
//   * After wake, re-assert the manual target if the mode diverged while a
//     boost is active.

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
        installWakeObserver()
        startWatchdog()
        setupSocket()
        acceptLoop()   // never returns
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

        // 0660: owner (root) + group rw. So the non-root app can reach the
        // socket at the filesystem layer, chown it to the allowed uid and that
        // user's primary group. The real authorization gate is getpeereid()
        // in the accept loop, which only admits root or the recorded uid.
        chmod(kSocketPath, 0o660)
        if let uid = allowedUID() {
            var gid: gid_t = 0
            if let pw = getpwuid(uid) { gid = pw.pointee.pw_gid }
            chown(kSocketPath, uid, gid)
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
                log("accept() failed: \(String(cString: strerror(errno)))")
                continue
            }
            // Verify peer identity before serving.
            var euid: uid_t = 0
            var egid: gid_t = 0
            if getpeereid(clientFd, &euid, &egid) != 0 {
                log("getpeereid failed; rejecting")
                close(clientFd)
                continue
            }
            if !isPeerAllowed(euid) {
                log("rejected peer uid=\(euid)")
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

        while true {
            let n = read(fd, &readBuf, readBuf.count)
            if n == 0 { break }          // client disconnected
            if n < 0 {
                if errno == EINTR { continue }
                break
            }
            buffer.append(contentsOf: readBuf[0..<n])

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
            return jsonReply(statusPayload(ok: true))

        case "heartbeat":
            pet()
            reassertIfDiverged()
            return jsonReply(["ok": true])

        case "auto":
            stateQueue.sync {
                fans.restoreAllAuto()
                activeBoost.removeAll()
                boostOwner = nil
            }
            return jsonReply(["ok": true, "mode": "auto"])

        case "boost":
            guard let fan = (obj["fan"] as? NSNumber)?.intValue,
                  let rpm = (obj["rpm"] as? NSNumber)?.doubleValue
            else {
                return jsonReply(["ok": false, "error": "boost needs fan,rpm"])
            }
            guard fan >= 0 && fan < fans.fanCount() else {
                return jsonReply(["ok": false, "error": "invalid fan index"])
            }
            guard fans.clampBoost(fan: fan, rpm: rpm) != nil else {
                return jsonReply(["ok": false,
                                  "error": "rpm out of [min,max] (boost-only)"])
            }
            do {
                try fans.setBoost(fan: fan, rpm: rpm)
                let applied = fans.clampBoost(fan: fan, rpm: rpm) ?? rpm
                stateQueue.sync {
                    activeBoost[fan] = applied
                    boostOwner = connId
                    lastPetAt = Date()
                }
                var reply = statusPayload(ok: true)
                reply["appliedRpm"] = Int(applied.rounded())
                return jsonReply(reply)
            } catch {
                return jsonReply(["ok": false, "error": "\(error)"])
            }

        default:
            return jsonReply(["ok": false, "error": "unknown op"])
        }
    }

    private func statusPayload(ok: Bool) -> [String: Any] {
        [
            "ok": ok,
            "fans": fans.allFans().map { $0.json },
            "temps": fans.temperatures(),
        ]
    }

    private func jsonReply(_ obj: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{\"ok\":false}".utf8)
    }

    // MARK: - Watchdog

    private func pet() {
        stateQueue.sync { lastPetAt = Date() }
    }

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

    /// If a boost is active but firmware reset the fan to auto/thermal after
    /// wake, re-apply the recorded manual target.
    private func reassertIfDiverged() {
        stateQueue.sync {
            for (fan, target) in activeBoost {
                let current = fans.readFan(fan)
                if current.mode != .forced {
                    log("fan \(fan) diverged (mode=\(current.mode.label)); re-asserting \(Int(target)) rpm")
                    try? fans.setBoost(fan: fan, rpm: target)
                }
            }
        }
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

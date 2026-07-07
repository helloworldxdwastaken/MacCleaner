// main.swift — CLI dispatch for maccleaner-fanhelperd
//
// Subcommands:
//   status    JSON snapshot of fans + temps to stdout (no root needed for read)
//   daemon    LaunchDaemon mode: unix-socket JSON server + failsafe watchdog
//   auto      restore automatic fan control immediately (needs root)
//   selftest  supervised write self-test (needs root): boost fan 0 by ~800 rpm
//             for ~12s, confirm F0Ac rises, then restore auto and verify
//             mode == auto. NEVER leaves a fan in manual mode.
//
// See SMC.swift header for MIT-source attributions.

import Foundation

func emit(_ obj: [String: Any]) {
    let data = (try? JSONSerialization.data(
        withJSONObject: obj,
        options: [.sortedKeys])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    emit(["ok": false, "error": message])
    exit(code)
}

let args = CommandLine.arguments
let sub = args.count > 1 ? args[1] : "status"

let smc: SMC
do {
    smc = try SMC()
} catch {
    fail("cannot open AppleSMC: \(error)")
}
let fans = FanController(smc)

switch sub {

case "status":
    let payload: [String: Any] = [
        "ok": true,
        "fans": fans.allFans().map { $0.json },
        "temps": fans.temperatures(),
    ]
    emit(payload)

case "auto":
    fans.restoreAllAuto()
    let stillManual = fans.anyManual()
    emit(["ok": !stillManual, "mode": stillManual ? "manual" : "auto"])
    exit(stillManual ? 1 : 0)

case "daemon":
    let daemon = Daemon(smc)
    daemon.run()   // never returns

case "selftest":
    // Supervised write test. Requires root. Always restores auto at the end.
    guard getuid() == 0 else {
        fail("selftest requires root")
    }
    let n = fans.fanCount()
    guard n > 0 else { fail("no fans detected") }

    let fanIndex = 0
    let before = fans.readFan(fanIndex)
    let target = min(before.actualRpm + 800, before.maxRpm)

    var log: [String: Any] = [
        "fan": fanIndex,
        "beforeRpm": Int(before.actualRpm.rounded()),
        "min": Int(before.minRpm.rounded()),
        "max": Int(before.maxRpm.rounded()),
        "targetRpm": Int(target.rounded()),
    ]

    var rose = false
    var peakRpm = before.actualRpm
    var applied = false

    do {
        try fans.setBoost(fan: fanIndex, rpm: target)
        applied = true
    } catch {
        fans.restoreAllAuto()
        log["ok"] = false
        log["error"] = "boost write failed: \(error)"
        log["restoredAuto"] = !fans.anyManual()
        emit(log)
        exit(1)
    }

    // Sample F0Ac for ~12 seconds.
    if applied {
        var samples: [Int] = []
        for _ in 0..<12 {
            Thread.sleep(forTimeInterval: 1.0)
            let ac = fans.readFan(fanIndex).actualRpm
            samples.append(Int(ac.rounded()))
            if ac > peakRpm { peakRpm = ac }
            if ac > before.actualRpm + 150 { rose = true }
        }
        log["samples"] = samples
    }
    log["peakRpm"] = Int(peakRpm.rounded())
    log["rose"] = rose

    // ALWAYS restore auto, verify, and double-check no fan is left manual.
    fans.restoreAllAuto()
    Thread.sleep(forTimeInterval: 1.0)
    let after = fans.readFan(fanIndex)
    let anyManual = fans.anyManual()
    if anyManual {
        // Try once more, hard.
        fans.restoreAllAuto()
        Thread.sleep(forTimeInterval: 0.5)
    }
    log["afterMode"] = after.mode.label
    log["restoredAuto"] = !fans.anyManual()
    log["ok"] = rose && !fans.anyManual()
    emit(log)
    exit((rose && !fans.anyManual()) ? 0 : 1)

case "-h", "--help", "help":
    let text = """
    maccleaner-fanhelperd — SMC fan control helper

    Usage:
      maccleaner-fanhelperd status     Print fan + temperature JSON (no root)
      maccleaner-fanhelperd daemon     Run as LaunchDaemon (socket server)
      maccleaner-fanhelperd auto       Restore automatic fan control (root)
      maccleaner-fanhelperd selftest   Supervised boost self-test (root)
    """
    FileHandle.standardError.write(Data((text + "\n").utf8))

default:
    fail("unknown subcommand: \(sub)")
}

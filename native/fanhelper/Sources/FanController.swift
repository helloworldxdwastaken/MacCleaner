// FanController.swift — fan enumeration, temperature domains, boost/auto logic
//
// ATTRIBUTION: fan key semantics (F0Ac/F0Mn/F0Mx/F0Tg/F0Md/FS!/Ftst),
// manual-mode + target write sequence, and the auto-restore guard are adapted
// from the MIT-licensed exelban/stats and raminsharifi/MacFanControl. See the
// header of SMC.swift for full credits. No GPL code was used.
//
// Temperature domain key clusters for Apple M1 Max are per the blueprint
// (exelban/stats sensor lists, logi.wiki SMC sensor codes). Keys absent on
// this machine are silently skipped.

import Foundation

// MARK: - Fan mode

enum FanMode: Int {
    case auto = 0
    case forced = 1      // manual / forced target
    case thermalMgr = 3  // macOS thermal manager owns the fan

    var label: String {
        switch self {
        case .auto: return "auto"
        case .forced: return "manual"
        case .thermalMgr: return "thermal"
        }
    }
}

// MARK: - Fan snapshot

struct FanInfo {
    let id: Int
    let label: String
    let actualRpm: Double
    let minRpm: Double
    let maxRpm: Double
    let targetRpm: Double
    let mode: FanMode

    var json: [String: Any] {
        [
            "id": id,
            "label": label,
            "actualRpm": Int(actualRpm.rounded()),
            "minRpm": Int(minRpm.rounded()),
            "maxRpm": Int(maxRpm.rounded()),
            "targetRpm": Int(targetRpm.rounded()),
            "mode": mode.label,
        ]
    }
}

// MARK: - Temperature domains (M1 Max)

// Key clusters verified present on this MacBook Pro 18,2 (M1 Max) by
// enumerating all 2122 SMC keys (op 8) and reading each `flt` value. Keys not
// present on a given machine are silently skipped at read time, so these lists
// stay safe across M1/M2/M3 variants.
//
// On M1 Max the CPU exposes core-temperature triads. The die's 8 performance
// cores map to the higher "Tp0x" die-2 group; the 2 efficiency cores map to
// the low "Tp0x" group. We report the P-core "hot" sensor of each triad for
// cpuPerf and the E-core cluster for cpuEff.
private let tempDomains: [(name: String, keys: [String])] = [
    // CPU performance cores (P-core die sensors — the "hot" member of each triad)
    ("cpuPerf", ["Tp01", "Tp02", "Tp05", "Tp06", "Tp0D", "Tp0E", "Tp0H", "Tp0I",
                 "Tp0L", "Tp0M", "Tp0P", "Tp0Q", "Tp0X", "Tp0Y", "Tp0b", "Tp0c"]),
    // CPU efficiency cores
    ("cpuEff", ["Tp09", "Tp0A", "Tp0T", "Tp0U"]),
    // GPU cores
    ("gpu", ["Tg05", "Tg0D", "Tg0L", "Tg0T", "Tg04", "Tg0C", "Tg0K", "Tg0S"]),
    // Battery
    ("battery", ["TB0T", "TB1T", "TB2T"]),
    // SSD / NAND proximity
    ("ssd", ["Ts0P", "Ts1P", "TaLP", "TaRP"]),
    // Ambient / airflow
    ("ambient", ["TA0P", "TA1P", "TAOL", "TA0L"]),
]

final class FanController {
    let smc: SMC

    init(_ smc: SMC) { self.smc = smc }

    // MARK: Fan enumeration

    func fanCount() -> Int {
        if let v = smc.readDouble("FNum") { return Int(v) }
        return 0
    }

    func readFan(_ i: Int) -> FanInfo {
        let ac = smc.readDouble("F\(i)Ac") ?? 0
        let mn = smc.readDouble("F\(i)Mn") ?? 0
        let mx = smc.readDouble("F\(i)Mx") ?? 0
        let tg = smc.readDouble("F\(i)Tg") ?? 0
        let modeRaw = Int(smc.readDouble("F\(i)Md") ?? 0)
        let mode = FanMode(rawValue: modeRaw) ?? .auto
        return FanInfo(
            id: i,
            label: "Fan \(i + 1)",
            actualRpm: ac, minRpm: mn, maxRpm: mx, targetRpm: tg,
            mode: mode)
    }

    func allFans() -> [FanInfo] {
        (0..<fanCount()).map { readFan($0) }
    }

    // MARK: Temperatures

    /// Per-domain averages over the keys that actually exist on this machine.
    /// Returns domain->°C plus hottest{key,value}.
    func temperatures() -> [String: Any] {
        var result: [String: Any] = [:]
        var hottestKey = ""
        var hottestVal = -Double.greatestFiniteMagnitude

        for domain in tempDomains {
            var sum = 0.0
            var count = 0
            for key in domain.keys {
                guard let v = smc.readDouble(key) else { continue }
                // Plausible on-die temperature range; ignore obvious garbage.
                guard v > 0 && v < 130 else { continue }
                sum += v
                count += 1
                if v > hottestVal {
                    hottestVal = v
                    hottestKey = key
                }
            }
            if count > 0 {
                result[domain.name] = round(sum / Double(count) * 10) / 10
            }
        }

        if hottestVal > -Double.greatestFiniteMagnitude {
            result["hottest"] = [
                "key": hottestKey,
                "value": round(hottestVal * 10) / 10,
            ]
        }
        return result
    }

    // MARK: Boost / Auto

    /// Clamp a requested RPM to [autoMin, hwMax] (boost-only: never below the
    /// firmware auto minimum, never above the hardware ceiling).
    func clampBoost(fan i: Int, rpm: Double) -> Double? {
        let mn = smc.readDouble("F\(i)Mn") ?? 0
        let mx = smc.readDouble("F\(i)Mx") ?? 0
        guard mx > 0, mn >= 0 else { return nil }
        // Reject values that fall below the auto minimum outright — boost-only.
        if rpm < mn { return nil }
        return min(rpm, mx)
    }

    /// Put a fan into manual mode and command a target RPM. Defensive M3+
    /// unlock (Ftst) is attempted only if the write is initially rejected.
    func setBoost(fan i: Int, rpm: Double) throws {
        guard let target = clampBoost(fan: i, rpm: rpm) else {
            throw FanError.outOfRange
        }
        do {
            try smc.writeUInt8("F\(i)Md", UInt8(FanMode.forced.rawValue))
            try smc.writeRPM("F\(i)Tg", target)
        } catch {
            // Defensive unlock for M3+ firmware (harmless on M1); retry once.
            _ = try? smc.writeUInt8("Ftst", 1)
            Thread.sleep(forTimeInterval: 0.2)
            try smc.writeUInt8("F\(i)Md", UInt8(FanMode.forced.rawValue))
            try smc.writeRPM("F\(i)Tg", target)
        }
    }

    /// Restore automatic control for one fan: mode=0 and clear its forced bit.
    func restoreAuto(fan i: Int) {
        _ = try? smc.writeUInt8("F\(i)Md", UInt8(FanMode.auto.rawValue))
    }

    /// Restore automatic control for all fans and clear the global force mask.
    func restoreAllAuto() {
        let n = fanCount()
        for i in 0..<n {
            _ = try? smc.writeUInt8("F\(i)Md", UInt8(FanMode.auto.rawValue))
        }
        // Clear the legacy per-fan forced bitmask (FS! ) if present.
        if smc.exists("FS! ") {
            _ = try? smc.writeUInt16("FS! ", 0)
        }
    }

    /// True if any fan is currently in a non-auto mode.
    func anyManual() -> Bool {
        for i in 0..<fanCount() where readFan(i).mode != .auto { return true }
        return false
    }
}

enum FanError: Error, CustomStringConvertible {
    case outOfRange
    case noFans

    var description: String {
        switch self {
        case .outOfRange: return "requested rpm out of [min,max] range"
        case .noFans: return "no fans detected"
        }
    }
}

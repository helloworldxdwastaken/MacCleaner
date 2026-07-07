// SMC.swift — AppleSMC IOKit user-client access for maccleaner-fanhelperd
//
// ATTRIBUTION
// -----------
// The SMC IOKit protocol implemented here (the 80-byte SMCParamStruct /
// SMCKeyData_t layout, selector 2 = kSMCHandleYPCEvent, the operation codes
// 5=read / 6=write / 8=key-from-index / 9=key-info, the FourCharCode key
// packing, and the flt/fpe2/ui* value decoding) is adapted — with thanks —
// from the following MIT-licensed open-source projects:
//
//   * exelban/stats            (MIT)  — SMC/smc.swift, SMC/Helper/main.swift
//                                        https://github.com/exelban/stats
//   * beltex/SMCKit            (MIT)  — SMCKit/SMC.swift (struct layout)
//                                        https://github.com/beltex/SMCKit
//   * raminsharifi/MacFanControl (MIT) — Apple-Silicon flt encoding + auto
//                                        restore guard
//                                        https://github.com/raminsharifi/MacFanControl
//
// No code was copied from any GPL project. This file is an original Swift
// re-implementation informed by the MIT sources above.
//
// Apple Silicon note: fan/temperature RPM & °C values are little-endian
// IEEE-754 `flt` (4 bytes) rather than Intel's `fpe2` fixed point. We probe
// each key's dataType at runtime (op 9) and decode accordingly, with an fpe2
// fallback for robustness.

import Foundation
import IOKit

// MARK: - FourCharCode <-> String

@inline(__always)
func fourCharCode(_ str: String) -> UInt32 {
    // Pack 4 ASCII chars big-endian into a UInt32, matching SMC key encoding.
    precondition(str.utf8.count == 4, "SMC key must be exactly 4 chars: \(str)")
    var code: UInt32 = 0
    for b in str.utf8 { code = (code << 8) | UInt32(b) }
    return code
}

func fourCharString(_ code: UInt32) -> String {
    let bytes = [
        UInt8((code >> 24) & 0xff),
        UInt8((code >> 16) & 0xff),
        UInt8((code >> 8) & 0xff),
        UInt8(code & 0xff),
    ]
    return String(bytes: bytes, encoding: .ascii) ?? ""
}

// MARK: - SMCParamStruct (80 bytes — must match kernel ABI exactly)

typealias SMCBytes = (
    UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
    UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
    UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
    UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8
)

let smcBytesZero: SMCBytes = (
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
)

struct SMCVersion {
    var major: UInt8 = 0
    var minor: UInt8 = 0
    var build: UInt8 = 0
    var reserved: UInt8 = 0
    var release: UInt16 = 0
}

struct SMCPLimitData {
    var version: UInt16 = 0
    var length: UInt16 = 0
    var cpuPLimit: UInt32 = 0
    var gpuPLimit: UInt32 = 0
    var memPLimit: UInt32 = 0
}

struct SMCKeyInfoData {
    var dataSize: UInt32 = 0     // IOByteCount
    var dataType: UInt32 = 0
    var dataAttributes: UInt8 = 0
}

struct SMCParamStruct {
    var key: UInt32 = 0
    var vers = SMCVersion()
    var pLimitData = SMCPLimitData()
    var keyInfo = SMCKeyInfoData()
    var padding: UInt16 = 0
    var result: UInt8 = 0
    var status: UInt8 = 0
    var data8: UInt8 = 0
    var data32: UInt32 = 0
    var bytes: SMCBytes = smcBytesZero
}

// MARK: - Operations

enum SMCSelector: UInt8 {
    case handleYPCEvent = 2      // kernel index / selector
}

enum SMCOp: UInt8 {
    case readBytes = 5
    case writeBytes = 6
    case getKeyFromIndex = 8
    case getKeyInfo = 9
}

// MARK: - Decoded value

struct SMCValue {
    let key: String
    let dataType: String
    let dataSize: UInt32
    let bytes: [UInt8]

    /// Decode into a Double honouring the SMC dataType.
    var double: Double {
        switch dataType {
        case "flt ":
            guard bytes.count >= 4 else { return 0 }
            let raw = bytes[0..<4].reversedIfNeeded()
            let bits = UInt32(raw[0]) | (UInt32(raw[1]) << 8)
                | (UInt32(raw[2]) << 16) | (UInt32(raw[3]) << 24)
            return Double(Float(bitPattern: bits))
        case "fpe2":
            guard bytes.count >= 2 else { return 0 }
            // fixed point: (b0 << 6) | (b1 >> 2)
            return Double((Int(bytes[0]) << 6) | (Int(bytes[1]) >> 2))
        case "sp78":
            guard bytes.count >= 2 else { return 0 }
            let i = Int16(bitPattern: (UInt16(bytes[0]) << 8) | UInt16(bytes[1]))
            return Double(i) / 256.0
        case "ui8 ", "ui8":
            return bytes.isEmpty ? 0 : Double(bytes[0])
        case "ui16":
            guard bytes.count >= 2 else { return 0 }
            return Double((UInt16(bytes[0]) << 8) | UInt16(bytes[1]))
        case "ui32":
            guard bytes.count >= 4 else { return 0 }
            let v = (UInt32(bytes[0]) << 24) | (UInt32(bytes[1]) << 16)
                | (UInt32(bytes[2]) << 8) | UInt32(bytes[3])
            return Double(v)
        case "si8 ", "si8":
            return bytes.isEmpty ? 0 : Double(Int8(bitPattern: bytes[0]))
        default:
            // Best effort: little-endian float if 4 bytes, else first byte.
            if bytes.count >= 4 {
                let bits = UInt32(bytes[0]) | (UInt32(bytes[1]) << 8)
                    | (UInt32(bytes[2]) << 16) | (UInt32(bytes[3]) << 24)
                let f = Float(bitPattern: bits)
                if f.isFinite && abs(f) < 1e9 { return Double(f) }
            }
            return bytes.isEmpty ? 0 : Double(bytes[0])
        }
    }
}

private extension ArraySlice where Element == UInt8 {
    // SMC `flt` bytes are stored little-endian (Apple Silicon). We read them
    // as-is; this helper keeps the intent explicit.
    func reversedIfNeeded() -> [UInt8] { Array(self) }
}

// MARK: - SMC connection

enum SMCError: Error, CustomStringConvertible {
    case open(kern_return_t)
    case notFound
    case call(kern_return_t)
    case smcResult(UInt8)

    var description: String {
        switch self {
        case .open(let r): return "IOServiceOpen failed: 0x\(String(r, radix: 16))"
        case .notFound: return "AppleSMC service not found"
        case .call(let r): return "IOConnectCallStructMethod failed: 0x\(String(r, radix: 16))"
        case .smcResult(let r): return "SMC returned result 0x\(String(r, radix: 16))"
        }
    }
}

final class SMC {
    private var conn: io_connect_t = 0
    private var keyInfoCache: [UInt32: SMCKeyInfoData] = [:]

    init() throws {
        let service = IOServiceGetMatchingService(
            kIOMainPortDefault, IOServiceMatching("AppleSMC"))
        guard service != 0 else { throw SMCError.notFound }
        defer { IOObjectRelease(service) }
        let rc = IOServiceOpen(service, mach_task_self_, 0, &conn)
        guard rc == kIOReturnSuccess else { throw SMCError.open(rc) }
    }

    deinit {
        if conn != 0 { IOServiceClose(conn) }
    }

    private func callStruct(_ input: inout SMCParamStruct) throws -> SMCParamStruct {
        var output = SMCParamStruct()
        let inSize = MemoryLayout<SMCParamStruct>.stride
        var outSize = MemoryLayout<SMCParamStruct>.stride
        let rc = withUnsafeMutablePointer(to: &input) { inPtr in
            withUnsafeMutablePointer(to: &output) { outPtr in
                IOConnectCallStructMethod(
                    conn, UInt32(SMCSelector.handleYPCEvent.rawValue),
                    inPtr, inSize, outPtr, &outSize)
            }
        }
        guard rc == kIOReturnSuccess else { throw SMCError.call(rc) }
        return output
    }

    /// Query a key's info (dataSize + dataType), cached.
    func keyInfo(_ key: String) throws -> SMCKeyInfoData {
        let code = fourCharCode(key)
        if let cached = keyInfoCache[code] { return cached }
        var input = SMCParamStruct()
        input.key = code
        input.data8 = SMCOp.getKeyInfo.rawValue
        let out = try callStruct(&input)
        if out.result != 0 { throw SMCError.smcResult(out.result) }
        keyInfoCache[code] = out.keyInfo
        return out.keyInfo
    }

    /// True if the key exists on this machine.
    func exists(_ key: String) -> Bool {
        (try? keyInfo(key)) != nil
    }

    /// Read and decode a key. Returns nil if the key is absent.
    func read(_ key: String) -> SMCValue? {
        guard let info = try? keyInfo(key) else { return nil }
        var input = SMCParamStruct()
        input.key = fourCharCode(key)
        input.keyInfo.dataSize = info.dataSize
        input.data8 = SMCOp.readBytes.rawValue
        guard let out = try? callStruct(&input), out.result == 0 else { return nil }
        let size = Int(info.dataSize)
        var arr = [UInt8](repeating: 0, count: min(size, 32))
        withUnsafeBytes(of: out.bytes) { raw in
            for i in 0..<arr.count { arr[i] = raw[i] }
        }
        return SMCValue(
            key: key,
            dataType: fourCharString(info.dataType),
            dataSize: info.dataSize,
            bytes: arr)
    }

    /// Convenience: read a key as Double (0 if absent).
    func readDouble(_ key: String) -> Double? {
        read(key)?.double
    }

    // MARK: Writes (require root)

    /// Low-level write of raw bytes to a key.
    func writeBytes(_ key: String, _ bytes: [UInt8]) throws {
        let info = try keyInfo(key)
        var input = SMCParamStruct()
        input.key = fourCharCode(key)
        input.keyInfo.dataSize = info.dataSize
        input.data8 = SMCOp.writeBytes.rawValue
        withUnsafeMutableBytes(of: &input.bytes) { raw in
            for (i, b) in bytes.enumerated() where i < 32 { raw[i] = b }
        }
        let out = try callStruct(&input)
        if out.result != 0 { throw SMCError.smcResult(out.result) }
    }

    /// Write a UInt8 to a key.
    func writeUInt8(_ key: String, _ value: UInt8) throws {
        try writeBytes(key, [value])
    }

    /// Write a UInt16 (big-endian, SMC convention) to a key.
    func writeUInt16(_ key: String, _ value: UInt16) throws {
        try writeBytes(key, [UInt8(value >> 8), UInt8(value & 0xff)])
    }

    /// Write a fan RPM value honouring the key's declared dataType (flt/fpe2).
    func writeRPM(_ key: String, _ rpm: Double) throws {
        let info = try keyInfo(key)
        let type = fourCharString(info.dataType)
        switch type {
        case "flt ":
            let f = Float(rpm)
            let bits = f.bitPattern
            // Little-endian byte order (Apple Silicon native).
            let bytes = [
                UInt8(bits & 0xff),
                UInt8((bits >> 8) & 0xff),
                UInt8((bits >> 16) & 0xff),
                UInt8((bits >> 24) & 0xff),
            ]
            try writeBytes(key, bytes)
        case "fpe2":
            let v = UInt16(max(0, min(65535, rpm)))
            // inverse of (b0<<6)|(b1>>2)
            let b0 = UInt8((v >> 6) & 0xff)
            let b1 = UInt8((v << 2) & 0xff)
            try writeBytes(key, [b0, b1])
        default:
            // Fall back to little-endian float.
            let bits = Float(rpm).bitPattern
            try writeBytes(key, [
                UInt8(bits & 0xff), UInt8((bits >> 8) & 0xff),
                UInt8((bits >> 16) & 0xff), UInt8((bits >> 24) & 0xff),
            ])
        }
    }
}

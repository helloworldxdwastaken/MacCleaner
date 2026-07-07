#!/bin/bash
# build.sh — release build of maccleaner-fanhelperd
#
# Produces ./build/maccleaner-fanhelperd. Attempts a universal (arm64+x86_64)
# binary via lipo; falls back to arm64-only if the x86_64 slice fails to build
# (e.g. no macOS SDK x86_64 support). The chosen arch is printed at the end.
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p build

BIN="build/maccleaner-fanhelperd"
SRCS=(Sources/SMC.swift Sources/FanController.swift Sources/Daemon.swift Sources/main.swift)

# Common flags. AppKit is linked for NSWorkspace wake notifications; IOKit for
# the SMC user client. -O for release.
COMMON=(-O -framework IOKit -framework AppKit -framework Foundation)

build_slice() {
  local arch="$1" out="$2"
  swiftc "${COMMON[@]}" -target "${arch}-apple-macosx12.0" "${SRCS[@]}" -o "$out"
}

echo "==> Building arm64 slice"
build_slice arm64 "build/fanhelperd-arm64"

ARCH_NOTE="arm64-only"
if build_slice x86_64 "build/fanhelperd-x86_64" 2>/dev/null; then
  echo "==> Building x86_64 slice"
  echo "==> lipo -> universal"
  lipo -create -output "$BIN" \
    "build/fanhelperd-arm64" "build/fanhelperd-x86_64"
  ARCH_NOTE="universal (arm64 + x86_64)"
  rm -f "build/fanhelperd-arm64" "build/fanhelperd-x86_64"
else
  echo "==> x86_64 slice unavailable; producing arm64-only binary"
  mv "build/fanhelperd-arm64" "$BIN"
fi

# Ad-hoc sign so the binary can run under a LaunchDaemon without Gatekeeper
# complaints on the local machine. (Distribution signing is done by the app's
# afterPack step, not here.)
codesign --force --sign - "$BIN" 2>/dev/null || true

echo "==> Built $BIN ($ARCH_NOTE)"
lipo -info "$BIN" 2>/dev/null || file "$BIN"

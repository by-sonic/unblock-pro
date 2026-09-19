#!/bin/bash
# Local macOS runtime verification; no system proxy/DNS/pf changes, no app launch.
# Usage: bash scripts/verify-mac.sh [path/to/tpws]
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This diagnostic is intended for macOS." >&2
  exit 1
fi

BINARY="${1:-bin/darwin/tpws}"
echo "=== UnblockPro macOS runtime verification ==="
printf 'arch: %s; macOS: %s\n' "$(uname -m)" "$(sw_vers -productVersion)"
printf 'binary: %s\n' "$BINARY"
if [ ! -f "$BINARY" ]; then
  echo "Binary missing. Pass the tpws path from the app log as the first argument." >&2
  exit 1
fi
file "$BINARY"
echo "--- signing evidence (SIGKILL alone does not establish a signing failure) ---"
codesign -dv --verbose=4 "$BINARY" 2>&1 || true
codesign --verify --verbose "$BINARY" 2>&1 || true

echo "--- unit tests ---"
npm test

echo "--- real SOCKS listener + localhost domain CONNECT (resolver worker) ---"
if node scripts/check-mac-runtime.js "$BINARY"; then
  echo "Local runtime smoke passed. Pinned tpws rejects loopback destinations by policy."
  echo "This checks the event loop, SOCKS request handling and localhost resolver, not external forwarding or ISP bypass."
else
  echo "Runtime smoke failed. Save this output and the matching tpws .ips crash report from:"
  echo "  ~/Library/Logs/DiagnosticReports/ or /Library/Logs/DiagnosticReports/"
  echo "Review reports before sharing them. AMFI 'Denying core dump' does not establish the crash cause."
  exit 1
fi

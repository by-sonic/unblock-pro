#!/bin/bash
# Verification harness for the strategy-selection fix. Run on macOS.
#
#   ./verify-mac.sh            # test the current branch
#   git switch main && ./verify-mac.sh   # capture the "before" numbers
#
# What it measures: how many strategies were really tested vs. falsely reported
# as "процесс не запустился", and how many tpws processes leak.

set -u

SEARCH_SECONDS="${SEARCH_SECONDS:-180}"
LOG="$(mktemp -t unblockpro-verify)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"

echo "=== UnblockPro macOS verification ==="
echo "branch:          $BRANCH"
echo "arch:            $(uname -m)"
echo "macOS:           $(sw_vers -productVersion)"
echo "search window:   ${SEARCH_SECONDS}s"
echo

echo "--- 1. unit tests ---"
npm test 2>&1 | tail -8
echo

# In dev mode (`npm start`) the app uses <repo>/bin/darwin/tpws and compiles it
# on first connect — so before the run that file usually does not exist yet, and
# inspecting only at the start examines a binary the app never touches. Hence
# this runs twice: section 2 and again after the app has been exercised.
inspect_binaries() {
  local found=0
  local candidate
  for candidate in \
    bin/darwin/tpws \
    "$HOME/Library/Application Support/unblock-pro/bin/darwin/tpws" \
    /Applications/UnblockPro.app/Contents/Resources/bin/tpws
  do
    [ -f "$candidate" ] || continue
    found=1
    echo "$candidate"
    file "$candidate" | sed 's/^/    arch:      /'
    # A missing or invalidated signature is one reason Apple Silicon SIGKILLs a
    # binary on exec while Intel runs the same file. Verified on a clean arm64
    # runner that a freshly built tpws is adhoc/linker-signed and runs, so a bad
    # signature here means something happened to this copy.
    codesign -dv "$candidate" 2>&1 \
      | grep -iE "Signature|Authority|flags|adhoc|not signed|code object|invalid" \
      | sed 's/^/    signing:   /' || true
    codesign --verify --verbose "$candidate" 2>&1 | head -2 | sed 's/^/    verify:    /' || true
    xattr -l "$candidate" 2>/dev/null | sed 's/^/    xattr:     /' || true

    # The decisive test: run it. No pipe — $? after a pipeline is the exit code
    # of the last stage, not the binary. macOS has no GNU `timeout`, so watchdog.
    RUN_LOG="$(mktemp -t unblockpro-exec)"
    "$candidate" --help >"$RUN_LOG" 2>&1 &
    RUN_PID=$!
    ( sleep 5; kill -9 "$RUN_PID" 2>/dev/null ) >/dev/null 2>&1 &
    WATCHDOG=$!
    wait "$RUN_PID" 2>/dev/null
    RUN_CODE=$?
    kill "$WATCHDOG" 2>/dev/null

    if [ "$RUN_CODE" -ge 128 ]; then
      echo "    exec:      KILLED by signal $((RUN_CODE - 128))  <-- THIS is the failure"
    else
      echo "    exec:      ran, exit=$RUN_CODE  (non-zero is fine, it ran)"
    fi
    head -2 "$RUN_LOG" 2>/dev/null | sed 's/^/    output:    /'
    rm -f "$RUN_LOG"
    echo
  done
  [ "$found" = "0" ] && echo "    (no tpws binary on disk yet — the app compiles it on first connect)"
  return 0
}

echo "--- 2. tpws binary BEFORE the run ---"
inspect_binaries
echo

echo "--- 3. stray tpws before start ---"
STRAY_BEFORE="$(pgrep -x tpws | wc -l | tr -d ' ')"
echo "tpws running: $STRAY_BEFORE"
if [ "$STRAY_BEFORE" != "0" ]; then
  echo "  (leftovers from an earlier run — killing so the measurement is clean)"
  pkill -x tpws 2>/dev/null
  sleep 1
fi
echo

echo "--- 4. launching app; press Подключить in the window ---"
echo "    log -> $LOG"
npm start >"$LOG" 2>&1 &
APP_PID=$!

PEAK_TPWS=0
ELAPSED=0
while [ "$ELAPSED" -lt "$SEARCH_SECONDS" ]; do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "    app exited early after ${ELAPSED}s"
    break
  fi
  COUNT="$(pgrep -x tpws | wc -l | tr -d ' ')"
  [ "$COUNT" -gt "$PEAK_TPWS" ] && PEAK_TPWS="$COUNT"
  sleep 3
  ELAPSED=$((ELAPSED + 3))
done

echo
echo "--- 5. results ---"
# grep -c already prints 0 when nothing matches; a `|| echo 0` fallback printed
# a second zero on its own line and made the report look corrupted.
count() { grep -cE "$1" "$LOG" 2>/dev/null || true; }

TESTED="$(count 'Тестирование:')"
NOT_STARTED="$(count 'процесс не запустился')"
BINARY_DEAD="$(count 'tpws не запускается')"
PORT_BUSY="$(count 'не доступен|занят другим процессом')"
FAILED_CHECK="$(count 'не прошла проверку соединения')"
WORKED="$(count 'работает!')"
ALL_FAILED="$(count 'Ни одна стратегия не сработала|стратегий не сработали')"

printf 'strategies announced:        %s\n' "$TESTED"
printf 'false "не запустился":        %s   <-- must be ~0 after the fix\n' "$NOT_STARTED"
printf 'binary cannot run at all:    %s   <-- if 1, the strategies are irrelevant\n' "$BINARY_DEAD"
printf 'port unavailable/busy:       %s\n' "$PORT_BUSY"
printf 'failed connectivity check:   %s   <-- honest failures, fine\n' "$FAILED_CHECK"
printf 'strategy accepted:           %s\n' "$WORKED"
printf 'gave up entirely:            %s\n' "$ALL_FAILED"
printf 'peak concurrent tpws:        %s   <-- must never exceed 1\n' "$PEAK_TPWS"

echo
echo "--- 6. why each strategy was rejected (the reason, not just the count) ---"
# Everything after the em dash is the actual cause: stderr from tpws, the signal
# that killed it, or which probe failed. This is the part worth reading.
grep -hoE '(процесс не запустился|не прошли проверку|не запускается) — .*' "$LOG" 2>/dev/null \
  | sort | uniq -c | sort -rn | head -12 | sed 's/^/    /'
grep -hE 'tpws не запускается|отклонила подпись|Подпись исправлена' "$LOG" 2>/dev/null \
  | sort -u | head -5 | sed 's/^/    /'
echo

echo "--- 6.5 tpws binary AFTER the run — this is the one the app actually used ---"
inspect_binaries
echo

echo "--- 7. cleanup check ---"
# `npm start &` gives us npm's pid, not Electron's — killing npm alone leaves the
# app running, which made the checks below measure a live app and report pf as
# still enabled. Terminate Electron itself so this section means something.
kill "$APP_PID" 2>/dev/null
pkill -f "Electron.*$PWD" 2>/dev/null
pkill -f "electron .*$PWD" 2>/dev/null
sleep 1

APP_GONE=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! pgrep -f "Electron.*$PWD" >/dev/null 2>&1; then APP_GONE=1; break; fi
  sleep 1
done
printf 'app actually terminated:      %s\n' "$([ "$APP_GONE" = "1" ] && echo yes || echo 'NO - readings below are unreliable')"

LEAKED="$(pgrep -x tpws | wc -l | tr -d ' ')"
printf 'tpws still alive after quit:  %s   <-- must be 0\n' "$LEAKED"
printf 'pf status:                    %s\n' "$(sudo pfctl -s info 2>/dev/null | head -1 || echo 'skipped (no sudo)')"
printf 'pf references (must be 0):    %s\n' "$(sudo pfctl -s References 2>/dev/null | head -1 || echo 'skipped (no sudo)')"
printf 'system SOCKS proxy:           %s\n' "$(networksetup -getsocksfirewallproxy Wi-Fi 2>/dev/null | head -1)"
[ "$LEAKED" != "0" ] && pkill -x tpws 2>/dev/null

echo
echo "Full log kept at: $LOG"
echo "Send that file back along with the numbers above."

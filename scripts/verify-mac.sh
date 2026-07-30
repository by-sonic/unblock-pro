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

echo "--- 2. bundled tpws architecture ---"
for candidate in bin/darwin/tpws "$HOME/Library/Application Support/unblock-pro/bin/darwin/tpws"; do
  if [ -f "$candidate" ]; then
    echo "$candidate:"
    file "$candidate" | sed 's/^/    /'
  fi
done
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
TESTED="$(grep -c 'Тестирование:' "$LOG" 2>/dev/null || echo 0)"
NOT_STARTED="$(grep -c 'процесс не запустился' "$LOG" 2>/dev/null || echo 0)"
PORT_BUSY="$(grep -c 'не доступен\|занят другим процессом' "$LOG" 2>/dev/null || echo 0)"
FAILED_CHECK="$(grep -c 'не прошла проверку соединения' "$LOG" 2>/dev/null || echo 0)"
WORKED="$(grep -c 'работает!' "$LOG" 2>/dev/null || echo 0)"
ALL_FAILED="$(grep -c 'Ни одна стратегия не сработала\|стратегий не сработали' "$LOG" 2>/dev/null || echo 0)"

printf 'strategies announced:        %s\n' "$TESTED"
printf 'false "не запустился":        %s   <-- must be ~0 after the fix\n' "$NOT_STARTED"
printf 'port unavailable/busy:       %s\n' "$PORT_BUSY"
printf 'failed connectivity check:   %s   <-- honest failures, fine\n' "$FAILED_CHECK"
printf 'strategy accepted:           %s\n' "$WORKED"
printf 'gave up entirely:            %s\n' "$ALL_FAILED"
printf 'peak concurrent tpws:        %s   <-- must never exceed 1\n' "$PEAK_TPWS"

echo
echo "--- 6. which probe rejected each strategy ---"
grep -E 'не прошли проверку' "$LOG" | sed 's/^/    /' | sort | uniq -c | sort -rn | head -10
echo

echo "--- 7. cleanup check ---"
kill "$APP_PID" 2>/dev/null
sleep 3
LEAKED="$(pgrep -x tpws | wc -l | tr -d ' ')"
printf 'tpws still alive after quit:  %s   <-- must be 0\n' "$LEAKED"
printf 'pf status:                    %s\n' "$(sudo pfctl -s info 2>/dev/null | head -1 || echo 'skipped (no sudo)')"
printf 'system SOCKS proxy:           %s\n' "$(networksetup -getsocksfirewallproxy Wi-Fi 2>/dev/null | head -1)"
[ "$LEAKED" != "0" ] && pkill -x tpws 2>/dev/null

echo
echo "Full log kept at: $LOG"
echo "Send that file back along with the numbers above."

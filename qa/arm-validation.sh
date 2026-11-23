set -euo pipefail
sw_vers
sysctl -n machdep.cpu.brand_string
for v in 2.0.20 2.0.23 2.0.33; do
  file="UnblockPro-$v-mac-arm64.zip"
  gh release download "v$v" -R by-sonic/unblock-pro -p "$file" -D "$RUNNER_TEMP"
  sha=$(gh release view "v$v" -R by-sonic/unblock-pro --json assets --jq ".assets[] | select(.name==\"$file\") | .digest")
  test "sha256:$(shasum -a 256 "$RUNNER_TEMP/$file" | cut -d' ' -f1)" = "$sha"
  binary="$RUNNER_TEMP/tpws-$v"
  unzip -p "$RUNNER_TEMP/$file" '*/Contents/Resources/bin/tpws' > "$binary"
  chmod +x "$binary"
  file "$binary"
  if [ "$v" = "2.0.20" ]; then
    if node scripts/check-mac-runtime.js "$binary"; then echo "$v ordinary DNS smoke passed"; else echo "$v ordinary DNS smoke failed"; fi
  elif [ "$v" = "2.0.33" ]; then
    node scripts/check-mac-runtime.js "$binary"
  fi
  if [ "$v" != "2.0.23" ]; then
    "$binary" --socks --bind-addr=127.0.0.1 --port=38485 >"$RUNNER_TEMP/tpws.log" 2>&1 &
    proc=$!
    trap 'kill "$proc" 2>/dev/null || true' EXIT
    if curl --retry 2 --retry-all-errors --max-time 15 -fsS --socks5-hostname 127.0.0.1:38485 https://raw.githubusercontent.com/by-sonic/unblock-pro/28c43e98fe8ab49a759b1351755a548970d0a14d/README.md -o "$RUNNER_TEMP/received-$v.md" && cmp README.md "$RUNNER_TEMP/received-$v.md"; then
      echo "$v remote-DNS retrieval of the pinned project README matched byte for byte"
    else
      echo "$v remote-DNS retrieval failed"
      cat "$RUNNER_TEMP/tpws.log"
      test "$v" = "2.0.20"
    fi
    if ! kill "$proc" 2>/dev/null; then
      status=0
      wait "$proc" || status=$?
      echo "$v runtime exited before teardown: $status"
    fi
    wait "$proc" || true
    trap - EXIT
  fi
  if [ "$v" = "2.0.23" ] || [ "$v" = "2.0.33" ]; then
    if [ "$v" = "2.0.23" ]; then
      curl -fsS https://raw.githubusercontent.com/by-sonic/unblock-pro/v2.0.23/src/main/main.js -o "$RUNNER_TEMP/main-2.0.23.js"
    fi
    QA_RELEASE="$v" python3 qa/strategies.py
  fi
done

'use strict';

const path = require('path');

// The macOS runtime is compiled from zapret source. This is the one place that
// says which source.
//
// Why pin: the Windows runtime is pinned to a Flowseal release and verified against
// a SHA256, but the macOS path used to download whatever `releases/latest`
// happened to be that day — no version pin, no integrity check. Two users could
// end up compiling different tpws builds, and the macOS strategy list in main.js
// was authored and validated against neither. Pinning to a commit makes the
// source tree content-addressed, so the commit id *is* the integrity guarantee.
//
// This is the same commit CI builds, so a locally compiled runtime and a shipped
// one are the same code.
//
// .github/workflows/upstream-update.yml proposes a new pin (as a PR, never at
// run time) when upstream changes tpws/; the block below is rewritten by
// scripts/update-upstream.js.
// upstream-pin:start
// 2026-09-18: upstream stopped forcing a 32 KiB resolver-thread stack on macOS
// after reports of stack-size crashes. Keep the default OS stack size instead.
// https://github.com/bol-van/zapret/commit/d437963452674faadfd45adcd62466272b5a2fcd
const ZAPRET_MACOS_COMMIT = 'd437963452674faadfd45adcd62466272b5a2fcd';
// upstream-pin:end

// codeload serves the source zip for an exact commit. The archive expands to
// zapret-<commit>/, which is why callers look for a directory starting with
// "zapret-".
const ZAPRET_MACOS_ARCHIVE_URL =
  `https://codeload.github.com/bol-van/zapret/zip/${ZAPRET_MACOS_COMMIT}`;

// Our changes on top of that commit, applied with `patch -p1` from the zapret
// root by CI and by the in-app build alike. A patch that no longer applies to a
// new upstream commit fails the build instead of shipping tpws without it.
//
// tpws-socks4a.patch: upstream tpws refuses SOCKS4a. Firefox maps the macOS
// system "SOCKS" proxy to SOCKS v4 and, with its default remote-DNS setting,
// sends hostnames that way, so almost every site failed in Firefox (#81).
const TPWS_PATCHES = Object.freeze([
  path.join(__dirname, 'patches', 'tpws-socks4a.patch')
]);

module.exports = {
  TPWS_PATCHES,
  ZAPRET_MACOS_ARCHIVE_URL,
  ZAPRET_MACOS_COMMIT
};

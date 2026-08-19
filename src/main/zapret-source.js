'use strict';

// The macOS runtime is compiled from zapret source. This is the one place that
// says which source.
//
// Why pin: the Windows runtime is pinned to Flowseal 1.9.9c and verified against
// a SHA256, but the macOS path used to download whatever `releases/latest`
// happened to be that day — no version pin, no integrity check. Two users could
// end up compiling different tpws builds, and the macOS strategy list in main.js
// was authored and validated against neither. Pinning to a commit makes the
// source tree content-addressed, so the commit id *is* the integrity guarantee.
//
// This is the same commit CI builds, so a locally compiled runtime and a shipped
// one are the same code.
const ZAPRET_MACOS_COMMIT = '1a1fc38c8ea05b481eebcbd338df48cdcca23c15';

// codeload serves the source zip for an exact commit. The archive expands to
// zapret-<commit>/, which is why callers look for a directory starting with
// "zapret-".
const ZAPRET_MACOS_ARCHIVE_URL =
  `https://codeload.github.com/bol-van/zapret/zip/${ZAPRET_MACOS_COMMIT}`;

module.exports = {
  ZAPRET_MACOS_ARCHIVE_URL,
  ZAPRET_MACOS_COMMIT
};

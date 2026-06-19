'use strict';

// Resilient file copy for Windows binary installation.
//
// Background: when binaries are (re)downloaded while the WinDivert kernel
// driver is loaded (the engine winws.exe is running, a stale driver from a
// crashed session is still mapped, or another DPI-bypass tool holds it), the
// destination WinDivert64.sys is locked by the OS and fs.copyFileSync throws
// `EBUSY: resource busy or locked`. Re-installing or updating does not help,
// because that does not unload the driver and the copy always tries to
// overwrite the locked file.
//
// The Windows bundle is pinned and checksum-verified, so when a destination
// file already exists it is byte-identical to the source — overwriting it is
// unnecessary. This helper therefore:
//   1. skips the copy entirely when the destination is already identical;
//   2. retries a few times on transient lock errors;
//   3. treats an exhausted lock as non-fatal IF a usable file is already in
//      place (the in-place driver is the correct one);
//   4. only throws when the file is genuinely missing or the error is not a
//      lock (e.g. ENOSPC, EROFS).

const fs = require('node:fs');
const crypto = require('node:crypto');

// Windows / POSIX error codes that mean "the file is locked / in use" rather
// than a genuine I/O failure.
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ETXTBSY']);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function filesIdentical(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (!sa.isFile() || !sb.isFile()) return false;
    if (sa.size !== sb.size) return false;
    return sha256(a) === sha256(b);
  } catch (e) {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Copy `src` to `dest`, tolerating the WinDivert-driver-locked case.
 *
 * @returns {Promise<'skipped-identical'|'copied'|'copied-after-retry'|'skipped-locked'>}
 * @throws  when the error is not a lock, or when the file is locked AND no
 *          usable copy already exists at `dest`.
 */
async function copyFileResilient(src, dest, opts = {}) {
  const {
    retries = 5,
    delayMs = 300,
    copyImpl = fs.copyFileSync,
    existsImpl = fs.existsSync,
    identicalImpl = filesIdentical,
    sleep = delay,
  } = opts;

  // Nothing to do — the correct file is already in place.
  if (existsImpl(dest) && identicalImpl(src, dest)) {
    return 'skipped-identical';
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      copyImpl(src, dest);
      return attempt === 0 ? 'copied' : 'copied-after-retry';
    } catch (err) {
      lastErr = err;
      // A genuine, non-lock error — fail immediately, do not retry.
      if (!LOCK_CODES.has(err.code)) throw err;
      if (attempt < retries) {
        await sleep(delayMs);
      }
    }
  }

  // The file stayed locked through every retry. If a usable file is already at
  // the destination (e.g. the currently loaded, identical driver), this is not
  // fatal — the app can run with what is in place.
  if (existsImpl(dest)) {
    return 'skipped-locked';
  }

  throw lastErr;
}

module.exports = { copyFileResilient, filesIdentical, LOCK_CODES };

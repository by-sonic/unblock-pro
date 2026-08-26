'use strict';

// Checks the Windows bypass runtime against a trusted reference before it is
// executed with administrator rights.
//
// The engine lives in %APPDATA%\unblock-pro\bin\win32 — a directory any
// unprivileged process running as the same user can write to — and every
// "Подключить" runs it elevated. Nothing on that path re-checked the files: the
// SHA-256 was verified once, when the bundle was downloaded, and never again.
// Replace winws.exe (or WinDivert64.sys) once and the replacement is executed as
// administrator on every connect, however many UAC prompts the user confirms
// (#53).
//
// The reference is the copy shipped inside the installed application. The
// Windows installer is perMachine, so that directory lives under Program Files
// and an unprivileged process cannot write to it — while the runtime directory
// beside it can be rewritten by anyone. Comparing one against the other turns a
// silent substitution into a repair.
//
// Deliberately not the whole answer: a portable build and a dev checkout have no
// admin-only reference, and there `hasReference` is false. Say so rather than
// implying a guarantee that is not there.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fileState(file) {
  try {
    if (!fs.statSync(file).isFile()) return { present: false, hash: null };
    return { present: true, hash: sha256(file) };
  } catch (e) {
    return { present: false, hash: null };
  }
}

// Compares each required file with the reference copy.
//
// Returns:
//   hasReference — false when there is no trusted copy to compare against
//   ok           — every file present and identical
//   mismatched   — files that differ from the reference
//   missing      — files absent from the runtime directory
//   unreferenced — files the reference itself does not have (cannot be judged)
function verifyRuntimeAgainstReference(runtimeDir, referenceDir, files) {
  const result = { hasReference: false, ok: false, mismatched: [], missing: [], unreferenced: [] };

  if (!runtimeDir || !referenceDir) return result;
  try {
    if (!fs.statSync(referenceDir).isDirectory()) return result;
  } catch (e) {
    return result;
  }

  for (const file of files) {
    const reference = fileState(path.join(referenceDir, file));
    if (!reference.present) {
      result.unreferenced.push(file);
      continue;
    }
    result.hasReference = true;

    const runtime = fileState(path.join(runtimeDir, file));
    if (!runtime.present) {
      result.missing.push(file);
    } else if (runtime.hash !== reference.hash) {
      result.mismatched.push(file);
    }
  }

  result.ok = result.hasReference && result.mismatched.length === 0 && result.missing.length === 0;
  return result;
}

// Puts the reference copies back. Used when verification failed: the runtime
// directory is a cache, so restoring it is always the right move — the file that
// belongs there is the one shipped with the app.
//
// `copyFile` is injected so the caller can pass the resilient copy used for the
// WinDivert driver, which can be locked while a previous engine is unloading.
async function repairRuntimeFromReference(runtimeDir, referenceDir, files, { copyFile } = {}) {
  const copy = copyFile || (async (src, dest) => { fs.copyFileSync(src, dest); });
  const repaired = [];
  const failed = [];

  fs.mkdirSync(runtimeDir, { recursive: true });

  for (const file of files) {
    const source = path.join(referenceDir, file);
    if (!fileState(source).present) continue;

    try {
      await copy(source, path.join(runtimeDir, file));
      repaired.push(file);
    } catch (e) {
      failed.push({ file, error: e.message });
    }
  }

  return { repaired, failed };
}

// One line for the log and the error message. Names the files, because "проверка
// целостности не пройдена" without them is unactionable.
function describeIntegrityFailure(result) {
  const parts = [];
  if (result.mismatched.length > 0) parts.push(`изменены: ${result.mismatched.join(', ')}`);
  if (result.missing.length > 0) parts.push(`отсутствуют: ${result.missing.join(', ')}`);
  return parts.join('; ');
}

module.exports = {
  describeIntegrityFailure,
  repairRuntimeFromReference,
  verifyRuntimeAgainstReference
};

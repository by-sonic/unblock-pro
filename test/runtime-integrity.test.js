'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  describeIntegrityFailure,
  repairRuntimeFromReference,
  verifyRuntimeAgainstReference
} = require('../src/main/runtime-integrity');

const FILES = ['winws.exe', 'WinDivert64.sys', 'WinDivert.dll'];

function dirs(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-integrity-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const reference = path.join(base, 'reference');
  const runtime = path.join(base, 'runtime');
  fs.mkdirSync(reference, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });

  for (const file of FILES) {
    fs.writeFileSync(path.join(reference, file), `genuine ${file}`);
    fs.writeFileSync(path.join(runtime, file), `genuine ${file}`);
  }

  return { base, reference, runtime };
}

test('an untouched runtime passes', (t) => {
  const { runtime, reference } = dirs(t);

  const result = verifyRuntimeAgainstReference(runtime, reference, FILES);

  assert.equal(result.ok, true);
  assert.equal(result.hasReference, true);
  assert.deepEqual(result.mismatched, []);
});

test('a swapped engine is caught', (t) => {
  const { runtime, reference } = dirs(t);
  fs.writeFileSync(path.join(runtime, 'winws.exe'), 'malicious payload');

  const result = verifyRuntimeAgainstReference(runtime, reference, FILES);

  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatched, ['winws.exe']);
});

test('a swapped driver is caught too — not just the executable', (t) => {
  const { runtime, reference } = dirs(t);
  fs.writeFileSync(path.join(runtime, 'WinDivert64.sys'), 'rootkit');

  const result = verifyRuntimeAgainstReference(runtime, reference, FILES);

  assert.deepEqual(result.mismatched, ['WinDivert64.sys']);
});

test('a file of the same size but different content is caught', (t) => {
  const { runtime, reference } = dirs(t);
  const genuine = fs.readFileSync(path.join(reference, 'winws.exe'), 'utf8');
  const forged = 'g' + 'e'.repeat(genuine.length - 1);
  assert.equal(forged.length, genuine.length);
  fs.writeFileSync(path.join(runtime, 'winws.exe'), forged);

  assert.deepEqual(verifyRuntimeAgainstReference(runtime, reference, FILES).mismatched, ['winws.exe']);
});

test('a missing file is reported separately from a modified one', (t) => {
  const { runtime, reference } = dirs(t);
  fs.unlinkSync(path.join(runtime, 'WinDivert.dll'));

  const result = verifyRuntimeAgainstReference(runtime, reference, FILES);

  assert.deepEqual(result.missing, ['WinDivert.dll']);
  assert.deepEqual(result.mismatched, []);
  assert.equal(result.ok, false);
});

test('without a reference the check claims nothing', (t) => {
  const { runtime, base } = dirs(t);

  const result = verifyRuntimeAgainstReference(runtime, path.join(base, 'absent'), FILES);

  assert.equal(result.hasReference, false);
  assert.equal(result.ok, false, 'нет эталона — нет и подтверждения целостности');
});

test('a file the reference does not carry cannot be judged', (t) => {
  const { runtime, reference } = dirs(t);
  fs.writeFileSync(path.join(runtime, 'extra.bin'), 'whatever');

  const result = verifyRuntimeAgainstReference(runtime, reference, [...FILES, 'extra.bin']);

  assert.deepEqual(result.unreferenced, ['extra.bin']);
  assert.equal(result.ok, true, 'остальные файлы всё ещё проверены');
});

test('a directory in place of a file is not mistaken for one', (t) => {
  const { runtime, reference } = dirs(t);
  fs.unlinkSync(path.join(runtime, 'winws.exe'));
  fs.mkdirSync(path.join(runtime, 'winws.exe'));

  assert.deepEqual(verifyRuntimeAgainstReference(runtime, reference, FILES).missing, ['winws.exe']);
});

test('repair restores the reference copies and verification then passes', async (t) => {
  const { runtime, reference } = dirs(t);
  fs.writeFileSync(path.join(runtime, 'winws.exe'), 'malicious payload');
  fs.unlinkSync(path.join(runtime, 'WinDivert.dll'));

  const { repaired, failed } = await repairRuntimeFromReference(runtime, reference, FILES);

  assert.deepEqual(failed, []);
  assert.deepEqual(repaired.sort(), FILES.slice().sort());
  assert.equal(verifyRuntimeAgainstReference(runtime, reference, FILES).ok, true);
  assert.equal(fs.readFileSync(path.join(runtime, 'winws.exe'), 'utf8'), 'genuine winws.exe');
});

test('repair recreates the runtime directory when it is gone', async (t) => {
  const { runtime, reference } = dirs(t);
  fs.rmSync(runtime, { recursive: true, force: true });

  await repairRuntimeFromReference(runtime, reference, FILES);

  assert.equal(verifyRuntimeAgainstReference(runtime, reference, FILES).ok, true);
});

test('a locked file is reported instead of silently skipped', async (t) => {
  const { runtime, reference } = dirs(t);
  const copyFile = async (src, dest) => {
    if (dest.endsWith('WinDivert64.sys')) {
      const err = new Error('EBUSY: resource busy or locked');
      err.code = 'EBUSY';
      throw err;
    }
    fs.copyFileSync(src, dest);
  };

  const { repaired, failed } = await repairRuntimeFromReference(runtime, reference, FILES, { copyFile });

  assert.equal(failed.length, 1);
  assert.equal(failed[0].file, 'WinDivert64.sys');
  assert.ok(repaired.includes('winws.exe'));
});

test('the failure description names the files, so the message is actionable', () => {
  const text = describeIntegrityFailure({ mismatched: ['winws.exe'], missing: ['WinDivert.dll'] });

  assert.match(text, /изменены: winws\.exe/);
  assert.match(text, /отсутствуют: WinDivert\.dll/);
});

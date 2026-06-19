'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { copyFileResilient, filesIdentical } = require('../src/main/safe-copy');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-pro-copy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lockError() {
  const err = new Error("EBUSY: resource busy or locked, copyfile 'WinDivert64.sys'");
  err.code = 'EBUSY';
  return err;
}

test('copies when destination is missing', async (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'src.sys');
  const dest = path.join(dir, 'dest.sys');
  fs.writeFileSync(src, 'driver-bytes');

  const result = await copyFileResilient(src, dest);

  assert.equal(result, 'copied');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'driver-bytes');
});

test('skips copy when destination is byte-identical (pinned bundle)', async (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'src.sys');
  const dest = path.join(dir, 'dest.sys');
  fs.writeFileSync(src, 'same-bytes');
  fs.writeFileSync(dest, 'same-bytes');

  // copyImpl must never run when the files are already identical — this is the
  // core fix: a locked-but-identical WinDivert64.sys must not be touched.
  const result = await copyFileResilient(src, dest, {
    copyImpl: () => { throw new Error('copyImpl should not be called'); },
  });

  assert.equal(result, 'skipped-identical');
});

test('overwrites when destination differs', async (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'src.sys');
  const dest = path.join(dir, 'dest.sys');
  fs.writeFileSync(src, 'new-version');
  fs.writeFileSync(dest, 'old-version');

  const result = await copyFileResilient(src, dest);

  assert.equal(result, 'copied');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'new-version');
});

test('retries on EBUSY and succeeds once the lock clears', async (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'src.sys');
  const dest = path.join(dir, 'dest.sys');
  fs.writeFileSync(src, 'driver-bytes');

  let calls = 0;
  const result = await copyFileResilient(src, dest, {
    delayMs: 0,
    copyImpl: (s, d) => {
      calls += 1;
      if (calls < 3) throw lockError();
      fs.copyFileSync(s, d);
    },
  });

  assert.equal(result, 'copied-after-retry');
  assert.equal(calls, 3);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'driver-bytes');
});

test('locked but a usable file already in place is non-fatal', async (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'src.sys');
  const dest = path.join(dir, 'dest.sys');
  fs.writeFileSync(src, 'new-bytes');
  fs.writeFileSync(dest, 'in-place-but-locked'); // different, but present

  const result = await copyFileResilient(src, dest, {
    retries: 2,
    delayMs: 0,
    copyImpl: () => { throw lockError(); },
  });

  assert.equal(result, 'skipped-locked');
});

test('locked AND no file in place throws', async (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'src.sys');
  const dest = path.join(dir, 'dest.sys');
  fs.writeFileSync(src, 'new-bytes');

  await assert.rejects(
    copyFileResilient(src, dest, {
      retries: 2,
      delayMs: 0,
      copyImpl: () => { throw lockError(); },
    }),
    /EBUSY/,
  );
});

test('non-lock errors fail immediately without retry', async (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'src.sys');
  const dest = path.join(dir, 'dest.sys');
  fs.writeFileSync(src, 'bytes');

  let calls = 0;
  await assert.rejects(
    copyFileResilient(src, dest, {
      delayMs: 0,
      copyImpl: () => {
        calls += 1;
        const err = new Error('ENOSPC: no space left on device');
        err.code = 'ENOSPC';
        throw err;
      },
    }),
    /ENOSPC/,
  );
  assert.equal(calls, 1);
});

test('filesIdentical compares content, not just size', (t) => {
  const dir = tmpDir(t);
  const a = path.join(dir, 'a');
  const b = path.join(dir, 'b');
  const c = path.join(dir, 'c');
  fs.writeFileSync(a, 'AAAA');
  fs.writeFileSync(b, 'AAAA');
  fs.writeFileSync(c, 'BBBB'); // same size, different bytes

  assert.equal(filesIdentical(a, b), true);
  assert.equal(filesIdentical(a, c), false);
  assert.equal(filesIdentical(a, path.join(dir, 'missing')), false);
});

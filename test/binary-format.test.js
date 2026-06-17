'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { isMachOBinary } = require('../src/main/binary-format');

test('distinguishes Mach-O binaries from Linux ELF files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-pro-format-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const universal = path.join(dir, 'universal');
  const arm64 = path.join(dir, 'arm64');
  const elf = path.join(dir, 'elf');
  fs.writeFileSync(universal, Buffer.from('cafebabe00000000', 'hex'));
  fs.writeFileSync(arm64, Buffer.from('cffaedfe00000000', 'hex'));
  fs.writeFileSync(elf, Buffer.from('7f454c4600000000', 'hex'));

  assert.equal(isMachOBinary(universal), true);
  assert.equal(isMachOBinary(arm64), true);
  assert.equal(isMachOBinary(elf), false);
  assert.equal(isMachOBinary(path.join(dir, 'missing')), false);
});

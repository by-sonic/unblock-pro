'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CPU_TYPE_ARM64,
  CPU_TYPE_X86_64,
  getMachOCpuTypes,
  isMachOBinary,
  isMachOBinaryRunnable
} = require('../src/main/binary-format');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-pro-format-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 64-bit thin Mach-O: little-endian magic followed by cputype.
function writeThin(filePath, cpuType) {
  const buf = Buffer.alloc(32);
  buf.write('cffaedfe', 0, 'hex');
  buf.writeInt32LE(cpuType | 0, 4);
  fs.writeFileSync(filePath, buf);
}

// Universal (fat) Mach-O header: big-endian magic, arch count, then 20-byte
// fat_arch entries each starting with cputype.
function writeFat(filePath, cpuTypes) {
  const buf = Buffer.alloc(8 + cpuTypes.length * 20);
  buf.write('cafebabe', 0, 'hex');
  buf.writeUInt32BE(cpuTypes.length, 4);
  cpuTypes.forEach((cpuType, i) => buf.writeUInt32BE(cpuType >>> 0, 8 + i * 20));
  fs.writeFileSync(filePath, buf);
}

test('distinguishes Mach-O binaries from Linux ELF files', (t) => {
  const dir = tempDir(t);

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

test('reads the CPU types of thin and universal binaries', (t) => {
  const dir = tempDir(t);

  const thinArm = path.join(dir, 'thin-arm64');
  const thinIntel = path.join(dir, 'thin-x64');
  const fat = path.join(dir, 'fat');
  writeThin(thinArm, CPU_TYPE_ARM64);
  writeThin(thinIntel, CPU_TYPE_X86_64);
  writeFat(fat, [CPU_TYPE_X86_64, CPU_TYPE_ARM64]);

  assert.deepEqual(getMachOCpuTypes(thinArm), [CPU_TYPE_ARM64]);
  assert.deepEqual(getMachOCpuTypes(thinIntel), [CPU_TYPE_X86_64]);
  assert.deepEqual(getMachOCpuTypes(fat), [CPU_TYPE_X86_64, CPU_TYPE_ARM64]);
  assert.deepEqual(getMachOCpuTypes(path.join(dir, 'missing')), []);
});

test('rejects an arm64-only binary on an Intel Mac', (t) => {
  // The #39 regression: magic bytes alone accepted this, then spawn() failed at
  // exec time and the crash surfaced as "с ошибкой: null".
  const dir = tempDir(t);
  const armOnly = path.join(dir, 'tpws-arm64');
  writeThin(armOnly, CPU_TYPE_ARM64);

  assert.equal(isMachOBinary(armOnly), true, 'still a valid Mach-O file');
  assert.equal(isMachOBinaryRunnable(armOnly, 'x64'), false, 'but not runnable on Intel');
  assert.equal(isMachOBinaryRunnable(armOnly, 'arm64'), true);
});

test('accepts an x86_64-only binary on Apple Silicon via Rosetta', (t) => {
  const dir = tempDir(t);
  const intelOnly = path.join(dir, 'tpws-x64');
  writeThin(intelOnly, CPU_TYPE_X86_64);

  assert.equal(isMachOBinaryRunnable(intelOnly, 'arm64'), true);
  assert.equal(isMachOBinaryRunnable(intelOnly, 'x64'), true);
});

test('accepts a universal binary on both architectures', (t) => {
  const dir = tempDir(t);
  const fat = path.join(dir, 'tpws-universal');
  writeFat(fat, [CPU_TYPE_X86_64, CPU_TYPE_ARM64]);

  assert.equal(isMachOBinaryRunnable(fat, 'x64'), true);
  assert.equal(isMachOBinaryRunnable(fat, 'arm64'), true);
});

test('rejects non-Mach-O and corrupt headers', (t) => {
  const dir = tempDir(t);

  const elf = path.join(dir, 'elf');
  fs.writeFileSync(elf, Buffer.from('7f454c4600000000', 'hex'));
  assert.equal(isMachOBinaryRunnable(elf, 'arm64'), false);

  // Fat header claiming an implausible number of slices must not be trusted.
  const bogus = path.join(dir, 'bogus-fat');
  const buf = Buffer.alloc(8);
  buf.write('cafebabe', 0, 'hex');
  buf.writeUInt32BE(0xffff, 4);
  fs.writeFileSync(bogus, buf);
  assert.deepEqual(getMachOCpuTypes(bogus), []);
  assert.equal(isMachOBinaryRunnable(bogus, 'arm64'), false);
});

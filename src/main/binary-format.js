'use strict';

const fs = require('fs');

// Mach-O magics, little- and big-endian, thin and fat (universal).
const MACH_O_MAGICS = new Set([
  'cffaedfe',
  'feedfacf',
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca'
]);

const FAT_MAGICS = new Set(['cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);

// mach/machine.h
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

const ARCH_TO_CPU_TYPE = {
  x64: CPU_TYPE_X86_64,
  arm64: CPU_TYPE_ARM64
};

function readHeader(filePath, length) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, 0);
    return read === length ? buf : null;
  } finally {
    fs.closeSync(fd);
  }
}

function isMachOBinary(filePath) {
  try {
    const header = readHeader(filePath, 4);
    if (!header) return false;
    return MACH_O_MAGICS.has(header.toString('hex'));
  } catch (e) {
    return false;
  }
}

// The CPU types a Mach-O file can actually run as. A thin binary yields one
// entry; a universal ("fat") binary yields one per slice.
//
// Needed because a magic-bytes-only check accepts an arm64-only binary on an
// Intel Mac. spawn() then fails at exec time with a null exit code, which
// surfaced to users as "Процесс обхода завершился с ошибкой: null".
function getMachOCpuTypes(filePath) {
  try {
    const magicBuf = readHeader(filePath, 4);
    if (!magicBuf) return [];
    const magic = magicBuf.toString('hex');
    if (!MACH_O_MAGICS.has(magic)) return [];

    if (!FAT_MAGICS.has(magic)) {
      // Thin binary: cputype is the 32-bit field right after the magic.
      const thin = readHeader(filePath, 8);
      if (!thin) return [];
      // 'cffaedfe' / 'cefaedfe' are little-endian on disk; 'feedfacf' is big-endian.
      const littleEndian = magic === 'cffaedfe' || magic === 'cefaedfe';
      const cpuType = littleEndian ? thin.readInt32LE(4) : thin.readInt32BE(4);
      return [cpuType >>> 0];
    }

    // Fat binary: big-endian header, nfat_arch at offset 4, then 20-byte
    // (fat_arch) or 32-byte (fat_arch_64) entries starting with cputype.
    const is64 = magic === 'cafebabf' || magic === 'bfbafeca';
    const entrySize = is64 ? 32 : 20;
    const countBuf = readHeader(filePath, 8);
    if (!countBuf) return [];
    const count = countBuf.readUInt32BE(4);
    // Guard against a corrupt/hostile header claiming a huge arch count.
    if (count === 0 || count > 32) return [];

    const table = readHeader(filePath, 8 + count * entrySize);
    if (!table) return [];

    const cpuTypes = [];
    for (let i = 0; i < count; i++) {
      cpuTypes.push(table.readUInt32BE(8 + i * entrySize));
    }
    return cpuTypes;
  } catch (e) {
    return [];
  }
}

// True when the binary contains a slice for the given Node/Electron arch.
// Rosetta 2 can run x64 on arm64, so an x86_64-only binary is accepted on
// Apple Silicon; the reverse never works.
function isMachOBinaryRunnable(filePath, arch = process.arch) {
  const cpuTypes = getMachOCpuTypes(filePath);
  if (cpuTypes.length === 0) return false;

  const required = ARCH_TO_CPU_TYPE[arch];
  // Unknown arch (e.g. a future one): fall back to the magic-only check rather
  // than refusing to run.
  if (!required) return true;

  if (cpuTypes.includes(required)) return true;
  return arch === 'arm64' && cpuTypes.includes(CPU_TYPE_X86_64);
}

module.exports = {
  CPU_TYPE_ARM64,
  CPU_TYPE_X86_64,
  getMachOCpuTypes,
  isMachOBinary,
  isMachOBinaryRunnable
};

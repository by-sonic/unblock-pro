'use strict';

const fs = require('fs');

const MACH_O_MAGICS = new Set([
  'cffaedfe',
  'feedfacf',
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca'
]);

function isMachOBinary(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(4);
      if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) return false;
      return MACH_O_MAGICS.has(header.toString('hex'));
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return false;
  }
}

module.exports = { isMachOBinary };

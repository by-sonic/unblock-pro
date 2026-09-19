'use strict';

const path = require('node:path');
const { probeSocksRuntime } = require('../src/main/mac-runtime');

const binary = path.resolve(process.argv[2] || 'bin/darwin/tpws');
probeSocksRuntime(binary).then((result) => {
  console.log(JSON.stringify({ binary, arch: process.arch, ...result }, null, 2));
  if (!result.ok) process.exitCode = 1;
}).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  FLOWSEAL_BUNDLE_MARKER,
  FLOWSEAL_BUNDLE_SHA256,
  FLOWSEAL_BUNDLE_URL,
  FLOWSEAL_BUNDLE_VERSION,
  FLOWSEAL_REQUIRED_WINDOWS_FILES
} = require('../src/main/flowseal-bundle');
const { isMachOBinary } = require('../src/main/binary-format');

const ZAPRET_MACOS_COMMIT = '1a1fc38c8ea05b481eebcbd338df48cdcca23c15';
const repoRoot = path.join(__dirname, '..');
const binRoot = path.join(repoRoot, 'bin');
const tempRoot = path.join(repoRoot, 'temp', 'runtime-build');

function download(url, destination, redirects = 5) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'UnblockPro' } }, (response) => {
      if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location && redirects > 0) {
        response.resume();
        download(response.headers.location, destination, redirects - 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    request.on('error', reject);
  });
}

function resetTempDir() {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });
}

async function buildWindowsRuntime() {
  const archive = path.join(tempRoot, 'flowseal.zip');
  const extractDir = path.join(tempRoot, 'flowseal');
  const destination = path.join(binRoot, 'win32');
  await download(FLOWSEAL_BUNDLE_URL, archive);

  const hash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (hash !== FLOWSEAL_BUNDLE_SHA256) {
    throw new Error(`Flowseal checksum mismatch: ${hash}`);
  }

  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
  ], { stdio: 'inherit' });

  const source = path.join(extractDir, `zapret-discord-youtube-${FLOWSEAL_BUNDLE_VERSION}`, 'bin');
  fs.mkdirSync(destination, { recursive: true });
  for (const file of FLOWSEAL_REQUIRED_WINDOWS_FILES) {
    fs.copyFileSync(path.join(source, file), path.join(destination, file));
  }
  fs.writeFileSync(path.join(destination, FLOWSEAL_BUNDLE_MARKER), FLOWSEAL_BUNDLE_VERSION, 'utf8');
  console.log(`Windows runtime ${FLOWSEAL_BUNDLE_VERSION}: ${destination}`);
}

function buildMacRuntime() {
  if (process.platform !== 'darwin') {
    throw new Error('The macOS runtime must be compiled on macOS with Xcode Command Line Tools.');
  }

  const source = path.join(tempRoot, 'zapret');
  const destination = path.join(binRoot, 'darwin', 'tpws');
  fs.mkdirSync(source, { recursive: true });
  execFileSync('git', ['init'], { cwd: source, stdio: 'inherit' });
  execFileSync('git', ['fetch', '--depth', '1', 'https://github.com/bol-van/zapret.git', ZAPRET_MACOS_COMMIT], {
    cwd: source,
    stdio: 'inherit'
  });
  execFileSync('git', ['checkout', '--detach', 'FETCH_HEAD'], { cwd: source, stdio: 'inherit' });
  execFileSync('make', ['-C', path.join(source, 'tpws'), 'mac'], {
    stdio: 'inherit',
    env: { ...process.env, OPTIMIZE: '-O2' }
  });

  const compiled = path.join(source, 'tpws', 'tpws');
  if (!isMachOBinary(compiled)) throw new Error('Compiled tpws is not a Mach-O binary');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(compiled, destination);
  fs.chmodSync(destination, 0o755);
  console.log(`macOS universal runtime ${ZAPRET_MACOS_COMMIT}: ${destination}`);
}

async function main() {
  resetTempDir();
  const target = process.argv[2] || process.platform;
  if (target === 'win32') await buildWindowsRuntime();
  else if (target === 'darwin') buildMacRuntime();
  else throw new Error(`Unsupported target: ${target}`);
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

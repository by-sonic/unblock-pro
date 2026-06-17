'use strict';

const fs = require('fs');
const path = require('path');

const FLOWSEAL_BUNDLE_VERSION = '1.9.9c';
const FLOWSEAL_BUNDLE_URL = `https://github.com/Flowseal/zapret-discord-youtube/releases/download/${FLOWSEAL_BUNDLE_VERSION}/zapret-discord-youtube-${FLOWSEAL_BUNDLE_VERSION}.zip`;
const FLOWSEAL_BUNDLE_SHA256 = '6064e4b26ed7358961a0b978fbb6263b119d8d7a5a06bb4a6454aeb855cf63e9';
const FLOWSEAL_BUNDLE_MARKER = 'flowseal-bundle-version.txt';

const FLOWSEAL_REQUIRED_WINDOWS_FILES = [
  'winws.exe',
  'WinDivert.dll',
  'WinDivert64.sys',
  'cygwin1.dll',
  'quic_initial_dbankcloud_ru.bin',
  'quic_initial_www_google_com.bin',
  'stun.bin',
  'tls_clienthello_4pda_to.bin',
  'tls_clienthello_max_ru.bin',
  'tls_clienthello_www_google_com.bin'
];

function isFlowsealBundleCurrent(platformDir) {
  try {
    const marker = fs.readFileSync(path.join(platformDir, FLOWSEAL_BUNDLE_MARKER), 'utf8').trim();
    return marker === FLOWSEAL_BUNDLE_VERSION &&
      FLOWSEAL_REQUIRED_WINDOWS_FILES.every((file) => fs.existsSync(path.join(platformDir, file)));
  } catch (e) {
    return false;
  }
}

function installBundledFlowsealBundle(sourceDir, destinationDir) {
  if (!isFlowsealBundleCurrent(sourceDir)) return false;

  fs.mkdirSync(destinationDir, { recursive: true });
  for (const file of [...FLOWSEAL_REQUIRED_WINDOWS_FILES, FLOWSEAL_BUNDLE_MARKER]) {
    fs.copyFileSync(path.join(sourceDir, file), path.join(destinationDir, file));
  }
  return isFlowsealBundleCurrent(destinationDir);
}

module.exports = {
  FLOWSEAL_BUNDLE_MARKER,
  FLOWSEAL_BUNDLE_SHA256,
  FLOWSEAL_BUNDLE_URL,
  FLOWSEAL_BUNDLE_VERSION,
  FLOWSEAL_REQUIRED_WINDOWS_FILES,
  installBundledFlowsealBundle,
  isFlowsealBundleCurrent
};

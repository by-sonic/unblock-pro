'use strict';

const fs = require('fs');
const path = require('path');

const FLOWSEAL_BUNDLE_VERSION = '1.10.4';
const FLOWSEAL_SOURCE_COMMIT = '176f56dc3f11ce5915c26abcdde903f93d835b64';
const FLOWSEAL_BUNDLE_URL = `https://github.com/Flowseal/zapret-discord-youtube/releases/download/${FLOWSEAL_BUNDLE_VERSION}/zapret-discord-youtube-${FLOWSEAL_BUNDLE_VERSION}.zip`;
const FLOWSEAL_BUNDLE_SHA256 = '291af673bd0238506f9548e0e94ca0abf244000f4c9a06960544fb01c5f97b34';
const FLOWSEAL_BUNDLE_MARKER = 'flowseal-bundle-version.txt';

const FLOWSEAL_REQUIRED_WINDOWS_FILES = [
  'winws.exe',
  'WinDivert.dll',
  'WinDivert64.sys',
  'cygwin1.dll',
  'ACTIVE_DISCORD_UDP.bin',
  'ACTIVE_GAME_UDP.bin',
  'quic_initial_4pda_to.bin',
  'quic_initial_5ka_ru.bin',
  'quic_initial_lemana_pro.bin',
  'quic_initial_rutube_ru.bin',
  'quic_initial_steam_chat_com.bin',
  'quic_initial_steamcommunity_com.bin',
  'quic_initial_steamstatic_com.bin',
  'quic_initial_tencent_com.bin',
  'quic_initial_www_google_com.bin',
  'stun.bin',
  'stun2.bin',
  'tls_clienthello_4pda_to.bin',
  'tls_clienthello_5ka_ru.bin',
  'tls_clienthello_awswaf_com.bin',
  'tls_clienthello_max_ru.bin',
  'tls_clienthello_sochi_park.bin',
  'tls_clienthello_steam_chat_com.bin',
  'tls_clienthello_steamstatic_com.bin',
  'tls_clienthello_teamspeak_com.bin',
  'tls_clienthello_www_google_com.bin',
  'tls_clienthello_www_sferum_ru.bin'
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
  FLOWSEAL_SOURCE_COMMIT,
  FLOWSEAL_REQUIRED_WINDOWS_FILES,
  installBundledFlowsealBundle,
  isFlowsealBundleCurrent
};

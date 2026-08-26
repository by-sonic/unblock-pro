const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const { spawn, exec, execFile, execFileSync, execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const dns = require('dns');
const tls = require('tls');
const sudo = require('sudo-prompt');
const { isMachOBinary, isMachOBinaryRunnable } = require('./binary-format');
const {
  collectBlockHostnames,
  hasCurrentBlock,
  isSafeHostsRewrite,
  parsePfEnableToken,
  replaceMarkedBlock
} = require('./system-files');
const { copyFileResilient } = require('./safe-copy');
const {
  describeIntegrityFailure,
  repairRuntimeFromReference,
  verifyRuntimeAgainstReference
} = require('./runtime-integrity');
const {
  describeChildExit,
  hasExited,
  probeBinaryRuns,
  terminateChild,
  waitForPortState,
  waitForStartupWindow
} = require('./process-lifecycle');
const { buildMirrorUrls } = require('./mirror-urls');
const { ZAPRET_MACOS_ARCHIVE_URL, ZAPRET_MACOS_COMMIT } = require('./zapret-source');
const {
  BODY_SAMPLE_BYTES,
  ORDERED_ENDPOINTS,
  PROBE_TIMEOUTS,
  PATIENT_TIMEOUTS,
  REMAINING_ENDPOINTS,
  SCREENING_ENDPOINTS,
  buildPowerShellProbeScript,
  probeKind,
  probeLabel,
  validateProbe
} = require('./connectivity-probes');
const {
  FLOWSEAL_BUNDLE_MARKER,
  FLOWSEAL_BUNDLE_SHA256,
  FLOWSEAL_BUNDLE_URL,
  FLOWSEAL_BUNDLE_VERSION,
  FLOWSEAL_REQUIRED_WINDOWS_FILES,
  installBundledFlowsealBundle,
  isFlowsealBundleCurrent
} = require('./flowseal-bundle');
const {
  FLOWSEAL_AUTO_ORDER,
  buildFlowsealStrategies
} = require('./flowseal-strategies');

dns.setDefaultResultOrder('ipv4first');
const ipv4Lookup = (host, opts, cb) => dns.lookup(host, { family: 4 }, cb);
const { autoUpdater } = require('electron-updater');
const { resolveUpdateMode } = require('./update-mode');

let mainWindow;
let tray;
let proxyProcess = null;
// Incremented for every spawn attempt. A process that dies after the loop has
// moved on must not touch shared state that now belongs to a newer attempt.
let proxyGeneration = 0;
// Makes probe temp-file names unique across concurrent probes.
let probeCounter = 0;
// A strategy search owns the bypass process, the SOCKS port and the system proxy
// for minutes at a time. Two searches running at once fight over all three: each
// kills the other's process and can credit a strategy for traffic the other one
// carried. The generation token cannot help there — both loops share it.
let isSearching = false;
// Set when the user asks to disconnect or quit while a search is running. The
// loop yields on every probe, so without this it would keep spawning processes
// (or commit a "working" strategy, re-enabling the system proxy) after the user
// has already left.
let cancelRequested = false;
// How long winws gets to install its WinDivert filters before it counts as up.
const WINWS_STARTUP_MS = 3000;
let warnedAboutBundledArch = false;
const TPWS_PORT = 1080;
let isConnected = false;
let isDownloading = false;
let currentStrategy = null;
let lastError = null;
let lastErrorCode = null;
let disconnectReason = null;
let connectedSince = null; // timestamp when connected
let strategyProgress = null; // { current: N, total: M, name: '...' }
let logEntries = []; // strategy testing log for UI
let hostListsDir = null; // directory with host list files for strategies

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// ============= SETTINGS =============

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch (e) {}
  return { autoStart: false, autoConnect: false, selectedStrategy: 'auto', lastWorkingStrategy: null, autoUpdate: true };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) {}
}

function applyAutoStart(enabled) {
  if (isDev) return; // Don't set login items in dev mode
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true
  });
}

// The macOS runtime is compiled from a pinned zapret commit — see
// src/main/zapret-source.js for why. Resolving "releases/latest" at runtime
// meant the strategy list was validated against one tpws and users could be
// running another.

function getResourcePath() {
  if (isDev) {
    return path.join(__dirname, '..', '..', 'bin', process.platform);
  }
  // Use writable userData directory instead of app bundle Resources.
  // On macOS, App Translocation makes the .app bundle read-only when
  // the app is downloaded and quarantined, so we can't write to
  // process.resourcesPath. Using userData (~/.../UnblockPro/) is always writable.
  return path.join(app.getPath('userData'), 'bin', process.platform);
}

function getBinDir() {
  if (isDev) {
    return path.join(__dirname, '..', '..', 'bin');
  }
  return path.join(app.getPath('userData'), 'bin');
}

function getBinaryPath() {
  const binDir = getResourcePath();
  
  if (process.platform === 'darwin') {
    // Require a slice for this CPU, not just a valid Mach-O header. A bundle
    // built for the other architecture would otherwise be selected and then
    // fail at exec time with a null exit code.
    if (app.isPackaged) {
      const bundledBinary = path.join(process.resourcesPath, 'bin', 'tpws');
      if (isMachOBinaryRunnable(bundledBinary)) return bundledBinary;
      // getBinaryPath() runs on every status update, so warn only once.
      if (!warnedAboutBundledArch && isMachOBinary(bundledBinary)) {
        warnedAboutBundledArch = true;
        sendLog({
          type: 'warning',
          message: `Встроенный tpws собран под другую архитектуру (нужна ${process.arch}) — пересоберу локально`
        });
      }
    }

    // Fall back to a previously downloaded or development binary.
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    const archBinary = path.join(binDir, `tpws_${arch}`);
    if (isMachOBinaryRunnable(archBinary)) return archBinary;
    const binary = path.join(binDir, 'tpws');
    if (isMachOBinaryRunnable(binary)) return binary;
    return path.join(binDir, 'tpws');
  } else if (process.platform === 'win32') {
    return path.join(binDir, 'winws.exe');
  }
  
  return null;
}

function isWindowsBundleCurrent(platformDir = getResourcePath()) {
  if (process.platform !== 'win32') return true;
  return isFlowsealBundleCurrent(platformDir);
}

// The trusted copy of the Windows runtime: the one inside the installed
// application. The installer is perMachine, so it sits under Program Files where
// an unprivileged process cannot write — unlike the runtime directory in
// %APPDATA% that the engine is actually launched from.
function getRuntimeReferenceDir() {
  if (process.platform !== 'win32' || !app.isPackaged) return null;

  // The portable build unpacks its resources into a temp directory the user can
  // write to, so the "reference" there is exactly as forgeable as the runtime it
  // would be vouching for. Better to report that no check is possible than to
  // compare a copy against itself and call it verified.
  if (process.env.PORTABLE_EXECUTABLE_DIR) return null;

  return path.join(process.resourcesPath, 'bin');
}

// Runs before every elevated launch. Returns { ok } or { ok: false, error }.
async function ensureWindowsRuntimeIntegrity() {
  const runtimeDir = getResourcePath();
  const referenceDir = getRuntimeReferenceDir();

  const result = verifyRuntimeAgainstReference(runtimeDir, referenceDir, FLOWSEAL_REQUIRED_WINDOWS_FILES);

  if (!result.hasReference) {
    // Portable build or a dev checkout: there is no admin-only copy to compare
    // against. Say that plainly instead of implying the check passed.
    sendLog({
      type: 'warning',
      message: 'Проверка целостности движка недоступна в этой сборке — эталонной копии нет'
    });
    return { ok: true };
  }

  if (result.ok) return { ok: true };

  sendLog({
    type: 'warning',
    message: `Файлы движка не совпадают с эталоном (${describeIntegrityFailure(result)}) — восстанавливаю из приложения`
  });

  const { failed } = await repairRuntimeFromReference(
    runtimeDir,
    referenceDir,
    FLOWSEAL_REQUIRED_WINDOWS_FILES,
    { copyFile: (src, dest) => copyFileResilient(src, dest) }
  );

  const after = verifyRuntimeAgainstReference(runtimeDir, referenceDir, FLOWSEAL_REQUIRED_WINDOWS_FILES);
  if (after.ok) {
    sendLog({ type: 'success', message: 'Движок восстановлен из встроенной копии' });
    return { ok: true };
  }

  // Refuse rather than run an unverified binary as administrator.
  const detail = describeIntegrityFailure(after) || (failed[0] && failed[0].error) || 'причина неизвестна';
  return {
    ok: false,
    error: `Файлы движка не совпадают с эталоном и восстановить их не удалось (${detail}). Подключение отменено — переустановите приложение.`
  };
}

// ============= HOST LISTS & PATTERN FILES =============

// Domain lists matching Flowseal/zapret-discord-youtube v1.9.9c.
// IMPORTANT: list-general = Discord + Cloudflare ONLY (no YouTube!)
// YouTube goes in list-google with separate filter rules
const HOST_LIST_GENERAL = [
  'cloudflare-ech.com', 'encryptedsni.com', 'cloudflareaccess.com', 'cloudflareapps.com',
  'cloudflarebolt.com', 'cloudflareclient.com', 'cloudflareinsights.com', 'cloudflareok.com',
  'cloudflarepartners.com', 'cloudflareportal.com', 'cloudflarepreview.com', 'cloudflareresolve.com',
  'cloudflaressl.com', 'cloudflarestatus.com', 'cloudflarestorage.com', 'cloudflarestream.com',
  'cloudflaretest.com', 'cloudfront.net', 'dis.gd', 'discord-attachments-uploads-prd.storage.googleapis.com',
  'discord.app', 'discord.co', 'discord.com', 'discord.design', 'discord.dev', 'discord.gift',
  'discord.gifts', 'discord.gg', 'discord.media', 'discord.new', 'discord.store', 'discord.status',
  'discord-activities.com', 'discordactivities.com', 'discordapp.com', 'discordapp.net',
  'discordcdn.com', 'discordmerch.com', 'discordpartygames.com', 'discordsays.com',
  'discordsez.com', 'discordstatus.com',
  'frankerfacez.com', 'ffzap.com', 'betterttv.net',
  '7tv.app', '7tv.io', 'localizeapi.com', 'klipy.com'
].join('\n');

const HOST_LIST_GOOGLE = [
  'yt3.ggpht.com', 'yt4.ggpht.com', 'yt3.googleusercontent.com',
  'googlevideo.com', 'jnn-pa.googleapis.com', 'stable.dl2.discordapp.net',
  'wide-youtube.l.google.com', 'youtube-nocookie.com', 'youtube-ui.l.google.com',
  'youtube.com', 'youtubeembeddedplayer.googleapis.com', 'youtubekids.com', 'youtube.googleapis.com',
  'youtubei.googleapis.com', 'youtu.be', 'yt-video-upload.l.google.com',
  'ytimg.com', 'ytimg.l.google.com', 'play.google.com', 'google.ru'
].join('\n');

// Discord-only list: apply gentler desync to Discord TLS first, syndata for the rest
const HOST_LIST_DISCORD = [
  'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media',
  'discord.co', 'discord.gift', 'discord.gifts', 'discord.new', 'discord.store', 'discord.status',
  'discord.app', 'discord.design', 'discord.dev', 'discord-activities.com', 'discordactivities.com',
  'discordcdn.com', 'discordmerch.com', 'discordpartygames.com', 'discordsays.com', 'discordsez.com',
  'discordstatus.com', 'dis.gd', 'gateway.discord.gg', 'cdn.discordapp.com', 'dl.discordapp.net',
  'updates.discord.com', 'discord-attachments-uploads-prd.storage.googleapis.com',
  'media.discordapp.net', 'images-ext-1.discordapp.net', 'images-ext-2.discordapp.net',
  'router.discordapp.net'
].join('\n');

// Exclude list — Russian/local services that should NOT be processed by DPI bypass
const HOST_LIST_EXCLUDE = [
  'pusher.com', 'live-video.net', 'ttvnw.net', 'twitch.tv',
  'mail.ru', 'citilink.ru', 'yandex.com', 'yandex.net', 'yandex.org', 'yandex.md',
  'yandex.ru', 'yandexadexchange.net', 'yandexcloud.net', 'yandexcom.net',
  'yandexmetrica.com', 'yandexwebcache.net', 'yandexwebcache.org', 'yastat.net',
  'yastatic-net.ru', 'yastatic.net', 'ya.ru', 'adfox.ru', 'admetrica.ru',
  'naydex.net', 'rostaxi.org', 'turbopages.org', 'webvisor.com', 'webvisor.org',
  'nvidia.com', 'donationalerts.com', 'vk.com', 'yandex.kz', 'mts.ru', 'multimc.org',
  'dns-shop.ru', 'habr.com', '3dnews.ru', 'microsoft.com', 'microsoftonline.com',
  'live.com', 'sharepoint.com', 'minecraft.net', 'xboxlive.com',
  'akamaitechnologies.com', 'msi.com', '2ip.ru', 'boosty.to', 'tanki.su',
  'lesta.ru', 'korabli.su', 'tanksblitz.ru', 'reg.ru', 'epicgames.dev',
  'epicgames.com', 'unrealengine.com', 'riotgames.com', 'riotcdn.net',
  'leagueoflegends.com', 'playvalorant.com', 'marketplace.visualstudio.com',
  'gallery.vsassets.io', 'gallerycdn.vsassets.io', 'gosuslugi.ru', 'gov.ru',
  'nalog.ru', 'spb.ru', 'mos.ru', 'vk.ru', 'vk.me', 'vkvideo.ru', 'ok.ru',
  'mycdn.me', 'okcdn.ru', 'odkl.ru', 'wb.ru', 'geobasket.ru', 'paywb.com',
  'rwb.ru', 'wb-basket.ru', 'wbbasket.ru', 'wbpay.ru', 'wibes.ru',
  'wildberries.ru', 'ozon.by', 'ozon.com', 'ozon.com.by', 'ozon.com.kz',
  'ozon.kz', 'ozon.ru', 'ozon.tm', 'ozone.ru', 'ozonru.me',
  'ozonusercontent.com', 'alfabank.ru', 'gazprombank.ru', 'gpb.ru',
  'dbo-dengi.online', 'mtsdengi.ru', 'psbank.ru', 'bankline.ru', 'rosbank.ru',
  'abr.ru', 'rshb.ru', 'sber.ru', 'sberbank.com', 'sberbank.ru',
  'cdn-tinkoff.ru', 'tbank-online.com', 'tbank.ru', 't-bank-app.ru',
  'tochka-tech.com', 'tochka.com', 'vtb.ru', 'steamcommunity.com'
].join('\n');

// Private/reserved IP ranges to exclude from processing
const IPSET_EXCLUDE = [
  '0.0.0.0/8', '10.0.0.0/8', '127.0.0.0/8', '172.16.0.0/12',
  '192.168.0.0/16', '169.254.0.0/16', '224.0.0.0/4', '100.64.0.0/10',
  '::1', 'fc00::/7', 'fe80::/10'
].join('\n');

// IPSet for IP-based fallback rules (dummy IP = "none" mode, like reference default)
const IPSET_ALL = '203.0.113.113/32';

function ensureHostLists() {
  hostListsDir = path.join(app.getPath('userData'), 'lists');
  fs.mkdirSync(hostListsDir, { recursive: true });

  const settings = loadSettings();
  const customInclude = (settings.customIncludeDomains || []).filter(d => d.trim()).join('\n');
  const customExclude = (settings.customExcludeDomains || []).filter(d => d.trim()).join('\n');

  const generalWithCustom = customInclude
    ? HOST_LIST_GENERAL + '\n' + customInclude
    : HOST_LIST_GENERAL;
  const excludeWithCustom = customExclude
    ? HOST_LIST_EXCLUDE + '\n' + customExclude
    : HOST_LIST_EXCLUDE;

  fs.writeFileSync(path.join(hostListsDir, 'list-general.txt'), generalWithCustom, 'utf8');
  fs.writeFileSync(path.join(hostListsDir, 'list-google.txt'), HOST_LIST_GOOGLE, 'utf8');
  fs.writeFileSync(path.join(hostListsDir, 'list-discord.txt'), HOST_LIST_DISCORD, 'utf8');
  fs.writeFileSync(path.join(hostListsDir, 'list-exclude.txt'), excludeWithCustom, 'utf8');
  fs.writeFileSync(path.join(hostListsDir, 'ipset-exclude.txt'), IPSET_EXCLUDE, 'utf8');
  fs.writeFileSync(path.join(hostListsDir, 'ipset-all.txt'), IPSET_ALL, 'utf8');

  const HOST_LIST_ALL = generalWithCustom + '\n' + HOST_LIST_GOOGLE + '\n' + HOST_LIST_DISCORD;
  fs.writeFileSync(path.join(hostListsDir, 'list-all.txt'), HOST_LIST_ALL, 'utf8');

  return hostListsDir;
}

// Generate fake QUIC initial packet (standard QUIC Initial packet for google.com)
// This is what Flowseal ships as quic_initial_www_google_com.bin
function generateFakeQuicInitial() {
  // QUIC Initial packet header: long header form, version 1
  // This is a minimal valid-looking QUIC Initial packet
  const buf = Buffer.alloc(256);
  let offset = 0;
  
  // Flags: Long Header, Initial packet type (0xc0)
  buf[offset++] = 0xc3;
  // Version: QUIC v1 (0x00000001)
  buf.writeUInt32BE(0x00000001, offset); offset += 4;
  // DCID Length + DCID (8 bytes random)
  buf[offset++] = 0x08;
  for (let i = 0; i < 8; i++) buf[offset++] = Math.floor(Math.random() * 256);
  // SCID Length + SCID (0 bytes)
  buf[offset++] = 0x00;
  // Token Length (0)
  buf[offset++] = 0x00;
  // Length (2 bytes, remaining)
  const remaining = 256 - offset - 2;
  buf.writeUInt16BE(0x4000 | remaining, offset); offset += 2;
  // Packet Number (4 bytes)
  buf.writeUInt32BE(0x00000001, offset); offset += 4;
  // Fill rest with random data to look like encrypted payload
  for (let i = offset; i < 256; i++) buf[i] = Math.floor(Math.random() * 256);
  
  return buf;
}

// Generate fake TLS ClientHello packet
function generateFakeTlsClientHello(sni = 'www.google.com') {
  // Minimal TLS 1.2 ClientHello with SNI extension
  const sniBytes = Buffer.from(sni, 'ascii');
  
  // Build SNI extension
  const sniExtension = Buffer.alloc(9 + sniBytes.length);
  let off = 0;
  // Extension type: server_name (0x0000)
  sniExtension.writeUInt16BE(0x0000, off); off += 2;
  // Extension data length
  sniExtension.writeUInt16BE(5 + sniBytes.length, off); off += 2;
  // Server Name List Length
  sniExtension.writeUInt16BE(3 + sniBytes.length, off); off += 2;
  // Server Name Type: host_name (0)
  sniExtension[off++] = 0x00;
  // Server Name Length
  sniExtension.writeUInt16BE(sniBytes.length, off); off += 2;
  // Server Name
  sniBytes.copy(sniExtension, off);
  
  // Build ClientHello
  const random = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) random[i] = Math.floor(Math.random() * 256);
  
  // Cipher suites (common ones)
  const cipherSuites = Buffer.from([
    0x00, 0x04, // length: 2 suites
    0x13, 0x01, // TLS_AES_128_GCM_SHA256
    0x13, 0x02  // TLS_AES_256_GCM_SHA384
  ]);
  
  // Compression methods
  const compression = Buffer.from([0x01, 0x00]); // 1 method: null
  
  // Extensions length + data
  const extensionsLen = Buffer.alloc(2);
  extensionsLen.writeUInt16BE(sniExtension.length, 0);
  
  // ClientHello body
  const clientHelloBody = Buffer.concat([
    Buffer.from([0x03, 0x03]), // TLS 1.2
    random,
    Buffer.from([0x00]), // Session ID length: 0
    cipherSuites,
    compression,
    extensionsLen,
    sniExtension
  ]);
  
  // Handshake header
  const handshake = Buffer.alloc(4 + clientHelloBody.length);
  handshake[0] = 0x01; // ClientHello
  handshake[1] = 0x00;
  handshake.writeUInt16BE(clientHelloBody.length, 2);
  clientHelloBody.copy(handshake, 4);
  
  // TLS record
  const record = Buffer.alloc(5 + handshake.length);
  record[0] = 0x16; // Handshake
  record.writeUInt16BE(0x0301, 1); // TLS 1.0 (record layer)
  record.writeUInt16BE(handshake.length, 3);
  handshake.copy(record, 5);
  
  return record;
}

function ensureBinPatternFiles(platformDir) {
  const files = {
    'quic_initial_www_google_com.bin': () => generateFakeQuicInitial(),
    'tls_clienthello_www_google_com.bin': () => generateFakeTlsClientHello('www.google.com'),
    'tls_clienthello_4pda_to.bin': () => generateFakeTlsClientHello('4pda.to'),
    'tls_clienthello_max_ru.bin': () => generateFakeTlsClientHello('max.ru')
  };
  
  // Ensure the directory exists before writing pattern files
  try { fs.mkdirSync(platformDir, { recursive: true }); } catch (e) {}
  
  for (const [filename, generator] of Object.entries(files)) {
    const filePath = path.join(platformDir, filename);
    if (!fs.existsSync(filePath)) {
      try {
        fs.writeFileSync(filePath, generator());
      } catch (e) {
        // Non-critical: some strategies just won't use pattern files
      }
    }
  }
}

// Build strategy args with resolved bin/list paths
// NOTE: paths are NOT quoted here — spawn() handles quoting automatically.
// The batch-file elevated path also handles quoting via its own logic.
//
// Architecture: every strategy follows Flowseal's 8-rule structure:
//   Rule 1: UDP 443 + hostlist-general + exclude (QUIC)
//   Rule 2: UDP 19294-19344,50000-50100 + L7=discord,stun (voice)
//   Rule 3: TCP 2053,2083,2087,2096,8443 + hostlist-domains=discord.media (media)
//   Rule 4: TCP 443 + hostlist-google + ip-id=zero (YouTube)
//   Rule 5: TCP 80,443 + hostlist-general + exclude (Discord web/API)
//   Rule 6: UDP 443 + ipset-all + exclude (QUIC IP fallback)
//   Rule 7: TCP 80,443 + ipset-all + exclude (TCP IP fallback)
//   Rule 8: UDP game + ipset-all + any-protocol=1 (catch-all)
function buildWin32Strategies(binDir, listsDir) {
  const q = (f) => path.join(binDir, f);  // bin file path
  const l = (f) => path.join(listsDir, f); // list file path

  const WF_FULL = ['--wf-tcp=80,443,2053,2083,2087,2096,8443', '--wf-udp=443,19294-19344,50000-50100'];

  // Rule 1: UDP 443 QUIC — hostlist-general with exclude
  function rule1_udpQuic(quicRepeats = 6) {
    return [
      '--filter-udp=443', `--hostlist=${l('list-general.txt')}`,
      `--hostlist-exclude=${l('list-exclude.txt')}`, `--ipset-exclude=${l('ipset-exclude.txt')}`,
      '--dpi-desync=fake', `--dpi-desync-repeats=${quicRepeats}`,
      `--dpi-desync-fake-quic=${q('quic_initial_www_google_com.bin')}`, '--new'
    ];
  }

  // Rule 2: UDP Discord voice + STUN
  function rule2_udpDiscordVoice() {
    return [
      '--filter-udp=19294-19344,50000-50100', '--filter-l7=discord,stun',
      '--dpi-desync=fake', '--dpi-desync-repeats=6', '--new'
    ];
  }

  // Rule 3: TCP Discord media ports with hostlist-domains=discord.media
  function rule3_discordMedia(method, extraArgs = []) {
    return [
      '--filter-tcp=2053,2083,2087,2096,8443', '--hostlist-domains=discord.media',
      `--dpi-desync=${method}`, ...extraArgs, '--new'
    ];
  }

  // Rule 4: TCP 443 Google/YouTube with ip-id=zero
  function rule4_google(method, extraArgs = []) {
    return [
      '--filter-tcp=443', `--hostlist=${l('list-google.txt')}`, '--ip-id=zero',
      `--dpi-desync=${method}`, ...extraArgs, '--new'
    ];
  }

  // Rule 5: TCP 80,443 general hostlist with exclude
  function rule5_generalTcp(method, extraArgs = []) {
    return [
      '--filter-tcp=80,443', `--hostlist=${l('list-general.txt')}`,
      `--hostlist-exclude=${l('list-exclude.txt')}`, `--ipset-exclude=${l('ipset-exclude.txt')}`,
      `--dpi-desync=${method}`, ...extraArgs, '--new'
    ];
  }

  // Rule 6: UDP 443 IP-based fallback (QUIC for IPs not in hostlist)
  function rule6_ipsetUdpFallback(quicRepeats = 6) {
    return [
      '--filter-udp=443', `--ipset=${l('ipset-all.txt')}`,
      `--hostlist-exclude=${l('list-exclude.txt')}`, `--ipset-exclude=${l('ipset-exclude.txt')}`,
      '--dpi-desync=fake', `--dpi-desync-repeats=${quicRepeats}`,
      `--dpi-desync-fake-quic=${q('quic_initial_www_google_com.bin')}`, '--new'
    ];
  }

  // Rule 7: TCP IP-based fallback
  function rule7_ipsetTcpFallback(method, extraArgs = []) {
    return [
      '--filter-tcp=80,443', `--ipset=${l('ipset-all.txt')}`,
      `--hostlist-exclude=${l('list-exclude.txt')}`, `--ipset-exclude=${l('ipset-exclude.txt')}`,
      `--dpi-desync=${method}`, ...extraArgs, '--new'
    ];
  }

  // Rule 8: UDP game catch-all with any-protocol
  function rule8_gameUdp(repeats = 12, cutoff = 'n2') {
    return [
      '--filter-udp=12', `--ipset=${l('ipset-all.txt')}`, `--ipset-exclude=${l('ipset-exclude.txt')}`,
      '--dpi-desync=fake', `--dpi-desync-repeats=${repeats}`, '--dpi-desync-any-protocol=1',
      `--dpi-desync-fake-unknown-udp=${q('quic_initial_www_google_com.bin')}`,
      `--dpi-desync-cutoff=${cutoff}`
    ];
  }

  // Discord-only TCP 443 rule — for combo strategies that split Discord/YouTube methods
  function discordTcp443Rule(method, extraArgs = []) {
    return [
      '--filter-tcp=443', `--hostlist=${l('list-discord.txt')}`,
      `--dpi-desync=${method}`, ...extraArgs, '--new'
    ];
  }

  // Helper: build a standard 8-rule strategy (Rules 3-5 + 7 share the same method)
  function std8(method, r3extra, r4extra, r5extra, r7extra, opts = {}) {
    const quicR = opts.quicRepeats || 6;
    const gameR = opts.gameRepeats || 12;
    const cutoff = opts.cutoff || 'n2';
    return [
      ...WF_FULL,
      ...rule1_udpQuic(quicR),
      ...rule2_udpDiscordVoice(),
      ...rule3_discordMedia(method, r3extra),
      ...rule4_google(method, r4extra),
      ...rule5_generalTcp(method, r5extra),
      ...rule6_ipsetUdpFallback(quicR),
      ...rule7_ipsetTcpFallback(method, r7extra),
      ...rule8_gameUdp(gameR, cutoff)
    ];
  }

  const tlsG = q('tls_clienthello_www_google_com.bin');
  const tls4 = q('tls_clienthello_4pda_to.bin');
  const tlsM = q('tls_clienthello_max_ru.bin');

  const legacyStrategies = [
    // ========== Flowseal reference strategies (8-rule architecture) ==========

    // general.bat (Flowseal default) — multisplit 681/568 with pattern
    { name: 'general', args: std8('multisplit',
      ['--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=1', `--dpi-desync-split-seqovl-pattern=${tlsG}`],
      ['--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=1', `--dpi-desync-split-seqovl-pattern=${tlsG}`],
      ['--dpi-desync-split-seqovl=568', '--dpi-desync-split-pos=1', `--dpi-desync-split-seqovl-pattern=${tls4}`],
      ['--dpi-desync-split-seqovl=568', '--dpi-desync-split-pos=1', `--dpi-desync-split-seqovl-pattern=${tls4}`],
      { cutoff: 'n2' })
    },

    // ALT — fake,fakedsplit ts + TLS pattern
    { name: 'ALT', args: std8('fake,fakedsplit',
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts', '--dpi-desync-fakedsplit-pattern=0x00', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts', '--dpi-desync-fakedsplit-pattern=0x00', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts', '--dpi-desync-fakedsplit-pattern=0x00', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts', '--dpi-desync-fakedsplit-pattern=0x00', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      { cutoff: 'n3' })
    },

    // ALT2 — multisplit 652 pos=2 + pattern
    { name: 'ALT2', args: std8('multisplit',
      ['--dpi-desync-split-seqovl=652', '--dpi-desync-split-pos=2', `--dpi-desync-split-seqovl-pattern=${tlsG}`],
      ['--dpi-desync-split-seqovl=652', '--dpi-desync-split-pos=2', `--dpi-desync-split-seqovl-pattern=${tlsG}`],
      ['--dpi-desync-split-seqovl=652', '--dpi-desync-split-pos=2', `--dpi-desync-split-seqovl-pattern=${tlsG}`],
      ['--dpi-desync-split-seqovl=652', '--dpi-desync-split-pos=2', `--dpi-desync-split-seqovl-pattern=${tlsG}`],
      { cutoff: 'n2' })
    },

    // ALT3 — fake,hostfakesplit with TLS mod rnd,dupsid,sni
    { name: 'ALT3', args: [
      ...WF_FULL,
      ...rule1_udpQuic(6),
      ...rule2_udpDiscordVoice(),
      ...rule3_discordMedia('fake,hostfakesplit', [
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com',
        '--dpi-desync-hostfakesplit-mod=host=www.google.com,altorder=1', '--dpi-desync-fooling=ts']),
      ...rule4_google('fake,hostfakesplit', [
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com',
        '--dpi-desync-hostfakesplit-mod=host=www.google.com,altorder=1', '--dpi-desync-fooling=ts']),
      ...rule5_generalTcp('fake,hostfakesplit', [
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=ya.ru',
        '--dpi-desync-hostfakesplit-mod=host=ya.ru,altorder=1', '--dpi-desync-fooling=ts', `--dpi-desync-fake-http=${tlsM}`]),
      ...rule6_ipsetUdpFallback(6),
      ...rule7_ipsetTcpFallback('fake,hostfakesplit', [
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=ya.ru',
        '--dpi-desync-hostfakesplit-mod=host=ya.ru,altorder=1', '--dpi-desync-fooling=ts', `--dpi-desync-fake-http=${tlsM}`]),
      ...rule8_gameUdp(10, 'n4')
    ]},

    // ALT4 — fake,multisplit badseq increment=1000 + TLS pattern
    { name: 'ALT4', args: std8('fake,multisplit',
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=1000', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=1000', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=1000', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`, `--dpi-desync-fake-http=${tlsM}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=1000', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`, `--dpi-desync-fake-http=${tlsM}`],
      { cutoff: 'n2' })
    },

    // ALT5 — syndata,multidisorder (NOT RECOMMENDED but works for some)
    { name: 'ALT5', args: [
      ...WF_FULL,
      ...rule1_udpQuic(6),
      ...rule2_udpDiscordVoice(),
      '--filter-l3=ipv4', '--filter-tcp=443,2053,2083,2087,2096,8443',
      `--hostlist-exclude=${l('list-exclude.txt')}`, `--ipset-exclude=${l('ipset-exclude.txt')}`,
      '--dpi-desync=syndata,multidisorder', '--new',
      ...rule6_ipsetUdpFallback(6),
      ...rule8_gameUdp(14, 'n3')
    ]},

    // ALT6 — multisplit 681 pos=1 + pattern (same as general but 681 everywhere)
    { name: 'ALT6', args: std8('multisplit',
      ['--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=1', `--dpi-desync-split-seqovl-pattern=${tlsG}`],
      ['--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=1', `--dpi-desync-split-seqovl-pattern=${tlsG}`],
      ['--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=1', `--dpi-desync-split-seqovl-pattern=${tlsG}`],
      ['--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=1', `--dpi-desync-split-seqovl-pattern=${tlsG}`],
      { cutoff: 'n2' })
    },

    // ALT7 — fake badseq increment=2 (simple, wide compat)
    { name: 'ALT7', args: std8('fake',
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=2', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=2', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=2', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=2', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      { cutoff: 'n2' })
    },

    // ALT8 — fake badseq increment=10000000
    { name: 'ALT8', args: std8('fake',
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=10000000', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=10000000', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=10000000', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=10000000', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      { cutoff: 'n2' })
    },

    // ALT10 — multisplit 652 pos=2 (no pattern, unlike ALT2)
    { name: 'ALT10', args: std8('multisplit',
      ['--dpi-desync-split-seqovl=652', '--dpi-desync-split-pos=2'],
      ['--dpi-desync-split-seqovl=652', '--dpi-desync-split-pos=2'],
      ['--dpi-desync-split-seqovl=652', '--dpi-desync-split-pos=2'],
      ['--dpi-desync-split-seqovl=652', '--dpi-desync-split-pos=2'],
      { cutoff: 'n2' })
    },

    // ALT11 — fake,multisplit 681 ts repeats=8 + TLS pattern
    { name: 'ALT11', args: [
      ...WF_FULL,
      ...rule1_udpQuic(11),
      ...rule2_udpDiscordVoice(),
      ...rule3_discordMedia('fake,multisplit', [
        '--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=1',
        '--dpi-desync-fooling=ts', '--dpi-desync-repeats=8',
        `--dpi-desync-split-seqovl-pattern=${tlsG}`, `--dpi-desync-fake-tls=${tlsG}`]),
      ...rule4_google('fake,multisplit', [
        '--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=1',
        '--dpi-desync-fooling=ts', '--dpi-desync-repeats=8',
        `--dpi-desync-split-seqovl-pattern=${tlsG}`, `--dpi-desync-fake-tls=${tlsG}`]),
      ...rule5_generalTcp('fake,multisplit', [
        '--dpi-desync-split-seqovl=664', '--dpi-desync-split-pos=1',
        '--dpi-desync-fooling=ts', '--dpi-desync-repeats=8',
        `--dpi-desync-split-seqovl-pattern=${tlsM}`, `--dpi-desync-fake-tls=${tlsM}`, `--dpi-desync-fake-http=${tlsM}`]),
      ...rule6_ipsetUdpFallback(11),
      ...rule7_ipsetTcpFallback('fake,multisplit', [
        '--dpi-desync-split-seqovl=664', '--dpi-desync-split-pos=1',
        '--dpi-desync-fooling=ts', '--dpi-desync-repeats=8',
        `--dpi-desync-split-seqovl-pattern=${tlsM}`, `--dpi-desync-fake-tls=${tlsM}`, `--dpi-desync-fake-http=${tlsM}`]),
      ...rule8_gameUdp(10, 'n4')
    ]},

    // SIMPLE FAKE — fake ts + TLS pattern (simple, for lenient ISPs)
    { name: 'SIMPLE FAKE', args: std8('fake',
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      { cutoff: 'n3' })
    },

    // SIMPLE FAKE ALT — fake,fakedsplit ts
    { name: 'SIMPLE FAKE ALT', args: std8('fake,fakedsplit',
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts', '--dpi-desync-fakedsplit-pattern=0x00', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts', '--dpi-desync-fakedsplit-pattern=0x00', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts', '--dpi-desync-fakedsplit-pattern=0x00', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=ts', '--dpi-desync-fakedsplit-pattern=0x00', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      { cutoff: 'n3' })
    },

    // SIMPLE FAKE ALT2 — fake badseq increment=2
    { name: 'SIMPLE FAKE ALT2', args: std8('fake',
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=2', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=2', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=2', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=2', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      { cutoff: 'n3' })
    },

    // FAKE TLS AUTO — fake,multidisorder with TLS mod rnd,dupsid,sni=www.google.com
    { name: 'FAKE TLS AUTO', args: [
      ...WF_FULL,
      ...rule1_udpQuic(11),
      ...rule2_udpDiscordVoice(),
      ...rule3_discordMedia('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11', '--dpi-desync-fooling=badseq',
        '--dpi-desync-fake-tls=0x00000000', '--dpi-desync-fake-tls=!',
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      ...rule4_google('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11', '--dpi-desync-fooling=badseq',
        '--dpi-desync-fake-tls=0x00000000', '--dpi-desync-fake-tls=!',
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      ...rule5_generalTcp('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11', '--dpi-desync-fooling=badseq',
        '--dpi-desync-fake-tls=0x00000000', '--dpi-desync-fake-tls=!',
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com', `--dpi-desync-fake-http=${tlsM}`]),
      ...rule6_ipsetUdpFallback(11),
      ...rule7_ipsetTcpFallback('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11', '--dpi-desync-fooling=badseq',
        '--dpi-desync-fake-tls=0x00000000', '--dpi-desync-fake-tls=!',
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com', `--dpi-desync-fake-http=${tlsM}`]),
      ...rule8_gameUdp(10, 'n2')
    ]},

    // FAKE TLS AUTO ALT — same structure, slightly different params
    { name: 'FAKE TLS AUTO ALT', args: [
      ...WF_FULL,
      ...rule1_udpQuic(11),
      ...rule2_udpDiscordVoice(),
      ...rule3_discordMedia('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11', '--dpi-desync-fooling=badseq',
        '--dpi-desync-fake-tls=0x00000000', '--dpi-desync-fake-tls=!',
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      ...rule4_google('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11', '--dpi-desync-fooling=badseq',
        '--dpi-desync-fake-tls=0x00000000', '--dpi-desync-fake-tls=!',
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      ...rule5_generalTcp('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11', '--dpi-desync-fooling=badseq',
        '--dpi-desync-fake-tls=0x00000000', '--dpi-desync-fake-tls=!',
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com', `--dpi-desync-fake-http=${tlsM}`]),
      ...rule6_ipsetUdpFallback(11),
      ...rule7_ipsetTcpFallback('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11', '--dpi-desync-fooling=badseq',
        '--dpi-desync-fake-tls=0x00000000', '--dpi-desync-fake-tls=!',
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com', `--dpi-desync-fake-http=${tlsM}`]),
      ...rule8_gameUdp(11, 'n2')
    ]},

    // FAKE TLS AUTO ALT2 — with fake-tls-mod=rnd,dupsid,sni + badseq increment=2
    { name: 'FAKE TLS AUTO ALT2', args: [
      ...WF_FULL,
      ...rule1_udpQuic(11),
      ...rule2_udpDiscordVoice(),
      ...rule3_discordMedia('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11', '--dpi-desync-fooling=badseq',
        '--dpi-desync-badseq-increment=2',
        '--dpi-desync-fake-tls=0x00000000', '--dpi-desync-fake-tls=!',
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      ...rule4_google('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11', '--dpi-desync-fooling=badseq',
        '--dpi-desync-badseq-increment=2',
        '--dpi-desync-fake-tls=0x00000000', '--dpi-desync-fake-tls=!',
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      ...rule5_generalTcp('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11', '--dpi-desync-fooling=badseq',
        '--dpi-desync-badseq-increment=2',
        '--dpi-desync-fake-tls=0x00000000', '--dpi-desync-fake-tls=!',
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com', `--dpi-desync-fake-http=${tlsM}`]),
      ...rule6_ipsetUdpFallback(11),
      ...rule7_ipsetTcpFallback('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11', '--dpi-desync-fooling=badseq',
        '--dpi-desync-badseq-increment=2',
        '--dpi-desync-fake-tls=0x00000000', '--dpi-desync-fake-tls=!',
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com', `--dpi-desync-fake-http=${tlsM}`]),
      ...rule8_gameUdp(11, 'n2')
    ]},

    // FAKE TLS AUTO ALT3 — with ts,badseq fooling variant
    { name: 'FAKE TLS AUTO ALT3', args: [
      ...WF_FULL,
      ...rule1_udpQuic(11),
      ...rule2_udpDiscordVoice(),
      ...rule3_discordMedia('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11', '--dpi-desync-fooling=ts,badseq',
        '--dpi-desync-fake-tls=0x00000000', '--dpi-desync-fake-tls=!',
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      ...rule4_google('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11', '--dpi-desync-fooling=ts,badseq',
        '--dpi-desync-fake-tls=0x00000000', '--dpi-desync-fake-tls=!',
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      ...rule5_generalTcp('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11', '--dpi-desync-fooling=ts,badseq',
        '--dpi-desync-fake-tls=0x00000000', '--dpi-desync-fake-tls=!',
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com', `--dpi-desync-fake-http=${tlsM}`]),
      ...rule6_ipsetUdpFallback(11),
      ...rule7_ipsetTcpFallback('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11', '--dpi-desync-fooling=ts,badseq',
        '--dpi-desync-fake-tls=0x00000000', '--dpi-desync-fake-tls=!',
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com', `--dpi-desync-fake-http=${tlsM}`]),
      ...rule8_gameUdp(11, 'n2')
    ]},

    // ========== Combo strategies (Discord-first + syndata for YouTube) ==========

    // COMBO: Discord badseq + syndata YouTube
    { name: 'combo:syndata+badseq', args: [
      ...WF_FULL,
      ...rule1_udpQuic(6),
      ...rule2_udpDiscordVoice(),
      ...rule3_discordMedia('fake', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=2']),
      ...discordTcp443Rule('fake', ['--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--dpi-desync-badseq-increment=2']),
      '--filter-l3=ipv4', '--filter-tcp=443', '--dpi-desync=syndata,multidisorder', '--new',
      '--filter-tcp=80', '--dpi-desync=fake', '--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--new',
      ...rule6_ipsetUdpFallback(6),
      ...rule8_gameUdp(12, 'n2')
    ]},

    // COMBO: Discord multisplit + syndata YouTube
    { name: 'combo:syndata+multisplit', args: [
      ...WF_FULL,
      ...rule1_udpQuic(6),
      ...rule2_udpDiscordVoice(),
      ...rule3_discordMedia('multisplit', ['--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=1']),
      ...discordTcp443Rule('multisplit', ['--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=1']),
      '--filter-l3=ipv4', '--filter-tcp=443', '--dpi-desync=syndata,multidisorder', '--new',
      '--filter-tcp=80', '--dpi-desync=multisplit', '--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=1', '--new',
      ...rule6_ipsetUdpFallback(6),
      ...rule8_gameUdp(12, 'n2')
    ]},

    // ========== Additional strategies for ISPs with updated DPI (2025-2026) ==========

    // syndata-only — bypasses newest TSPU for YouTube without needing TLS patterns
    { name: 'syndata-only', args: [
      ...WF_FULL,
      ...rule1_udpQuic(6),
      ...rule2_udpDiscordVoice(),
      '--filter-l3=ipv4', '--filter-tcp=443,2053,2083,2087,2096,8443',
      `--hostlist-exclude=${l('list-exclude.txt')}`, `--ipset-exclude=${l('ipset-exclude.txt')}`,
      '--dpi-desync=syndata,multidisorder', '--new',
      '--filter-tcp=80', `--hostlist=${l('list-general.txt')}`,
      `--hostlist-exclude=${l('list-exclude.txt')}`, `--ipset-exclude=${l('ipset-exclude.txt')}`,
      '--dpi-desync=fake', '--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--new',
      ...rule6_ipsetUdpFallback(6),
      ...rule8_gameUdp(14, 'n3')
    ]},

    // fake,multidisorder + TLS mod (proven for MGTS, Rostelecom 2025+)
    { name: 'fake-multidisorder-tlsmod', args: [
      ...WF_FULL,
      ...rule1_udpQuic(11),
      ...rule2_udpDiscordVoice(),
      ...rule3_discordMedia('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11',
        '--dpi-desync-fooling=ts,badseq', '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      ...rule4_google('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11',
        '--dpi-desync-fooling=ts,badseq', '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      ...rule5_generalTcp('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11',
        '--dpi-desync-fooling=ts,badseq', '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=ya.ru', `--dpi-desync-fake-http=${tlsM}`]),
      ...rule6_ipsetUdpFallback(11),
      ...rule7_ipsetTcpFallback('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11',
        '--dpi-desync-fooling=ts,badseq', '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=ya.ru', `--dpi-desync-fake-http=${tlsM}`]),
      ...rule8_gameUdp(11, 'n2')
    ]},

    // multisplit with higher seqovl values (works on providers that block 681)
    { name: 'multisplit-900', args: std8('multisplit',
      ['--dpi-desync-split-seqovl=900', '--dpi-desync-split-pos=1', `--dpi-desync-split-seqovl-pattern=${tlsG}`],
      ['--dpi-desync-split-seqovl=900', '--dpi-desync-split-pos=1', `--dpi-desync-split-seqovl-pattern=${tlsG}`],
      ['--dpi-desync-split-seqovl=900', '--dpi-desync-split-pos=1', `--dpi-desync-split-seqovl-pattern=${tls4}`],
      ['--dpi-desync-split-seqovl=900', '--dpi-desync-split-pos=1', `--dpi-desync-split-seqovl-pattern=${tls4}`],
      { cutoff: 'n2' })
    },

    // fake+multisplit with ts fooling (effective for dom.ru, beeline 2025+)
    { name: 'fake+multisplit-ts', args: std8('fake,multisplit',
      ['--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=1', '--dpi-desync-fooling=ts', '--dpi-desync-repeats=6', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-split-seqovl-pattern=${tlsG}`],
      ['--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=1', '--dpi-desync-fooling=ts', '--dpi-desync-repeats=6', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-split-seqovl-pattern=${tlsG}`],
      ['--dpi-desync-split-seqovl=568', '--dpi-desync-split-pos=1', '--dpi-desync-fooling=ts', '--dpi-desync-repeats=6', `--dpi-desync-fake-tls=${tls4}`, `--dpi-desync-split-seqovl-pattern=${tls4}`],
      ['--dpi-desync-split-seqovl=568', '--dpi-desync-split-pos=1', '--dpi-desync-fooling=ts', '--dpi-desync-repeats=6', `--dpi-desync-fake-tls=${tls4}`, `--dpi-desync-split-seqovl-pattern=${tls4}`],
      { cutoff: 'n3' })
    },

    // COMBO: syndata YouTube + hostfakesplit Discord (for providers where multisplit stopped working)
    { name: 'combo:syndata+hostfakesplit', args: [
      ...WF_FULL,
      ...rule1_udpQuic(6),
      ...rule2_udpDiscordVoice(),
      ...rule3_discordMedia('fake,hostfakesplit', [
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com',
        '--dpi-desync-hostfakesplit-mod=host=www.google.com,altorder=1', '--dpi-desync-fooling=ts']),
      ...discordTcp443Rule('fake,hostfakesplit', [
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com',
        '--dpi-desync-hostfakesplit-mod=host=www.google.com,altorder=1', '--dpi-desync-fooling=ts']),
      '--filter-l3=ipv4', '--filter-tcp=443', '--dpi-desync=syndata,multidisorder', '--new',
      '--filter-tcp=80', '--dpi-desync=fake,hostfakesplit', '--dpi-desync-fooling=ts',
      '--dpi-desync-hostfakesplit-mod=host=ya.ru,altorder=1', '--new',
      ...rule6_ipsetUdpFallback(6),
      ...rule8_gameUdp(12, 'n2')
    ]},

    // COMBO: syndata YouTube + fake TLS AUTO Discord
    { name: 'combo:syndata+faketls', args: [
      ...WF_FULL,
      ...rule1_udpQuic(11),
      ...rule2_udpDiscordVoice(),
      ...rule3_discordMedia('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11', '--dpi-desync-fooling=badseq',
        '--dpi-desync-fake-tls=0x00000000', '--dpi-desync-fake-tls=!',
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      ...discordTcp443Rule('fake,multidisorder', [
        '--dpi-desync-split-pos=1,midsld', '--dpi-desync-repeats=11', '--dpi-desync-fooling=badseq',
        '--dpi-desync-fake-tls=0x00000000', '--dpi-desync-fake-tls=!',
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com']),
      '--filter-l3=ipv4', '--filter-tcp=443', '--dpi-desync=syndata,multidisorder', '--new',
      '--filter-tcp=80', '--dpi-desync=fake', '--dpi-desync-repeats=6', '--dpi-desync-fooling=badseq', '--new',
      ...rule6_ipsetUdpFallback(11),
      ...rule8_gameUdp(11, 'n2')
    ]},

    // ========== TSPU-optimized strategies (SNI filtering with silent drop) ==========

    // md5sig fooling — bypasses TSPU connection tracker (proven Feb 2026)
    { name: 'fake-md5sig', args: std8('fake',
      ['--dpi-desync-repeats=11', '--dpi-desync-fooling=md5sig', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=11', '--dpi-desync-fooling=md5sig', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=11', '--dpi-desync-fooling=md5sig', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      ['--dpi-desync-repeats=11', '--dpi-desync-fooling=md5sig', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      { cutoff: 'n2' })
    },

    // md5sig + badseq double fooling — for ISPs that detect single fooling method
    { name: 'fake-md5sig+badseq', args: std8('fake',
      ['--dpi-desync-repeats=11', '--dpi-desync-fooling=md5sig,badseq', '--dpi-desync-badseq-increment=1', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=11', '--dpi-desync-fooling=md5sig,badseq', '--dpi-desync-badseq-increment=1', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=11', '--dpi-desync-fooling=md5sig,badseq', '--dpi-desync-badseq-increment=1', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      ['--dpi-desync-repeats=11', '--dpi-desync-fooling=md5sig,badseq', '--dpi-desync-badseq-increment=1', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      { cutoff: 'n2' })
    },

    // disorder-only — pure packet reorder without fake (low overhead, fast)
    { name: 'disorder-midsld', args: std8('multidisorder',
      ['--dpi-desync-split-pos=1,midsld'],
      ['--dpi-desync-split-pos=1,midsld'],
      ['--dpi-desync-split-pos=1,midsld'],
      ['--dpi-desync-split-pos=1,midsld'],
      { cutoff: 'n2' })
    },

    // Very low seqovl — minimal overlap, effective when DPI has simple reassembly
    { name: 'multisplit-seqovl-2', args: std8('multisplit',
      ['--dpi-desync-split-seqovl=2', '--dpi-desync-split-pos=2'],
      ['--dpi-desync-split-seqovl=2', '--dpi-desync-split-pos=2'],
      ['--dpi-desync-split-seqovl=2', '--dpi-desync-split-pos=2'],
      ['--dpi-desync-split-seqovl=2', '--dpi-desync-split-pos=2'],
      { cutoff: 'n2' })
    },

    // fake,disorder with TLS mod + midsld split (latest TSPU bypass, Feb 2026)
    { name: 'fake-disorder-tlsmod', args: [
      ...WF_FULL,
      ...rule1_udpQuic(11),
      ...rule2_udpDiscordVoice(),
      ...rule3_discordMedia('fake,multidisorder', [
        '--dpi-desync-split-pos=midsld', '--dpi-desync-repeats=11',
        '--dpi-desync-fooling=md5sig', '--dpi-desync-fake-tls-mod=rnd,sni=www.google.com']),
      ...rule4_google('fake,multidisorder', [
        '--dpi-desync-split-pos=midsld', '--dpi-desync-repeats=11',
        '--dpi-desync-fooling=md5sig', '--dpi-desync-fake-tls-mod=rnd,sni=www.google.com']),
      ...rule5_generalTcp('fake,multidisorder', [
        '--dpi-desync-split-pos=midsld', '--dpi-desync-repeats=11',
        '--dpi-desync-fooling=md5sig', '--dpi-desync-fake-tls-mod=rnd,sni=ya.ru', `--dpi-desync-fake-http=${tlsM}`]),
      ...rule6_ipsetUdpFallback(11),
      ...rule7_ipsetTcpFallback('fake,multidisorder', [
        '--dpi-desync-split-pos=midsld', '--dpi-desync-repeats=11',
        '--dpi-desync-fooling=md5sig', '--dpi-desync-fake-tls-mod=rnd,sni=ya.ru', `--dpi-desync-fake-http=${tlsM}`]),
      ...rule8_gameUdp(11, 'n2')
    ]},

    // COMBO: Discord md5sig + YouTube syndata (optimized for TSPU Feb 2026)
    { name: 'combo:syndata+md5sig', args: [
      ...WF_FULL,
      ...rule1_udpQuic(6),
      ...rule2_udpDiscordVoice(),
      ...rule3_discordMedia('fake', ['--dpi-desync-repeats=11', '--dpi-desync-fooling=md5sig', `--dpi-desync-fake-tls=${tlsG}`]),
      ...discordTcp443Rule('fake', ['--dpi-desync-repeats=11', '--dpi-desync-fooling=md5sig', `--dpi-desync-fake-tls=${tlsG}`]),
      '--filter-l3=ipv4', '--filter-tcp=443', '--dpi-desync=syndata,multidisorder', '--new',
      '--filter-tcp=80', '--dpi-desync=fake', '--dpi-desync-repeats=6', '--dpi-desync-fooling=md5sig', '--new',
      ...rule6_ipsetUdpFallback(6),
      ...rule8_gameUdp(12, 'n2')
    ]},

    // fake,fakedsplit with md5sig — alternative to ts fooling
    { name: 'fakedsplit-md5sig', args: std8('fake,fakedsplit',
      ['--dpi-desync-repeats=11', '--dpi-desync-fooling=md5sig', '--dpi-desync-fakedsplit-pattern=0x00', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=11', '--dpi-desync-fooling=md5sig', '--dpi-desync-fakedsplit-pattern=0x00', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=11', '--dpi-desync-fooling=md5sig', '--dpi-desync-fakedsplit-pattern=0x00', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      ['--dpi-desync-repeats=11', '--dpi-desync-fooling=md5sig', '--dpi-desync-fakedsplit-pattern=0x00', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      { cutoff: 'n3' })
    },

    // Triple fooling: ts + badseq + md5sig for most aggressive TSPU evasion
    { name: 'fake-triple-fooling', args: std8('fake',
      ['--dpi-desync-repeats=11', '--dpi-desync-fooling=ts,badseq,md5sig', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=11', '--dpi-desync-fooling=ts,badseq,md5sig', `--dpi-desync-fake-tls=${tlsG}`],
      ['--dpi-desync-repeats=11', '--dpi-desync-fooling=ts,badseq,md5sig', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      ['--dpi-desync-repeats=11', '--dpi-desync-fooling=ts,badseq,md5sig', `--dpi-desync-fake-tls=${tlsG}`, `--dpi-desync-fake-http=${tlsM}`],
      { cutoff: 'n2' })
    },

    // COMBO: Discord hostfakesplit+md5sig + YouTube syndata
    { name: 'combo:syndata+hostfake-md5sig', args: [
      ...WF_FULL,
      ...rule1_udpQuic(6),
      ...rule2_udpDiscordVoice(),
      ...rule3_discordMedia('fake,hostfakesplit', [
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com',
        '--dpi-desync-hostfakesplit-mod=host=www.google.com,altorder=1', '--dpi-desync-fooling=md5sig']),
      ...discordTcp443Rule('fake,hostfakesplit', [
        '--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com',
        '--dpi-desync-hostfakesplit-mod=host=www.google.com,altorder=1', '--dpi-desync-fooling=md5sig']),
      '--filter-l3=ipv4', '--filter-tcp=443', '--dpi-desync=syndata,multidisorder', '--new',
      '--filter-tcp=80', '--dpi-desync=fake,hostfakesplit', '--dpi-desync-fooling=md5sig',
      '--dpi-desync-hostfakesplit-mod=host=ya.ru,altorder=1', '--new',
      ...rule6_ipsetUdpFallback(6),
      ...rule8_gameUdp(12, 'n2')
    ]},

    // multisplit with midsld position — splits exactly at SLD boundary
    { name: 'multisplit-midsld', args: std8('multisplit',
      ['--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=midsld', `--dpi-desync-split-seqovl-pattern=${tlsG}`],
      ['--dpi-desync-split-seqovl=681', '--dpi-desync-split-pos=midsld', `--dpi-desync-split-seqovl-pattern=${tlsG}`],
      ['--dpi-desync-split-seqovl=568', '--dpi-desync-split-pos=midsld', `--dpi-desync-split-seqovl-pattern=${tls4}`],
      ['--dpi-desync-split-seqovl=568', '--dpi-desync-split-pos=midsld', `--dpi-desync-split-seqovl-pattern=${tls4}`],
      { cutoff: 'n2' })
    },
  ];

  const flowsealStrategies = buildFlowsealStrategies(binDir, listsDir);
  const flowsealNames = new Set(flowsealStrategies.map((strategy) => strategy.name));
  return [
    ...flowsealStrategies,
    ...legacyStrategies.filter((strategy) => !flowsealNames.has(strategy.name))
  ];
}

// DPI bypass strategies — based on Flowseal/zapret-discord-youtube (22k+ stars)
// Both platforms now use dynamic strategy builders that reference runtime host list paths.
// macOS: tpws SOCKS proxy with --hostlist for targeted DPI bypass
// Windows: winws driver-level interception with host lists and pattern files
function buildDarwinStrategies(listsDir) {
  const la = path.join(listsDir, 'list-all.txt');
  const le = path.join(listsDir, 'list-exclude.txt');

  const BASE = ['--port', '1080', '--socks'];
  const HL = [`--hostlist=${la}`, `--hostlist-exclude=${le}`];

  const lg = path.join(listsDir, 'list-general.txt');
  const ld = path.join(listsDir, 'list-discord.txt');
  const HLG = [`--hostlist=${lg}`, `--hostlist-exclude=${le}`];
  const HLD = [`--hostlist=${ld}`];

  return [
    // === TIER 1: Multi-profile TLS+HTTP (best for Discord+YouTube combo) ===
    { name: 'multi:disorder+tlsrec', args: [...BASE, ...HL,
      '--filter-l7=tls', '--split-pos=1,midsld', '--disorder', '--tlsrec=sni',
      '--new', ...HL, '--filter-l7=http', '--hostcase', '--methodeol', '--split-pos=1', '--disorder'] },
    { name: 'multi:oob-tls+hostcase-http', args: [...BASE, ...HL,
      '--filter-l7=tls', '--split-pos=1,midsld', '--oob', '--disorder',
      '--new', ...HL, '--filter-l7=http', '--hostcase', '--hostdot', '--split-pos=1', '--disorder'] },
    { name: 'multi:split-sniext+methodeol', args: [...BASE, ...HL,
      '--filter-l7=tls', '--split-pos=1,sniext', '--disorder', '--tlsrec=sni',
      '--new', ...HL, '--filter-l7=http', '--methodeol', '--hostcase', '--split-pos=2', '--disorder'] },

    // === TIER 2: Split+Disorder basics (proven, wide ISP compat) ===
    { name: 'split+disorder', args: [...BASE, '--split-pos=1', '--disorder', '--hostcase', ...HL] },
    { name: 'split-midsld+disorder', args: [...BASE, '--split-pos=1,midsld', '--disorder', '--hostcase', ...HL] },
    { name: 'split2+disorder', args: [...BASE, '--split-pos=2', '--disorder', '--hostcase', ...HL] },
    { name: 'split-host+disorder', args: [...BASE, '--split-pos=host', '--disorder', '--hostcase', ...HL] },
    { name: 'split-endhost+disorder', args: [...BASE, '--split-pos=endhost', '--disorder', '--hostcase', ...HL] },

    // === TIER 3: TLS record manipulation (effective against TSPU for YouTube) ===
    { name: 'tlsrec+split+disorder', args: [...BASE, '--tlsrec=sni', '--split-pos=1', '--disorder', '--hostcase', ...HL] },
    { name: 'tlsrec+split-midsld+disorder', args: [...BASE, '--tlsrec=sni', '--split-pos=1,midsld', '--disorder', '--hostcase', ...HL] },
    { name: 'tlsrec-sniext+disorder', args: [...BASE, '--tlsrec=sniext', '--split-pos=1', '--disorder', '--hostcase', ...HL] },

    // === TIER 4: OOB — out-of-band data injection ===
    { name: 'oob+split+disorder', args: [...BASE, '--oob', '--split-pos=1', '--disorder', ...HL] },
    { name: 'oob+split-midsld', args: [...BASE, '--oob', '--split-pos=1,midsld', '--disorder', ...HL] },
    { name: 'oob+tlsrec+split', args: [...BASE, '--oob', '--tlsrec=sni', '--split-pos=1', '--hostcase', ...HL] },
    { name: 'oob-tls+split+disorder', args: [...BASE, '--oob=tls', '--split-pos=1,midsld', '--disorder', '--hostcase', ...HL] },
    { name: 'oob-0x01+split+disorder', args: [...BASE, '--oob', '--oob-data=0x01', '--split-pos=1', '--disorder', ...HL] },

    // === TIER 5: Multi-profile with Discord-specific rules ===
    { name: 'multi:discord-split+general-disorder', args: [...BASE,
      ...HLD, '--filter-l7=tls', '--split-pos=1,midsld', '--disorder', '--tlsrec=sni',
      '--new', ...HLD, '--filter-l7=http', '--hostcase', '--split-pos=1', '--disorder',
      '--new', ...HLG, '--filter-l7=tls', '--split-pos=1', '--disorder',
      '--new', ...HLG, '--filter-l7=http', '--hostcase', '--methodeol', '--split-pos=1'] },
    { name: 'multi:discord-oob+general-split', args: [...BASE,
      ...HLD, '--split-pos=1,midsld', '--oob', '--disorder',
      '--new', ...HLG, '--split-pos=1', '--disorder', '--hostcase'] },

    // === TIER 6: Host header manipulation ===
    { name: 'methodeol+split', args: [...BASE, '--methodeol', '--split-pos=1', '--hostcase', ...HL] },
    { name: 'hostdot+split+disorder', args: [...BASE, '--hostdot', '--split-pos=1,midsld', '--disorder', ...HL] },
    { name: 'hostpad+split+disorder', args: [...BASE, '--hostpad=256', '--split-pos=1', '--disorder', '--hostcase', ...HL] },
    { name: 'domcase+split+disorder', args: [...BASE, '--domcase', '--split-pos=1,midsld', '--disorder', ...HL] },

    // === TIER 7: Combined aggressive strategies ===
    { name: 'combined-v1', args: [...BASE, '--split-pos=1,midsld', '--disorder', '--hostcase', '--methodeol', ...HL] },
    { name: 'combined-v2', args: [...BASE, '--oob', '--methodeol', '--split-pos=1,midsld', '--disorder', '--hostcase', '--hostdot', ...HL] },
    { name: 'combined-v3', args: [...BASE, '--tlsrec=sni', '--hostpad=256', '--split-pos=2', '--disorder', '--hostcase', ...HL] },
    { name: 'oob+methodeol+split', args: [...BASE, '--oob', '--methodeol', '--split-pos=1', '--hostcase', ...HL] },
    { name: 'combined-v4', args: [...BASE, '--oob', '--hostpad=256', '--split-pos=1,midsld', '--disorder', '--hostcase', '--methodeol', ...HL] },
    { name: 'combined-v5', args: [...BASE, '--tlsrec=sni', '--methodeol', '--hostdot', '--split-pos=2', '--disorder', '--hostcase', ...HL] },
    { name: 'combined-v6', args: [...BASE, '--oob=tls', '--tlsrec=sni', '--split-pos=1,midsld', '--disorder', '--hostcase', ...HL] },
    { name: 'combined-v7', args: [...BASE, '--domcase', '--oob', '--split-pos=host', '--disorder', ...HL] },

    // === TIER 8: Multi-profile split-any-protocol (for edge cases) ===
    { name: 'multi:splitany+disorder', args: [...BASE, ...HL,
      '--split-pos=1,midsld', '--split-any-protocol', '--disorder',
      '--new', ...HL, '--filter-l7=http', '--hostcase', '--methodeol'] },
    { name: 'split-any+oob+disorder', args: [...BASE, '--split-pos=1', '--split-any-protocol', '--oob', '--disorder', ...HL] },

    // === TIER 9: Extended split positions ===
    { name: 'split3+disorder', args: [...BASE, '--split-pos=3', '--disorder', '--hostcase', ...HL] },
    { name: 'split-sniext+disorder', args: [...BASE, '--split-pos=1,sniext', '--disorder', '--hostcase', ...HL] },
    { name: 'split-sld+disorder', args: [...BASE, '--split-pos=sld', '--disorder', '--hostcase', ...HL] },
    { name: 'split-endsld+disorder', args: [...BASE, '--split-pos=endsld', '--disorder', '--hostcase', ...HL] },

    // === TIER 10: Host header variants ===
    { name: 'hosttab+split+disorder', args: [...BASE, '--hosttab', '--split-pos=1', '--disorder', '--hostcase', ...HL] },
    { name: 'hostnospace+split+disorder', args: [...BASE, '--hostnospace', '--split-pos=1', '--disorder', '--hostcase', ...HL] },
    { name: 'hostpad512+split+disorder', args: [...BASE, '--hostpad=512', '--split-pos=1', '--disorder', '--hostcase', ...HL] },
    { name: 'hostpad1024+split', args: [...BASE, '--hostpad=1024', '--split-pos=1,midsld', '--hostcase', ...HL] },
    { name: 'unixeol+split+disorder', args: [...BASE, '--unixeol', '--split-pos=1', '--disorder', '--hostcase', ...HL] },

    // === TIER 11: TLS record + OOB variants ===
    { name: 'tlsrec+disorder', args: [...BASE, '--tlsrec=sni', '--disorder', '--hostcase', ...HL] },
    { name: 'tlsrec+oob+split', args: [...BASE, '--tlsrec=sni', '--oob', '--split-pos=1', '--hostcase', ...HL] },
    { name: 'tlsrec+oob+disorder', args: [...BASE, '--tlsrec=sni', '--oob', '--disorder', '--hostcase', ...HL] },

    // === TIER 12: Multi-profile tamper-cutoff (reduce false positives) ===
    { name: 'multi:cutoff-tls+cutoff-http', args: [...BASE, ...HL,
      '--filter-l7=tls', '--split-pos=1,midsld', '--disorder', '--tlsrec=sni', '--tamper-cutoff=n5',
      '--new', ...HL, '--filter-l7=http', '--hostcase', '--methodeol', '--split-pos=1', '--tamper-cutoff=n3'] },

    // === TIER 13: Minimal (last resort with hostlist) ===
    { name: 'split-only', args: [...BASE, '--split-pos=1', ...HL] },
    { name: 'disorder-only', args: [...BASE, '--disorder', ...HL] },

    // === TIER 14: Fallback without hostlist ===
    { name: 'split+disorder-nohl', args: [...BASE, '--split-pos=1', '--disorder', '--hostcase'] },
    { name: 'split-midsld+disorder-nohl', args: [...BASE, '--split-pos=1,midsld', '--disorder', '--hostcase'] },
    { name: 'tlsrec+split+disorder-nohl', args: [...BASE, '--tlsrec=sni', '--split-pos=1', '--disorder', '--hostcase'] },
    { name: 'oob+split+disorder-nohl', args: [...BASE, '--oob', '--split-pos=1', '--disorder'] },
    { name: 'multi:disorder+tlsrec-nohl', args: [...BASE,
      '--filter-l7=tls', '--split-pos=1,midsld', '--disorder', '--tlsrec=sni',
      '--new', '--filter-l7=http', '--hostcase', '--methodeol', '--split-pos=1', '--disorder'] },
  ];
}

// Proven strategies ordered by speed (tested Feb 2026 on TSPU SNI-filtering DPI).
// Auto-select tries them in order, so fastest/most reliable go first.
const WIN32_PRIORITY_ORDER = [
  ...FLOWSEAL_AUTO_ORDER,
  'multisplit-seqovl-2', 'disorder-midsld', 'combo:syndata+md5sig',
  'combo:syndata+hostfake-md5sig', 'ALT10', 'syndata-only',
  'combo:syndata+badseq', 'combo:syndata+multisplit', 'ALT5',
];

function reorderStrategies(strategies) {
  const byName = new Map(strategies.map(s => [s.name, s]));
  const ordered = [];
  for (const name of WIN32_PRIORITY_ORDER) {
    const s = byName.get(name);
    if (s) { ordered.push(s); byName.delete(name); }
  }
  for (const s of strategies) {
    if (byName.has(s.name)) ordered.push(s);
  }
  return ordered;
}

// Get strategies for current platform (Windows strategies are built dynamically with paths)
function getStrategiesForPlatform() {
  if (process.platform === 'darwin') {
    const listsDir = ensureHostLists();
    return buildDarwinStrategies(listsDir);
  } else if (process.platform === 'win32') {
    const binDir = getResourcePath();
    const listsDir = ensureHostLists();
    ensureBinPatternFiles(binDir);
    return reorderStrategies(buildWin32Strategies(binDir, listsDir));
  }
  return [];
}

function sendStatus(extra = {}) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('status', { 
      connected: isConnected,
      downloading: isDownloading,
      strategy: currentStrategy,
      binaryExists: fs.existsSync(getBinaryPath() || ''),
      error: lastError,
      errorCode: lastErrorCode,
      disconnectReason: disconnectReason,
      connectedSince: connectedSince,
      strategyProgress: strategyProgress,
      ...extra
    });
  }
}

function sendLog(entry) {
  // entry: { type: 'info'|'success'|'error'|'warning', message: string, timestamp: number }
  console.log(`[${entry.type}] ${entry.message}`);
  const logEntry = { ...entry, timestamp: Date.now() };
  logEntries.push(logEntry);
  // Keep only last 100 entries
  if (logEntries.length > 100) logEntries.shift();
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('log-entry', logEntry);
  }
}

function clearError() {
  lastError = null;
  lastErrorCode = null;
  disconnectReason = null;
}

function updateTrayMenu() {
  if (!tray) return;
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Открыть', click: () => mainWindow.show() },
    { type: 'separator' },
    {
      label: isConnected ? '● Подключено' : (isSearching ? '◌ Подбор стратегии…' : '○ Отключено'),
      enabled: false
    },
    // Disabled while a search runs: the search owns the bypass process, the port
    // and the system proxy for minutes, and a second one would fight it for all
    // three. The renderer guards its own button, but the tray is a separate path.
    {
      label: 'Подключить',
      click: () => { startProxy().catch((e) => sendLog({ type: 'error', message: `Ошибка подключения: ${e.message}` })); },
      enabled: !isConnected && !isDownloading && !isSearching
    },
    {
      label: isSearching && !isConnected ? 'Отменить подбор' : 'Отключить',
      click: () => stopProxy(),
      enabled: isConnected || isSearching
    },
    { type: 'separator' },
    { label: 'Выход', click: () => { app.isQuitting = true; stopProxy(); app.quit(); }}
  ]);
  
  tray.setContextMenu(contextMenu);
}

// ============= BINARY DOWNLOAD =============

function downloadFileDirect(url, dest, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let file;
    try {
      file = fs.createWriteStream(dest);
    } catch (err) {
      reject(new Error(`Cannot write to ${dest}: ${err.message}`));
      return;
    }
    
    file.on('error', (err) => {
      file.close();
      try { fs.unlinkSync(dest); } catch (e) {}
      reject(err);
    });
    
    const request = https.get(url, { family: 4, lookup: ipv4Lookup }, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        try { fs.unlinkSync(dest); } catch (e) {}
        downloadFileDirect(response.headers.location, dest, timeoutMs).then(resolve).catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch (e) {}
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      
      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;
      
      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        const percent = totalSize ? Math.round((downloadedSize / totalSize) * 100) : 0;
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('download-progress', { percent, downloaded: downloadedSize, total: totalSize });
        }
      });
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        resolve();
      });
    });
    
    request.on('error', (err) => {
      file.close();
      try { fs.unlinkSync(dest); } catch (e) {}
      reject(err);
    });
    
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      reject(new Error('Timeout'));
    });
  });
}

async function downloadFile(url, dest) {
  const MAX_RETRIES = 3;
  const TIMEOUTS = [120000, 180000, 300000];
  // If GitHub is blocked by the ISP (ECONNRESET), fall back to public GitHub
  // proxies. The bundle is SHA256-verified after download, so a bad mirror
  // response cannot result in installing tampered binaries.
  const candidates = buildMirrorUrls(url);
  let lastError;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const viaMirror = i > 0;
    if (viaMirror) {
      sendLog({ type: 'info', message: `GitHub недоступен напрямую — пробуем зеркало (${i}/${candidates.length - 1})...` });
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const delaySec = attempt * 3;
          sendLog({ type: 'info', message: `Повторная попытка скачивания (${attempt + 1}/${MAX_RETRIES}) через ${delaySec}с...` });
          await new Promise(r => setTimeout(r, delaySec * 1000));
        }
        try { fs.unlinkSync(dest); } catch (e) {}
        await downloadFileDirect(candidate, dest, TIMEOUTS[attempt] || 300000);
        return;
      } catch (err) {
        lastError = err;
        const retryable = ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'Timeout', 'socket hang up'].some(s => (err.message || '').includes(s));
        // Stop retrying THIS url if the error isn't transient; move to the next
        // candidate (mirror) instead.
        if (!retryable) break;
      }
    }
    // This candidate exhausted — try the next mirror, if any.
  }

  throw lastError;
}

async function downloadAndExtractBinaries() {
  if (isDownloading) return { success: false, error: 'Already downloading' };
  
  isDownloading = true;
  sendStatus();
  
  const binDir = getBinDir();
  const platformDir = getResourcePath();
  const tempDir = path.join(app.getPath('temp'), 'unblock-pro-temp');
  
  try {
    // On Windows, try to add Defender exclusion so WinDivert driver isn't deleted
    if (process.platform === 'win32') {
      try {
        execSync(`powershell -command "Add-MpPreference -ExclusionPath '${platformDir}'" `, { stdio: 'pipe' });
      } catch (e) {
        // May fail without admin — non-critical
      }
    }
    
    // Clean up any leftover temp files from previous attempts (fixes EPERM on Windows)
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    
    // Create directories
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(platformDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });
    
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }
    
    // Windows strategies are audited against the pinned Flowseal bundle.
    // macOS continues to use the latest upstream zapret release for tpws.
    const downloadUrl = process.platform === 'win32'
      ? FLOWSEAL_BUNDLE_URL
      : ZAPRET_MACOS_ARCHIVE_URL;
    
    const zipPath = path.join(tempDir, 'zapret.zip');
    
    // Remove stale zip if it exists (Windows file locking)
    try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (e) {}
    
    // Download
    await downloadFile(downloadUrl, zipPath);

    if (process.platform === 'win32') {
      const archiveHash = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
      if (archiveHash !== FLOWSEAL_BUNDLE_SHA256) {
        throw new Error(`Flowseal bundle checksum mismatch: ${archiveHash}`);
      }
    }
    
    // Extract
    if (process.platform === 'win32') {
      execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tempDir}' -Force"`, { stdio: 'pipe' });
      
      // Archive has windows-x86_64/ (WinDivert64.sys) and windows-x86/ (WinDivert32.sys).
      // On 64-bit Windows we MUST use x86_64 — otherwise WinDivert64.sys is missing.
      const candidates = [];
      const findWinws = (dir) => {
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) findWinws(fullPath);
          else if (file === 'winws.exe') candidates.push(fullPath);
        }
      };
      findWinws(tempDir);
      // Prefer path containing x86_64 (64-bit driver)
      const winwsPath = candidates.find(p => path.dirname(p).toLowerCase().includes('x86_64'))
        || candidates.find(p => path.dirname(p).toLowerCase().includes('x64'))
        || candidates[0];
      
      if (winwsPath) {
        // Release the WinDivert driver before overwriting its files. If the
        // engine (winws.exe) is still running, WinDivert64.sys at the
        // destination is locked and copying it throws EBUSY. Best-effort: the
        // driver auto-unloads once winws exits, and copyFileResilient retries
        // through the brief unload window.
        try { execSync('taskkill /F /IM winws.exe', { stdio: 'pipe', timeout: 3000 }); } catch (e) {}

        await copyFileResilient(winwsPath, path.join(platformDir, 'winws.exe'));

        // Copy ALL required files from the same directory as winws.exe:
        // - WinDivert driver files (WinDivert.dll, WinDivert64.sys, WinDivert32.sys)
        // - Cygwin runtime DLLs (cygwin1.dll, cygstdc++-6.dll, cyggcc_s-seh-1.dll, etc.)
        const winwsDir = path.dirname(winwsPath);
        const dirFiles = fs.readdirSync(winwsDir);

        for (const file of dirFiles) {
          if (file === 'winws.exe') continue; // already copied
          const src = path.join(winwsDir, file);
          const stat = fs.statSync(src);
          if (stat.isFile()) {
            // Resilient against the WinDivert-driver-locked case: the pinned
            // bundle's destination files are byte-identical, so a locked-but-
            // identical WinDivert64.sys is skipped instead of failing.
            await copyFileResilient(src, path.join(platformDir, file));
          }
        }
        
        // Unblock all files — Windows marks downloaded files with Zone.Identifier ADS
        // which prevents kernel drivers (WinDivert64.sys) from loading
        try {
          execSync(`powershell -command "Get-ChildItem -Path '${platformDir}' | Unblock-File"`, { stdio: 'pipe' });
        } catch (e) {
          // Non-critical: unblock may fail if not needed
        }
        
        // Verify WinDivert files were copied
        const driverExists = fs.existsSync(path.join(platformDir, 'WinDivert64.sys'));
        const dllExists = fs.existsSync(path.join(platformDir, 'WinDivert.dll'));
        if (!driverExists || !dllExists) {
          sendLog({ type: 'warning', message: `WinDivert файлы: driver=${driverExists}, dll=${dllExists}` });
        }
        
        // Extract .bin pattern files from zapret archive (files/fake/ directory)
        const extractBinPatterns = (dir) => {
          if (!fs.existsSync(dir)) return;
          const items = fs.readdirSync(dir);
          for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              // Look inside 'fake' or 'files' subdirectories
              if (item === 'fake' || item === 'files') extractBinPatterns(fullPath);
            } else if (item.endsWith('.bin')) {
              const destFile = path.join(platformDir, item);
              if (!fs.existsSync(destFile)) {
                try { fs.copyFileSync(fullPath, destFile); } catch(e) {}
              }
            }
          }
        };
        extractBinPatterns(tempDir);
        
        // Generate any missing pattern files
        ensureBinPatternFiles(platformDir);

        const missingFiles = FLOWSEAL_REQUIRED_WINDOWS_FILES.filter(
          (file) => !fs.existsSync(path.join(platformDir, file))
        );
        if (missingFiles.length > 0) {
          throw new Error(`Flowseal bundle is incomplete: ${missingFiles.join(', ')}`);
        }
        fs.writeFileSync(
          path.join(platformDir, FLOWSEAL_BUNDLE_MARKER),
          `${FLOWSEAL_BUNDLE_VERSION}\n`,
          'utf8'
        );
      } else {
        throw new Error('winws.exe not found in archive');
      }
      
    } else if (process.platform === 'darwin') {
      execSync(`unzip -o "${zipPath}" -d "${tempDir}"`, { stdio: 'pipe' });
      
      // The pinned archive expands to zapret-<commit>/. Requiring the commit in
      // the name is the integrity check: it fails loudly if the download was not
      // the source we intend to compile.
      const zapretDirs = fs.readdirSync(tempDir).filter(f =>
        f.startsWith('zapret-') && fs.statSync(path.join(tempDir, f)).isDirectory()
      );
      const pinnedDir = zapretDirs.find(f => f.includes(ZAPRET_MACOS_COMMIT));
      if (!pinnedDir) {
        throw new Error(
          `Скачанный архив не соответствует закреплённому коммиту ${ZAPRET_MACOS_COMMIT.slice(0, 12)} ` +
          `(получено: ${zapretDirs.join(', ') || 'ничего'})`
        );
      }
      const zapretDir = path.join(tempDir, pinnedDir);

      // Upstream prebuilt aarch64/x86_64 files are Linux ELF binaries. Always
      // compile the dedicated universal macOS target instead of copying them.
      const tpwsSrcDir = path.join(zapretDir, 'tpws');
      const compiledPath = path.join(tpwsSrcDir, 'tpws');
      sendLog({ type: 'info', message: `Собираю tpws из zapret ${ZAPRET_MACOS_COMMIT.slice(0, 12)}...` });
      try {
        execSync('make mac', {
          cwd: tpwsSrcDir,
          stdio: 'pipe',
          timeout: 300000,
          env: { ...process.env, OPTIMIZE: '-O2' }
        });
      } catch (e) {
        // Do not flatten every cause into "install Xcode". A missing toolchain, a
        // real compile error and a timeout need different actions from the user,
        // and the previous message hid all three.
        const stderr = (e.stderr ? e.stderr.toString() : '').trim();
        const lastLine = stderr.split('\n').filter(Boolean).pop() || '';
        const looksLikeMissingToolchain =
          /make: (command )?not found|xcode-select|no developer tools|clang: (command )?not found/i.test(stderr);
        throw new Error(
          looksLikeMissingToolchain
            ? 'Не найдены инструменты сборки. Установите их командой: xcode-select --install'
            : `Сборка tpws не удалась: ${lastLine || e.message}`
        );
      }

      if (!isMachOBinaryRunnable(compiledPath)) {
        throw new Error('tpws binary not found and compilation failed. Please install Xcode Command Line Tools.');
      }
      const destination = path.join(platformDir, 'tpws');
      fs.copyFileSync(compiledPath, destination);
      fs.chmodSync(destination, '755');
    }
    
    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
    
    isDownloading = false;
    sendStatus();
    return { success: true };
    
  } catch (error) {
    isDownloading = false;
    
    let errorMsg = error.message;
    if (error.message.includes('ETIMEDOUT') || error.message.includes('Timeout')) {
      errorMsg = 'Таймаут при скачивании — GitHub может быть недоступен. Попробуйте позже или включите VPN для первой загрузки';
    } else if (error.message.includes('ECONNRESET') || error.message.includes('socket hang up')) {
      errorMsg = 'Соединение сброшено — провайдер мог заблокировать GitHub. Попробуйте через VPN или мобильный интернет';
    } else if (error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {
      errorMsg = 'Нет доступа к серверу — проверьте интернет-соединение';
    } else if (error.message.includes('EBUSY') || error.code === 'EBUSY') {
      errorMsg = 'Файл драйвера WinDivert занят. Отключите обход (кнопка «Стоп»), закройте другие приложения обхода блокировок и антивирус, затем повторите';
    } else if (error.message.includes('EPERM') || error.message.includes('EACCES')) {
      errorMsg = 'Нет прав для записи файлов — запустите от администратора';
    } else if (error.message.includes('Cannot write')) {
      errorMsg = 'Файл заблокирован — закройте антивирус и попробуйте снова';
    } else if (error.message.includes('not found')) {
      errorMsg = 'Бинарник не найден в архиве';
    }
    
    sendLog({ type: 'error', message: `Ошибка скачивания: ${errorMsg}` });
    sendStatus();
    
    // Cleanup on error
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    
    return { success: false, error: errorMsg };
  }
}

// ============= UDP BLOCKING (macOS) =============
// tpws is a TCP-only SOCKS proxy, so all UDP traffic bypasses it entirely.
// We use pf (packet filter) to block specific UDP traffic, forcing TCP fallback:
//  - UDP 443 (QUIC): forces YouTube/browsers to use TCP/TLS through tpws
//  - UDP 19294-19344, 50000-50100 (Discord Voice): forces Discord to use
//    TCP WebSocket for voice, which goes through tpws and gets DPI-bypassed

let quicBlockEnabled = false;
// `pfctl -E` hands out a reference token and refuses to disable pf until every
// token is released with `pfctl -X`. Without releasing ours, pf stayed enabled
// after disconnect and kept interfering with other networking tools.
let pfEnableToken = null;

async function enableQuicBlock() {
  if (process.platform !== 'darwin') return true;

  const pfConfPath = path.join(app.getPath('userData'), 'pf-quic-block.conf');
  try {
    let existingConf = '';
    try { existingConf = fs.readFileSync('/etc/pf.conf', 'utf8'); } catch (e) {}
    const rules = [
      'block return out quick proto udp from any to any port 443',
      'block return out quick proto udp from any to any port 19294:19344',
      'block return out quick proto udp from any to any port 50000:50100'
    ];
    const alreadyHasAll = rules.every(r => existingConf.includes(r));
    if (alreadyHasAll) {
      quicBlockEnabled = true;
      return true;
    }
    const newRules = rules.filter(r => !existingConf.includes(r));
    fs.writeFileSync(pfConfPath, existingConf.trimEnd() + '\n' + newRules.join('\n') + '\n');
  } catch (e) {
    sendLog({ type: 'warning', message: 'Не удалось создать конфиг для блокировки UDP' });
    return false;
  }

  return new Promise((resolve) => {
    // `-E` writes its token to stderr, so keep both streams.
    sudo.exec(
      `/sbin/pfctl -f "${pfConfPath}" 2>/dev/null; /sbin/pfctl -E 2>&1; exit 0`,
      { name: 'UnblockPro' },
      (error, stdout, stderr) => {
        if (error) {
          sendLog({ type: 'warning', message: 'UDP блокировка не установлена — Discord голос и YouTube могут не работать' });
          resolve(false);
          return;
        }
        pfEnableToken = parsePfEnableToken(`${stdout || ''}\n${stderr || ''}`);
        quicBlockEnabled = true;
        sendLog({ type: 'info', message: 'UDP заблокирован (QUIC + Discord Voice) — трафик идёт через TCP' });
        resolve(true);
      }
    );
  });
}

function disableQuicBlock() {
  if (!quicBlockEnabled || process.platform !== 'darwin') return;
  quicBlockEnabled = false;

  const token = pfEnableToken;
  pfEnableToken = null;
  // Reload the untouched system ruleset, then hand back our enable reference so
  // pf can return to whatever state it was in before we started.
  const release = token ? `/sbin/pfctl -X ${token} 2>/dev/null; ` : '';
  const command = `/sbin/pfctl -f /etc/pf.conf 2>/dev/null; ${release}exit 0`;

  try {
    execSync(command, { stdio: 'pipe', shell: '/bin/sh' });
  } catch (e) {
    // Fallback: try via sudo-prompt (credentials may still be cached)
    try {
      sudo.exec(command, { name: 'UnblockPro' }, () => {});
    } catch (e2) {}
  }
}

// ============= SYSTEM PROXY (macOS) =============

let proxyEnabledServices = [];
let originalDnsSettings = {};

function getActiveNetworkServices() {
  if (process.platform !== 'darwin') return [];
  try {
    const output = execSync('networksetup -listallnetworkservices', { encoding: 'utf8', stdio: 'pipe' });
    const allServices = output.split('\n')
      .filter(line => line.trim() && !line.startsWith('An asterisk'))
      .map(line => line.trim());
    
    const active = [];
    for (const service of allServices) {
      try {
        const info = execSync(`networksetup -getinfo "${service}"`, { encoding: 'utf8', stdio: 'pipe' });
        // Service is active if it has a real IP address
        if (/IP address:\s*\d+\.\d+\.\d+\.\d+/.test(info)) {
          active.push(service);
        }
      } catch (e) {}
    }
    return active.length > 0 ? active : allServices.filter(s => /wi-fi|ethernet|usb/i.test(s));
  } catch (e) {
    return ['Wi-Fi'];
  }
}

function enableSystemProxy(port = 1080) {
  if (process.platform !== 'darwin') return;
  const services = getActiveNetworkServices();
  proxyEnabledServices = [];
  
  for (const service of services) {
    try {
      execSync(`networksetup -setsocksfirewallproxy "${service}" 127.0.0.1 ${port}`, { stdio: 'pipe' });
      execSync(`networksetup -setsocksfirewallproxystate "${service}" on`, { stdio: 'pipe' });
      proxyEnabledServices.push(service);
    } catch (e) {}
  }
}

function disableSystemProxy() {
  if (process.platform !== 'darwin') return;
  const services = [...new Set([...proxyEnabledServices, ...getActiveNetworkServices()])];
  
  for (const service of services) {
    try {
      execSync(`networksetup -setsocksfirewallproxystate "${service}" off`, { stdio: 'pipe' });
    } catch (e) {}
  }
  proxyEnabledServices = [];
}

function setCleanDns(services) {
  if (process.platform !== 'darwin') return;
  originalDnsSettings = {};
  for (const service of services) {
    try {
      const info = execSync(`networksetup -getdnsservers "${service}"`, { encoding: 'utf8', stdio: 'pipe' }).trim();
      originalDnsSettings[service] = info;
      execSync(`networksetup -setdnsservers "${service}" 1.1.1.1 8.8.8.8 1.0.0.1 8.8.4.4`, { stdio: 'pipe' });
    } catch (e) {}
  }
}

function restoreDns() {
  if (process.platform !== 'darwin') return;
  const services = [...new Set([...Object.keys(originalDnsSettings), ...getActiveNetworkServices()])];
  for (const service of services) {
    try {
      const orig = originalDnsSettings[service];
      if (orig && !orig.includes("aren't any") && !orig.includes('Error')) {
        const servers = orig.split('\n').map(s => s.trim()).filter(Boolean).join(' ');
        execSync(`networksetup -setdnsservers "${service}" ${servers}`, { stdio: 'pipe' });
      } else {
        execSync(`networksetup -setdnsservers "${service}" Empty`, { stdio: 'pipe' });
      }
    } catch (e) {}
  }
  originalDnsSettings = {};
}

function flushDnsCache() {
  if (process.platform !== 'darwin') return;
  try { execSync('dscacheutil -flushcache', { stdio: 'pipe' }); } catch (e) {}
  try { execSync('killall -HUP mDNSResponder 2>/dev/null; exit 0', { stdio: 'pipe', shell: '/bin/sh' }); } catch (e) {}
}

// Reads at most `limit` bytes so a multi-megabyte page cannot blow up memory.
function readBodySample(filePath, limit = BODY_SAMPLE_BYTES) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(limit);
      const read = fs.readSync(fd, buf, 0, limit, 0);
      return buf.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return Buffer.alloc(0);
  }
}

// The body goes to a temp file rather than stdout: it keeps memory bounded and
// leaves the status code as the only thing on stdout, so there is nothing to
// mis-parse.
function testSingleConnection(port, timeoutSec, url) {
  return new Promise((resolve) => {
    const bodyFile = path.join(
      app.getPath('temp'),
      `unblock-probe-${process.pid}-${probeCounter++}.bin`
    );
    const cleanup = () => { try { fs.unlinkSync(bodyFile); } catch (e) {} };

    execFile(
      'curl',
      [
        '--socks5-hostname', `127.0.0.1:${port}`,
        '--connect-timeout', String(timeoutSec),
        '--max-time', String(timeoutSec + 5),
        '-s', '-o', bodyFile,
        '-w', '%{http_code}',
        url
      ],
      { timeout: (timeoutSec + 8) * 1000 },
      (error, stdout) => {
        if (error) { cleanup(); resolve(false); return; }
        const status = parseInt(String(stdout).trim(), 10);
        const body = readBodySample(bodyFile);
        cleanup();
        if (!Number.isFinite(status)) { resolve(false); return; }
        resolve(validateProbe(url, status, body.toString('utf8'), body.subarray(0, 16).toString('hex')));
      }
    );
  });
}

async function runProbeGroup(urls, groupLabel, runProbe) {
  const results = await Promise.all(urls.map((url) => runProbe(url)));
  const failed = urls.filter((_, i) => !results[i]).map(probeLabel);
  if (failed.length > 0) {
    sendLog({
      type: 'warning',
      message: `${groupLabel}: не прошли проверку — ${failed.join(', ')}`
    });
    return false;
  }
  return true;
}

async function testProxyConnection(port = TPWS_PORT, timeouts = PROBE_TIMEOUTS) {
  const { screenTimeoutSec, fullTimeoutSec } = timeouts;

  // Cheapest probes first, on a short budget. Acceptance still requires every
  // probe to pass, so this changes nothing about which strategy wins — it only
  // stops a doomed strategy from costing a full YouTube page download and a
  // 15-second hang before it is rejected.
  const screen = (url) => testSingleConnection(port, screenTimeoutSec, url);
  if (!await runProbeGroup(SCREENING_ENDPOINTS, 'Быстрая проверка', screen)) return false;

  const full = (url) => testSingleConnection(port, fullTimeoutSec, url);
  if (!await runProbeGroup(REMAINING_ENDPOINTS, 'Полная проверка', full)) return false;

  return true;
}

// ============= DIRECT CONNECTION TEST (Windows) =============

function testSingleDirectConnection(url, timeoutSec = 10) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };

    try {
      const urlObj = new URL(url);
      const req = https.get({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        family: 4, lookup: ipv4Lookup,
        timeout: timeoutSec * 1000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
      }, (res) => {
        // Read a bounded sample so the body can be validated, then stop early —
        // a status code alone does not prove the real service answered.
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (size >= BODY_SAMPLE_BYTES) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size >= BODY_SAMPLE_BYTES) {
            res.destroy();
          }
        });
        const done = () => {
          const body = Buffer.concat(chunks);
          finish(validateProbe(
            url,
            res.statusCode,
            body.toString('utf8'),
            body.subarray(0, 16).toString('hex')
          ));
        };
        res.on('end', done);
        res.on('close', done);
        res.on('error', () => finish(false));
      });
      req.on('error', () => finish(false));
      req.on('timeout', () => { req.destroy(); finish(false); });
    } catch (e) {
      finish(false);
    }
  });
}

// Test WebSocket handshake to Discord gateway — same as Discord app does. If this fails, app won't load.
function testDiscordWebSocketGateway(timeoutSec = 12) {
  return new Promise((resolve) => {
    const host = 'gateway.discord.gg';
    const timeoutMs = timeoutSec * 1000;
    let resolved = false;
    const done = (ok) => {
      if (resolved) return;
      resolved = true;
      try { socket.destroy(); } catch (e) {}
      resolve(ok);
    };
    let socket;
    try {
      socket = tls.connect({
        host,
        port: 443,
        servername: host,
        rejectUnauthorized: true
      }, () => {
        const key = Buffer.allocUnsafe(16);
        for (let i = 0; i < 16; i++) key[i] = Math.floor(Math.random() * 256);
        const req =
          `GET /?v=10&encoding=json HTTP/1.1\r\n` +
          `Host: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key.toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
        socket.write(req);
      });
      socket.setEncoding('utf8');
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk;
        if (data.includes('\r\n\r\n')) {
          const statusLine = data.split('\r\n')[0];
          done(statusLine.includes('101'));
        }
      });
      socket.on('error', () => done(false));
      socket.on('timeout', () => done(false));
      socket.setTimeout(timeoutMs);
    } catch (e) {
      resolve(false);
    }
  });
}

async function testDirectConnection(timeouts = PROBE_TIMEOUTS) {
  const { screenTimeoutSec, fullTimeoutSec } = timeouts;
  // winws works at driver level — test with direct HTTPS requests (no SOCKS proxy)
  // IMPORTANT: Must verify BOTH YouTube AND Discord work, including Discord media
  // ports (2053,8443 etc.) which are needed for voice/video calls.
  
  // Discord media — test TLS on the voice/media ports that DPI often blocks
  const discordMediaEndpoints = [
    'https://discord.media:443/',
    'https://discord.gg/'
  ];

  // Cheapest probes first on a short budget — a doomed strategy is rejected on a
  // few bytes instead of a full YouTube page plus a long hang. Acceptance still
  // requires all of them, so the verdict is unchanged; only the order and the
  // budget are. Covers YouTube web + video delivery and Discord API + CDN, so a
  // partially working route is still not accepted.
  const screen = (url) => testSingleDirectConnection(url, screenTimeoutSec);
  if (!await runProbeGroup(SCREENING_ENDPOINTS, 'Быстрая проверка', screen)) return false;

  const probe = (url) => testSingleDirectConnection(url, fullTimeoutSec);
  if (!await runProbeGroup(REMAINING_ENDPOINTS, 'Полная проверка', probe)) return false;

  // CRITICAL: Test WebSocket to gateway — Discord app uses this to load. If broken, app stays on "Проблемы с подключением".
  const gatewayWsOk = await testDiscordWebSocketGateway(fullTimeoutSec);
  if (!gatewayWsOk) {
    sendLog({ type: 'warning', message: 'Discord gateway (WebSocket) не прошёл — приложение не загрузится' });
    return false;
  }
  
  // Test Discord media (voice/video)
  let discordMediaOk = false;
  for (const url of discordMediaEndpoints) {
    if (await testSingleDirectConnection(url, fullTimeoutSec)) {
      discordMediaOk = true;
      break;
    }
  }
  if (discordMediaOk) {
    sendLog({ type: 'info', message: 'Discord media: доступен' });
  }
  
  return true; // YouTube + Discord API + Discord WebSocket all passed
}

// ============= WINDOWS ELEVATION & MONITORING =============

let winwsMonitorInterval = null;

function isRunningAsAdmin() {
  if (process.platform !== 'win32') return true;
  try {
    execSync('net session', { stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}

function startWinwsMonitor() {
  stopWinwsMonitor();
  winwsMonitorInterval = setInterval(() => {
    try {
      const output = execSync('tasklist /FI "IMAGENAME eq winws.exe" /NH', { encoding: 'utf8', stdio: 'pipe' });
      if (!output.includes('winws.exe')) {
        stopWinwsMonitor();
        if (isConnected) {
          isConnected = false;
          const prevStrategy = currentStrategy;
          currentStrategy = null;
          connectedSince = null;
          disconnectReason = 'PROCESS_CRASHED';
          lastError = 'Процесс обхода завершился неожиданно';
          lastErrorCode = 'PROCESS_CRASHED';
          updateTrayMenu();
          sendLog({ type: 'error', message: `Стратегия ${prevStrategy} прекратила работу` });
          sendStatus();
        }
      }
    } catch (e) {}
  }, 5000);
}

function stopWinwsMonitor() {
  if (winwsMonitorInterval) {
    clearInterval(winwsMonitorInterval);
    winwsMonitorInterval = null;
  }
}

// PowerShell script to test Discord gateway WebSocket handshake (used by elevated batch)
const PS_TEST_GATEWAY_WS = [
  '$hostname = "gateway.discord.gg"; $port = 443; $timeoutMs = 12000',
  'try {',
  '  $tcp = New-Object System.Net.Sockets.TcpClient',
  '  $ar = $tcp.BeginConnect($hostname, $port, $null, $null)',
  '  if (-not $ar.AsyncWaitHandle.WaitOne($timeoutMs)) { $tcp.Close(); exit 1 }',
  '  $tcp.EndConnect($ar)',
  '  $stream = $tcp.GetStream()',
  '  $ssl = New-Object System.Net.Security.SslStream($stream, $false, { $true })',
  '  $ssl.ReadTimeout = $timeoutMs; $ssl.WriteTimeout = $timeoutMs',
  '  $ssl.AuthenticateAsClient($hostname)',
  '  $key = [Convert]::ToBase64String((1..16 | ForEach-Object { Get-Random -Maximum 256 -Minimum 0 }) -as [byte[]])',
  "  $req = \"GET /?v=10&encoding=json HTTP/1.1`r`nHost: $hostname`r`nUpgrade: websocket`r`nConnection: Upgrade`r`nSec-WebSocket-Key: $key`r`nSec-WebSocket-Version: 13`r`n`r`n\"",
  '  $buf = [System.Text.Encoding]::UTF8.GetBytes($req)',
  '  $ssl.Write($buf, 0, $buf.Length)',
  '  $readBuf = New-Object byte[] 512',
  '  $read = $ssl.Read($readBuf, 0, 512)',
  '  $ssl.Close(); $tcp.Close()',
  '  $resp = [System.Text.Encoding]::UTF8.GetString($readBuf, 0, $read)',
  '  if ($resp -match "101") { exit 0 }',
  '} catch {}',
  'exit 1'
].join('\r\n');

async function startProxyWindowsElevated(finalBinaryPath, strategies, totalStrategies, firstIsPreferred = false) {
  const binDirectory = path.dirname(finalBinaryPath);
  const tempDir = app.getPath('temp');
  const resultFile = path.join(tempDir, 'unblock-result.txt');
  const progressFile = path.join(tempDir, 'unblock-progress.txt');
  const batchFile = path.join(tempDir, 'unblock-test.bat');
  const wsTestScript = path.join(tempDir, 'unblock-test-ws.ps1');
  const probeScript = path.join(tempDir, 'unblock-test-probe.ps1');

  // Clean old temp files
  try { fs.unlinkSync(resultFile); } catch(e) {}
  try { fs.unlinkSync(progressFile); } catch(e) {}
  try { fs.unlinkSync(wsTestScript); } catch(e) {}
  try { fs.unlinkSync(probeScript); } catch(e) {}
  fs.writeFileSync(wsTestScript, PS_TEST_GATEWAY_WS, 'utf8');
  // ASCII-only by construction, so no BOM is needed for PowerShell 5.1 to parse it.
  fs.writeFileSync(probeScript, buildPowerShellProbeScript(), 'ascii');

  const hostsUpdateScript = path.join(tempDir, 'unblock-pro-update-hosts.ps1');

  // Generate batch script that tests all strategies with one UAC prompt
  let bat = '@echo off\r\n';
  bat += 'setlocal EnableDelayedExpansion\r\n';
  bat += `set "RESULT=${resultFile}"\r\n`;
  bat += `set "PROGRESS=${progressFile}"\r\n`;
  bat += 'taskkill /F /IM winws.exe >nul 2>&1\r\n';
  bat += 'timeout /t 1 /nobreak >nul\r\n';
  bat += ':: Update hosts and clear Discord cache at each connection start\r\n';
  bat += `if exist "${hostsUpdateScript}" powershell -ExecutionPolicy Bypass -NoProfile -File "${hostsUpdateScript}"\r\n`;
  bat += 'rd /s /q "%APPDATA%\\discord\\Cache" 2>nul\r\n';
  bat += 'rd /s /q "%APPDATA%\\discord\\Code Cache" 2>nul\r\n';
  bat += 'rd /s /q "%APPDATA%\\discord\\GPUCache" 2>nul\r\n';
  bat += '\r\n';

  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    // Quote args that contain spaces or path separators with spaces
    const quotedArgs = s.args.map(a => {
      // If arg contains = with a path value, quote the path part
      const eqIdx = a.indexOf('=');
      if (eqIdx !== -1) {
        const key = a.substring(0, eqIdx + 1);
        const val = a.substring(eqIdx + 1);
        if (val.includes(' ') || val.includes('\\')) {
          return `${key}"${val}"`;
        }
      }
      return a;
    }).join(' ');
    bat += `:: Strategy ${i + 1}: ${s.name}\r\n`;
    bat += `echo ${i + 1}/${totalStrategies}:${s.name}> "%PROGRESS%"\r\n`;
    bat += `cd /d "${binDirectory}"\r\n`;
    bat += `start "" /b "${finalBinaryPath}" ${quotedArgs}\r\n`;
    bat += 'timeout /t 4 /nobreak >nul\r\n';
    // Every probe validates the response body, not just the status code: an ISP
    // notice page answering 200 used to be accepted and the strategy enabled
    // while nothing actually worked. Rules come from connectivity-probes.js so
    // this path and the Node path cannot diverge.
    for (const url of ORDERED_ENDPOINTS) {
      bat += `:: probe ${probeLabel(url)}\r\n`;
      // Same tiering as the Node path: the cheap screening probes get the short
      // budget, so a strategy DPI will break is rejected in seconds. And, as in
      // the Node path, a deliberately-preferred first strategy (the user's pick,
      // or the one that worked last time) gets the generous budget so a slow
      // network cannot cost it its place.
      const strategyTimeouts = (i === 0 && firstIsPreferred) ? PATIENT_TIMEOUTS : PROBE_TIMEOUTS;
      const probeTimeout = SCREENING_ENDPOINTS.includes(url)
        ? strategyTimeouts.screenTimeoutSec
        : strategyTimeouts.fullTimeoutSec;
      bat += `powershell -ExecutionPolicy Bypass -NoProfile -File "${probeScript}" -Url "${url}" -Kind "${probeKind(url)}" -TimeoutSec ${probeTimeout}\r\n`;
      bat += 'if !errorlevel! neq 0 (\r\n';
      bat += '  taskkill /F /IM winws.exe >nul 2>&1\r\n';
      bat += '  timeout /t 1 /nobreak >nul\r\n';
      bat += '  goto :strat_next_' + i + '\r\n';
      bat += ')\r\n';
    }
    // Require Discord gateway WebSocket (app won\'t load without it)
    bat += `powershell -ExecutionPolicy Bypass -File "${wsTestScript.replace(/\\/g, '\\\\')}"\r\n`;
    bat += 'if !errorlevel! neq 0 (\r\n';
    bat += '  taskkill /F /IM winws.exe >nul 2>&1\r\n';
    bat += '  goto :strat_next_' + i + '\r\n';
    bat += ')\r\n';
    bat += `echo WORKS:${s.name}> "%RESULT%"\r\n`;
    bat += 'goto :end\r\n';
    bat += ':strat_next_' + i + '\r\n';
    bat += 'taskkill /F /IM winws.exe >nul 2>&1\r\n';
    bat += 'timeout /t 1 /nobreak >nul\r\n';
    bat += '\r\n';
  }

  bat += 'echo NONE> "%RESULT%"\r\n';
  bat += 'taskkill /F /IM winws.exe >nul 2>&1\r\n';
  bat += 'goto :realend\r\n';
  bat += ':end\r\n';
  bat += ':: Strategy found — winws stays running\r\n';
  bat += ':realend\r\n';
  bat += 'endlocal\r\n';

  fs.writeFileSync(batchFile, bat, { encoding: 'utf8' });

  // Poll progress file to update UI
  let lastProgress = '';
  const progressInterval = setInterval(() => {
    try {
      const content = fs.readFileSync(progressFile, 'utf8').trim();
      if (content && content !== lastProgress) {
        lastProgress = content;
        const match = content.match(/^(\d+)\/(\d+):(.+)$/);
        if (match) {
          const current = parseInt(match[1]);
          const total = parseInt(match[2]);
          const name = match[3];
          strategyProgress = { current, total, name };
          sendStatus({ searching: true });
          sendLog({ type: 'info', message: `[${current}/${total}] Тестирование: ${name}` });
        }
      }
    } catch (e) {}
  }, 1500);

  sendLog({ type: 'info', message: 'Запуск с повышением прав (UAC)...' });

  // Run elevated batch — single UAC dialog for all strategies
  const result = await new Promise((resolve) => {
    sudo.exec(`"${batchFile}"`, { name: 'UnblockPro' }, (error) => {
      clearInterval(progressInterval);

      // Permission denied?
      if (error && error.message && (
        error.message.includes('canceled') ||
        error.message.includes('cancelled') ||
        error.message.includes('User did not grant')
      )) {
        resolve({ success: false, error: 'Требуются права администратора для обхода DPI', errorCode: 'PERMISSION_DENIED' });
        return;
      }

      // Read result file
      try {
        const resultContent = fs.readFileSync(resultFile, 'utf8').trim();
        if (resultContent.startsWith('WORKS:')) {
          const strategyName = resultContent.substring(6).trim();
          resolve({ success: true, strategy: strategyName });
        } else {
          resolve({ success: false, error: 'Ни одна стратегия не сработала', errorCode: 'ALL_STRATEGIES_FAILED' });
        }
      } catch (e) {
        resolve({ success: false, error: error ? error.message : 'Не удалось прочитать результат', errorCode: 'READ_ERROR' });
      }
    });
  });

  // Cleanup temp files
  try { fs.unlinkSync(batchFile); } catch(e) {}
  try { fs.unlinkSync(progressFile); } catch(e) {}
  try { fs.unlinkSync(resultFile); } catch(e) {}
  try { fs.unlinkSync(probeScript); } catch(e) {}
  try { fs.unlinkSync(wsTestScript); } catch(e) {}

  if (result.success) {
    isConnected = true;
    currentStrategy = result.strategy;
    connectedSince = Date.now();
    strategyProgress = null;
    clearError();
    // Save as last working strategy
    const s = loadSettings(); s.lastWorkingStrategy = result.strategy; saveSettings(s);
    updateTrayMenu();
    sendLog({ type: 'success', message: `Стратегия ${result.strategy} работает!` });
    sendStatus({ searching: false });
    // Monitor winws.exe since we can't track the elevated process directly
    startWinwsMonitor();
    return { success: true, strategy: result.strategy };
  } else {
    lastError = result.error;
    lastErrorCode = result.errorCode || 'ALL_STRATEGIES_FAILED';
    strategyProgress = null;
    sendLog({ type: 'error', message: result.error });
    sendStatus({ searching: false });
    return { success: false, error: result.error };
  }
}

// ============= PROXY CONTROL =============

// Ad-hoc signing is the standard remedy when Apple Silicon refuses to run a
// binary the app compiled or downloaded itself. Only attempted after an actual
// SIGKILL, never pre-emptively.
async function adHocSignBinary(binaryPath) {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', binaryPath], {
      stdio: 'pipe',
      timeout: 20000
    });
    return true;
  } catch (e) {
    return false;
  }
}

// Kill tpws instances this app left behind (previous crash, or a strategy that
// ignored SIGTERM). `pkill -x` matches the executable name exactly, so it can
// never hit an unrelated process that merely has "tpws" somewhere in its
// command line.
async function killStrayTpws() {
  if (process.platform !== 'darwin') return;
  try { execSync('pkill -x tpws 2>/dev/null; exit 0', { stdio: 'pipe', shell: '/bin/sh' }); } catch (e) {}
  await new Promise(resolve => setTimeout(resolve, 300));
  try { execSync('pkill -9 -x tpws 2>/dev/null; exit 0', { stdio: 'pipe', shell: '/bin/sh' }); } catch (e) {}
}

// Windows counterpart. `taskkill` returns before the image is actually gone, and
// WinDivert filters belonging to a not-yet-dead winws make the next strategy look
// broken — the same false "не запустился" the macOS side had, from a different
// cause. Wait for the process list to confirm it left.
async function killStrayWinws(timeoutMs = 5000) {
  if (process.platform !== 'win32') return;
  try { execSync('taskkill /F /IM winws.exe', { stdio: 'pipe', timeout: 5000 }); } catch (e) {}

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let stillRunning = false;
    try {
      const listed = execSync('tasklist /FI "IMAGENAME eq winws.exe" /NH', {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000
      }).toString();
      stillRunning = /winws\.exe/i.test(listed);
    } catch (e) {
      // Cannot tell — do not spin on an unavailable tasklist.
      return;
    }
    if (!stillRunning || Date.now() >= deadline) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

// Public entry point: holds the "one search at a time" lock and always releases
// it. The search itself lives in runProxyStartAttempt().
async function startProxy() {
  if (isSearching) {
    lastError = 'Подбор стратегии уже идёт';
    lastErrorCode = 'SEARCH_IN_PROGRESS';
    sendStatus();
    return { success: false, error: lastError };
  }

  isSearching = true;
  cancelRequested = false;
  updateTrayMenu();
  try {
    return await runProxyStartAttempt();
  } finally {
    isSearching = false;
    updateTrayMenu();
  }
}

async function runProxyStartAttempt() {
  if (isConnected || proxyProcess) {
    lastError = 'Подключение уже активно';
    lastErrorCode = 'ALREADY_RUNNING';
    sendStatus();
    return { success: false, error: 'Already running' };
  }

  // Clear previous errors
  clearError();
  strategyProgress = null;
  sendLog({ type: 'info', message: 'Начало подключения...' });

  if (process.platform === 'win32' && app.isPackaged && !isWindowsBundleCurrent()) {
    try {
      const bundledDir = path.join(process.resourcesPath, 'bin');
      if (installBundledFlowsealBundle(bundledDir, getResourcePath())) {
        sendLog({ type: 'info', message: `Windows runtime Flowseal ${FLOWSEAL_BUNDLE_VERSION} установлен из приложения` });
      }
    } catch (e) {
      sendLog({ type: 'warning', message: `Не удалось распаковать встроенный Windows runtime: ${e.message}` });
    }
  }

  const binaryPath = getBinaryPath();

  const binaryMissing = !binaryPath || !fs.existsSync(binaryPath);
  const windowsBundleStale = process.platform === 'win32' && !isWindowsBundleCurrent();
  const macBinaryInvalid = process.platform === 'darwin' && !isMachOBinaryRunnable(binaryPath);

  // Refresh existing Windows installs too: older runtimes do not include the
  // Discord/STUN payload used by the current Flowseal strategies.
  if (binaryMissing || windowsBundleStale || macBinaryInvalid) {
    const downloadMessage = windowsBundleStale
      ? `Обновляю Windows runtime до Flowseal ${FLOWSEAL_BUNDLE_VERSION}...`
      : 'Бинарник не найден, начинаю скачивание...';
    sendLog({ type: 'info', message: downloadMessage });
    const downloadResult = await downloadAndExtractBinaries();
    if (!downloadResult.success) {
      lastError = `Не удалось скачать бинарники: ${downloadResult.error}`;
      lastErrorCode = 'DOWNLOAD_FAILED';
      sendLog({ type: 'error', message: lastError });
      sendStatus();
      return { success: false, error: lastError };
    }
    sendLog({ type: 'success', message: 'Бинарники скачаны успешно' });
  }
  
  // Verify binary exists after download
  const finalBinaryPath = getBinaryPath();
  if (!finalBinaryPath || !fs.existsSync(finalBinaryPath)) {
    lastError = 'Бинарник не найден после скачивания';
    lastErrorCode = 'NO_BINARY';
    sendLog({ type: 'error', message: lastError });
    sendStatus();
    return { success: false, error: lastError };
  }

  // Check network availability on macOS
  if (process.platform === 'darwin') {
    const services = getActiveNetworkServices();
    if (services.length === 0) {
      lastError = 'Не обнаружено активных сетевых подключений';
      lastErrorCode = 'NETWORK_UNAVAILABLE';
      sendLog({ type: 'error', message: lastError });
      sendStatus();
      return { success: false, error: lastError };
    }
    // A crash or forced quit can leave tpws holding port 1080, which would make
    // every strategy in this run fail to bind.
    await killStrayTpws();

    // Verify tpws can execute at all before blaming the strategies for failing.
    let runCheck = await probeBinaryRuns(finalBinaryPath);
    if (!runCheck.ok && runCheck.signal === 'SIGKILL') {
      sendLog({ type: 'warning', message: 'tpws убит системой — подписываю бинарник ad-hoc и пробую снова' });
      if (await adHocSignBinary(finalBinaryPath)) {
        runCheck = await probeBinaryRuns(finalBinaryPath);
        if (runCheck.ok) {
          sendLog({ type: 'success', message: 'Подпись исправлена, tpws запускается' });
        }
      }
    }
    if (!runCheck.ok) {
      lastError = `tpws не запускается: ${runCheck.reason}. Перебор стратегий не поможет — проблема в самом бинарнике.`;
      lastErrorCode = 'BINARY_NOT_EXECUTABLE';
      sendLog({ type: 'error', message: lastError });
      strategyProgress = null;
      sendStatus({ searching: false });
      return { success: false, error: lastError };
    }

    // Set clean DNS (1.1.1.1, 8.8.8.8) to avoid ISP DNS poisoning for Discord
    setCleanDns(services);
    sendLog({ type: 'info', message: 'DNS установлен на 1.1.1.1 / 8.8.8.8 (защита от подмены)' });
    // Block QUIC (UDP 443) so YouTube uses TCP which goes through tpws
    await enableQuicBlock();
  }

  sendStatus({ searching: true });

  const allStrategies = getStrategiesForPlatform();
  
  // Check if user selected a specific strategy
  const settings = loadSettings();
  let strategies = allStrategies;
  let singleStrategy = false;
  // True when strategies[0] is a deliberate choice — the user's pick, or the one
  // that worked last time — rather than just the head of the default list. Those
  // get the generous probe budget; the rest get the impatient one.
  let firstIsPreferred = false;

  if (settings.selectedStrategy && settings.selectedStrategy !== 'auto') {
    const selected = allStrategies.find(s => s.name === settings.selectedStrategy);
    if (selected) {
      strategies = [selected];
      singleStrategy = true;
      firstIsPreferred = true;
      sendLog({ type: 'info', message: `Выбрана стратегия: ${selected.name}` });
    }
  } else if (settings.lastWorkingStrategy) {
    // Try last working strategy first, then all others
    const lastWorking = allStrategies.find(s => s.name === settings.lastWorkingStrategy);
    if (lastWorking) {
      const rest = allStrategies.filter(s => s.name !== settings.lastWorkingStrategy);
      strategies = [lastWorking, ...rest];
      firstIsPreferred = true;
      sendLog({ type: 'info', message: `Сначала пробуем последнюю рабочую: ${lastWorking.name}` });
    }
  }
  
  const totalStrategies = strategies.length;

  // Windows: the engine is about to be run with administrator rights out of a
  // directory the user can write to. Check it against the copy shipped inside
  // the installation before that happens, not only once at download time.
  if (process.platform === 'win32') {
    const integrity = await ensureWindowsRuntimeIntegrity();
    if (!integrity.ok) {
      lastError = integrity.error;
      lastErrorCode = 'RUNTIME_INTEGRITY';
      sendLog({ type: 'error', message: integrity.error });
      sendStatus({ searching: false });
      return { success: false, error: integrity.error };
    }
  }

  sendLog({ type: 'info', message: `Начинаю перебор ${totalStrategies} стратегий...` });

  // macOS: update hosts for Discord voice servers (all regions)
  if (process.platform === 'darwin') {
    try {
      const hostsResult = await updateHostsMacOS();
      if (hostsResult.success && !hostsResult.alreadyExists) {
        sendLog({ type: 'info', message: 'Hosts обновлён для Discord голоса (все регионы)' });
      }
    } catch (e) {
      sendLog({ type: 'warning', message: 'Не удалось обновить hosts — голос Discord может не работать' });
    }
    // Flush DNS cache so new hosts entries and clean DNS take effect immediately
    flushDnsCache();
    sendLog({ type: 'info', message: 'DNS кэш очищен' });

    // Clear Discord Electron cache on macOS (like we do on Windows)
    try {
      const discordBase = path.join(process.env.HOME || '', 'Library', 'Application Support', 'discord');
      for (const d of ['Cache', 'Code Cache', 'GPUCache']) {
        const full = path.join(discordBase, d);
        if (fs.existsSync(full)) fs.rmSync(full, { recursive: true });
      }
      sendLog({ type: 'info', message: 'Кэш Discord очищен' });
    } catch (e) {}
  }

  // Windows: update hosts and clear Discord cache at each connection start, then check admin
  if (process.platform === 'win32') {
    const tempDir = app.getPath('temp');
    await prepareHostsUpdateForBatch(tempDir);
    if (isRunningAsAdmin()) {
      const psPath = path.join(tempDir, 'unblock-pro-update-hosts.ps1');
      if (fs.existsSync(psPath)) {
        try { execSync(`powershell -ExecutionPolicy Bypass -NoProfile -File "${psPath}"`, { stdio: 'pipe' }); } catch (e) {}
      }
      const discordBase = path.join(process.env.APPDATA || '', 'discord');
      for (const d of ['Cache', 'Code Cache', 'GPUCache']) {
        try {
          const full = path.join(discordBase, d);
          if (fs.existsSync(full)) fs.rmSync(full, { recursive: true });
        } catch (e) {}
      }
      sendLog({ type: 'info', message: 'Hosts и кэш Discord обновлены' });
    }
    // If not running as admin, use elevated batch approach (single UAC prompt)
    if (!isRunningAsAdmin()) {
      sendLog({ type: 'info', message: 'Нет прав администратора — запуск через UAC...' });
      return await startProxyWindowsElevated(finalBinaryPath, strategies, totalStrategies, firstIsPreferred);
    }

    try {
      execSync('taskkill /F /IM winws.exe', { stdio: 'pipe' });
      await new Promise(resolve => setTimeout(resolve, 1500));
      sendLog({ type: 'info', message: 'Завершён предыдущий процесс winws.exe' });
    } catch (e) {
      // No existing process — that's fine
    }

    // Pre-flight check: verify WinDivert driver files exist
    const binDirectory = path.dirname(finalBinaryPath);
    const driverFile = path.join(binDirectory, 'WinDivert64.sys');
    const dllFile = path.join(binDirectory, 'WinDivert.dll');
    if (!fs.existsSync(driverFile) || !fs.existsSync(dllFile)) {
      sendLog({ type: 'warning', message: 'WinDivert файлы отсутствуют, перекачиваю бинарники...' });
      try { fs.unlinkSync(finalBinaryPath); } catch(e) {}
      const dlResult = await downloadAndExtractBinaries();
      if (!dlResult.success) {
        lastError = 'Не удалось скачать WinDivert. Добавьте папку приложения в исключения антивируса.';
        lastErrorCode = 'WINDIVERT_MISSING';
        sendLog({ type: 'error', message: lastError });
        strategyProgress = null;
        sendStatus({ searching: false });
        return { success: false, error: lastError };
      }
      if (!fs.existsSync(driverFile)) {
        lastError = 'WinDivert64.sys удалён антивирусом. Добавьте папку в исключения Windows Defender:\n' + binDirectory;
        lastErrorCode = 'WINDIVERT_BLOCKED';
        sendLog({ type: 'error', message: lastError });
        strategyProgress = null;
        sendStatus({ searching: false });
        return { success: false, error: lastError };
      }
    }
  }

  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];
    // Only the deliberately-preferred first strategy waits the long budget. For
    // the rest, a hung probe used to cost 15s each — over ~50 strategies that was
    // most of a quarter-hour spent waiting on answers that never come.
    const timeouts = (i === 0 && firstIsPreferred) ? PATIENT_TIMEOUTS : PROBE_TIMEOUTS;

    if (cancelRequested) break;

    // Update strategy progress
    strategyProgress = { current: i + 1, total: totalStrategies, name: strategy.name };
    sendStatus({ searching: true });
    sendLog({ type: 'info', message: `[${i + 1}/${totalStrategies}] Тестирование: ${strategy.name}` });
    
    // Stop any previous test process and wait for it to be reaped. Returning
    // early here used to leave an orphan holding the port, which made every
    // later strategy look like it "failed to start".
    if (proxyProcess) {
      const previous = proxyProcess;
      proxyProcess = null;
      await terminateChild(previous);
    }

    try {
      if (process.platform === 'darwin') {
        // The port must be free before spawning, otherwise tpws cannot bind and
        // the probe below would succeed against a leftover listener instead.
        if (!(await waitForPortState(TPWS_PORT, false, 5000))) {
          await killStrayTpws();
          if (!(await waitForPortState(TPWS_PORT, false, 3000))) {
            // A foreign listener on 1080 will not free itself, so trying the
            // remaining strategies would spend ~8s each to arrive at the same
            // wall and then report the misleading "ни одна стратегия не
            // сработала". Name the real obstacle instead.
            lastError = `Порт ${TPWS_PORT} занят другим процессом (возможно, другой VPN или прокси) — закройте его и попробуйте снова`;
            lastErrorCode = 'PORT_IN_USE';
            sendLog({ type: 'error', message: lastError });
            strategyProgress = null;
            sendStatus({ searching: false });
            return { success: false, error: lastError };
          }
        }

        // macOS - run tpws as SOCKS proxy
        const generation = ++proxyGeneration;
        const child = spawn(finalBinaryPath, strategy.args, {
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        proxyProcess = child;

        let stderrTail = '';
        child.stdout.on('data', () => {});
        child.stderr.on('data', (data) => {
          stderrTail = (stderrTail + data.toString()).slice(-500);
        });
        child.on('error', () => {});

        child.on('close', (code, signal) => {
          // A process from an earlier attempt must not clear the handle that now
          // belongs to a newer one.
          if (generation !== proxyGeneration) return;
          proxyProcess = null;
          if (isConnected) {
            isConnected = false;
            const prevStrategy = currentStrategy;
            currentStrategy = null;
            connectedSince = null;
            disconnectReason = code === 0 ? 'PROCESS_EXITED' : 'PROCESS_CRASHED';
            const exitDetail = code === null ? `сигнал: ${signal || 'неизвестен'}` : `код: ${code}`;
            lastError = code === 0
              ? 'Процесс обхода завершился'
              : `Процесс обхода завершился с ошибкой (${exitDetail})`;
            lastErrorCode = 'PROCESS_CRASHED';
            disableSystemProxy();
            restoreDns();
            updateTrayMenu();
            sendLog({ type: 'error', message: `Стратегия ${prevStrategy} прекратила работу (${exitDetail})` });
            sendStatus();
          }
        });

        // Wait for tpws to bind, instead of hoping 2s was enough. Aborts the
        // moment the process dies, so an instantly-failing binary costs
        // milliseconds per strategy rather than the full timeout.
        const listening = await waitForPortState(TPWS_PORT, true, 8000, {
          shouldAbort: () => hasExited(child)
        });

        if (hasExited(child)) {
          sendLog({
            type: 'warning',
            message: `${strategy.name}: процесс не запустился — ${describeChildExit(child, stderrTail)}`
          });
          if (generation === proxyGeneration) proxyProcess = null;
          continue; // Process died, try next strategy
        }

        if (!listening) {
          sendLog({ type: 'warning', message: `${strategy.name}: порт ${TPWS_PORT} не доступен` });
          proxyProcess = null;
          await terminateChild(child);
          continue; // tpws not listening, skip this strategy
        }

        // Enable system SOCKS proxy so all traffic goes through tpws
        enableSystemProxy(TPWS_PORT);

        // Actually test if connection works through the proxy
        const works = await testProxyConnection(TPWS_PORT, timeouts);

        // The probes above take seconds; the user may have disconnected or quit
        // in the meantime. Committing now would switch the system proxy back on
        // behind their back.
        if (cancelRequested) {
          disableSystemProxy();
          proxyProcess = null;
          await terminateChild(child);
          break;
        }

        if (works) {
          // Strategy verified working
          isConnected = true;
          currentStrategy = strategy.name;
          connectedSince = Date.now();
          strategyProgress = null;
          clearError();
          // Save as last working strategy
          const s = loadSettings(); s.lastWorkingStrategy = strategy.name; saveSettings(s);
          updateTrayMenu();
          sendLog({ type: 'success', message: `Стратегия ${strategy.name} работает!` });
          sendStatus({ searching: false });
          return { success: true, strategy: strategy.name };
        } else {
          // Strategy didn't work — clean up and try next. Wait for the exit so
          // the next iteration starts with a free port.
          sendLog({ type: 'warning', message: `${strategy.name}: не прошла проверку соединения` });
          disableSystemProxy();
          proxyProcess = null;
          await terminateChild(child);
          continue;
        }

      } else if (process.platform === 'win32') {
        // Windows - winws.exe intercepts traffic at driver level via WinDivert
        // No proxy configuration needed — it modifies packets in-flight
        const binDirectory = path.dirname(finalBinaryPath);

        // Wait for any leftover winws to really be gone. Blindly firing taskkill
        // and pausing 500ms was the Windows twin of the macOS orphan bug.
        await killStrayWinws();

        // Start winws.exe directly (app runs as admin via manifest)
        const generation = ++proxyGeneration;
        let spawnError = null;
        let winwsStderr = '';
        let child;

        try {
          child = spawn(finalBinaryPath, strategy.args, {
            cwd: binDirectory,
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
          });
        } catch (e) {
          sendLog({ type: 'warning', message: `${strategy.name}: не удалось запустить — ${e.message}` });
          continue;
        }
        proxyProcess = child;

        child.stderr.on('data', (data) => { winwsStderr = (winwsStderr + data.toString()).slice(-500); });
        child.stdout.on('data', () => {});
        child.on('error', (err) => { spawnError = err; });

        // Let winws install its WinDivert filters, but stop waiting the moment it
        // dies: a strategy the driver rejects instantly used to cost the full 3s,
        // on every one of ~50 attempts.
        await waitForStartupWindow(child, WINWS_STARTUP_MS);

        if (spawnError || hasExited(child)) {
          const errMsg = spawnError
            ? spawnError.message
            : describeChildExit(child, winwsStderr);
          sendLog({ type: 'warning', message: `${strategy.name}: процесс не запустился — ${errMsg}` });
          if (generation === proxyGeneration) proxyProcess = null;
          continue;
        }

        // winws is running — test if DPI bypass actually works
        const works = await testDirectConnection(timeouts);

        if (cancelRequested) {
          proxyProcess = null;
          await terminateChild(child);
          await killStrayWinws();
          break;
        }

        if (works) {
          // Strategy verified working!
          isConnected = true;
          currentStrategy = strategy.name;
          connectedSince = Date.now();
          strategyProgress = null;
          clearError();
          // Save as last working strategy
          const s = loadSettings(); s.lastWorkingStrategy = strategy.name; saveSettings(s);
          
          // Set up close handler for the connected process. Generation-gated for
          // the same reason as the macOS handler: on a quick reconnect the old
          // process's close event would otherwise clear the handle that now
          // belongs to the new connection and report the live one as crashed.
          child.removeAllListeners('close');
          child.on('close', () => {
            if (generation !== proxyGeneration) return;
            proxyProcess = null;
            if (isConnected) {
              isConnected = false;
              const prevStrategy = currentStrategy;
              currentStrategy = null;
              connectedSince = null;
              disconnectReason = 'PROCESS_CRASHED';
              // Not `код: ${code}`: a process killed by a signal has no exit code,
              // and printing the raw null is what made these reports unusable.
              lastError = `Процесс обхода завершился неожиданно (${describeChildExit(child, winwsStderr)})`;
              lastErrorCode = 'PROCESS_CRASHED';
              updateTrayMenu();
              sendLog({ type: 'error', message: `Стратегия ${prevStrategy} прекратила работу` });
              sendStatus();
            }
          });

          updateTrayMenu();
          sendLog({ type: 'success', message: `Стратегия ${strategy.name} работает!` });
          sendStatus({ searching: false });
          return { success: true, strategy: strategy.name };
        } else {
          // Strategy didn't work — wait for it to actually exit before the next
          // one starts, so its WinDivert filters cannot blame the successor.
          sendLog({ type: 'warning', message: `${strategy.name}: не прошла проверку соединения` });
          proxyProcess = null;
          await terminateChild(child);
          continue;
        }
      }

    } catch (error) {
      sendLog({ type: 'warning', message: `${strategy.name}: ошибка — ${error.message}` });
      // Strategy failed, try next
    }
  }

  if (cancelRequested) {
    strategyProgress = null;
    sendLog({ type: 'info', message: 'Подбор стратегии отменён' });
    sendStatus({ searching: false });
    return { success: false, error: 'Отменено' };
  }

  // All strategies failed
  lastError = 'Ни одна стратегия не сработала. Попробуйте позже или обратитесь в поддержку';
  lastErrorCode = 'ALL_STRATEGIES_FAILED';
  strategyProgress = null;
  sendLog({ type: 'error', message: `Все ${totalStrategies} стратегий не сработали` });
  sendStatus({ searching: false });
  return { success: false, error: lastError };
}

function stopProxy() {
  // Tell a running search to stand down. It yields on every probe, so without
  // this it would carry on spawning processes after the user disconnected or quit.
  cancelRequested = true;

  // Disable system proxy FIRST (before killing tpws)
  disableSystemProxy();
  
  // Restore original DNS settings
  restoreDns();
  
  // Restore QUIC (remove pf block)
  disableQuicBlock();
  
  // Stop winws monitor if running
  stopWinwsMonitor();
  
  // Invalidate pending close handlers so a shutting-down process cannot report
  // itself as an unexpected crash.
  proxyGeneration++;
  if (proxyProcess) {
    try { proxyProcess.kill('SIGTERM'); } catch (e) {}
    proxyProcess = null;
  }

  // Kill all related processes synchronously for reliable cleanup
  if (process.platform === 'darwin') {
    try { execSync('pkill -x tpws 2>/dev/null; exit 0', { stdio: 'pipe', shell: '/bin/sh' }); } catch (e) {}
  } else if (process.platform === 'win32') {
    try {
      execSync('taskkill /F /IM winws.exe', { stdio: 'pipe', timeout: 3000 });
    } catch (e) {
      // If direct kill fails (elevated process), try elevated taskkill
      try {
        execSync('powershell -command "Start-Process taskkill -ArgumentList \'/F\',\'/IM\',\'winws.exe\' -Verb RunAs -WindowStyle Hidden -Wait"', { stdio: 'pipe', timeout: 5000 });
      } catch (e2) {}
    }
  }

  isConnected = false;
  currentStrategy = null;
  connectedSince = null;
  strategyProgress = null;
  clearError();
  updateTrayMenu();
  sendLog({ type: 'info', message: 'Отключено пользователем' });
  sendStatus();
  
  return { success: true };
}

// ============= WINDOW & TRAY =============

function createWindow() {
  const appIconPath = path.join(__dirname, 'icons', 'app-icon.png');
  const windowIcon = fs.existsSync(appIconPath) ? nativeImage.createFromPath(appIconPath) : undefined;

  mainWindow = new BrowserWindow({
    width: 420,
    // The promo card lives outside .main-content, so it permanently consumes
    // ~145px that never scrolls away. Measured in the real renderer: at 560px
    // the connect button itself ended up 8px below the fold, and "Свои домены"
    // 216px below it. 680/600 keeps the connect button and the domains header
    // visible at every allowed size.
    height: 680,
    minWidth: 380,
    minHeight: 600,
    frame: false,
    transparent: true,
    resizable: true,
    show: false,
    icon: windowIcon,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
  const showTimeout = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 5000);
  mainWindow.once('show', () => clearTimeout(showTimeout));

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const iconDir = path.join(__dirname, 'icons');
  let trayIcon;

  if (process.platform === 'darwin') {
    // macOS: a monochrome template image, which the system recolours for a light
    // or dark menu bar. A coloured icon looks foreign there, and one that ignores
    // the theme becomes invisible on one of the two.
    //
    // No resize(): createFromPath already picked up tray-16@2x.png for retina,
    // and resizing collapses the image to the single 1x representation, which is
    // what made the icon look soft on retina Macs.
    trayIcon = nativeImage.createFromPath(path.join(iconDir, 'tray-16.png'));
    trayIcon.setTemplateImage(true);
  } else {
    // Windows: 32x32 colored icon for system tray
    trayIcon = nativeImage.createFromPath(path.join(iconDir, 'tray-32.png'));
  }

  // Fallback: if PNG failed to load, create a simple canvas-based icon
  if (trayIcon.isEmpty()) {
    const size = process.platform === 'darwin' ? 16 : 32;
    trayIcon = nativeImage.createEmpty();
    try {
      const fallbackPng = path.join(iconDir, 'tray-64.png');
      if (fs.existsSync(fallbackPng)) {
        trayIcon = nativeImage.createFromPath(fallbackPng).resize({ width: size, height: size });
      }
    } catch (e) {}
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('UnblockPro');

  updateTrayMenu();

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

// ============= AUTO-UPDATER =============

function setupAutoUpdater() {
  if (isDev) return; // Don't check for updates in dev mode
  
  const settings = loadSettings();
  const { manualInstall } = resolveUpdateMode({ platform: process.platform, autoUpdate: settings.autoUpdate });
  autoUpdater.autoDownload = !manualInstall;
  autoUpdater.autoInstallOnAppQuit = !manualInstall;
  
  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus('checking');
  });
  
  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus(manualInstall ? 'manual-available' : 'available', info.version);
  });
  
  autoUpdater.on('update-not-available', () => {
    sendUpdateStatus('not-available');
  });
  
  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('update-download-progress', {
        percent: Math.round(progress.percent),
        transferred: progress.transferred,
        total: progress.total
      });
    }
  });
  
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus('downloaded', info.version);
  });
  
  autoUpdater.on('error', () => {
    sendUpdateStatus('error');
  });
  
  // Check for updates after a short delay
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5000);
}

function sendUpdateStatus(status, version = null) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('update-status', { status, version });
  }
}

// ============= IPC HANDLERS =============

ipcMain.handle('start-proxy', async () => {
  return await startProxy();
});

ipcMain.handle('stop-proxy', () => {
  return stopProxy();
});

ipcMain.handle('download-binaries', async () => {
  return await downloadAndExtractBinaries();
});

ipcMain.handle('get-status', () => {
  return { 
    connected: isConnected,
    downloading: isDownloading,
    strategy: currentStrategy,
    binaryExists: fs.existsSync(getBinaryPath() || ''),
    error: lastError,
    errorCode: lastErrorCode,
    disconnectReason: disconnectReason,
    connectedSince: connectedSince,
    strategyProgress: strategyProgress
  };
});

ipcMain.handle('get-logs', () => {
  return logEntries;
});

ipcMain.handle('clear-error', () => {
  clearError();
  sendStatus();
  return { success: true };
});

ipcMain.handle('minimize-window', () => mainWindow.minimize());
ipcMain.handle('close-window', () => mainWindow.hide());

ipcMain.handle('open-external', (event, url) => {
  const { shell } = require('electron');
  if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url);
  }
});

// Update hosts file for Discord voice — Flowseal: "для подключения к голосовому чату Discord"
const HOSTS_URL = 'https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/main/.service/hosts';
const HOSTS_MARKER = '# UnblockPro Discord/Telegram hosts';

// Embedded fallback hosts data — used when GitHub download fails.
// Includes Telegram web hosts and Discord voice servers (finland10000-10199.discord.media).
function generateFallbackHostsData() {
  const lines = [];
  // Telegram web
  const tgDomains = [
    'telegram.me', 'telegram.dog', 'telegram.space', 'telesco.pe', 'tg.dev',
    'kws2.web.telegram.org', 'kws2-1.web.telegram.org', 'kws1-1.web.telegram.org',
    'kws1.web.telegram.org', 'telegram.org', 't.me', 'api.telegram.org',
    'pluto.web.telegram.org', 'pluto-1.web.telegram.org', 'flora.web.telegram.org',
    'td.telegram.org', 'venus.web.telegram.org', 'web.telegram.org',
    'kws4-1.web.telegram.org', 'kws4.web.telegram.org', 'kws5-1.web.telegram.org',
    'kws5.web.telegram.org', 'zws1-1.web.telegram.org', 'zws1.web.telegram.org',
    'zws2-1.web.telegram.org', 'zws2.web.telegram.org', 'zws4-1.web.telegram.org',
    'zws5-1.web.telegram.org', 'zws5.web.telegram.org'
  ];
  for (const d of tgDomains) lines.push(`149.154.167.220 ${d}`);
  lines.push('');

  // Discord voice servers — ALL regions, ports 10000-10099
  const voiceIp = '104.25.158.178';
  const regions = [
    'finland', 'russia',
    'us-east', 'us-west', 'us-south', 'us-central',
    'eu-central', 'eu-west',
    'brazil', 'hongkong', 'india', 'japan', 'singapore',
    'southafrica', 'south-korea', 'sydney',
    'bucharest', 'tel-aviv', 'newark', 'milan',
    'rotterdam', 'madrid', 'stockholm', 'buenos-aires',
    'atlanta', 'seattle', 'santa-clara', 'oregon'
  ];
  for (const region of regions) {
    for (let i = 10000; i <= 10099; i++) {
      lines.push(`${voiceIp} ${region}${i}.discord.media`);
    }
  }
  return lines.join('\n');
}

function getHostsPath() {
  if (process.platform === 'darwin') return '/etc/hosts';
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
}
// The elevated script only needs to move an already-validated file into place.
// Block detection, removal and the integrity check all happen in Node, where
// they are unit-tested, instead of as PowerShell string surgery.
function buildHostsUpdateScript(hostsPath, tempFile) {
  return [
    '$hostsPath = "' + hostsPath.replace(/"/g, '""') + '"',
    '$newPath = "' + tempFile.replace(/"/g, '""') + '"',
    'if (-not (Test-Path -LiteralPath $newPath)) { exit 1 }',
    'if (-not (Test-Path -LiteralPath $hostsPath)) { exit 2 }',
    'try { Copy-Item -LiteralPath $hostsPath -Destination ($hostsPath + ".unblockpro.bak") -Force } catch {}',
    'try { [System.IO.File]::Copy($newPath, $hostsPath, $true) } catch { exit 3 }',
    'exit 0'
  ].join('; ');
}
async function prepareHostsUpdateForBatch(tempDir) {
  const tempFile = path.join(tempDir, 'unblock-pro-hosts-discord.txt');
  const psScriptPath = path.join(tempDir, 'unblock-pro-update-hosts.ps1');

  // latin1 round-trips arbitrary single-byte content unchanged, so a user's
  // existing hosts entries survive byte-for-byte. Everything we add is ASCII.
  let currentHosts = '';
  try {
    currentHosts = fs.readFileSync(getHostsPath(), 'latin1');
    if (hasCurrentBlock(currentHosts, HOSTS_MARKER, app.getVersion())) {
      return { success: true, psScriptPath: null };
    }
  } catch (e) {}

  // Try downloading latest from GitHub
  const downloaded = await new Promise((resolve) => {
    const req = https.get(HOSTS_URL, { family: 4, lookup: ipv4Lookup, timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) { resolve(null); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });

  // Use downloaded data or fall back to embedded data
  const hostsData = downloaded || generateFallbackHostsData();
  const nextHosts = replaceMarkedBlock(currentHosts, HOSTS_MARKER, app.getVersion(), hostsData);
  const ownHostnames = collectBlockHostnames(hostsData);

  if (!isSafeHostsRewrite(currentHosts, nextHosts, HOSTS_MARKER, { ownHostnames })) {
    sendLog({ type: 'warning', message: 'Пропускаю обновление hosts — проверка целостности не пройдена' });
    return { success: false, psScriptPath: null };
  }

  try {
    fs.writeFileSync(tempFile, nextHosts, 'latin1');
    const script = buildHostsUpdateScript(getHostsPath(), tempFile);
    fs.writeFileSync(psScriptPath, script, 'utf8');
    return { success: true, psScriptPath };
  } catch (e) {
    return { success: false, psScriptPath: null };
  }
}
async function updateHostsMacOS() {
  const hostsPath = '/etc/hosts';
  let current = '';
  try {
    current = fs.readFileSync(hostsPath, 'latin1');
    // Version-aware: a block written by an older release is refreshed instead of
    // trusted forever. Discord voice IPs rotate, and a stale pinned address is
    // exactly what leaves voice stuck on "connecting".
    if (hasCurrentBlock(current, HOSTS_MARKER, app.getVersion())) {
      return { success: true, alreadyExists: true };
    }
  } catch (e) {}

  let hostsData;
  try {
    hostsData = await new Promise((resolve) => {
      const req = https.get(HOSTS_URL, { family: 4, lookup: ipv4Lookup, timeout: 10000 }, (res) => {
        if (res.statusCode !== 200) { resolve(null); return; }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  } catch (e) {}
  hostsData = hostsData || generateFallbackHostsData();

  const tempFile = path.join(app.getPath('temp'), 'unblock-pro-hosts-add.txt');
  const nextHosts = replaceMarkedBlock(current, HOSTS_MARKER, app.getVersion(), hostsData);
  const ownHostnames = collectBlockHostnames(hostsData);

  // Replacing the whole file is the only way to drop a stale block, so refuse
  // unless every system and user line provably survives.
  if (!isSafeHostsRewrite(current, nextHosts, HOSTS_MARKER, { ownHostnames })) {
    sendLog({ type: 'warning', message: 'Пропускаю обновление hosts — проверка целостности не пройдена' });
    return { success: false, error: 'unsafe hosts rewrite' };
  }

  fs.writeFileSync(tempFile, nextHosts, 'latin1');

  return new Promise((resolve) => {
    // Back up first: if anything goes wrong the user has /etc/hosts.unblockpro.bak.
    sudo.exec(
      `/bin/cp "${hostsPath}" "${hostsPath}.unblockpro.bak" 2>/dev/null; /bin/cat "${tempFile}" > "${hostsPath}" && rm -f "${tempFile}"`,
      { name: 'UnblockPro' },
      (error) => {
        try { fs.unlinkSync(tempFile); } catch (e) {}
        if (error) {
          resolve({ success: false, error: error.message || 'Permission denied' });
        } else {
          sendLog({ type: 'success', message: 'Hosts обновлён для Discord/Telegram' });
          resolve({ success: true });
        }
      }
    );
  });
}

ipcMain.handle('update-hosts-for-discord', async () => {
  if (process.platform === 'darwin') {
    return await updateHostsMacOS();
  }
  const tempDir = app.getPath('temp');
  const tempFile = path.join(tempDir, 'unblock-pro-hosts-discord.txt');
  const hostsPath = getHostsPath();
  const psScriptPath = path.join(tempDir, 'unblock-pro-update-hosts.ps1');
  return new Promise((resolve) => {
    const req = https.get(HOSTS_URL, { family: 4, lookup: ipv4Lookup, timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        resolve({ success: false, error: `HTTP ${res.statusCode}` });
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          fs.writeFileSync(tempFile, body, 'utf8');
          const psScript = buildHostsUpdateScript(hostsPath, tempFile);
          fs.writeFileSync(psScriptPath, psScript, 'utf8');
          sendLog({ type: 'info', message: 'Запрос прав для записи в hosts...' });
          sudo.exec(`powershell -ExecutionPolicy Bypass -NoProfile -File "${psScriptPath.replace(/\\/g, '\\\\')}"`, { name: 'UnblockPro update hosts' }, (err) => {
            try { fs.unlinkSync(psScriptPath); } catch (e) {}
            if (err && (err.message || '').toLowerCase().includes('cancel')) {
              resolve({ success: false, error: 'Отклонено' });
              return;
            }
            if (err) {
              resolve({ success: false, error: err.message || 'Ошибка' });
              return;
            }
            sendLog({ type: 'success', message: 'Hosts обновлён для Discord/Telegram' });
            resolve({ success: true, hostsPath });
          });
        } catch (e) {
          resolve({ success: false, error: e.message });
        }
      });
    });
    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Timeout' }); });
  });
});

ipcMain.handle('clear-discord-cache', () => {
  const discordBase = path.join(process.env.APPDATA || '', 'discord');
  const dirs = ['Cache', 'Code Cache', 'GPUCache'];
  let cleared = 0;
  for (const d of dirs) {
    const full = path.join(discordBase, d);
    try {
      if (fs.existsSync(full)) {
        fs.rmSync(full, { recursive: true });
        cleared++;
      }
    } catch (e) {}
  }
  sendLog({ type: 'info', message: cleared ? `Очищен кэш Discord (${cleared} папок)` : 'Кэш Discord не найден или уже пуст' });
  return { success: true, cleared };
});

ipcMain.handle('get-system-info', () => ({
  platform: process.platform,
  arch: process.arch,
  version: app.getVersion(),
  binaryExists: fs.existsSync(getBinaryPath() || ''),
  binaryPath: getBinaryPath()
}));

ipcMain.handle('get-settings', () => {
  return loadSettings();
});

ipcMain.handle('install-update', async () => {
  if (isDev) {
    return { ok: false, error: 'В режиме разработки обновление недоступно' };
  }

  const updateSettings = loadSettings();
  const { manualInstall } = resolveUpdateMode({ platform: process.platform, autoUpdate: updateSettings.autoUpdate });
  if (manualInstall) {
    return {
      ok: false,
      manual: true,
      url: 'https://github.com/by-sonic/unblock-pro/releases/latest'
    };
  }

  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('update-status', { status: 'restarting' });
  }

  // Clean up proxy BEFORE triggering quit — prevents before-quit from blocking
  // with heavy execSync calls (taskkill, pkill, networksetup).
  try { stopProxy(); } catch (e) {}
  app.isQuitting = true;

  await new Promise(resolve => setTimeout(resolve, 300));

  try {
    // isSilent=true: don't show installer window on Windows (avoids second UAC)
    // isForceRunAfter=true: restart the app after installing
    autoUpdater.quitAndInstall(true, true);
  } catch (e) {
    console.error('quitAndInstall failed:', e);
    try {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('update-status', { status: 'error' });
      }
    } catch (e2) {}
    // Fallback: normal quit — autoInstallOnAppQuit=true will handle installation
    app.quit();
  }

  // Safety net: force exit if the app is still alive after 5 seconds
  setTimeout(() => { app.exit(0); }, 5000);

  return { ok: true };
});

ipcMain.handle('check-for-updates', () => {
  if (!isDev) autoUpdater.checkForUpdates().catch(() => {});
});

ipcMain.handle('set-auto-start', (event, enabled) => {
  const settings = loadSettings();
  settings.autoStart = enabled;
  saveSettings(settings);
  applyAutoStart(enabled);
  return { success: true };
});

ipcMain.handle('set-auto-connect', (event, enabled) => {
  const settings = loadSettings();
  settings.autoConnect = enabled;
  saveSettings(settings);
  return { success: true };
});

ipcMain.handle('set-auto-update', (event, enabled) => {
  const settings = loadSettings();
  settings.autoUpdate = enabled;
  saveSettings(settings);
  return { success: true };
});

ipcMain.handle('get-strategies', () => {
  try {
    const strategies = getStrategiesForPlatform();
    return strategies.map(s => s.name);
  } catch (e) {
    return ['auto'];
  }
});

ipcMain.handle('set-selected-strategy', (event, strategyName) => {
  const settings = loadSettings();
  settings.selectedStrategy = strategyName; // 'auto' or strategy name
  saveSettings(settings);
  return { success: true };
});

ipcMain.handle('get-custom-domains', () => {
  const settings = loadSettings();
  return {
    include: settings.customIncludeDomains || [],
    exclude: settings.customExcludeDomains || []
  };
});

ipcMain.handle('set-custom-domains', (event, { include, exclude }) => {
  const settings = loadSettings();
  settings.customIncludeDomains = (include || []).map(d => d.trim().toLowerCase()).filter(Boolean);
  settings.customExcludeDomains = (exclude || []).map(d => d.trim().toLowerCase()).filter(Boolean);
  saveSettings(settings);
  ensureHostLists();
  return { success: true };
});

// ============= SINGLE INSTANCE LOCK =============
// MUST be checked BEFORE any app.whenReady() or event handlers are registered.
// Otherwise app.quit() races with already-queued callbacks and the window
// briefly appears then disappears.

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // ============= APP LIFECYCLE =============

  app.whenReady().then(async () => {
    // Clean up stale proxy/DNS settings from previous crash
    disableSystemProxy();
    restoreDns();
    
    createWindow();
    createTray();
    
    // Send initial status
    const binaryExists = fs.existsSync(getBinaryPath() || '');
    sendLog({ type: 'info', message: 'Приложение запущено' });
    sendStatus({ binaryExists });
    
    // Setup auto-updater
    setupAutoUpdater();
    
    // Apply saved auto-start setting
    const settings = loadSettings();
    applyAutoStart(settings.autoStart);
    
    // Auto-connect if enabled
    if (settings.autoConnect) {
      setTimeout(() => {
        // Nothing awaits this one, so it must not be able to become an
        // unhandled rejection in the main process.
        startProxy().catch((e) => {
          sendLog({ type: 'error', message: `Автоподключение не удалось: ${e.message}` });
        });
      }, 1500);
    }
    
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        mainWindow.show();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    emergencyCleanup();
  });

  app.on('before-quit', () => {
    if (app.isQuitting) {
      // Already cleaned up by install-update handler — skip heavy execSync calls
      // to avoid blocking the quit/update sequence.
      return;
    }
    app.isQuitting = true;
    stopProxy();
    if (process.platform === 'win32') {
      try { execSync('taskkill /F /IM winws.exe', { stdio: 'pipe', timeout: 3000 }); } catch (e) {}
    }
  });

  // Ensure proxy cleanup on any exit scenario
  function emergencyCleanup() {
    try { disableSystemProxy(); } catch (e) {}
    try { restoreDns(); } catch (e) {}
    try { disableQuicBlock(); } catch (e) {}
    try { stopWinwsMonitor(); } catch (e) {}
    try { if (proxyProcess) proxyProcess.kill(); } catch (e) {}
    if (process.platform === 'darwin') {
      try { execSync('pkill -x tpws 2>/dev/null; exit 0', { stdio: 'pipe', shell: '/bin/sh' }); } catch (e) {}
    } else if (process.platform === 'win32') {
      // Try normal taskkill first, then elevated if it fails (winws may be running as admin)
      try { execSync('taskkill /F /IM winws.exe', { stdio: 'pipe', timeout: 3000 }); } catch (e) {
        try {
          execSync('powershell -command "Start-Process taskkill -ArgumentList \'/F\',\'/IM\',\'winws.exe\' -Verb RunAs -WindowStyle Hidden -Wait"', { stdio: 'pipe', timeout: 5000 });
        } catch (e2) {}
      }
    }
  }

  process.on('exit', emergencyCleanup);
  process.on('SIGTERM', () => { emergencyCleanup(); process.exit(0); });
  process.on('SIGINT', () => { emergencyCleanup(); process.exit(0); });

} // end of gotTheLock else block

'use strict';

// Generates the elevated Windows sweep batch.
//
// This path runs when the app is not already elevated: the whole strategy sweep
// is emitted as one .bat so the user sees a single UAC prompt instead of one per
// strategy. It used to be built inline inside main.js, which meant the only way
// to exercise it was to trigger a UAC dialog on a real machine.
//
// Acceptance mirrors the Node path (see strategy-outcome.js): each strategy is
// scored per service, one that fixes both wins immediately, and the first one
// that fixes exactly one is remembered. If the list runs out without a full
// match, that remembered strategy is started again and reported as PARTIAL,
// instead of leaving the user with nothing at all.
//
// Batch specifics worth knowing before editing:
//   * delayed expansion (!VAR!) is required — %VAR% is expanded when the line is
//     parsed, which is useless across a sweep;
//   * conditionals are written flat with goto rather than as parenthesised
//     blocks: nested ifs with delayed expansion are the classic source of silent
//     misparses here.

const {
  PATIENT_TIMEOUTS,
  PROBE_TIMEOUTS,
  endpointsByService,
  probeKind,
  probeLabel
} = require('./connectivity-probes');

const DEFAULT_SETTLE_SECONDS = 4;

// Quotes an argument whose value is a path containing spaces or separators.
function quoteArg(arg) {
  const eqIdx = arg.indexOf('=');
  if (eqIdx !== -1) {
    const key = arg.substring(0, eqIdx + 1);
    const val = arg.substring(eqIdx + 1);
    if (val.includes(' ') || val.includes('\\')) return key + '"' + val + '"';
  }
  return arg;
}

function buildStrategySweepBatch({
  strategies,
  binaryPath,
  binDirectory,
  resultFile,
  progressFile,
  hostsUpdateScript,
  probeScript,
  wsTestScript,
  totalStrategies = strategies.length,
  firstIsPreferred = false,
  settleSeconds = DEFAULT_SETTLE_SECONDS
}) {
  const lines = [];
  const add = (line) => lines.push(line);

  const screening = endpointsByService('screen');
  const remaining = endpointsByService('full');

  add('@echo off');
  add('setlocal EnableDelayedExpansion');
  add('set "RESULT=' + resultFile + '"');
  add('set "PROGRESS=' + progressFile + '"');
  add('set "PARTIAL_IDX="');
  add('set "PARTIAL_NAME="');
  add('set "PARTIAL_SERVICES="');
  add('taskkill /F /IM winws.exe >nul 2>&1');
  add('timeout /t 1 /nobreak >nul');
  add(':: Update hosts and clear Discord cache at each connection start');
  add('if exist "' + hostsUpdateScript + '" powershell -ExecutionPolicy Bypass -NoProfile -File "' + hostsUpdateScript + '"');
  add('rd /s /q "%APPDATA%\\discord\\Cache" 2>nul');
  add('rd /s /q "%APPDATA%\\discord\\Code Cache" 2>nul');
  add('rd /s /q "%APPDATA%\\discord\\GPUCache" 2>nul');
  add('');

  // One probe invocation, writing its verdict into the service flag.
  const emitProbe = (url, timeoutSec, flag) => {
    add(':: probe ' + probeLabel(url));
    add('powershell -ExecutionPolicy Bypass -NoProfile -File "' + probeScript + '" -Url "' + url + '" -Kind "' + probeKind(url) + '" -TimeoutSec ' + timeoutSec);
    add('if !errorlevel! neq 0 set "' + flag + '=0"');
  };

  strategies.forEach((strategy, i) => {
    const timeouts = (i === 0 && firstIsPreferred) ? PATIENT_TIMEOUTS : PROBE_TIMEOUTS;

    add(':: Strategy ' + (i + 1) + ': ' + strategy.name);
    add('echo ' + (i + 1) + '/' + totalStrategies + ':' + strategy.name + '> "%PROGRESS%"');
    add('cd /d "' + binDirectory + '"');
    add('start "" /b "' + binaryPath + '" ' + strategy.args.map(quoteArg).join(' '));
    add('timeout /t ' + settleSeconds + ' /nobreak >nul');
    add('set "YT=1"');
    add('set "DC=1"');

    for (const url of screening.youtube || []) emitProbe(url, timeouts.screenTimeoutSec, 'YT');
    for (const url of screening.discord || []) emitProbe(url, timeouts.screenTimeoutSec, 'DC');

    // Nothing survived screening: no point paying for the expensive probes.
    add('if "!YT!!DC!"=="00" goto :strat_next_' + i);

    add('if "!YT!"=="0" goto :yt_done_' + i);
    for (const url of remaining.youtube || []) emitProbe(url, timeouts.fullTimeoutSec, 'YT');
    add(':yt_done_' + i);

    add('if "!DC!"=="0" goto :dc_done_' + i);
    for (const url of remaining.discord || []) emitProbe(url, timeouts.fullTimeoutSec, 'DC');
    // Without the gateway WebSocket the Discord app never finishes loading, so
    // it decides the Discord verdict even when the HTTP probes passed.
    add('if "!DC!"=="0" goto :dc_done_' + i);
    add('powershell -ExecutionPolicy Bypass -File "' + wsTestScript.replace(/\\/g, '\\\\') + '"');
    add('if !errorlevel! neq 0 set "DC=0"');
    add(':dc_done_' + i);

    add('if not "!YT!!DC!"=="11" goto :not_full_' + i);
    add('echo WORKS:' + strategy.name + '> "%RESULT%"');
    add('goto :end');

    add(':not_full_' + i);
    add('if "!YT!!DC!"=="00" goto :strat_next_' + i);
    // Exactly one service works. Keep the first such strategy: the list is in
    // preference order, so the earliest partial is also the best one.
    add('if not "!PARTIAL_IDX!"=="" goto :strat_next_' + i);
    add('set "PARTIAL_IDX=' + i + '"');
    add('set "PARTIAL_NAME=' + strategy.name + '"');
    add('set "PARTIAL_SERVICES=!YT!!DC!"');

    add(':strat_next_' + i);
    add('taskkill /F /IM winws.exe >nul 2>&1');
    add('timeout /t 1 /nobreak >nul');
    add('');
  });

  add('if not "!PARTIAL_IDX!"=="" goto :partial_dispatch');
  add('echo NONE> "%RESULT%"');
  add('taskkill /F /IM winws.exe >nul 2>&1');
  add('goto :realend');
  add('');

  // Re-run the remembered partial strategy and leave it running.
  add(':partial_dispatch');
  add('echo PARTIAL:!PARTIAL_SERVICES!:!PARTIAL_NAME!> "%RESULT%"');
  strategies.forEach((_, i) => {
    add('if "!PARTIAL_IDX!"=="' + i + '" goto :run_partial_' + i);
  });
  add('goto :realend');
  strategies.forEach((strategy, i) => {
    add(':run_partial_' + i);
    add('cd /d "' + binDirectory + '"');
    add('start "" /b "' + binaryPath + '" ' + strategy.args.map(quoteArg).join(' '));
    add('timeout /t ' + settleSeconds + ' /nobreak >nul');
    add('goto :end');
  });

  add(':end');
  add(':: Strategy found — winws stays running');
  add(':realend');
  add('endlocal');

  return lines.join('\r\n') + '\r\n';
}

// Reads what the batch wrote: WORKS:<name>, PARTIAL:<yt><dc>:<name>, or NONE.
function parseSweepResult(resultContent) {
  const content = String(resultContent || '').trim();

  if (content.startsWith('WORKS:')) {
    return { found: true, strategy: content.substring(6).trim(), services: { youtube: true, discord: true } };
  }

  if (content.startsWith('PARTIAL:')) {
    const rest = content.substring(8);
    const sep = rest.indexOf(':');
    if (sep === -1) return { found: false };
    const flags = rest.substring(0, sep);
    return {
      found: true,
      strategy: rest.substring(sep + 1).trim(),
      services: { youtube: flags[0] === '1', discord: flags[1] === '1' }
    };
  }

  return { found: false };
}

module.exports = {
  DEFAULT_SETTLE_SECONDS,
  buildStrategySweepBatch,
  parseSweepResult,
  quoteArg
};

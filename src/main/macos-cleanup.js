'use strict';

const crypto = require('node:crypto');

function shQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }

// Every operation emits its own success marker and contributes to the exit
// status. In particular, a failing cp/cat cannot be hidden by a successful rm.
// Hosts bytes travel in the command, not a user-writable temporary script/file.
function buildMacCleanupCommand({ restorePf = false, releaseToken = null, hostsCleanup = null }) {
  const lines = ['cleanup_status=0'];
  const step = (name, command) => lines.push(`if ${command}; then printf '%s\\n' 'UNBLOCK_CLEANUP_${name}'; else cleanup_status=1; fi`);
  if (restorePf) step('PF', '/sbin/pfctl -f /etc/pf.conf');
  if (releaseToken !== null) {
    if (!/^\d+$/.test(String(releaseToken))) throw new Error('Invalid pf enable token');
    step('TOKEN', `/sbin/pfctl -X ${releaseToken}`);
  }
  if (hostsCleanup) {
    const { hostsPath, original, next } = hostsCleanup;
    if (typeof original !== 'string' || typeof next !== 'string' || !next.trim() || hostsPath !== '/etc/hosts') {
      throw new Error('Cleanup requires validated original and replacement hosts bytes for /etc/hosts');
    }
    const before = crypto.createHash('sha256').update(Buffer.from(original, 'latin1')).digest('hex');
    const body = Buffer.from(next, 'latin1').toString('base64');
    const target = shQuote(hostsPath);
    // Refuse stale plans after a password prompt: another app may have edited
    // hosts while this operation was waiting for elevation.
    step('HOSTS', `[ "$(/usr/bin/shasum -a 256 ${target} | /usr/bin/awk '{print $1}')" = ${shQuote(before)} ] && /bin/cp ${target} ${shQuote(hostsPath + '.unblockpro.bak')} && printf '%s' ${shQuote(body)} | /usr/bin/base64 -D > ${target}`);
  }
  if (lines.length === 1) return null;
  lines.push('exit "$cleanup_status"');
  return lines.join('\n');
}

function collectSuccess(output, state) {
  const markers = new Set(String(output || '').split(/\r?\n/));
  if (markers.has('UNBLOCK_CLEANUP_PF')) state.pfRestored = true;
  if (markers.has('UNBLOCK_CLEANUP_TOKEN')) state.tokenReleased = true;
  if (markers.has('UNBLOCK_CLEANUP_HOSTS')) state.hostsRestored = true;
}

async function runMacCleanup({ quicBlockEnabled = false, pfEnableToken = null, hostsCleanup = null }, { execSync, sudoExec }) {
  const state = {
    pfRestored: !quicBlockEnabled,
    tokenReleased: pfEnableToken === null,
    hostsRestored: !hostsCleanup,
    elevated: false
  };
  const pending = () => ({
    restorePf: !state.pfRestored,
    releaseToken: state.tokenReleased ? null : pfEnableToken,
    hostsCleanup: state.hostsRestored ? null : hostsCleanup
  });
  const complete = () => state.pfRestored && state.tokenReleased && state.hostsRestored;
  try {
    const command = buildMacCleanupCommand(pending());
    if (!command) return { ...state, ok: true };
    try {
      collectSuccess(execSync(command, { stdio: 'pipe', encoding: 'utf8', shell: '/bin/sh' }), state);
    } catch (error) {
      collectSuccess(error.stdout, state);
    }
    if (complete()) return { ...state, ok: true };
    const elevatedCommand = buildMacCleanupCommand(pending());
    state.elevated = true;
    const elevated = await new Promise((resolve) => {
      try {
        sudoExec(elevatedCommand, { name: 'UnblockPro' }, (error, stdout) => resolve({ error, stdout }));
      } catch (error) { resolve({ error }); }
    });
    collectSuccess(elevated.stdout, state);
    return { ...state, ok: complete(), error: complete() ? null : (elevated.error && elevated.error.message) || 'System cleanup did not complete' };
  } catch (error) {
    return { ...state, ok: false, error: error.message };
  }
}

module.exports = { buildMacCleanupCommand, runMacCleanup };

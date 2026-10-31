'use strict';

const crypto = require('node:crypto');

function shQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }

// Every operation emits its own success marker and contributes to the exit
// status. In particular, a failing cp/cat cannot be hidden by a successful rm.
// Hosts bytes travel in the command, not a user-writable temporary script/file.
function hostsReplaceCondition({ hostsPath, original, next }) {
  if (typeof original !== 'string' || typeof next !== 'string' || !next.trim() || hostsPath !== '/etc/hosts') {
    throw new Error('Cleanup requires validated original and replacement hosts bytes for /etc/hosts');
  }
  const before = crypto.createHash('sha256').update(Buffer.from(original, 'latin1')).digest('hex');
  const body = Buffer.from(next, 'latin1').toString('base64');
  const target = shQuote(hostsPath);
  // Refuse stale plans after a password prompt: another app may have edited
  // hosts while this operation was waiting for elevation.
  return `[ "$(/usr/bin/shasum -a 256 ${target} | /usr/bin/awk '{print $1}')" = ${shQuote(before)} ] && /bin/cp ${target} ${shQuote(hostsPath + '.unblockpro.bak')} && printf '%s' ${shQuote(body)} | /usr/bin/base64 -D > ${target}`;
}

function buildMacCleanupCommand({ restorePf = false, releaseToken = null, hostsCleanup = null }) {
  const lines = ['cleanup_status=0'];
  const step = (name, command) => lines.push(`if ${command}; then printf '%s\\n' 'UNBLOCK_CLEANUP_${name}'; else cleanup_status=1; fi`);
  if (restorePf) step('PF', '/sbin/pfctl -f /etc/pf.conf');
  if (releaseToken !== null) {
    if (!/^\d+$/.test(String(releaseToken))) throw new Error('Invalid pf enable token');
    step('TOKEN', `/sbin/pfctl -X ${releaseToken}`);
  }
  if (hostsCleanup) step('HOSTS', hostsReplaceCondition(hostsCleanup));
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

// Everything connecting needs root for goes into one command on purpose: each
// elevated call is a password dialog. The hosts block leaves with the disconnect,
// so pf and hosts used to cost two dialogs on every single connection.
//
// pf output stays on stdout because it carries the enable token. Its failure is
// not fatal, and a failed hosts step only loses its marker: neither stops the
// other one.
function buildMacConnectCommand({ pfConfPath = null, hostsUpdate = null }) {
  const lines = [];
  if (pfConfPath) {
    lines.push(`/sbin/pfctl -f ${shQuote(pfConfPath)} 2>/dev/null`);
    lines.push('/sbin/pfctl -E 2>&1');
  }
  if (hostsUpdate) lines.push(`if ${hostsReplaceCondition(hostsUpdate)}; then printf '%s\\n' 'UNBLOCK_CONNECT_HOSTS'; fi`);
  if (lines.length === 0) return null;
  lines.push('exit 0');
  return lines.join('\n');
}

async function runMacConnect(plan, { sudoExec }) {
  const nothing = { elevated: false, pfLoaded: false, hostsUpdated: false, output: '', error: null };
  const command = buildMacConnectCommand(plan);
  if (!command) return nothing;
  const { error, stdout, stderr } = await new Promise((resolve) => {
    try {
      sudoExec(command, { name: 'UnblockPro' }, (failure, out, err) => resolve({ error: failure, stdout: out, stderr: err }));
    } catch (failure) { resolve({ error: failure }); }
  });
  const output = `${stdout || ''}\n${stderr || ''}`;
  const markers = new Set(output.split(/\r?\n/));
  return {
    ...nothing,
    elevated: true,
    // Rules may be in force even if the token was not printed, so a command
    // that ran counts: the disconnect must still take them out.
    pfLoaded: !error,
    hostsUpdated: markers.has('UNBLOCK_CONNECT_HOSTS'),
    output,
    error: error || null
  };
}

module.exports = { buildMacCleanupCommand, buildMacConnectCommand, runMacCleanup, runMacConnect };

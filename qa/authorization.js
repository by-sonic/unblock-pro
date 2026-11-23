'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync, execSync } = require('node:child_process');
const { runMacConnect, runMacCleanup } = require('../src/main/macos-cleanup');

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.platform, 'darwin');
  const hostsPath = '/etc/hosts';
  const original = fs.readFileSync(hostsPath, 'latin1');
  const next = original + '\n# UnblockPro disposable CI verification\n';
  const pfConfPath = path.join(process.env.RUNNER_TEMP, 'issue81-check.conf');
  const pfRule = 'block return out quick proto udp from any to any port 443';
  fs.writeFileSync(pfConfPath, fs.readFileSync('/etc/pf.conf', 'utf8').trimEnd() + '\n' + pfRule + '\n');
  let requests = 0;
  // Count app elevation requests; the CI runner authorizes sudo without a GUI.
  const sudoExec = (command, options, callback) => {
    requests++;
    execFile('/usr/bin/sudo', ['-n', '/bin/sh', '-c', command], callback);
  };
  const result = await runMacConnect({pfConfPath, hostsUpdate: {hostsPath, original, next}}, {sudoExec});
  const token = result.output.match(/Token\s*:\s*(\d+)/i)?.[1];
  try {
    assert.equal(requests, 1);
    assert.ok(token, result.output);
    assert.equal(result.hostsUpdated, true);
    assert.equal(fs.readFileSync(hostsPath, 'latin1'), next);
    assert.match(execFileSync('/usr/bin/sudo', ['-n', '/sbin/pfctl', '-sr'], {encoding:'utf8'}), /block return out quick.*proto udp.*port = (?:https|443)/);
    console.log('connect: exactly one elevation request; pf rule active and hosts updated');
  } finally {
    requests = 0;
    const cleanup = await runMacCleanup({quicBlockEnabled:true, pfEnableToken:token, hostsCleanup:{hostsPath, original:next, next:original}}, {execSync, sudoExec});
    console.log('disconnect:', JSON.stringify({requests, ...cleanup}));
    assert.equal(requests, 1);
    assert.equal(cleanup.ok, true);
    assert.equal(fs.readFileSync(hostsPath, 'latin1'), original);
    assert.equal(cleanup.tokenReleased, true);
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { buildProtectedRuntimeInspection, inspectProtectedWindowsRuntime, systemPowerShellPath } = require('../src/main/windows-protected-runtime');

const options = {
  resourcesPath: 'C:\\Program Files\\UnblockPro\\resources',
  executablePath: 'C:\\Program Files\\UnblockPro\\UnblockPro.exe',
  requiredFiles: ['winws.exe', 'WinDivert.dll'],
  getPowerShellPath: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
};

test('PowerShell bootstrap derives from loaded system modules, not inherited environment', () => {
  assert.equal(systemPowerShellPath(['D:\\Windows\\System32\\KERNEL32.DLL']), 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.throws(() => systemPowerShellPath(['C:\\Users\\attacker\\kernel32.dll']), /Cannot locate/);
  assert.throws(() => systemPowerShellPath([]), /Cannot locate/);
});

test('only the protected bundled directory is returned, never the AppData cache', () => {
  let script;
  const result = inspectProtectedWindowsRuntime({ ...options, run: (exe, args, spawnOptions) => {
    assert.equal(path.win32.isAbsolute(exe), true);
    assert.equal(spawnOptions.windowsHide, true);
    script = Buffer.from(args[3], 'base64').toString('utf16le');
    return JSON.stringify({ ok: true, runtimeDir: path.win32.join(options.resourcesPath, 'bin') });
  } });
  assert.equal(result.ok, true);
  assert.equal(result.binaryPath, 'C:\\Program Files\\UnblockPro\\resources\\bin\\winws.exe');
  assert.match(script, /GetAccessRules/);
});

test('inspection failure, invalid output, and unexpected paths fail closed', () => {
  for (const run of [
    () => { throw new Error('timeout'); },
    () => 'not JSON',
    () => JSON.stringify({ ok: false, error: 'Unprivileged write access' }),
    () => JSON.stringify({ ok: true, runtimeDir: 'C:\\Users\\attacker' })
  ]) assert.equal(inspectProtectedWindowsRuntime({ ...options, run }).ok, false);
});

test('missing required manifest fails before invoking the inspector', () => {
  assert.equal(inspectProtectedWindowsRuntime({ ...options, requiredFiles: [], run: () => assert.fail() }).ok, false);
});

const onWindows = process.platform === 'win32';
function powershell(script) {
  return execFileSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
  ], { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim();
}
function inspectRealPath(candidate) {
  const script = buildProtectedRuntimeInspection({ runtimeDir: candidate, executablePath: candidate, requiredFiles: [] });
  const functions = script.slice(0, script.indexOf('\ntry {'));
  const encoded = Buffer.from(candidate, 'utf8').toString('base64');
  return JSON.parse(powershell(functions + `
try {
  $candidate = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
  Inspect-Path $candidate $true
  @{ok=$true} | ConvertTo-Json -Compress
} catch { @{ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress }
`));
}

test('real PowerShell rejects portable directories independent of PORTABLE env', { skip: !onWindows }, (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-portable-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const result = inspectProtectedWindowsRuntime({ resourcesPath: path.join(tmp, 'resources'), executablePath: path.join(tmp, 'UnblockPro.exe'), requiredFiles: ['winws.exe'] });
  assert.equal(result.ok, false);
  assert.match(result.error, /Program Files/);
});

test('real ACL inspection rejects a user-owned temp runtime without changing permissions', { skip: !onWindows }, (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-acl-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const result = inspectRealPath(tmp);
  assert.equal(result.ok, false);
  assert.match(result.error, /Untrusted owner|Unprivileged write/);
});

test('real ACL inspection accepts the OS protected PowerShell binary', { skip: !onWindows }, () => {
  const systemExe = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  assert.deepEqual(inspectRealPath(systemExe), { ok: true });
});

test('real reparse point is rejected before resolving its ACL', { skip: !onWindows }, (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-junction-'));
  const target = path.join(tmp, 'target');
  const junction = path.join(tmp, 'junction');
  fs.mkdirSync(target);
  fs.symlinkSync(target, junction, 'junction');
  t.after(() => { fs.unlinkSync(junction); fs.rmSync(tmp, { recursive: true, force: true }); });
  const result = inspectRealPath(junction);
  assert.equal(result.ok, false);
  assert.match(result.error, /Reparse point/);
});

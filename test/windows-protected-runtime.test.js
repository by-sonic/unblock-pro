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

test('volume root permits creation rights but keeps replacement rights forbidden', { skip: !onWindows }, () => {
  const script = buildProtectedRuntimeInspection(options);
  const functions = script.slice(0, script.indexOf('\ntry {'));
  const matrix = [
    // Creating an unrelated entry or deleting the volume root itself cannot
    // replace Program Files. The same bits remain forbidden below the root.
    [0x00000004, false, false], // create subdirectory
    [0x40000000, false, false], // generic write
    [0x000301bf, false, false], // modify, including DELETE on the root itself
    [0x40000000, true, true],
    [0x000301bf, true, true],
    [0x00000002, true, true], // add a file inside protected directory
    // Any way to replace Program Files or change the root ACL stays blocked.
    [0x00000040, false, true], // DELETE_CHILD
    [0x00040000, false, true], // WRITE_DAC
    [0x00080000, false, true], // WRITE_OWNER
    [0x10000000, false, true], // GENERIC_ALL
    [0x001f01ff, false, true] // FullControl
  ];
  const cases = matrix.map(([rights, full, denied]) => `if ((Test-DangerousRights ${rights} $${full}) -ne $${denied}) { throw 'mask ${rights} full=${full}' }`).join('\n');
  assert.match(powershell(`${functions}\n${cases}\n'PASS'`), /PASS/);
  assert.match(script, /Test-PhysicalVolumeRoot \$cursor/);
});

test('real volume root passes its dedicated ACL policy', { skip: !onWindows }, () => {
  const root = path.parse(process.env.SystemRoot).root;
  const script = buildProtectedRuntimeInspection({ runtimeDir: root, executablePath: root, requiredFiles: [] });
  const functions = script.slice(0, script.indexOf('\ntry {'));
  const result = JSON.parse(powershell(`${functions}\ntry { if (-not (Test-PhysicalVolumeRoot '${root}')) { throw 'Not a physical volume root' }; Inspect-Path '${root}' $false; @{ok=$true} | ConvertTo-Json -Compress } catch { @{ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress }`));
  assert.deepEqual(result, { ok: true });
});

test('the relaxed root policy excludes aliases and network shares', { skip: !onWindows }, () => {
  const script = buildProtectedRuntimeInspection(options);
  const functions = script.slice(0, script.indexOf('\ntry {'));
  const result = JSON.parse(powershell(`${functions}
$roots = @(
  (Test-PhysicalVolumeRoot ([IO.Path]::GetPathRoot($env:SystemRoot))),
  (Test-PhysicalVolumeRoot 'C:\\Windows'),
  (Test-PhysicalVolumeRoot '\\\\server\\share\\')
)
$prefix = [char]92 + 'Device' + [char]92 + 'HarddiskVolume'
$targets = @(
  (Test-DirectLocalVolumeTarget ($prefix + '3')),
  (Test-DirectLocalVolumeTarget ([char]92 + '??' + [char]92 + 'C:' + [char]92 + 'alias')),
  (Test-DirectLocalVolumeTarget ([char]92 + 'Device' + [char]92 + 'Mup' + [char]92 + 'server')),
  (Test-DirectLocalVolumeTarget ($prefix + '3' + [char]92 + 'alias'))
)
@{ roots=$roots; targets=$targets } | ConvertTo-Json -Compress
`));
  assert.deepEqual(result.roots, [true, false, false]);
  assert.deepEqual(result.targets, [true, false, false, false]);
});

test('real Program Files keeps the strict directory policy', { skip: !onWindows }, () => {
  assert.deepEqual(inspectRealPath(process.env.ProgramFiles), { ok: true });
});

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

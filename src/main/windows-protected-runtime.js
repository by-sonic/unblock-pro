'use strict';

// Hashing a writable cache before CreateProcess leaves a substitution window.
// Installed builds execute the bundled engine in its protected directory instead.
// This inspector is read-only: an unexpected ACL requires reinstalling, never an
// automatic "repair" that elevates user-controlled files into a trusted location.
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function systemPowerShellPath(sharedObjects = process.report.getReport().sharedObjects) {
  // The OS maps kernel32 as a KnownDLL before JavaScript starts. Its loaded
  // module path cannot be redirected by a writable PATH/SystemRoot variable.
  const kernel = sharedObjects.find((file) => path.win32.isAbsolute(file) &&
    path.win32.basename(file).toLowerCase() === 'kernel32.dll' &&
    path.win32.basename(path.win32.dirname(file)).toLowerCase() === 'system32');
  if (!kernel) throw new Error('Cannot locate the loaded Windows system library');
  return path.win32.join(path.win32.dirname(kernel), 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function buildProtectedRuntimeInspection({ runtimeDir, executablePath, requiredFiles }) {
  const payload = Buffer.from(JSON.stringify({ runtimeDir, executablePath, requiredFiles }), 'utf8').toString('base64');
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class ProtectedVolumeDevice { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint QueryDosDevice(string name, StringBuilder target, int max); }'
function Test-DirectLocalVolumeTarget([string]$name) {
  $prefix = [char]92 + 'Device' + [char]92 + 'HarddiskVolume'
  if (-not $name.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $false }
  return ($name.Substring($prefix.Length) -match '^[0-9]+$')
}
function Test-PhysicalVolumeRoot([string]$candidate) {
  # A SUBST or network drive root can refer to a removable ordinary directory.
  # Only a direct local volume may use the narrower root ACL policy.
  if ($candidate.Length -ne 3 -or $candidate[1] -ne ':' -or $candidate[2] -ne [char]92 -or -not [char]::IsLetter($candidate[0])) { return $false }
  $target = New-Object Text.StringBuilder 1024
  if ([ProtectedVolumeDevice]::QueryDosDevice($candidate.Substring(0, 2), $target, $target.Capacity) -eq 0) { return $false }
  return (Test-DirectLocalVolumeTarget $target.ToString())
}
function Test-DangerousRights([long]$rights, [bool]$fullWriteCheck) {
  # A volume root may allow creating unrelated entries (GENERIC_WRITE), and
  # DELETE on the volume root itself cannot delete an existing child. Neither
  # permission permits replacing Program Files. DELETE_CHILD and the ability
  # to rewrite the root ACL remain forbidden, as do all writes below the root.
  $dangerous = [long]0x100C0040
  if ($fullWriteCheck) { $dangerous = [long]0x500D0156 }
  return (($rights -band $dangerous) -ne 0)
}
function Inspect-Path([string]$candidate, [bool]$fullWriteCheck) {
  $item = Get-Item -LiteralPath $candidate -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point: $candidate" }
  if ($item.PSIsContainer) { $acl = [IO.Directory]::GetAccessControl($candidate) }
  else { $acl = [IO.File]::GetAccessControl($candidate) }
  $descriptor = New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $descriptor.DiscretionaryAcl) { throw "Null DACL: $candidate" }
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($trusted -notcontains $owner) { throw "Untrusted owner: $candidate" }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
    if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    if ($trusted -contains $rule.IdentityReference.Value) { continue }
    $rights = [int]$rule.FileSystemRights
    if (Test-DangerousRights $rights $fullWriteCheck) {
      $hex = '{0:X8}' -f $rights
      throw "Unprivileged write access: $candidate (SID $($rule.IdentityReference.Value), rights 0x$hex)"
    }
  }
}
try {
  $runtime = [IO.Path]::GetFullPath($request.runtimeDir).TrimEnd('\\')
  $exe = [IO.Path]::GetFullPath($request.executablePath)
  $registry = Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion'
  $roots = @($registry.ProgramFilesDir, $registry.'ProgramFilesDir (x86)', $registry.ProgramW6432Dir) | Where-Object { $_ }
  $inside = $false
  foreach ($root in $roots) {
    $prefix = [IO.Path]::GetFullPath($root).TrimEnd('\\') + '\\'
    if ($runtime.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and $exe.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $inside = $true }
  }
  if (-not $inside) { throw 'The application must be installed in Program Files using the installer; portable execution is not protected.' }
  $expected = Join-Path ([IO.Path]::GetDirectoryName($exe)) 'resources\\bin'
  if (-not $runtime.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected bundled runtime path' }
  $cursor = $runtime
  while ($cursor) {
    Inspect-Path $cursor $true
    $parent = [IO.Directory]::GetParent($cursor)
    if ($null -eq $parent) { break }
    $cursor = $parent.FullName
    # Root permits Users to create their own directories, but not replace ours.
    if ($null -eq [IO.Directory]::GetParent($cursor)) {
      if (-not (Test-PhysicalVolumeRoot $cursor)) { throw "Unsupported volume root: $cursor" }
      Inspect-Path $cursor $false
      break
    }
  }
  Inspect-Path $exe $true
  foreach ($item in Get-ChildItem -LiteralPath $runtime -Force -Recurse) { Inspect-Path $item.FullName $true }
  foreach ($name in $request.requiredFiles) {
    if ([IO.Path]::GetFileName($name) -ne $name -or $name -eq '.' -or $name -eq '..') { throw 'Invalid required runtime filename' }
    $file = Join-Path $runtime $name
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing bundled runtime file: $name" }
    Inspect-Path $file $true
  }
  @{ ok = $true; runtimeDir = $runtime; binaryPath = (Join-Path $runtime 'winws.exe') } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
}

function inspectProtectedWindowsRuntime({ resourcesPath, executablePath = process.execPath, requiredFiles, run = execFileSync, getPowerShellPath = systemPowerShellPath }) {
  if (!Array.isArray(requiredFiles) || !requiredFiles.includes('winws.exe')) {
    return { ok: false, error: 'Required runtime manifest is missing winws.exe' };
  }
  const runtimeDir = path.win32.join(resourcesPath, 'bin');
  const script = buildProtectedRuntimeInspection({ runtimeDir, executablePath, requiredFiles });
  try {
    const powershell = getPowerShellPath();
    const output = run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024
    });
    const result = JSON.parse(String(output).trim());
    if (result.ok !== true) return { ok: false, error: result.error || 'Protected runtime inspection failed' };
    // Do not trust unexpected paths even from a successful inspector response.
    if (path.win32.normalize(result.runtimeDir).toLowerCase() !== path.win32.normalize(runtimeDir).toLowerCase()) {
      return { ok: false, error: 'Protected runtime inspection returned an unexpected directory' };
    }
    return { ok: true, runtimeDir, binaryPath: path.win32.join(runtimeDir, 'winws.exe') };
  } catch (error) {
    return { ok: false, error: `Protected runtime inspection unavailable: ${error.message}` };
  }
}

module.exports = { buildProtectedRuntimeInspection, inspectProtectedWindowsRuntime, systemPowerShellPath };

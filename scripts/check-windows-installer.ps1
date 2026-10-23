# Installs the built setup on the CI runner and checks what the user gets:
# every installed file readable, the app's own protected-runtime inspection
# passing, and a clean uninstall. With -PreviousSetup it first installs that
# release, so upgrading over a broken install is covered too (#79: 2.0.24 and
# 2.0.25 left every installed file with an empty DACL).
#
# Runs on a throwaway runner only: it installs into Program Files.

param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [string]$PreviousSetup
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $env:ProgramFiles 'UnblockPro'
$exe = Join-Path $dir 'UnblockPro.exe'

function Invoke-Setup([string]$path) {
  Write-Host "Installing $path"
  $process = Start-Process -FilePath $path -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "$path exited with $($process.ExitCode)" }
  if (-not (Test-Path -LiteralPath $exe)) { throw "$exe is missing after install" }
}

function Get-UnreadableFiles {
  # Reading the bytes, not just the ACL: an empty DACL leaves Get-Acl working
  # for the owner while nobody can open the file.
  Get-ChildItem -LiteralPath $dir -Recurse -File -Force | Where-Object {
    try { [IO.File]::OpenRead($_.FullName).Dispose(); $false } catch { $true }
  } | ForEach-Object { $_.FullName }
}

function Assert-Installed {
  $unreadable = @(Get-UnreadableFiles)
  if ($unreadable.Count -gt 0) {
    $unreadable | Select-Object -First 20 | ForEach-Object { Write-Host "  unreadable: $_" }
    throw "$($unreadable.Count) installed files are unreadable"
  }
  # Users must be able to read and run the app, or Explorer cannot even start
  # the elevation prompt ("no application is associated with this file").
  $usersCanRun = (Get-Acl -LiteralPath $exe).Access | Where-Object {
    $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-32-545' -and
    $_.AccessControlType -eq 'Allow' -and
    ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadAndExecute) -eq [Security.AccessControl.FileSystemRights]::ReadAndExecute
  }
  if (-not $usersCanRun) { throw "Users cannot read and execute $exe" }

  # The same inspection the app performs before every engine launch.
  $check = @'
const { inspectProtectedWindowsRuntime } = require('./src/main/windows-protected-runtime');
const { FLOWSEAL_REQUIRED_WINDOWS_FILES } = require('./src/main/flowseal-bundle');
const result = inspectProtectedWindowsRuntime({
  resourcesPath: process.argv[1], executablePath: process.argv[2], requiredFiles: FLOWSEAL_REQUIRED_WINDOWS_FILES
});
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
'@
  Push-Location $repoRoot
  try { node -e $check (Join-Path $dir 'resources') $exe } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw 'Protected runtime inspection rejected the installed app' }
  Write-Host 'Installed files are readable and the protected runtime check passes.'
}

if ($PreviousSetup) {
  Invoke-Setup $PreviousSetup
  $broken = @(Get-UnreadableFiles).Count
  Write-Host "Previous release left $broken unreadable files."
}

Invoke-Setup $Setup
Assert-Installed

$uninstaller = Join-Path $dir 'Uninstall UnblockPro.exe'
Write-Host "Uninstalling with $uninstaller"
Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait | Out-Null
# The NSIS uninstaller re-launches itself from %TEMP%, so -Wait returns early.
$deadline = (Get-Date).AddSeconds(120)
while ((Test-Path -LiteralPath $exe) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
if (Test-Path -LiteralPath $exe) { throw "$exe is still present after uninstall" }
Write-Host 'Uninstall removed the app.'

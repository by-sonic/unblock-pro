# Removes the UnblockPro block from the hosts file.
#
# Run by the NSIS uninstaller: the block pins Discord voice addresses, and hosts
# wins over DNS, so a block left behind keeps breaking Discord long after the app
# is gone - including under a VPN.
#
# Deliberately narrow: it removes only the region between our opening marker and
# our closing sentinel, and only when both are present. A block written before
# the sentinel existed is left alone rather than guessed at - the app itself
# removes those while it is still installed.
#
# ASCII-only on purpose: PowerShell 5.1 misreads a UTF-8 script without a BOM.

param(
    [string]$HostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
)

$marker = '# UnblockPro Discord/Telegram hosts'
$endMarker = "$marker end"

if (-not (Test-Path -LiteralPath $HostsPath)) {
    Write-Output 'hosts file not found, nothing to do'
    exit 0
}

$lines = @(Get-Content -LiteralPath $HostsPath -Encoding Byte -ErrorAction SilentlyContinue)
if ($lines.Count -eq 0) {
    $lines = @(Get-Content -LiteralPath $HostsPath)
} else {
    $lines = @([System.Text.Encoding]::GetEncoding(28591).GetString($lines) -split "`r?`n")
}

$start = -1
$end = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
    $trimmed = $lines[$i].Trim()
    if ($trimmed -eq $endMarker) {
        if ($start -ge 0 -and $end -lt 0) { $end = $i }
        continue
    }
    if ($start -lt 0 -and $trimmed.StartsWith($marker)) { $start = $i }
}

if ($start -lt 0 -or $end -lt 0) {
    Write-Output 'no complete UnblockPro block found, leaving hosts untouched'
    exit 0
}

$kept = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($i -ge $start -and $i -le $end) { continue }
    $kept.Add($lines[$i])
}

# Collapse the blank separator that preceded the block.
while ($kept.Count -gt 0 -and $kept[$kept.Count - 1].Trim() -eq '') { $kept.RemoveAt($kept.Count - 1) }

$result = ($kept -join "`r`n") + "`r`n"

# A hosts file with no loopback mapping is broken; refuse rather than ship that.
if ($result -notmatch '127\.0\.0\.1') {
    Write-Output 'refusing to write a hosts file without a loopback entry'
    exit 1
}

try {
    Copy-Item -LiteralPath $HostsPath -Destination "$HostsPath.unblockpro.bak" -Force -ErrorAction SilentlyContinue
    [System.IO.File]::WriteAllText($HostsPath, $result, [System.Text.Encoding]::GetEncoding(28591))
    Write-Output 'UnblockPro block removed from hosts'
    exit 0
} catch {
    Write-Output "failed to write hosts: $_"
    exit 1
}

'use strict';

// Strategy verification probes.
//
// A status-code-only check is too weak here: some ISPs answer a blocked request
// with a 200 stub page, and a reachable host says nothing about whether the
// service actually works. Each probe therefore also asserts something that only
// the real endpoint can produce, which is what stops auto-select from reporting
// success while YouTube and Discord stay broken.
//
// The rules live in one table because two runtimes evaluate them: Node (macOS
// SOCKS probes and the non-elevated Windows path) and PowerShell (the elevated
// Windows batch, which has no Node available). The PowerShell probe is generated
// from this table so the two can never drift apart.

const REQUIRED_YOUTUBE_ENDPOINTS = Object.freeze([
  'https://www.youtube.com/',
  'https://redirector.googlevideo.com/'
]);

const REQUIRED_DISCORD_ENDPOINTS = Object.freeze([
  'https://discord.com/api/v10/gateway',
  'https://cdn.discordapp.com/embed/avatars/0.png'
]);

// Bytes of the body worth reading for validation. Enough for a YouTube shell
// and far more than the JSON/PNG probes need.
const BODY_SAMPLE_BYTES = 65536;

const PNG_MAGIC = '89504e470d0a1a0a';

// A body served instead of the real response by an ISP notice page.
const BLOCK_NOTICE_PATTERN = 'blocked|\\u0437\\u0430\\u0431\\u043b\\u043e\\u043a\\u0438\\u0440\\u043e\\u0432\\u0430\\u043d|\\u0434\\u043e\\u0441\\u0442\\u0443\\u043f \\u043e\\u0433\\u0440\\u0430\\u043d\\u0438\\u0447\\u0435\\u043d';

const PROBE_RULES = Object.freeze([
  Object.freeze({
    kind: 'youtube-home',
    url: 'https://www.youtube.com/',
    label: 'YouTube Web',
    statuses: Object.freeze([200]),
    // The YouTube shell always ships its config bootstrap; an interstitial does not.
    bodyPattern: 'ytcfg|ytInitialData|<title>[^<]*YouTube'
  }),
  Object.freeze({
    kind: 'youtube-video',
    url: 'https://redirector.googlevideo.com/',
    label: 'YouTube video (googlevideo)',
    // This host has no index document — 404 is the healthy answer and proves the
    // video-delivery path is reachable end to end. A 200 means something
    // answered on its behalf.
    statuses: Object.freeze([204, 404]),
    rejectBodyPattern: BLOCK_NOTICE_PATTERN
  }),
  Object.freeze({
    kind: 'discord-api',
    url: 'https://discord.com/api/v10/gateway',
    label: 'Discord API',
    statuses: Object.freeze([200]),
    // Returns {"url":"wss://gateway.discord.gg"} — the first call the Discord
    // client makes, and not something a stub page can fake.
    bodyPattern: '"url"\\s*:\\s*"wss://'
  }),
  Object.freeze({
    kind: 'discord-cdn',
    url: 'https://cdn.discordapp.com/embed/avatars/0.png',
    label: 'Discord CDN',
    statuses: Object.freeze([200]),
    // A real CDN asset is a PNG, not an HTML notice.
    hexPrefix: PNG_MAGIC
  })
]);

const RULES_BY_URL = new Map(PROBE_RULES.map((rule) => [rule.url, rule]));

function matches(pattern, text) {
  return new RegExp(pattern, 'i').test(text);
}

function validateProbe(url, status, body = '', bodyHex = '') {
  const rule = RULES_BY_URL.get(url);
  // Preserve permissive behaviour for URLs without a dedicated rule.
  if (!rule) return status > 0 && status < 400;

  if (!rule.statuses.includes(status)) return false;
  if (rule.bodyPattern && !matches(rule.bodyPattern, body)) return false;
  if (rule.rejectBodyPattern && matches(rule.rejectBodyPattern, body)) return false;
  if (rule.hexPrefix && !String(bodyHex).toLowerCase().startsWith(rule.hexPrefix)) return false;
  return true;
}

function probeLabel(url) {
  const rule = RULES_BY_URL.get(url);
  return rule ? rule.label : url;
}

function probeKind(url) {
  const rule = RULES_BY_URL.get(url);
  return rule ? rule.kind : null;
}

// Escapes a value for a single-quoted PowerShell string literal.
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Generates the PowerShell probe used by the elevated Windows batch. Exit code
// 0 means the endpoint passed the same rule the Node path applies.
//
// HttpWebRequest rather than Invoke-WebRequest: it exposes the response body on
// 4xx, which the googlevideo probe needs (404 is its healthy answer).
function buildPowerShellProbeScript() {
  const lines = [
    'param(',
    '  [Parameter(Mandatory=$true)][string]$Url,',
    '  [Parameter(Mandatory=$true)][string]$Kind,',
    '  [int]$TimeoutSec = 10',
    ')',
    '',
    `$sampleBytes = ${BODY_SAMPLE_BYTES}`,
    '$status = 0',
    '$text = ""',
    '$hex = ""',
    '',
    'function Read-Body($response) {',
    '  $stream = $response.GetResponseStream()',
    '  $buffer = New-Object byte[] $sampleBytes',
    '  $total = 0',
    '  while ($total -lt $sampleBytes) {',
    '    $read = $stream.Read($buffer, $total, $sampleBytes - $total)',
    '    if ($read -le 0) { break }',
    '    $total += $read',
    '  }',
    '  $stream.Close()',
    '  if ($total -le 0) { return @("", "") }',
    '  $bodyText = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $total)',
    '  $prefixLen = 8',
    '  if ($total -lt 8) { $prefixLen = $total }',
    '  $bodyHex = ($buffer[0..($prefixLen - 1)] | ForEach-Object { $_.ToString("x2") }) -join ""',
    '  return @($bodyText, $bodyHex)',
    '}',
    '',
    'try {',
    '  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    '  $request = [System.Net.HttpWebRequest]::Create($Url)',
    '  $request.Timeout = $TimeoutSec * 1000',
    '  $request.ReadWriteTimeout = $TimeoutSec * 1000',
    '  $request.UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"',
    '  $response = $request.GetResponse()',
    '  $status = [int]$response.StatusCode',
    '  $parts = Read-Body $response',
    '  $text = $parts[0]; $hex = $parts[1]',
    '  $response.Close()',
    '} catch [System.Net.WebException] {',
    '  # A 4xx still carries a response; anything else (reset, timeout, DNS) does not.',
    '  if ($_.Exception.Response -ne $null) {',
    '    $response = $_.Exception.Response',
    '    $status = [int]$response.StatusCode',
    '    try { $parts = Read-Body $response; $text = $parts[0]; $hex = $parts[1] } catch {}',
    '    $response.Close()',
    '  }',
    '} catch { }',
    '',
    'switch ($Kind) {'
  ];

  for (const rule of PROBE_RULES) {
    const statusList = rule.statuses.map((s) => String(s)).join(', ');
    const checks = [`@(${statusList}) -contains $status`];
    if (rule.bodyPattern) checks.push(`$text -imatch ${psQuote(rule.bodyPattern)}`);
    if (rule.rejectBodyPattern) checks.push(`-not ($text -imatch ${psQuote(rule.rejectBodyPattern)})`);
    if (rule.hexPrefix) checks.push(`$hex.ToLower().StartsWith(${psQuote(rule.hexPrefix)})`);
    lines.push(`  ${psQuote(rule.kind)} {`);
    lines.push(`    if (${checks.join(' -and ')}) { exit 0 }`);
    lines.push('    exit 1');
    lines.push('  }');
  }

  lines.push('}');
  lines.push('# Unknown kind: fall back to the permissive status check.');
  lines.push('if ($status -gt 0 -and $status -lt 400) { exit 0 }');
  lines.push('exit 1');

  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  BODY_SAMPLE_BYTES,
  PROBE_RULES,
  REQUIRED_DISCORD_ENDPOINTS,
  REQUIRED_YOUTUBE_ENDPOINTS,
  buildPowerShellProbeScript,
  probeKind,
  probeLabel,
  validateProbe
};

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

// Video volume through a googlevideo connection; see the youtube-video-volume rule.
const YOUTUBE_VIDEO_VOLUME_URL = 'https://redirector.googlevideo.com/?unblock=volume';

const REQUIRED_YOUTUBE_ENDPOINTS = Object.freeze([
  'https://www.youtube.com/',
  'https://redirector.googlevideo.com/',
  YOUTUBE_VIDEO_VOLUME_URL
]);

const REQUIRED_DISCORD_ENDPOINTS = Object.freeze([
  'https://discord.com/api/v10/gateway',
  'https://cdn.discordapp.com/embed/avatars/0.png',
  'https://discord.com/app'
]);

// Bytes of the body worth reading for validation. Enough for a YouTube shell
// and far more than the JSON/PNG probes need.
const BODY_SAMPLE_BYTES = 65536;

const PNG_MAGIC = '89504e470d0a1a0a';

// A body served instead of the real response by an ISP notice page.
const BLOCK_NOTICE_PATTERN = 'blocked|\\u0437\\u0430\\u0431\\u043b\\u043e\\u043a\\u0438\\u0440\\u043e\\u0432\\u0430\\u043d|\\u0434\\u043e\\u0441\\u0442\\u0443\\u043f \\u043e\\u0433\\u0440\\u0430\\u043d\\u0438\\u0447\\u0435\\u043d';

// A custom target is an arbitrary site, and real pages are free to contain these
// words: YouTube's own shell ships `blocked_packages_for_sps`, which made every
// strategy fail against https://www.youtube.com/ (#76). A notice page is small,
// so the phrase counts only in its title or in a body that short.
const NOTICE_PAGE_MAX_CHARS = 16384;
const NOTICE_TITLE_PATTERN = `<title[^>]*>[^<]*(?:${BLOCK_NOTICE_PATTERN})`;

function looksLikeBlockNotice(body) {
  const text = String(body || '');
  if (matches(NOTICE_TITLE_PATTERN, text)) return true;
  return text.length < NOTICE_PAGE_MAX_CHARS && matches(BLOCK_NOTICE_PATTERN, text);
}

const PROBE_RULES = Object.freeze([
  Object.freeze({
    kind: 'youtube-home',
    service: 'youtube',
    tier: 'full',  // ~1 MB of HTML — never pay for it on a doomed strategy
    url: 'https://www.youtube.com/',
    label: 'YouTube Web',
    statuses: Object.freeze([200]),
    // The YouTube shell always ships its config bootstrap; an interstitial does not.
    bodyPattern: 'ytcfg|ytInitialData|<title>[^<]*YouTube'
  }),
  Object.freeze({
    kind: 'youtube-video',
    service: 'youtube',
    tier: 'screen',  // 404 + empty body, a few bytes
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
    service: 'discord',
    tier: 'screen',  // tiny JSON
    url: 'https://discord.com/api/v10/gateway',
    label: 'Discord API',
    statuses: Object.freeze([200]),
    // Returns {"url":"wss://gateway.discord.gg"} — the first call the Discord
    // client makes, and not something a stub page can fake.
    bodyPattern: '"url"\\s*:\\s*"wss://'
  }),
  Object.freeze({
    kind: 'discord-cdn',
    service: 'discord',
    tier: 'full',  // small PNG, but still a real download
    url: 'https://cdn.discordapp.com/embed/avatars/0.png',
    label: 'Discord CDN',
    statuses: Object.freeze([200]),
    // A real CDN asset is a PNG, not an HTML notice.
    hexPrefix: PNG_MAGIC
  }),
  Object.freeze({
    kind: 'youtube-video-volume',
    service: 'youtube',
    tier: 'full',  // ~900 KB, like the YouTube shell
    url: YOUTUBE_VIDEO_VOLUME_URL,
    label: 'YouTube video (googlevideo, volume)',
    // The 404 screen above proves only that a googlevideo handshake gets
    // through. The ISP throttles video by the googlevideo SNI after the
    // handshake, so a strategy could pass it while video never loaded (#84):
    // the interface opened and the player spun. Here TLS still goes to
    // redirector.googlevideo.com, so the DPI treats the connection as video,
    // but Google's front is asked for the YouTube shell in the Host header and
    // answers ~900 KB. The whole body has to arrive within the probe timeout.
    requestHost: 'www.youtube.com',
    wholeBody: true,
    statuses: Object.freeze([200, 404]),
    // A 200 must be the real shell. A 404 means the front declined to serve
    // another host, or the runtime cannot set Host without changing the SNI
    // (.NET HttpWebRequest, the elevated Windows batch): it then proves only
    // the handshake, as the screen probe does, and never less.
    bodyPattern: 'ytcfg|ytInitialData|<title>[^<]*YouTube'
  }),
  Object.freeze({
    kind: 'discord-app',
    service: 'discord',
    tier: 'full',  // ~77 KB
    url: 'https://discord.com/app',
    label: 'Discord Web (volume)',
    // The API answers 35 bytes and the CDN avatar about a kilobyte, both well
    // under the ~16 KB after which DPI commonly freezes a connection. Then the
    // checks passed while discord.com did not open in the browser and the
    // client hung on "Checking for updates" (#46). The web app shell is ~77 KB
    // and has to arrive in full.
    wholeBody: true,
    statuses: Object.freeze([200]),
    // Its bootstrap config, near the top of the page.
    bodyPattern: 'GLOBAL_ENV'
  })
]);

const RULES_BY_URL = new Map(PROBE_RULES.map((rule) => [rule.url, rule]));

// Which service a probe speaks for. Acceptance is per service: a strategy that
// fixes YouTube but not Discord is a usable result on an ISP where Discord
// cannot be unblocked at all, and rejecting it outright leaves the user with
// nothing. See strategy-outcome.js.
function serviceOfUrl(url) {
  const rule = RULES_BY_URL.get(url);
  return rule ? rule.service : null;
}

// Endpoints of one tier ('screen' | 'full'), grouped by service, so the sweep
// can screen both services cheaply, drop the ones that are already lost, and
// spend the expensive probes only on services still in play.
function endpointsByService(tier) {
  const grouped = {};
  for (const rule of PROBE_RULES) {
    const inTier = tier === 'screen' ? rule.tier === 'screen' : rule.tier !== 'screen';
    if (!inTier) continue;
    (grouped[rule.service] = grouped[rule.service] || []).push(rule.url);
  }
  return grouped;
}

// Verification requires every probe to pass, so failing any one is already enough
// to reject a strategy. That makes the order free to choose — and cheapest-first
// matters a lot: with ~50 strategies, downloading the YouTube shell for every
// doomed one is most of the wait. Screening probes answer in bytes.
const SCREENING_ENDPOINTS = Object.freeze(
  PROBE_RULES.filter((rule) => rule.tier === 'screen').map((rule) => rule.url)
);
const REMAINING_ENDPOINTS = Object.freeze(
  PROBE_RULES.filter((rule) => rule.tier !== 'screen').map((rule) => rule.url)
);

// Cheapest-first order for callers that run the probes as one sequence, such as
// the elevated Windows batch.
const ORDERED_ENDPOINTS = Object.freeze([...SCREENING_ENDPOINTS, ...REMAINING_ENDPOINTS]);

// Where the sweep time actually goes. Body size is a rounding error next to
// waiting on a probe that will never answer: at 15s per hung probe, ~50
// strategies is a quarter of an hour, which is what the old 15s budget cost
// whenever nothing worked.
//
// Measured unproxied on a clean link, the screening probes answer in 53-82 ms
// and the YouTube shell in ~295 ms, so 6s is roughly 20x headroom over a healthy
// response — impatient with a hung strategy, not with a slow one.
const PROBE_TIMEOUTS = Object.freeze({
  screenTimeoutSec: 6,
  fullTimeoutSec: 12
});

// The strategy that worked last time is tried first and deserves the old
// generous budget: being wrong about it costs a reconnect, and it is one
// strategy's worth of waiting, not fifty.
const PATIENT_TIMEOUTS = Object.freeze({
  screenTimeoutSec: 15,
  fullTimeoutSec: 15
});

function matches(pattern, text) {
  return new RegExp(pattern, 'i').test(text);
}

function validateProbe(url, status, body = '', bodyHex = '') {
  const rule = RULES_BY_URL.get(url);
  // Custom targets prove a TLS-authenticated HTTP response from this URL.
  // Redirects count as reachability, but are not followed to unrelated hosts.
  if (!rule) return status >= 200 && status < 400 && !looksLikeBlockNotice(body);

  if (!rule.statuses.includes(status)) return false;
  if (rule.requestHost && status === 404) return !looksLikeBlockNotice(body);
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

// How a runtime must send the request: `requestHost` goes in the Host header
// while TLS keeps the URL's host as SNI, and `wholeBody` means the body has to
// be read to its end rather than to the validation sample.
function probeRequest(url) {
  const rule = RULES_BY_URL.get(url);
  return {
    requestHost: (rule && rule.requestHost) || null,
    wholeBody: Boolean(rule && rule.wholeBody)
  };
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
    '  [string]$Url,',
    '  [string]$UrlBase64,',
    '  [Parameter(Mandatory=$true)][string]$Kind,',
    '  [int]$TimeoutSec = 10',
    ')',
    '',
    'if ($UrlBase64) { $Url = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($UrlBase64)) }',
    `$sampleBytes = ${BODY_SAMPLE_BYTES}`,
    '$status = 0',
    '$text = ""',
    '$hex = ""',
    '',
    `$wholeBody = @(${PROBE_RULES.filter((rule) => rule.wholeBody).map((rule) => psQuote(rule.kind)).join(', ')}) -contains $Kind`,
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
    '  # A volume probe checks that the whole body arrives, not just the sample.',
    '  if ($wholeBody -and $total -eq $sampleBytes) {',
    '    $rest = New-Object byte[] 65536',
    '    while ($stream.Read($rest, 0, $rest.Length) -gt 0) { }',
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
    '  $request.AllowAutoRedirect = $false',
    '  $request.Proxy = $null',
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
    `$notice = ($text -imatch ${psQuote(NOTICE_TITLE_PATTERN)}) -or ($text.Length -lt ${NOTICE_PAGE_MAX_CHARS} -and $text -imatch ${psQuote(BLOCK_NOTICE_PATTERN)})`,
    '',
    'switch ($Kind) {'
  ];

  for (const rule of PROBE_RULES) {
    const statusList = rule.statuses.map((s) => String(s)).join(', ');
    const checks = [`@(${statusList}) -contains $status`];
    // HttpWebRequest puts its Host into the SNI as well, so the request goes
    // out without it and the front answers 404: the same proof as the screen.
    if (rule.requestHost) checks.push(`(($status -eq 404 -and -not $notice) -or $text -imatch ${psQuote(rule.bodyPattern)})`);
    else if (rule.bodyPattern) checks.push(`$text -imatch ${psQuote(rule.bodyPattern)}`);
    if (rule.rejectBodyPattern) checks.push(`-not ($text -imatch ${psQuote(rule.rejectBodyPattern)})`);
    if (rule.hexPrefix) checks.push(`$hex.ToLower().StartsWith(${psQuote(rule.hexPrefix)})`);
    lines.push(`  ${psQuote(rule.kind)} {`);
    lines.push(`    if (${checks.join(' -and ')}) { exit 0 }`);
    lines.push('    exit 1');
    lines.push('  }');
  }

  lines.push('}');
  lines.push('# Custom target: HTTPS response without following redirects.');
  lines.push('if ($status -ge 200 -and $status -lt 400 -and -not $notice) { exit 0 }');
  lines.push('exit 1');

  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  BODY_SAMPLE_BYTES,
  ORDERED_ENDPOINTS,
  PATIENT_TIMEOUTS,
  PROBE_RULES,
  PROBE_TIMEOUTS,
  REMAINING_ENDPOINTS,
  SCREENING_ENDPOINTS,
  REQUIRED_DISCORD_ENDPOINTS,
  REQUIRED_YOUTUBE_ENDPOINTS,
  buildPowerShellProbeScript,
  YOUTUBE_VIDEO_VOLUME_URL,
  endpointsByService,
  probeKind,
  probeLabel,
  probeRequest,
  serviceOfUrl,
  validateProbe
};

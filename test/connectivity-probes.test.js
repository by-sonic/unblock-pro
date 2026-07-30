'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PROBE_RULES,
  REQUIRED_DISCORD_ENDPOINTS,
  REQUIRED_YOUTUBE_ENDPOINTS,
  buildPowerShellProbeScript,
  probeKind,
  probeLabel,
  validateProbe
} = require('../src/main/connectivity-probes');

const YT_HOME = 'https://www.youtube.com/';
const YT_VIDEO = 'https://redirector.googlevideo.com/';
const DC_API = 'https://discord.com/api/v10/gateway';
const DC_CDN = 'https://cdn.discordapp.com/embed/avatars/0.png';

const PNG_HEX = '89504e470d0a1a0a0000000d49484452';

test('auto-selection probes the services users actually need', () => {
  assert.deepEqual(REQUIRED_YOUTUBE_ENDPOINTS, [YT_HOME, YT_VIDEO]);
  assert.deepEqual(REQUIRED_DISCORD_ENDPOINTS, [DC_API, DC_CDN]);
});

test('accepts genuine responses from every probed endpoint', () => {
  assert.equal(validateProbe(YT_HOME, 200, '<html><title>YouTube</title>ytcfg.set({})'), true);
  assert.equal(validateProbe(YT_VIDEO, 404, 'Not Found'), true);
  assert.equal(validateProbe(DC_API, 200, '{"url":"wss://gateway.discord.gg"}'), true);
  assert.equal(validateProbe(DC_CDN, 200, 'PNG', PNG_HEX), true);
});

test('rejects an ISP stub page served with HTTP 200', () => {
  // The false-positive behind #31/#22/#18: a 200 was treated as success, so
  // auto-select enabled a strategy that did not work in the browser.
  const stub = '<html><body>Доступ ограничен по решению уполномоченного органа</body></html>';

  assert.equal(validateProbe(YT_HOME, 200, stub), false);
  assert.equal(validateProbe(DC_API, 200, stub), false);
  assert.equal(validateProbe(DC_CDN, 200, stub, '3c68746d6c3e'), false);
});

test('rejects a 4xx that used to pass the code < 500 check', () => {
  assert.equal(validateProbe(YT_HOME, 403, 'Forbidden'), false);
  assert.equal(validateProbe(DC_API, 429, '{"retry_after":1}'), false);
  assert.equal(validateProbe(DC_CDN, 404, 'missing', ''), false);
});

test('rejects a hijacked googlevideo redirector answering 200', () => {
  // The healthy answer is 404. Anything serving content here is not the real
  // video-delivery host.
  assert.equal(validateProbe(YT_VIDEO, 200, '<html>welcome</html>'), false);
  assert.equal(validateProbe(YT_VIDEO, 404, 'страница заблокирована'), false);
});

test('rejects malformed or truncated Discord gateway JSON', () => {
  assert.equal(validateProbe(DC_API, 200, '{"url":'), false);
  assert.equal(validateProbe(DC_API, 200, '{"url":"https://gateway.discord.gg"}'), false);
  assert.equal(validateProbe(DC_API, 200, '{}'), false);
});

test('unknown URLs keep the permissive status check', () => {
  assert.equal(validateProbe('https://example.com/', 200, ''), true);
  assert.equal(validateProbe('https://example.com/', 301, ''), true);
  assert.equal(validateProbe('https://example.com/', 500, ''), false);
  assert.equal(validateProbe('https://example.com/', 0, ''), false);
});

test('probe labels are human-readable for the log', () => {
  assert.equal(probeLabel(DC_API), 'Discord API');
  assert.equal(probeLabel('https://example.com/'), 'https://example.com/');
});

test('the generated PowerShell probe covers every rule and stays in sync', () => {
  const script = buildPowerShellProbeScript();

  // ASCII-only: PowerShell 5.1 misreads non-ASCII files written without a BOM.
  assert.match(script, /^[\x09\x0a\x0d\x20-\x7e]*$/, 'script must be pure ASCII');

  for (const rule of PROBE_RULES) {
    assert.ok(script.includes(`'${rule.kind}'`), `missing branch for ${rule.kind}`);
    assert.ok(
      script.includes(`@(${rule.statuses.join(', ')}) -contains $status`),
      `${rule.kind}: accepted statuses not asserted`
    );
    if (rule.hexPrefix) {
      assert.ok(script.includes(rule.hexPrefix), `${rule.kind}: hex prefix not asserted`);
    }
    if (rule.bodyPattern) {
      assert.ok(script.includes('$text -imatch'), `${rule.kind}: body pattern not asserted`);
    }
  }

  // Every probed endpoint must resolve to a kind the script implements.
  for (const url of [...REQUIRED_YOUTUBE_ENDPOINTS, ...REQUIRED_DISCORD_ENDPOINTS]) {
    const kind = probeKind(url);
    assert.ok(kind, `no probe kind for ${url}`);
    assert.ok(script.includes(`'${kind}'`), `script has no branch for ${kind}`);
  }
});

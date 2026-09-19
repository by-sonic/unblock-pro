'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTargetUrl, buildTargetOutcome, includeTargetInLists } = require('../src/main/custom-target');
const { runServiceProbes } = require('../src/main/service-probe-run');
const { isAcceptable, describeOutcome } = require('../src/main/strategy-outcome');
const { buildStrategySweepBatch, parseSweepResult } = require('../src/main/windows-batch');
const { buildPowerShellProbeScript, validateProbe } = require('../src/main/connectivity-probes');

test('empty target preserves default mode, valid targets retain their full path and query', () => {
  assert.equal(normalizeTargetUrl('  '), '');
  assert.equal(normalizeTargetUrl(undefined), '');
  assert.equal(normalizeTargetUrl(' https://EXAMPLE.com:443/path?a=1&b=2 '), 'https://example.com/path?a=1&b=2');
  assert.equal(new URL(normalizeTargetUrl('https://пример.рф/')).hostname, 'xn--e1afmkfd.xn--p1ai');
});

test('target validation rejects unsafe schemes, credentials, control characters and unsupported ports/hosts', () => {
  for (const url of ['http://example.com', 'file:///tmp/a', 'javascript:alert(1)', 'https://me:secret@example.com/', 'https://example.com:8443/', 'https://example.com/#secret', 'https://127.0.0.1/', 'https://[::1]/', 'https://localhost/', 'https://example.com/a\nb', 'https://example.com/a b', 'https://bad_name.example/', 'https://example.com/' + 'a'.repeat(2048), {}, ['https://example.com']]) {
    assert.throws(() => normalizeTargetUrl(url), undefined, String(url));
  }
});

test('custom host participates in every generated hostlist without modifying saved lists', () => {
  const lists = {
    'list-general.txt': 'general.example', 'list-google.txt': 'google.example',
    'list-discord.txt': 'discord.example', 'list-all.txt': 'all.example',
    'list-exclude.txt': 'example.com\nunrelated.example\nsub.example.com'
  };
  const updated = includeTargetInLists(lists, 'https://sub.example.com/page');
  for (const name of ['list-general.txt', 'list-google.txt', 'list-discord.txt', 'list-all.txt']) {
    assert.ok(updated[name].split('\n').includes('sub.example.com'));
    assert.ok(!lists[name].includes('sub.example.com'));
  }
  assert.equal(updated['list-exclude.txt'], 'unrelated.example');
  assert.ok(lists['list-exclude.txt'].includes('example.com'));
  assert.deepEqual(includeTargetInLists(lists, ''), lists);
});

test('custom success selects a strategy without claiming either standard service was verified', async () => {
  const calls = [];
  const { outcome, failed } = await runServiceProbes({
    targetUrl: 'https://example.com/custom',
    screen: () => assert.fail('default services must not run'),
    discordExtra: () => assert.fail('Discord must not run'),
    full: async (url) => { calls.push(url); return true; }
  });
  assert.deepEqual(calls, ['https://example.com/custom']);
  assert.deepEqual(outcome.services, { youtube: null, discord: null, target: true });
  assert.equal(isAcceptable(outcome), true);
  assert.match(describeOutcome(outcome), /не проверялись/);
  assert.deepEqual(failed, []);
});

test('failed target cannot be accepted as a partial strategy', async () => {
  const { outcome, failed } = await runServiceProbes({ targetUrl: 'https://example.com/', full: async () => false });
  assert.equal(isAcceptable(outcome, true), false);
  assert.deepEqual(failed, ['Выбранный сайт']);
});

test('cancellation before or during a custom probe cannot select the strategy', async () => {
  const before = await runServiceProbes({ targetUrl: 'https://example.com/', shouldAbort: () => true, full: () => assert.fail('cancelled') });
  assert.equal(isAcceptable(before.outcome), false);
  let cancelled = false;
  const during = await runServiceProbes({ targetUrl: 'https://example.com/', shouldAbort: () => cancelled, full: async () => { cancelled = true; return true; } });
  assert.equal(isAcceptable(during.outcome), false);
});

const batchOptions = {
  strategies: [{ name: 'alpha', args: ['--filter-tcp=443'] }, { name: 'beta', args: [] }],
  binaryPath: 'C:\\bin\\winws.exe', binDirectory: 'C:\\bin', resultFile: 'C:\\tmp\\result',
  progressFile: 'C:\\tmp\\progress', hostsUpdateScript: 'C:\\tmp\\hosts.ps1',
  probeScript: 'C:\\tmp\\probe.ps1', wsTestScript: 'C:\\tmp\\ws.ps1', cancelFile: 'C:\\tmp\\cancel'
};

test('elevated custom mode encodes shell metacharacters and tests the target for each strategy', () => {
  const url = normalizeTargetUrl('https://example.com/a?x=%PATH%&q=!test!&other=\'`$()');
  const batch = buildStrategySweepBatch({ ...batchOptions, targetUrl: url });
  assert.ok(!batch.includes(url));
  assert.ok(!batch.includes('%PATH%'));
  const encoded = Buffer.from(url).toString('base64');
  assert.equal(batch.split('-UrlBase64 "' + encoded + '"').length - 1, 2);
  assert.ok(!batch.includes('-Url "https://discord.com'));
  assert.match(batch, /echo TARGET:alpha/);
  assert.match(batch, /if !errorlevel! neq 0 goto :target_next_0/);
  assert.match(batch, /if exist "C:\\tmp\\cancel" goto :cancelled/);
  assert.match(batch, /:cancelled\r\ntaskkill/);
  const labels = new Set([...batch.matchAll(/^:([a-z_0-9]+)\r?$/gim)].map((m) => m[1]));
  for (const match of batch.matchAll(/goto :([a-z_0-9]+)/gi)) assert.ok(labels.has(match[1]), match[1]);
});

test('elevated target result has a distinct verdict, cancellation never succeeds', () => {
  const parsed = parseSweepResult('TARGET:alpha');
  assert.equal(parsed.target, true);
  assert.equal(parsed.services, undefined);
  assert.equal(buildTargetOutcome('https://example.com/', parsed.target).services.youtube, null);
  assert.deepEqual(parseSweepResult('CANCELLED'), { found: false });
});

test('target verification rejects error/stub responses and does not follow redirects or disable TLS verification', () => {
  const url = 'https://example.com/';
  assert.equal(validateProbe(url, 200, 'welcome'), true);
  assert.equal(validateProbe(url, 302, ''), true);
  for (const code of [0, 100, 403, 404, 500]) assert.equal(validateProbe(url, code, ''), false);
  assert.equal(validateProbe(url, 200, 'Доступ ограничен'), false);
  const script = buildPowerShellProbeScript();
  assert.match(script, /FromBase64String/);
  assert.match(script, /AllowAutoRedirect = \$false/);
  assert.doesNotMatch(script, /ServerCertificateValidationCallback|SkipCertificateCheck|return \$true/);
});

test('generated target PowerShell parses in Windows PowerShell 5.1', { skip: process.platform !== 'win32' }, () => {
  const { spawnSync } = require('node:child_process');
  const encoded = Buffer.from(buildPowerShellProbeScript()).toString('base64');
  const command = `$tokens = $null; $parseErrors = $null; [void][Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')), [ref]$tokens, [ref]$parseErrors); if ($parseErrors.Count -gt 0) { $parseErrors | Out-String | Write-Output; exit 1 }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

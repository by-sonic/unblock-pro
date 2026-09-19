'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildStrategySweepBatch,
  parseSweepResult,
  quoteArg
} = require('../src/main/windows-batch');

const STRATEGIES = [
  { name: 'alpha', args: ['--filter-l7=tls', '--hostlist=C:\\Program Files\\lists\\all.txt'] },
  { name: 'beta', args: ['--split-pos=1'] },
  { name: 'gamma', args: ['--oob'] }
];

function build(overrides = {}) {
  return buildStrategySweepBatch({
    strategies: STRATEGIES,
    binaryPath: 'C:\\bin\\winws.exe',
    binDirectory: 'C:\\bin',
    resultFile: 'C:\\tmp\\result.txt',
    progressFile: 'C:\\tmp\\progress.txt',
    hostsUpdateScript: 'C:\\tmp\\hosts.ps1',
    probeScript: 'C:\\tmp\\probe.ps1',
    wsTestScript: 'C:\\tmp\\ws.ps1',
    ...overrides
  });
}

test('paths with spaces are quoted, plain flags are not', () => {
  assert.equal(quoteArg('--hostlist=C:\\Program Files\\a.txt'), '--hostlist="C:\\Program Files\\a.txt"');
  assert.equal(quoteArg('--split-pos=1'), '--split-pos=1');
  assert.equal(quoteArg('--oob'), '--oob');
});

test('the batch uses CRLF line endings', () => {
  const bat = build();
  assert.ok(bat.includes('\r\n'));
  assert.equal(bat.split('\n').every((line) => line === '' || line.endsWith('\r')), true);
});

test('delayed expansion is enabled, since every flag depends on it', () => {
  assert.match(build(), /setlocal EnableDelayedExpansion/);
});

test('native cmd launch preserves Flowseal exclamation reset markers', { skip: process.platform !== 'win32' }, (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-argv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'capture.js'), "require('fs').writeFileSync('args.json', JSON.stringify(process.argv.slice(2)))");
  const args = ['capture.js', '--dpi-desync-fake-tls=!', '--dpi-desync-fake-tls=!+'];
  const bat = build({ binaryPath: process.execPath, binDirectory: dir, strategies: [{ name: 'reset', args }] });
  const blocks = [...bat.matchAll(/setlocal DisableDelayedExpansion\r\n[\s\S]*?\r\nendlocal/g)];
  assert.equal(blocks.length, 2, 'initial and partial restart must both preserve markers');
  // Execute only the generated launch fragment with a harmless argv recorder.
  // No winws, taskkill, hosts/DNS changes or elevated shell is involved.
  for (const [block] of blocks) {
    fs.writeFileSync(path.join(dir, 'launch.cmd'), '@echo off\r\nsetlocal EnableDelayedExpansion\r\n' + block.replace('start "" /b', 'start "" /b /wait') + '\r\n');
    execFileSync('cmd.exe', ['/d', '/c', 'launch.cmd'], { cwd: dir, timeout: 10000 });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8')), args.slice(1));
  }
});

test('each strategy gets its own label set, so gotos cannot collide', () => {
  const bat = build();
  for (let i = 0; i < STRATEGIES.length; i++) {
    for (const label of ['strat_next', 'yt_done', 'dc_done', 'not_full', 'run_partial']) {
      assert.ok(bat.includes(`:${label}_${i}\r\n`) || bat.includes(`:${label}_${i}`), `нет метки ${label}_${i}`);
    }
  }
});

test('every goto target exists as a label', () => {
  const bat = build();
  const labels = new Set([...bat.matchAll(/^:([a-z_0-9]+)\r?$/gim)].map((m) => m[1].toLowerCase()));
  const targets = [...bat.matchAll(/goto :([a-z_0-9]+)/gi)].map((m) => m[1].toLowerCase());

  assert.ok(targets.length > 0);
  for (const target of new Set(targets)) {
    assert.ok(labels.has(target), `goto :${target} без метки`);
  }
});

test('screening probes for both services run before the expensive ones', () => {
  const bat = build();
  const screenIdx = bat.indexOf('redirector.googlevideo.com');
  const discordScreenIdx = bat.indexOf('discord.com/api/v10/gateway');
  const fullIdx = bat.indexOf('www.youtube.com');

  assert.ok(screenIdx !== -1 && discordScreenIdx !== -1 && fullIdx !== -1);
  assert.ok(screenIdx < fullIdx, 'дешёвая проба YouTube идёт раньше дорогой');
  assert.ok(discordScreenIdx < fullIdx, 'Discord отсеивается до загрузки страницы YouTube');
});

test('a strategy where nothing survives screening skips the expensive probes', () => {
  assert.match(build(), /if "!YT!!DC!"=="00" goto :strat_next_0/);
});

test('a full match is written as WORKS and stops the sweep', () => {
  const bat = build();
  assert.match(bat, /echo WORKS:alpha> "%RESULT%"/);
  assert.ok(bat.indexOf('echo WORKS:alpha') < bat.indexOf('goto :end'));
});

test('the first single-service strategy is remembered, later ones do not overwrite it', () => {
  const bat = build();
  assert.match(bat, /if not "!PARTIAL_IDX!"=="" goto :strat_next_1/);
  assert.match(bat, /set "PARTIAL_IDX=1"/);
});

test('with no partial candidate the result is NONE', () => {
  const bat = build();
  const idx = bat.indexOf('echo NONE> "%RESULT%"');
  assert.ok(idx !== -1);
  assert.ok(bat.lastIndexOf('if not "!PARTIAL_IDX!"=="" goto :partial_dispatch') < idx);
});

test('the remembered partial strategy is started again rather than left dead', () => {
  const bat = build();
  const dispatch = bat.indexOf(':partial_dispatch');
  assert.ok(dispatch !== -1);
  assert.match(bat.slice(dispatch), /echo PARTIAL:!PARTIAL_SERVICES!:!PARTIAL_NAME!> "%RESULT%"/);
  assert.match(bat.slice(dispatch), /if "!PARTIAL_IDX!"=="2" goto :run_partial_2/);
  // The retry block must actually launch the engine again.
  assert.match(bat.slice(bat.indexOf(':run_partial_2')), /start "" \/b "C:\\bin\\winws\.exe" --oob/);
});

test('the preferred first strategy gets the patient probe budget', () => {
  const patient = build({ firstIsPreferred: true });
  const impatient = build({ firstIsPreferred: false });

  assert.match(patient, /-TimeoutSec 15/);
  assert.doesNotMatch(impatient.split(':: Strategy 2')[0], /-TimeoutSec 15/);
});

test('WORKS is parsed as both services working', () => {
  assert.deepEqual(parseSweepResult('WORKS:multi:disorder+tlsrec'), {
    found: true,
    strategy: 'multi:disorder+tlsrec',
    services: { youtube: true, discord: true }
  });
});

test('PARTIAL keeps the strategy name even though it contains colons', () => {
  assert.deepEqual(parseSweepResult('PARTIAL:10:multi:disorder+tlsrec'), {
    found: true,
    strategy: 'multi:disorder+tlsrec',
    services: { youtube: true, discord: false }
  });
});

test('a Discord-only partial is reported as such', () => {
  assert.deepEqual(parseSweepResult('PARTIAL:01:beta').services, { youtube: false, discord: true });
});

test('NONE, junk and an unreadable result all mean "nothing found"', () => {
  assert.equal(parseSweepResult('NONE').found, false);
  assert.equal(parseSweepResult('PARTIAL:broken').found, false);
  assert.equal(parseSweepResult('').found, false);
  assert.equal(parseSweepResult(null).found, false);
});

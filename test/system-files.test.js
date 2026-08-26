'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildBlockEndMarker,
  buildBlockMarker,
  collectBlockHostnames,
  hasCurrentBlock,
  hasMarkedBlock,
  isSafeHostsRewrite,
  parsePfEnableToken,
  removeMarkedBlock,
  replaceMarkedBlock
} = require('../src/main/system-files');

const MARKER = '# UnblockPro Discord/Telegram hosts';

// Counts only the versioned opening marker, so the closing sentinel is not
// mistaken for a second block.
function countBlocks(text) {
  return text.split('\n').filter((l) => /^\s*# UnblockPro Discord\/Telegram hosts v/.test(l)).length;
}

function countEndMarkers(text) {
  return text.split('\n').filter((l) => l.trim() === buildBlockEndMarker(MARKER)).length;
}

// The payload the app actually writes separates its Telegram and Discord
// sections with a blank line. Anything that infers the block's extent from
// layout has to be tested against this shape, not a one-liner.
const REAL_SHAPED_BODY = [
  '149.154.167.220 telegram.me',
  '149.154.167.220 t.me',
  '',
  '9.9.9.9 russia10000.discord.media',
  '9.9.9.9 finland10000.discord.media'
].join('\n');

test('parses the pf enable token so it can be released on disconnect', () => {
  assert.equal(parsePfEnableToken('pf enabled\nToken : 12345678901234567890'), '12345678901234567890');
  assert.equal(parsePfEnableToken('Token: 42'), '42');
  assert.equal(parsePfEnableToken('pf already enabled'), null);
  assert.equal(parsePfEnableToken(''), null);
  assert.equal(parsePfEnableToken(null), null);
});

test('detects an existing block regardless of version', () => {
  const withOld = `127.0.0.1 localhost\n\n${MARKER} v2.0.18\n1.2.3.4 finland10000.discord.media\n`;

  assert.equal(hasMarkedBlock(withOld, MARKER), true);
  assert.equal(hasCurrentBlock(withOld, MARKER, '2.0.18'), true);
  // The version-aware check is what lets a stale block be refreshed instead of
  // trusted forever — Discord voice IPs rotate.
  assert.equal(hasCurrentBlock(withOld, MARKER, '2.0.19'), false);
  assert.equal(hasMarkedBlock('127.0.0.1 localhost\n', MARKER), false);
});

test('removing a block leaves unrelated entries untouched', () => {
  const hosts = [
    '##',
    '# Host Database',
    '##',
    '127.0.0.1 localhost',
    '255.255.255.255 broadcasthost',
    '',
    '# my own entry',
    '10.0.0.5 nas.local',
    '',
    `${MARKER} v2.0.18`,
    '1.2.3.4 finland10000.discord.media',
    '1.2.3.4 finland10001.discord.media',
    ''
  ].join('\n');

  const cleaned = removeMarkedBlock(hosts, MARKER);

  assert.ok(cleaned.includes('127.0.0.1 localhost'));
  assert.ok(cleaned.includes('10.0.0.5 nas.local'), 'user entries must survive');
  assert.ok(cleaned.includes('# my own entry'));
  assert.ok(!cleaned.includes('discord.media'), 'our entries must be gone');
  assert.ok(!cleaned.includes(MARKER));
  assert.equal(hasMarkedBlock(cleaned, MARKER), false);
});

test('removing is a no-op when no block is present', () => {
  const hosts = '127.0.0.1 localhost\n';
  assert.equal(removeMarkedBlock(hosts, MARKER), hosts);
});

test('removing twice is idempotent', () => {
  const hosts = `127.0.0.1 localhost\n\n${MARKER} v1\n1.2.3.4 a.discord.media\n`;
  const once = removeMarkedBlock(hosts, MARKER);
  assert.equal(removeMarkedBlock(once, MARKER), once);
});

test('replacing a stale block does not stack duplicates', () => {
  const hosts = `127.0.0.1 localhost\n\n${MARKER} v2.0.18\n1.1.1.1 finland10000.discord.media\n`;

  const updated = replaceMarkedBlock(hosts, MARKER, '2.0.19', '9.9.9.9 finland10000.discord.media');

  assert.equal(countBlocks(updated), 1, 'exactly one block after replace');
  assert.equal(countEndMarkers(updated), 1, 'exactly one closing sentinel');
  assert.ok(updated.includes('9.9.9.9 finland10000.discord.media'), 'new IP present');
  assert.ok(!updated.includes('1.1.1.1'), 'stale IP gone');
  assert.ok(updated.includes('127.0.0.1 localhost'), 'system entries kept');
  assert.equal(hasCurrentBlock(updated, MARKER, '2.0.19'), true);
});

test('replacing on a file without a block simply appends', () => {
  const updated = replaceMarkedBlock('127.0.0.1 localhost\n', MARKER, '2.0.19', '9.9.9.9 a.discord.media');

  assert.ok(updated.startsWith('127.0.0.1 localhost\n'));
  assert.equal(hasCurrentBlock(updated, MARKER, '2.0.19'), true);
  assert.ok(updated.endsWith('\n'), 'hosts file must end with a newline');
});

test('repeated replaces never grow the file unboundedly', () => {
  let hosts = '127.0.0.1 localhost\n';
  for (let i = 0; i < 5; i++) {
    hosts = replaceMarkedBlock(hosts, MARKER, `2.0.${i}`, `9.9.9.${i} a.discord.media`);
  }

  assert.equal(countBlocks(hosts), 1);
  assert.equal(countEndMarkers(hosts), 1);
  assert.equal(hosts.split('\n').filter((l) => l.includes('discord.media')).length, 1);
});

// Regression: the block body contains a blank line, so an implementation that
// ends the block at the first blank line removed only the first half. The rest
// stayed behind unmarked — read as "the user's own lines" — and every version
// bump appended a fresh copy. In production that is ~2800 Discord lines added
// per update, and because hosts resolution is first-match-wins, the stale
// address kept winning over the new one: exactly the failure the versioned
// marker exists to prevent.
test('a block whose body contains a blank line is removed whole', () => {
  const hosts = replaceMarkedBlock('127.0.0.1 localhost\n', MARKER, '2.0.19', REAL_SHAPED_BODY);

  const cleaned = removeMarkedBlock(hosts, MARKER, {
    ownHostnames: collectBlockHostnames(REAL_SHAPED_BODY)
  });

  assert.equal(cleaned, '127.0.0.1 localhost\n');
  assert.ok(!cleaned.includes('discord.media'), 'no orphaned Discord lines');
  assert.ok(!cleaned.includes('telegram'), 'no orphaned Telegram lines');
});

test('version bumps with a real-shaped body neither duplicate nor grow the file', () => {
  let hosts = '127.0.0.1 localhost\n';
  const own = collectBlockHostnames(REAL_SHAPED_BODY);

  for (const version of ['2.0.19', '2.0.20', '2.0.21', '2.0.22']) {
    const next = replaceMarkedBlock(hosts, MARKER, version, REAL_SHAPED_BODY);
    assert.equal(
      isSafeHostsRewrite(hosts, next, MARKER, { ownHostnames: own }),
      true,
      `rewrite must stay safe at ${version}`
    );
    hosts = next;
  }

  assert.equal(countBlocks(hosts), 1);
  assert.equal(hosts.split('\n').filter((l) => l.includes('discord.media')).length, 2);
  // Both Telegram lines share one address; count that rather than the substring
  // "telegram", which t.me does not contain.
  assert.equal(hosts.split('\n').filter((l) => l.includes('149.154.167.220')).length, 2);
});

// Regression: a user appending an entry directly below the block (no blank line
// between) had it silently deleted on the next rewrite, while the integrity
// guard reported the rewrite as safe — the guard asked the same parser that made
// the mistake which lines were ours.
test('a user entry directly below the block survives a rewrite', () => {
  const own = collectBlockHostnames(REAL_SHAPED_BODY);
  const withBlock = replaceMarkedBlock('127.0.0.1 localhost\n', MARKER, '2.0.19', REAL_SHAPED_BODY);
  const withUserLine = withBlock.replace(/\n*$/, '\n') + '10.0.0.9 myserver.local\n';

  const next = replaceMarkedBlock(withUserLine, MARKER, '2.0.20', REAL_SHAPED_BODY);

  assert.ok(next.includes('10.0.0.9 myserver.local'), 'user entry must survive');
  assert.equal(isSafeHostsRewrite(withUserLine, next, MARKER, { ownHostnames: own }), true);
});

// Upgrade path from 2.0.19 and earlier: those releases appended the block with
// no closing sentinel, so its extent has to be inferred. Inference must stop at
// the first line we do not own rather than swallowing whatever follows.
test('a legacy block without a sentinel migrates without touching user entries', () => {
  const own = collectBlockHostnames(REAL_SHAPED_BODY);
  const legacy = [
    '127.0.0.1 localhost',
    '255.255.255.255 broadcasthost',
    '',
    `${MARKER} v2.0.19`,
    '149.154.167.220 telegram.me',
    '149.154.167.220 t.me',
    '',
    '104.25.158.178 russia10000.discord.media',
    '104.25.158.178 finland10000.discord.media',
    '10.0.0.9 myserver.local',
    ''
  ].join('\n');

  const next = replaceMarkedBlock(legacy, MARKER, '2.0.20', REAL_SHAPED_BODY);

  assert.ok(next.includes('10.0.0.9 myserver.local'), 'user entry must survive migration');
  assert.ok(!next.includes('104.25.158.178'), 'stale pinned address must be gone');
  assert.ok(next.includes('9.9.9.9 finland10000.discord.media'), 'fresh address present');
  assert.ok(next.includes('255.255.255.255 broadcasthost'), 'system entries kept');
  assert.equal(countBlocks(next), 1);
  assert.equal(isSafeHostsRewrite(legacy, next, MARKER, { ownHostnames: own }), true);
});

test('collectBlockHostnames takes every hostname and ignores comments', () => {
  const hostnames = collectBlockHostnames(
    '# comment\n1.2.3.4 a.example b.example\n\n5.6.7.8 c.example\n'
  );
  assert.deepEqual([...hostnames].sort(), ['a.example', 'b.example', 'c.example']);
});

test('buildBlockMarker appends the version when given one', () => {
  assert.equal(buildBlockMarker(MARKER, '2.0.19'), `${MARKER} v2.0.19`);
  assert.equal(buildBlockMarker(MARKER, null), MARKER);
});

test('the hosts rewrite guard accepts a correct replacement', () => {
  const body = '9.9.9.9 a.discord.media';
  const original = `127.0.0.1 localhost\n10.0.0.5 nas.local\n\n${MARKER} v1\n1.1.1.1 a.discord.media\n`;
  const next = replaceMarkedBlock(original, MARKER, '2', body);

  assert.equal(
    isSafeHostsRewrite(original, next, MARKER, { ownHostnames: collectBlockHostnames(body) }),
    true
  );
});

// Without ownership information the guard cannot tell a stale line of ours from
// a user's, so it must refuse rather than guess. A caller that forgets to say
// what it owns loses the update, not the user's data.
test('the hosts rewrite guard refuses when it cannot attribute a dropped line', () => {
  const original = `127.0.0.1 localhost\n\n${MARKER} v1\n1.1.1.1 a.discord.media\n`;
  const next = replaceMarkedBlock(original, MARKER, '2', '9.9.9.9 a.discord.media');

  assert.equal(isSafeHostsRewrite(original, next, MARKER), false);
});

// A user entry that happens to map a hostname we manage is still theirs to keep
// if it is not inside our block — but our own stale copy may go. The guard
// distinguishes them by whether the line survives, not by address.
test('the hosts rewrite guard blocks dropping a user line with an unmanaged hostname', () => {
  const body = '9.9.9.9 a.discord.media';
  const own = collectBlockHostnames(body);
  const original = `127.0.0.1 localhost\n10.0.0.5 nas.local\n\n${MARKER} v1\n1.1.1.1 a.discord.media\n`;
  const clobbered = `127.0.0.1 localhost\n\n${MARKER} v2\n${body}\n${buildBlockEndMarker(MARKER)}\n`;

  assert.equal(isSafeHostsRewrite(original, clobbered, MARKER, { ownHostnames: own }), false);
});

test('the hosts rewrite guard blocks anything that drops user entries', () => {
  const original = `127.0.0.1 localhost\n10.0.0.5 nas.local\n\n${MARKER} v1\n1.1.1.1 a.discord.media\n`;

  // Truncated / clobbered candidates that must never reach /etc/hosts.
  assert.equal(isSafeHostsRewrite(original, '', MARKER), false, 'empty');
  assert.equal(isSafeHostsRewrite(original, '   \n', MARKER), false, 'whitespace only');
  assert.equal(
    isSafeHostsRewrite(original, `${MARKER} v2\n9.9.9.9 a.discord.media\n`, MARKER),
    false,
    'lost every system and user line'
  );
  assert.equal(
    isSafeHostsRewrite(original, `127.0.0.1 localhost\n${MARKER} v2\n9.9.9.9 a.discord.media\n`, MARKER),
    false,
    'lost the user NAS entry'
  );
});

test('the hosts rewrite guard requires a loopback mapping to survive', () => {
  const original = '127.0.0.1 localhost\n';
  assert.equal(isSafeHostsRewrite(original, 'somehost 1.2.3.4\n', MARKER), false);
});

// --- The elevated hosts write ---

const WIN_HOSTS = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
const WIN_TEMP = 'C:\\Temp\\new.txt';

test('the elevated script refuses to run unless both files exist', () => {
  const { buildHostsUpdateScript } = require('../src/main/system-files');
  const script = buildHostsUpdateScript(WIN_HOSTS, WIN_TEMP);

  assert.match(script, /Test-Path -LiteralPath \$newPath.*exit 1/);
  assert.match(script, /Test-Path -LiteralPath \$hostsPath.*exit 2/);
});

test('the elevated script backs up before it overwrites', () => {
  const { buildHostsUpdateScript } = require('../src/main/system-files');
  const script = buildHostsUpdateScript(WIN_HOSTS, WIN_TEMP);

  assert.ok(script.indexOf('.unblockpro.bak') < script.indexOf('[System.IO.File]::Copy'));
});

test('a quote in a path stays data instead of ending the string', () => {
  const { buildHostsUpdateScript } = require('../src/main/system-files');
  const script = buildHostsUpdateScript('C:\\a"; rm -rf x', WIN_TEMP);

  // PowerShell escapes a double quote inside a double-quoted string by doubling
  // it, so injected text cannot start a statement of its own.
  assert.ok(script.includes('$hostsPath = "C:\\a""; rm -rf x"'), script.split('; ')[0]);
});

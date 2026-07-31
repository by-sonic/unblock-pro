'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ZAPRET_MACOS_ARCHIVE_URL, ZAPRET_MACOS_COMMIT } = require('../src/main/zapret-source');

const repoRoot = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

test('the macOS source is pinned to a full commit id, not a moving ref', () => {
  // A tag or "latest" would let the compiled runtime drift away from the strategy
  // list, which was authored and validated against one specific tpws.
  assert.match(ZAPRET_MACOS_COMMIT, /^[0-9a-f]{40}$/, 'must be a full 40-char sha');
  assert.ok(ZAPRET_MACOS_ARCHIVE_URL.endsWith(ZAPRET_MACOS_COMMIT), 'archive url must carry the sha');
  assert.ok(
    ZAPRET_MACOS_ARCHIVE_URL.startsWith('https://'),
    'source must be fetched over TLS'
  );
});

test('nothing resolves the zapret runtime from a moving release', () => {
  // The defect this guards: the app used to compile whatever
  // api.github.com/repos/bol-van/zapret/releases/latest returned, so two users
  // could run different tpws builds and neither matched what CI shipped.
  //
  // Scoped to zapret on purpose — the app legitimately links its OWN releases
  // page for manual macOS updates, and that must keep working.
  const main = read('src/main/main.js');
  const code = main
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  assert.ok(!/bol-van\/zapret\/releases/.test(code), 'must not resolve a zapret release');
  assert.ok(!code.includes('getLatestZapretUrl'), 'the unpinned resolver must be gone');
  assert.ok(code.includes('ZAPRET_MACOS_ARCHIVE_URL'), 'main.js must use the pinned archive');

  // The app's own update link is a different thing and must survive.
  assert.ok(
    main.includes('by-sonic/unblock-pro/releases/latest'),
    'the manual-update link to our own releases must stay'
  );
});

test('the app, the build script and CI all pin the same commit', () => {
  // Three consumers, one constant. A hardcoded copy in any of them is how the
  // shipped runtime and the locally built one silently diverge.
  const script = read('scripts/download-binaries.js');
  const workflow = read('.github/workflows/build.yml');

  assert.ok(
    script.includes("require('../src/main/zapret-source')"),
    'download-binaries.js must import the shared constant'
  );
  assert.ok(
    workflow.includes("require('./src/main/zapret-source')"),
    'the workflow must read the commit from the shared module'
  );

  // Exactly 40 hex chars with no hex on either side. Without the lookarounds this
  // also matches the first 40 chars of the 64-char Flowseal SHA256, which is a
  // checksum and belongs hardcoded.
  const GIT_SHA = /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/g;

  for (const [name, text] of [['download-binaries.js', script], ['build.yml', workflow]]) {
    const hardcoded = text.match(GIT_SHA) || [];
    assert.deepEqual(hardcoded, [], `${name} still hardcodes a commit sha: ${hardcoded}`);
  }
});

test('the Flowseal checksum is still pinned — the guard above must not remove it', () => {
  // Windows integrity was already correct; this asserts the cleanup above did not
  // weaken it while chasing hardcoded commits.
  const bundle = read('src/main/flowseal-bundle.js');
  const workflow = read('.github/workflows/build.yml');

  assert.match(bundle, /FLOWSEAL_BUNDLE_SHA256 = '[0-9a-f]{64}'/, 'Windows bundle must keep its SHA256');
  assert.match(workflow, /[0-9a-f]{64}/, 'the workflow must still verify the Windows archive');
});

test('the extracted archive directory is verified against the pin', () => {
  // codeload expands to zapret-<commit>/. Accepting any zapret-* directory would
  // silently compile whatever was downloaded.
  const main = read('src/main/main.js');

  assert.ok(
    main.includes('includes(ZAPRET_MACOS_COMMIT)'),
    'the extracted directory must be matched against the pinned commit'
  );
});

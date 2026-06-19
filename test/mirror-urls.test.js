'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildMirrorUrls, DEFAULT_MIRRORS } = require('../src/main/mirror-urls');

test('github release URL gets the original first, then every mirror', () => {
  const url = 'https://github.com/bol-van/zapret/releases/download/v70.6/zapret-v70.6.zip';
  const result = buildMirrorUrls(url);

  assert.equal(result[0], url, 'original must be tried first');
  assert.equal(result.length, 1 + DEFAULT_MIRRORS.length);
  for (const mirror of DEFAULT_MIRRORS) {
    assert.ok(result.includes(`${mirror}${url}`), `missing mirror ${mirror}`);
  }
});

test('raw.githubusercontent.com is mirrored too', () => {
  const url = 'https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/main/.service/hosts';
  const result = buildMirrorUrls(url);
  assert.ok(result.length > 1);
  assert.ok(result.every((u) => u.includes(url)));
});

test('non-github URLs are returned unchanged', () => {
  const url = 'https://example.com/file.zip';
  assert.deepEqual(buildMirrorUrls(url), [url]);
});

test('malformed URL yields just the original', () => {
  assert.deepEqual(buildMirrorUrls('not a url'), ['not a url']);
});

test('custom mirror list is honored and normalized (trailing slash added)', () => {
  const url = 'https://github.com/a/b/releases/download/v1/x.zip';
  const result = buildMirrorUrls(url, ['https://m1.test', 'https://m2.test/']);
  assert.deepEqual(result, [url, `https://m1.test/${url}`, `https://m2.test/${url}`]);
});

test('result has no duplicates', () => {
  const url = 'https://github.com/a/b/x.zip';
  const result = buildMirrorUrls(url, ['https://m.test/', 'https://m.test/']);
  assert.equal(new Set(result).size, result.length);
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { FLOWSEAL_BUNDLE_VERSION, FLOWSEAL_SOURCE_COMMIT } = require('../src/main/flowseal-bundle');
const { HOST_LIST_GENERAL, HOST_LIST_GOOGLE, HOST_LIST_EXCLUDE, snapshot } = require('../src/main/flowseal-lists');

test('domain lists use the same audited upstream release as strategies and runtime', () => {
  assert.equal(snapshot.version, FLOWSEAL_BUNDLE_VERSION);
  assert.equal(snapshot.commit, FLOWSEAL_SOURCE_COMMIT);
  for (const entries of Object.values(snapshot.lists)) {
    assert.equal(entries.length, new Set(entries).size);
    assert.ok(entries.every((line) => /^\^?[a-z0-9.-]+$/.test(line)));
  }
});

test('new upstream domains and exclusions reach both application and package data', () => {
  assert.ok(HOST_LIST_GENERAL.split('\n').includes('^dns.google'));
  assert.ok(HOST_LIST_GENERAL.split('\n').includes('live-video.net'));
  assert.ok(HOST_LIST_GENERAL.split('\n').includes('zendesk.com'));
  assert.ok(HOST_LIST_GOOGLE.split('\n').includes('googlevideo.com'));
  assert.ok(HOST_LIST_EXCLUDE.split('\n').includes('api.steampowered.com'));
  assert.equal(HOST_LIST_EXCLUDE.split('\n').includes('live-video.net'), false);
});

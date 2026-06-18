'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveUpdateMode } = require('../src/main/update-mode');

test('macOS always installs manually regardless of the autoUpdate setting', () => {
  assert.equal(resolveUpdateMode({ platform: 'darwin', autoUpdate: true }).manualInstall, true);
  assert.equal(resolveUpdateMode({ platform: 'darwin', autoUpdate: false }).manualInstall, true);
});

test('other platforms auto-install unless the user opts out', () => {
  assert.equal(resolveUpdateMode({ platform: 'win32', autoUpdate: true }).manualInstall, false);
  assert.equal(resolveUpdateMode({ platform: 'win32', autoUpdate: false }).manualInstall, true);
});

test('a missing autoUpdate setting keeps automatic installs on non-macOS platforms', () => {
  assert.equal(resolveUpdateMode({ platform: 'win32', autoUpdate: undefined }).manualInstall, false);
});

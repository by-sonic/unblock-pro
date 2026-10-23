'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const installer = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
const commands = installer.split(/\r?\n/).filter((line) => line.trim().startsWith('nsExec::'));

test('installer pins inheritable grants on the folder only, never recursively (#79)', () => {
  // icacls drops (OI)(CI) ACEs on files; combined with /inheritance:r and /T
  // that left every installed file with an empty DACL.
  const grants = commands.filter((line) => line.includes('/grant'));
  assert.equal(grants.length, 1);
  assert.match(grants[0], /\/inheritance:r/);
  assert.doesNotMatch(grants[0], /\s\/T\b/);
  assert.ok(commands.some((line) => line.includes('icacls "$INSTDIR\\*" /reset /T')), 'children must inherit the folder ACL');
});

test('installer repairs a broken install before the old uninstaller runs', () => {
  const init = /!macro customInit([\s\S]*?)!macroend/.exec(installer);
  assert.ok(init, 'customInit runs in .onInit, before uninstallOldVersion');
  assert.match(init[1], /icacls "\$INSTDIR" \/reset \/T/);
  assert.match(init[1], /FileExists/, 'only an existing app folder is reset');
});

'use strict';

// Run with the shipped Electron runtime, not CI's separately installed Node.
// With --packaged, load the production import from every built app.asar too.
// Exercise the real dependency's validation/callback path, stopping before any
// password prompt, shell, temporary applet, or system configuration change.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const child = require('node:child_process');
const { app } = require('electron');

function check(root) {
  const mainPath = path.join(root, 'src/main/main.js');
  const source = fs.readFileSync(mainPath, 'utf8');
  const imported = source.match(/^const sudo = require\('([^']+)'\);/m);
  assert.ok(imported, 'production elevation import must be found');
  assert.equal(imported[1], '@vscode/sudo-prompt');
  const productionRequire = createRequire(mainPath);
  const metadata = productionRequire('@vscode/sudo-prompt/package.json');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['@vscode/sudo-prompt'], metadata.version);
  assert.equal(manifest.dependencies['sudo-prompt'], undefined);
  if (root.endsWith('.asar')) {
    assert.ok(productionRequire.resolve(imported[1]).startsWith(root + path.sep), 'must load the packaged dependency');
  }
  const sudo = productionRequire(imported[1]);
  const expected = 'Command should not be prefixed with "sudo".';
  // This invalid command is deliberately rejected BEFORE Attempt() can launch
  // anything, but AFTER the isObject/isFunction path that broke release 2.0.21.
  for (const name of ['UnblockPro', 'UnblockPro update hosts']) {
    let calls = 0;
    sudo.exec('sudo compatibility-check-only', { name }, (error) => {
      assert.equal(error?.message, expected);
      calls++;
    });
    assert.equal(calls, 1, 'three-argument API must return its validation callback');
  }
  let calls = 0;
  sudo.exec('sudo compatibility-check-only', (error) => {
    assert.equal(error?.message, expected);
    calls++;
  });
  assert.equal(calls, 1, 'two-argument callback API must work');
  assert.throws(() => sudo.exec('sudo compatibility-check-only', null, () => {}), /Expected options to be an object/);
  console.log(JSON.stringify({ root, electron: process.versions.electron, node: process.versions.node, dependency: metadata.version, ok: true }));
}

const saved = {};
try {
  assert.ok(process.versions.electron, 'must execute in Electron');
  // Fail closed if a future dependency starts processes before validation.
  for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
    saved[name] = child[name];
    child[name] = () => assert.fail('Elevation smoke must not launch a process: ' + name);
  }
  const repoRoot = path.join(__dirname, '..');
  if (process.argv.includes('--packaged')) {
    const archives = process.platform === 'darwin'
      ? ['mac', 'mac-arm64'].map(dir => path.join(repoRoot, 'dist', dir, 'UnblockPro.app', 'Contents', 'Resources', 'app.asar'))
      : [path.join(repoRoot, 'dist', 'win-unpacked', 'resources', 'app.asar')];
    for (const archive of archives) check(archive);
  } else {
    check(repoRoot);
  }
  app.exit(0);
} catch (error) {
  console.error(error.stack);
  app.exit(1);
} finally {
  Object.assign(child, saved);
}

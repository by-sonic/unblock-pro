#!/usr/bin/env node
'use strict';

// Parse every imported strategy using the exact packaged engine and payloads.
// Upstream nfq/nfqws.c exits on bDry before win_main / windivert_init, so this
// validates arguments and data files without opening the packet driver.
// https://github.com/bol-van/zapret/blob/d437963452674faadfd45adcd62466272b5a2fcd/nfq/nfqws.c
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { buildFlowsealStrategies } = require('../src/main/flowseal-strategies');
const { FLOWSEAL_BUNDLE_VERSION, isFlowsealBundleCurrent } = require('../src/main/flowseal-bundle');

function main() {
  if (process.platform !== 'win32') throw new Error('Windows strategy validation requires Windows.');
  const repoRoot = path.join(__dirname, '..');
  const binDir = path.join(repoRoot, 'bin', 'win32');
  if (!isFlowsealBundleCurrent(binDir)) throw new Error('Missing or incomplete audited Windows bundle.');

  // Uses the same list snapshots as the application, including the inert
  // documentation-address ipset used when the optional game filter is off.
  execFileSync(process.execPath, [path.join(__dirname, 'generate-lists.js')], { stdio: 'inherit' });
  const strategies = buildFlowsealStrategies(binDir, path.join(repoRoot, 'lists'));
  if (!strategies.length) throw new Error('No imported Windows strategies to validate.');
  const failures = [];
  for (const strategy of strategies) {
    const result = spawnSync(path.join(binDir, 'winws.exe'), ['--dry-run', ...strategy.args], {
      cwd: binDir,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.error || result.signal || result.status !== 0 || !output.includes('command line parameters verified')) {
      failures.push(strategy.name);
      console.error(`${strategy.name}: ${result.error?.message || result.signal || `exit ${result.status}`}`);
      console.error(output.slice(-4000));
    } else {
      console.log(`${strategy.name}: parameters and data files verified`);
    }
  }
  if (failures.length) throw new Error(`${failures.length}/${strategies.length} strategies failed: ${failures.join(', ')}`);
  console.log(`Flowseal ${FLOWSEAL_BUNDLE_VERSION}: ${strategies.length}/${strategies.length} strategy dry-runs passed (no packet driver opened).`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

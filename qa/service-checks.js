'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const {runServiceProbes} = require('../src/main/service-probe-run');
const methods = require('../src/main/connectivity-probes');
const {normalizeTargetUrl} = require('../src/main/custom-target');
const source = fs.readFileSync('src/main/main.js', 'utf8');
const readAndTest = source.slice(source.indexOf('function readBodySample('), source.indexOf('async function testProxyConnection('));
const run = vm.runInNewContext('let probeCounter = 0;\n' + readAndTest + '\ntestSingleConnection', {
  ...methods, Buffer, fs, process, app:{getPath:() => process.env.RUNNER_TEMP},
  path:require('node:path'), execFile:require('node:child_process').execFile
});
async function main() {
  const screen = (url) => run(38486, methods.PROBE_TIMEOUTS.screenTimeoutSec, url);
  const full = (url) => run(38486, methods.PROBE_TIMEOUTS.fullTimeoutSec, url);
  for (const targetUrl of [normalizeTargetUrl('youtube.com'), normalizeTargetUrl('www.youtube.com/?issue=76'), '']) {
    console.log(JSON.stringify({targetUrl: targetUrl || '(default)', ...(await runServiceProbes({screen, full, targetUrl}))}));
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });

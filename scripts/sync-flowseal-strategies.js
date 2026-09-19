#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { FLOWSEAL_BUNDLE_VERSION, FLOWSEAL_SOURCE_COMMIT } = require('../src/main/flowseal-bundle');

const repoRoot = path.join(__dirname, '..');
const ref = process.argv[2] || FLOWSEAL_SOURCE_COMMIT;
const outputPath = path.join(repoRoot, 'src', 'main', 'flowseal-strategies.snapshot.json');
const listsOutputPath = path.join(repoRoot, 'src', 'main', 'flowseal-lists.snapshot.json');

function git(...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function strategyName(file) {
  if (file === 'general.bat') return 'general';
  const match = file.match(/^general \((.+)\)\.bat$/);
  if (!match) throw new Error(`Unsupported strategy filename: ${file}`);
  return match[1];
}

function extractArguments(content, file) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => /start\s+.+winws\.exe"/i.test(line));
  if (start < 0) throw new Error(`winws command not found in ${file}`);

  const commandLines = [];
  for (let index = start; index < lines.length; index++) {
    let line = lines[index].trim();
    if (index === start) {
      line = line.replace(/^.*?winws\.exe"\s*/i, '');
    }
    const continues = line.endsWith('^');
    commandLines.push(line.replace(/\s*\^$/, ''));
    if (!continues) break;
  }

  return commandLines
    .join(' ')
    .replace(/"/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((arg) => arg
      // cmd.exe consumes this escape; direct spawn must receive the literal !.
      .replace(/\^!/g, '!')
      .replace(/%GameFilterTCP%/gi, '12')
      .replace(/%GameFilterUDP%/gi, '12')
      .replace(/%GameFilter%/gi, '12')
      .replace(/%BIN%/gi, '{BIN}/')
      .replace(/%LISTS%/gi, '{LISTS}/')
      .replace(/\\/g, '/'))
    // UnblockPro merges custom domains into the primary lists at runtime.
    .filter((arg) => !/-user\.txt$/i.test(arg));
}

const commit = git('rev-parse', `${ref}^{commit}`);
const version = git('show', `${ref}:.service/version.txt`);
if (commit !== FLOWSEAL_SOURCE_COMMIT || version !== FLOWSEAL_BUNDLE_VERSION) {
  throw new Error('Update the audited bundle version, commit and checksum together before syncing upstream data.');
}

const files = git('ls-tree', '-r', '--name-only', ref)
  .split(/\r?\n/)
  .filter((file) => /^general(?: \(.+\))?\.bat$/.test(file));

const strategies = files.map((file) => ({
  name: strategyName(file),
  file,
  args: extractArguments(git('show', `${ref}:${file}`), file)
}));

const snapshot = {
  source: 'Flowseal/zapret-discord-youtube',
  version,
  commit,
  strategies
};

fs.writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
const lists = Object.fromEntries(['list-general.txt', 'list-google.txt', 'list-exclude.txt'].map((file) => [
  file, git('show', `${ref}:lists/${file}`).split(/\r?\n/).filter(Boolean)
]));
fs.writeFileSync(listsOutputPath, `${JSON.stringify({ source: snapshot.source, version, commit, lists }, null, 2)}\n`, 'utf8');
console.log(`Wrote ${strategies.length} strategies from ${ref} to ${outputPath}`);

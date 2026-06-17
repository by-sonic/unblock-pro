#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const ref = process.argv[2] || 'flowseal/main';
const outputPath = path.join(repoRoot, 'src', 'main', 'flowseal-strategies.snapshot.json');

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
      .replace(/%GameFilterTCP%/gi, '12')
      .replace(/%GameFilterUDP%/gi, '12')
      .replace(/%GameFilter%/gi, '12')
      .replace(/%BIN%/gi, '{BIN}/')
      .replace(/%LISTS%/gi, '{LISTS}/')
      .replace(/\\/g, '/'))
    // UnblockPro merges custom domains into the primary lists at runtime.
    .filter((arg) => !/-user\.txt$/i.test(arg));
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
  version: git('show', `${ref}:.service/version.txt`),
  commit: git('rev-parse', ref),
  strategies
};

fs.writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
console.log(`Wrote ${strategies.length} strategies from ${ref} to ${outputPath}`);

'use strict';

const path = require('path');
const snapshot = require('./flowseal-strategies.snapshot.json');

const FLOWSEAL_AUTO_ORDER = [
  'ALT9',
  'ALT11',
  'ALT3',
  'ALT10',
  'ALT12',
  'ALT',
  'SIMPLE FAKE',
  'SIMPLE FAKE ALT2',
  'FAKE TLS AUTO ALT3',
  'FAKE TLS AUTO',
  'general',
  'ALT6',
  'ALT5',
  'SIMPLE FAKE ALT',
  'FAKE TLS AUTO ALT',
  'ALT7',
  'ALT4',
  'FAKE TLS AUTO ALT2',
  'ALT2',
  'ALT8'
];

function resolveArgument(arg, binDir, listsDir) {
  return arg
    .replace('{BIN}/', `${binDir}${path.sep}`)
    .replace('{LISTS}/', `${listsDir}${path.sep}`);
}

function buildFlowsealStrategies(binDir, listsDir) {
  const byName = new Map(snapshot.strategies.map((strategy) => [strategy.name, strategy]));
  const orderedNames = [
    ...FLOWSEAL_AUTO_ORDER,
    ...snapshot.strategies.map((strategy) => strategy.name)
  ];

  const seen = new Set();
  return orderedNames.flatMap((name) => {
    if (seen.has(name) || !byName.has(name)) return [];
    seen.add(name);
    const strategy = byName.get(name);
    return [{
      name,
      source: `Flowseal ${snapshot.version}`,
      sourceFile: strategy.file,
      args: strategy.args.map((arg) => resolveArgument(arg, binDir, listsDir))
    }];
  });
}

module.exports = {
  FLOWSEAL_AUTO_ORDER,
  buildFlowsealStrategies,
  snapshot
};

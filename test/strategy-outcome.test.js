'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildOutcome,
  describeOutcome,
  describeTally,
  isAcceptable,
  pickBetterOutcome,
  tallyFailures
} = require('../src/main/strategy-outcome');

test('both services working is a full outcome', () => {
  const outcome = buildOutcome({ youtube: true, discord: true });
  assert.equal(outcome.level, 'full');
  assert.deepEqual(outcome.passed, ['youtube', 'discord']);
});

test('one service working is a partial outcome', () => {
  assert.equal(buildOutcome({ youtube: true, discord: false }).level, 'partial');
  assert.equal(buildOutcome({ youtube: false, discord: true }).level, 'partial');
});

test('nothing working is not an outcome worth keeping', () => {
  assert.equal(buildOutcome({ youtube: false, discord: false }).level, 'none');
});

test('only a full outcome is acceptable while a full one may still turn up', () => {
  assert.equal(isAcceptable(buildOutcome({ youtube: true, discord: true }), false), true);
  assert.equal(isAcceptable(buildOutcome({ youtube: true, discord: false }), false), false);
});

test('a partial outcome is acceptable on the retry pass', () => {
  assert.equal(isAcceptable(buildOutcome({ youtube: true, discord: false }), true), true);
  assert.equal(isAcceptable(buildOutcome({ youtube: false, discord: false }), true), false);
});

test('more services beat fewer', () => {
  const yt = buildOutcome({ youtube: true, discord: false });
  const both = buildOutcome({ youtube: true, discord: true });
  assert.equal(pickBetterOutcome(yt, both), both);
  assert.equal(pickBetterOutcome(both, yt), both);
});

test('the first candidate keeps its place on a tie', () => {
  const first = buildOutcome({ youtube: true, discord: false });
  const second = buildOutcome({ youtube: true, discord: false });
  assert.equal(pickBetterOutcome(first, second), first);
});

test('anything beats nothing', () => {
  const nothing = buildOutcome({ youtube: false, discord: false });
  const yt = buildOutcome({ youtube: true, discord: false });
  assert.equal(pickBetterOutcome(null, yt), yt);
  assert.equal(pickBetterOutcome(nothing, yt), yt);
  assert.equal(pickBetterOutcome(yt, nothing), yt);
});

test('describes a partial outcome by naming both halves', () => {
  const text = describeOutcome(buildOutcome({ youtube: true, discord: false }));
  assert.match(text, /YouTube/);
  assert.match(text, /Discord/);
  assert.match(text, /работает/i);
});

test('describes a full outcome without a caveat', () => {
  const text = describeOutcome(buildOutcome({ youtube: true, discord: true }));
  assert.match(text, /YouTube и Discord/);
  assert.doesNotMatch(text, /не удалось/);
});

test('counts how often each probe was the one that failed', () => {
  const tally = {};
  tallyFailures(tally, ['Discord API']);
  tallyFailures(tally, ['Discord API', 'YouTube Web']);
  assert.deepEqual(tally, { 'Discord API': 2, 'YouTube Web': 1 });
});

test('the summary names the probe that failed most, with counts', () => {
  const tally = { 'Discord API': 52, 'YouTube Web': 3 };
  const text = describeTally(tally, 52);
  assert.match(text, /Discord API — 52 из 52/);
  assert.match(text, /YouTube Web — 3 из 52/);
  assert.ok(text.indexOf('Discord API') < text.indexOf('YouTube Web'), 'самая частая причина идёт первой');
});

test('an empty tally produces no summary rather than an empty list', () => {
  assert.equal(describeTally({}, 52), '');
});

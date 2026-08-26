'use strict';

// What a strategy actually achieved, and which of them to keep.
//
// Acceptance used to be all-or-nothing: a strategy passed only if YouTube *and*
// Discord both worked, and the sweep had no fallback. On an ISP where Discord
// cannot be unblocked at all — on macOS the engine is TCP-only, so Discord voice
// depends on a workaround that does not hold everywhere — that rejects all 52
// strategies including the ones that fully fix YouTube, and the user is left
// with nothing and the message "ни одна стратегия не сработала" (#56, #58).
//
// So a strategy now reports per service. A full result still wins and is still
// what the sweep looks for first; a partial result is remembered and used only
// after the whole list has been tried, and the user is told plainly what is and
// is not working rather than being handed a silent half-fix.

const SERVICES = Object.freeze(['youtube', 'discord']);

const SERVICE_LABELS = Object.freeze({
  youtube: 'YouTube',
  discord: 'Discord'
});

function buildOutcome(passedByService = {}) {
  const services = {};
  for (const service of SERVICES) services[service] = passedByService[service] === true;

  const passed = SERVICES.filter((service) => services[service]);
  const level = passed.length === SERVICES.length
    ? 'full'
    : (passed.length > 0 ? 'partial' : 'none');

  return { services, passed, level };
}

// While the sweep still has strategies to try, only a full result is worth
// stopping for. `acceptPartial` is set for the retry pass, once the list is
// exhausted and the best partial candidate is the only thing left.
function isAcceptable(outcome, acceptPartial = false) {
  if (!outcome) return false;
  if (outcome.level === 'full') return true;
  return acceptPartial && outcome.level === 'partial';
}

// More services wins. On a tie the incumbent keeps its place, so the earliest
// candidate — which is the higher-ranked strategy — is the one retried.
function pickBetterOutcome(current, candidate) {
  const score = (o) => (o && o.level !== 'none' ? o.passed.length : -1);
  return score(candidate) > score(current) ? candidate : current;
}

function listServices(names) {
  return names.map((name) => SERVICE_LABELS[name] || name).join(' и ');
}

function describeOutcome(outcome) {
  if (!outcome || outcome.level === 'none') return 'ничего не работает';
  if (outcome.level === 'full') return `${listServices(outcome.passed)} работают`;

  const failed = SERVICES.filter((service) => !outcome.services[service]);
  return `${listServices(outcome.passed)} работает, ${listServices(failed)} — не удалось`;
}

function tallyFailures(tally, failedLabels = []) {
  for (const label of failedLabels) {
    tally[label] = (tally[label] || 0) + 1;
  }
  return tally;
}

// Turns the sweep's failures into one line the user can paste into an issue:
// "Discord API — 52 из 52" says "your ISP blocks Discord", which is a different
// problem from "YouTube Web — 3 из 52".
function describeTally(tally, totalStrategies) {
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '';
  return entries.map(([label, count]) => `${label} — ${count} из ${totalStrategies}`).join('; ');
}

module.exports = {
  SERVICES,
  SERVICE_LABELS,
  buildOutcome,
  describeOutcome,
  describeTally,
  isAcceptable,
  pickBetterOutcome,
  tallyFailures
};

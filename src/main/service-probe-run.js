'use strict';

// Runs the verification probes service by service and reports what worked.
//
// The old verdict was a single boolean for "every probe passed", which is what
// made an ISP that blocks Discord outright reject every strategy — including the
// ones that fully fix YouTube (#59). Here each service is scored on its own, so
// the sweep can keep a half-working strategy as a fallback.
//
// Order is still chosen for speed, not for the verdict:
//   1. the cheap screening probes run for both services (bytes, not pages);
//   2. a service that already failed is dropped — the expensive probes are spent
//      only on services still in play;
//   3. if both services died in screening, nothing else is worth running.
//
// The probe functions and the logger are injected so this can be exercised
// without a network, an engine process or Electron.

const { endpointsByService, probeLabel } = require('./connectivity-probes');
const { SERVICES, buildOutcome } = require('./strategy-outcome');

async function runServiceProbes({ screen, full, discordExtra = null, log = () => {} }) {
  const failed = [];
  const alive = {};

  const screening = endpointsByService('screen');
  for (const service of SERVICES) {
    const urls = screening[service] || [];
    const results = await Promise.all(urls.map((url) => screen(url)));
    const bad = urls.filter((_, i) => !results[i]);
    for (const url of bad) failed.push(probeLabel(url));
    alive[service] = bad.length === 0;
  }

  if (SERVICES.every((service) => !alive[service])) {
    log({ type: 'warning', message: `Быстрая проверка: не прошли — ${failed.join(', ')}` });
    return { outcome: buildOutcome(alive), failed };
  }

  const remaining = endpointsByService('full');
  for (const service of SERVICES) {
    if (!alive[service]) continue;
    const urls = remaining[service] || [];
    const results = await Promise.all(urls.map((url) => full(url)));
    const bad = urls.filter((_, i) => !results[i]);
    for (const url of bad) failed.push(probeLabel(url));
    if (bad.length > 0) alive[service] = false;
  }

  // Without the gateway WebSocket the Discord app never leaves "Проблемы с
  // подключением", so it decides the Discord verdict even when HTTP passed.
  if (alive.discord && discordExtra) {
    if (!await discordExtra()) {
      failed.push('Discord gateway (WebSocket)');
      alive.discord = false;
    }
  }

  if (failed.length > 0) {
    log({ type: 'warning', message: `Не прошли проверку: ${failed.join(', ')}` });
  }

  return { outcome: buildOutcome(alive), failed };
}

module.exports = { runServiceProbes };

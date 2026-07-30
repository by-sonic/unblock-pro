'use strict';

// Pure helpers for the system files the app touches: pf output parsing and
// /etc/hosts block editing. Kept side-effect free so the tricky parts are
// testable without root.

// `pfctl -E` prints e.g. "pf enabled\nToken : 12345678901234567890".
// The token must be handed back with `pfctl -X <token>`, otherwise pf stays
// enabled for every other process on the machine.
function parsePfEnableToken(output) {
  const match = /Token\s*:\s*(\d+)/i.exec(String(output || ''));
  return match ? match[1] : null;
}

// Marker lines carry a version so a block written by an older release can be
// replaced instead of being trusted forever. Discord voice IPs rotate; a
// write-once block silently pins users to a dead address.
function buildBlockMarker(baseMarker, version) {
  return version ? `${baseMarker} v${version}` : baseMarker;
}

function markerPattern(baseMarker) {
  const escaped = baseMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[ \\t]*${escaped}.*$`, 'm');
}

function hasMarkedBlock(content, baseMarker) {
  return markerPattern(baseMarker).test(String(content || ''));
}

// True when a block exists and its marker matches this exact version.
function hasCurrentBlock(content, baseMarker, version) {
  const marker = buildBlockMarker(baseMarker, version);
  const lines = String(content || '').split(/\r?\n/);
  return lines.some((line) => line.trim() === marker);
}

// Drops everything from the marker line to the next blank-line-separated
// section (or end of file), leaving the rest of the file byte-identical.
function removeMarkedBlock(content, baseMarker) {
  const text = String(content || '');
  const lines = text.split('\n');
  const pattern = markerPattern(baseMarker);

  const start = lines.findIndex((line) => pattern.test(line));
  if (start === -1) return text;

  // The block runs to the end of the contiguous non-empty region after the
  // marker, so unrelated trailing entries are preserved.
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== '') end++;

  const before = lines.slice(0, start);
  const after = lines.slice(end);

  // Collapse the blank separator we originally inserted before the marker.
  while (before.length > 0 && before[before.length - 1].trim() === '') before.pop();
  while (after.length > 0 && after[0].trim() === '') after.shift();

  const joined = before.concat(after).join('\n');
  return joined.length > 0 ? joined.replace(/\n*$/, '\n') : '';
}

// Removes any previous block, then appends the new one under a versioned marker.
function replaceMarkedBlock(content, baseMarker, version, blockBody) {
  const cleaned = removeMarkedBlock(content, baseMarker);
  const marker = buildBlockMarker(baseMarker, version);
  const base = cleaned.length > 0 ? cleaned.replace(/\n*$/, '\n') : '';
  return `${base}\n${marker}\n${String(blockBody).replace(/\n*$/, '')}\n`;
}

// Guard for the one destructive operation in the app: replacing /etc/hosts
// wholesale. Rewriting it is only allowed when every line the user or system
// owns survives, so a bug in block handling can never cost someone their name
// resolution.
function isSafeHostsRewrite(original, next, baseMarker) {
  const originalText = String(original || '');
  const nextText = String(next || '');

  if (nextText.trim().length === 0) return false;

  const nextLines = new Set(nextText.split(/\r?\n/).map((l) => l.trim()));

  // Lines present in the original but not in our own block must be preserved.
  const strippedOriginal = removeMarkedBlock(originalText, baseMarker);
  for (const raw of strippedOriginal.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (!nextLines.has(line)) return false;
  }

  // A hosts file without a loopback mapping is broken on every platform.
  if (/127\.0\.0\.1/.test(originalText) && !/127\.0\.0\.1/.test(nextText)) return false;

  return true;
}

module.exports = {
  buildBlockMarker,
  hasCurrentBlock,
  hasMarkedBlock,
  isSafeHostsRewrite,
  parsePfEnableToken,
  removeMarkedBlock,
  replaceMarkedBlock
};

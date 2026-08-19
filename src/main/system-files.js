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

// The block is delimited explicitly at both ends. Deriving the end from layout
// ("stop at the first blank line") does not survive real payloads: the hosts
// data this app writes separates its Telegram and Discord sections with a blank
// line, so a layout-based end cut the block in half — leaving thousands of stale
// Discord lines behind as if a user had written them, above the fresh block
// where first-match-wins resolution keeps preferring them.
function buildBlockEndMarker(baseMarker) {
  return `${baseMarker} end`;
}

function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markerPattern(baseMarker) {
  return new RegExp(`^[ \\t]*${escapeForRegExp(baseMarker)}.*$`, 'm');
}

// Any line we authored: the versioned opening marker or the closing sentinel.
function isMarkerLine(line, baseMarker) {
  return String(line).trim().startsWith(baseMarker);
}

function isBlockEndLine(line, baseMarker) {
  return String(line).trim() === buildBlockEndMarker(baseMarker);
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

// Hostnames a hosts line maps, i.e. every field after the address.
function hostnamesOf(line) {
  const withoutComment = String(line).split('#')[0].trim();
  if (withoutComment.length === 0) return [];
  const fields = withoutComment.split(/\s+/);
  return fields.slice(1);
}

// A hosts line is ours only when every hostname on it is one we manage. Anything
// else — including a line that merely shares an address with our block — belongs
// to the user and must survive untouched.
function isOwnedHostsLine(line, ownHostnames) {
  const hosts = hostnamesOf(line);
  if (hosts.length === 0) return false;
  return hosts.every((host) => ownHostnames.has(host));
}

// Collects the hostnames a block body maps, so the legacy migration below and
// the safety guard can tell our own lines apart from a user's.
function collectBlockHostnames(blockBody) {
  const hostnames = new Set();
  for (const line of String(blockBody || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    for (const host of hostnamesOf(trimmed)) hostnames.add(host);
  }
  return hostnames;
}

// Drops our block, leaving every other line byte-identical.
//
// Blocks written by this version end at the closing sentinel. Blocks written by
// older releases have no sentinel; those were always appended at the end of the
// file, so the block runs to EOF — except that a user may have appended their
// own entries below it afterwards. `ownHostnames` is what makes that case safe:
// the legacy scan stops at the first line whose hostnames we do not manage, so
// user entries are never swallowed.
function removeMarkedBlock(content, baseMarker, options = {}) {
  const { ownHostnames = null } = options;
  const text = String(content || '');
  const lines = text.split('\n');
  const pattern = markerPattern(baseMarker);

  const start = lines.findIndex(
    (line) => pattern.test(line) && !isBlockEndLine(line, baseMarker)
  );
  if (start === -1) return text;

  // Exclusive end index.
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (isBlockEndLine(lines[i], baseMarker)) {
      end = i + 1;
      break;
    }
  }

  if (end === -1) {
    end = lines.length;
    if (ownHostnames) {
      for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length === 0 || line.startsWith('#')) continue;
        if (!isOwnedHostsLine(line, ownHostnames)) {
          end = i;
          break;
        }
      }
    }
  }

  const before = lines.slice(0, start);
  const after = lines.slice(end);

  // Collapse the blank separator we originally inserted before the marker.
  while (before.length > 0 && before[before.length - 1].trim() === '') before.pop();
  while (after.length > 0 && after[0].trim() === '') after.shift();

  const joined = before.concat(after).join('\n');
  return joined.length > 0 ? joined.replace(/\n*$/, '\n') : '';
}

// Removes any previous block, then appends the new one between a versioned
// opening marker and the closing sentinel.
function replaceMarkedBlock(content, baseMarker, version, blockBody) {
  const cleaned = removeMarkedBlock(content, baseMarker, {
    ownHostnames: collectBlockHostnames(blockBody)
  });
  const marker = buildBlockMarker(baseMarker, version);
  const base = cleaned.length > 0 ? cleaned.replace(/\n*$/, '\n') : '';
  const body = String(blockBody).replace(/\n*$/, '');
  return `${base}\n${marker}\n${body}\n${buildBlockEndMarker(baseMarker)}\n`;
}

// Guard for the one destructive operation in the app: replacing the hosts file
// wholesale. A line may only disappear when we are provably the ones who wrote
// it — our own marker lines, or a mapping for a hostname we manage.
//
// This deliberately does not reuse removeMarkedBlock: a guard that asks the same
// parser it is guarding "which lines were yours?" agrees with every mistake that
// parser makes. It answered "safe" while silently dropping a user's entry.
function isSafeHostsRewrite(original, next, baseMarker, options = {}) {
  const { ownHostnames = null } = options;
  const originalText = String(original || '');
  const nextText = String(next || '');

  if (nextText.trim().length === 0) return false;

  const nextLines = new Set(nextText.split(/\r?\n/).map((l) => l.trim()));
  const owned = ownHostnames ? new Set(ownHostnames) : null;

  for (const raw of originalText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (nextLines.has(line)) continue;
    if (isMarkerLine(line, baseMarker)) continue;
    if (owned && isOwnedHostsLine(line, owned)) continue;
    return false;
  }

  // A hosts file without a loopback mapping is broken on every platform.
  if (/127\.0\.0\.1/.test(originalText) && !/127\.0\.0\.1/.test(nextText)) return false;

  return true;
}

module.exports = {
  buildBlockEndMarker,
  buildBlockMarker,
  collectBlockHostnames,
  hasCurrentBlock,
  hasMarkedBlock,
  hostnamesOf,
  isOwnedHostsLine,
  isSafeHostsRewrite,
  parsePfEnableToken,
  removeMarkedBlock,
  replaceMarkedBlock
};

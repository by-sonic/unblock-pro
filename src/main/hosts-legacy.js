'use strict';

// What releases up to 2.0.20 wrote into the hosts file.
//
// This is never written anywhere. It exists so an *old* block can still be
// recognised and removed.
//
// Blocks written before the closing sentinel existed have no end marker, so the
// only way to tell where such a block stops is to walk it line by line and stop
// at the first hostname that was not ours. That comparison needs the list those
// versions actually produced — and it is not the list shipped today: upstream
// deleted the ~2800 `*.discord.media` entries, so matching an old block against
// the current data would end the block at its very first line and leave the rest
// behind, unmarked, forever. Which is the exact failure this cleanup exists to
// undo (#60).
//
// Keep in step with what shipped, not with what we write now: when a version
// whose block predates the end marker is no longer in the wild, this can go.

// 2800 lines of `104.25.158.178 <region><port>.discord.media`, generated the
// same way the old release generated them.
const LEGACY_VOICE_IP = '104.25.158.178';

const LEGACY_VOICE_REGIONS = [
  'finland', 'russia',
  'us-east', 'us-west', 'us-south', 'us-central',
  'eu-central', 'eu-west',
  'brazil', 'hongkong', 'india', 'japan', 'singapore',
  'southafrica', 'south-korea', 'sydney',
  'bucharest', 'tel-aviv', 'newark', 'milan',
  'rotterdam', 'madrid', 'stockholm', 'buenos-aires',
  'atlanta', 'seattle', 'santa-clara', 'oregon'
];

const LEGACY_TELEGRAM_IP = '149.154.167.220';

const LEGACY_TELEGRAM_DOMAINS = [
  'telegram.me', 'telegram.dog', 'telegram.space', 'telesco.pe', 'tg.dev',
  'kws2.web.telegram.org', 'kws2-1.web.telegram.org', 'kws1-1.web.telegram.org',
  'kws1.web.telegram.org', 'telegram.org', 't.me', 'api.telegram.org',
  'pluto.web.telegram.org', 'pluto-1.web.telegram.org', 'flora.web.telegram.org',
  'td.telegram.org', 'venus.web.telegram.org', 'web.telegram.org',
  'kws4-1.web.telegram.org', 'kws4.web.telegram.org', 'kws5-1.web.telegram.org',
  'kws5.web.telegram.org', 'zws1-1.web.telegram.org', 'zws1.web.telegram.org',
  'zws2-1.web.telegram.org', 'zws2.web.telegram.org', 'zws4-1.web.telegram.org',
  'zws5-1.web.telegram.org', 'zws5.web.telegram.org'
];

// Reproduces the payload byte-for-byte in shape: the blank line between the
// Telegram and Discord sections is part of what made these blocks hard to
// delimit, so it stays.
function legacyBlockData() {
  const lines = [];

  for (const domain of LEGACY_TELEGRAM_DOMAINS) lines.push(`${LEGACY_TELEGRAM_IP} ${domain}`);
  lines.push('');

  for (const region of LEGACY_VOICE_REGIONS) {
    for (let port = 10000; port <= 10099; port++) {
      lines.push(`${LEGACY_VOICE_IP} ${region}${port}.discord.media`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  LEGACY_TELEGRAM_DOMAINS,
  LEGACY_VOICE_IP,
  LEGACY_VOICE_REGIONS,
  legacyBlockData
};

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  REQUIRED_DISCORD_ENDPOINTS,
  REQUIRED_YOUTUBE_ENDPOINTS
} = require('../src/main/connectivity-probes');

test('auto-selection probes the services users actually need', () => {
  assert.deepEqual(REQUIRED_YOUTUBE_ENDPOINTS, [
    'https://www.youtube.com/',
    'https://redirector.googlevideo.com/'
  ]);
  assert.deepEqual(REQUIRED_DISCORD_ENDPOINTS, [
    'https://discord.com/api/v10/gateway',
    'https://cdn.discordapp.com/embed/avatars/0.png'
  ]);
});

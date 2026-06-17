'use strict';

const REQUIRED_YOUTUBE_ENDPOINTS = Object.freeze([
  'https://www.youtube.com/',
  'https://redirector.googlevideo.com/'
]);

const REQUIRED_DISCORD_ENDPOINTS = Object.freeze([
  'https://discord.com/api/v10/gateway',
  'https://cdn.discordapp.com/embed/avatars/0.png'
]);

module.exports = {
  REQUIRED_DISCORD_ENDPOINTS,
  REQUIRED_YOUTUBE_ENDPOINTS
};

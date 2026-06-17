#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const listsDir = path.join(__dirname, '..', 'lists');
fs.mkdirSync(listsDir, { recursive: true });

// Keep these lists in sync with Flowseal/zapret-discord-youtube 1.9.9c.
const HOST_LIST_GENERAL = [
  'cloudflare-ech.com', 'encryptedsni.com', 'cloudflareaccess.com', 'cloudflareapps.com',
  'cloudflarebolt.com', 'cloudflareclient.com', 'cloudflareinsights.com', 'cloudflareok.com',
  'cloudflarepartners.com', 'cloudflareportal.com', 'cloudflarepreview.com', 'cloudflareresolve.com',
  'cloudflaressl.com', 'cloudflarestatus.com', 'cloudflarestorage.com', 'cloudflarestream.com',
  'cloudflaretest.com', 'cloudfront.net', 'dis.gd', 'discord-attachments-uploads-prd.storage.googleapis.com',
  'discord.app', 'discord.co', 'discord.com', 'discord.design', 'discord.dev', 'discord.gift',
  'discord.gifts', 'discord.gg', 'discord.media', 'discord.new', 'discord.store', 'discord.status',
  'discord-activities.com', 'discordactivities.com', 'discordapp.com', 'discordapp.net',
  'discordcdn.com', 'discordmerch.com', 'discordpartygames.com', 'discordsays.com',
  'discordsez.com', 'discordstatus.com',
  'frankerfacez.com', 'ffzap.com', 'betterttv.net',
  '7tv.app', '7tv.io', 'localizeapi.com', 'klipy.com'
].join('\n');

const HOST_LIST_GOOGLE = [
  'yt3.ggpht.com', 'yt4.ggpht.com', 'yt3.googleusercontent.com',
  'googlevideo.com', 'jnn-pa.googleapis.com', 'stable.dl2.discordapp.net',
  'wide-youtube.l.google.com', 'youtube-nocookie.com', 'youtube-ui.l.google.com',
  'youtube.com', 'youtubeembeddedplayer.googleapis.com', 'youtubekids.com', 'youtube.googleapis.com',
  'youtubei.googleapis.com', 'youtu.be', 'yt-video-upload.l.google.com',
  'ytimg.com', 'ytimg.l.google.com', 'play.google.com', 'google.ru'
].join('\n');

const HOST_LIST_DISCORD = [
  'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media',
  'discord.co', 'discord.gift', 'discord.gifts', 'discord.new', 'discord.store', 'discord.status',
  'discord.app', 'discord.design', 'discord.dev', 'discord-activities.com', 'discordactivities.com',
  'discordcdn.com', 'discordmerch.com', 'discordpartygames.com', 'discordsays.com', 'discordsez.com',
  'discordstatus.com', 'dis.gd', 'gateway.discord.gg', 'cdn.discordapp.com', 'dl.discordapp.net',
  'updates.discord.com', 'discord-attachments-uploads-prd.storage.googleapis.com',
  'media.discordapp.net', 'images-ext-1.discordapp.net', 'images-ext-2.discordapp.net',
  'router.discordapp.net'
].join('\n');

const HOST_LIST_EXCLUDE = [
  'pusher.com', 'live-video.net', 'ttvnw.net', 'twitch.tv',
  'mail.ru', 'citilink.ru', 'yandex.com', 'yandex.net', 'yandex.org', 'yandex.md',
  'yandex.ru', 'yandexadexchange.net', 'yandexcloud.net', 'yandexcom.net',
  'yandexmetrica.com', 'yandexwebcache.net', 'yandexwebcache.org', 'yastat.net',
  'yastatic-net.ru', 'yastatic.net', 'ya.ru', 'adfox.ru', 'admetrica.ru',
  'naydex.net', 'rostaxi.org', 'turbopages.org', 'webvisor.com', 'webvisor.org',
  'nvidia.com', 'donationalerts.com', 'vk.com', 'yandex.kz', 'mts.ru', 'multimc.org',
  'dns-shop.ru', 'habr.com', '3dnews.ru', 'microsoft.com', 'microsoftonline.com',
  'live.com', 'sharepoint.com', 'minecraft.net', 'xboxlive.com',
  'akamaitechnologies.com', 'msi.com', '2ip.ru', 'boosty.to', 'tanki.su',
  'lesta.ru', 'korabli.su', 'tanksblitz.ru', 'reg.ru', 'epicgames.dev',
  'epicgames.com', 'unrealengine.com', 'riotgames.com', 'riotcdn.net',
  'leagueoflegends.com', 'playvalorant.com', 'marketplace.visualstudio.com',
  'gallery.vsassets.io', 'gallerycdn.vsassets.io', 'gosuslugi.ru', 'gov.ru',
  'nalog.ru', 'spb.ru', 'mos.ru', 'vk.ru', 'vk.me', 'vkvideo.ru', 'ok.ru',
  'mycdn.me', 'okcdn.ru', 'odkl.ru', 'wb.ru', 'geobasket.ru', 'paywb.com',
  'rwb.ru', 'wb-basket.ru', 'wbbasket.ru', 'wbpay.ru', 'wibes.ru',
  'wildberries.ru', 'ozon.by', 'ozon.com', 'ozon.com.by', 'ozon.com.kz',
  'ozon.kz', 'ozon.ru', 'ozon.tm', 'ozone.ru', 'ozonru.me',
  'ozonusercontent.com', 'alfabank.ru', 'gazprombank.ru', 'gpb.ru',
  'dbo-dengi.online', 'mtsdengi.ru', 'psbank.ru', 'bankline.ru', 'rosbank.ru',
  'abr.ru', 'rshb.ru', 'sber.ru', 'sberbank.com', 'sberbank.ru',
  'cdn-tinkoff.ru', 'tbank-online.com', 'tbank.ru', 't-bank-app.ru',
  'tochka-tech.com', 'tochka.com', 'vtb.ru', 'steamcommunity.com'
].join('\n');

const IPSET_EXCLUDE = [
  '0.0.0.0/8', '10.0.0.0/8', '127.0.0.0/8', '172.16.0.0/12',
  '192.168.0.0/16', '169.254.0.0/16', '224.0.0.0/4', '100.64.0.0/10',
  '::1', 'fc00::/7', 'fe80::/10'
].join('\n');

const IPSET_ALL = '203.0.113.113/32';

fs.writeFileSync(path.join(listsDir, 'list-general.txt'), HOST_LIST_GENERAL, 'utf8');
fs.writeFileSync(path.join(listsDir, 'list-google.txt'), HOST_LIST_GOOGLE, 'utf8');
fs.writeFileSync(path.join(listsDir, 'list-discord.txt'), HOST_LIST_DISCORD, 'utf8');
fs.writeFileSync(path.join(listsDir, 'list-exclude.txt'), HOST_LIST_EXCLUDE, 'utf8');
fs.writeFileSync(path.join(listsDir, 'ipset-exclude.txt'), IPSET_EXCLUDE, 'utf8');
fs.writeFileSync(path.join(listsDir, 'ipset-all.txt'), IPSET_ALL, 'utf8');

const all = HOST_LIST_GENERAL + '\n' + HOST_LIST_GOOGLE + '\n' + HOST_LIST_DISCORD;
fs.writeFileSync(path.join(listsDir, 'list-all.txt'), all, 'utf8');

console.log('Lists generated in', listsDir);
console.log('Files:', fs.readdirSync(listsDir).join(', '));

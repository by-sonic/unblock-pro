'use strict';

// A target URL is data, never a shell command. Only HTTPS on the port covered
// by the engine's TLS filters is supported. DNS names are needed for hostlists.
function normalizeTargetUrl(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value.trim())) {
    throw new Error('Укажите HTTPS URL без пробелов (до 2048 символов)');
  }
  const input = value.trim();
  if (!input) return '';
  let url;
  try { url = new URL(input); } catch { throw new Error('Некорректный URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    throw new Error('Нужен HTTPS URL на порту 443, без логина, пароля и #фрагмента');
  }
  const host = url.hostname;
  if (host.length > 253 || !host.includes('.') || /^\d+(\.\d+){3}$/.test(host) ||
      !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw new Error('Укажите доменное имя сайта, например https://example.com/');
  }
  return url.href;
}

function buildTargetOutcome(url, passed) {
  return {
    targetUrl: normalizeTargetUrl(url),
    services: { youtube: null, discord: null, target: passed === true },
    passed: passed === true ? ['target'] : [],
    level: passed === true ? 'full' : 'none'
  };
}

function targetHost(url) { return url ? new URL(normalizeTargetUrl(url)).hostname : ''; }

// Explicit custom targets override a matching host exclusion for this generated
// configuration only; the user's saved exclusion list is preserved.
function includeTargetInLists(lists, url) {
  const host = targetHost(url);
  if (!host) return { ...lists };
  const result = { ...lists };
  for (const name of ['list-general.txt', 'list-google.txt', 'list-discord.txt', 'list-all.txt']) {
    result[name] = (result[name] || '') + '\n' + host + '\n';
  }
  result['list-exclude.txt'] = (result['list-exclude.txt'] || '').split(/\r?\n/).filter((line) => {
    const excluded = line.trim().toLowerCase();
    return !excluded || !(host === excluded || host.endsWith('.' + excluded));
  }).join('\n');
  return result;
}

module.exports = { normalizeTargetUrl, buildTargetOutcome, targetHost, includeTargetInLists };

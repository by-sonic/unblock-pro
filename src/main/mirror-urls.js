'use strict';

// GitHub mirror fallback for binary downloads.
//
// Many Russian ISPs reset connections to github.com / *.githubusercontent.com
// (the user-facing error is "Соединение сброшено — провайдер мог заблокировать
// GitHub", ECONNRESET). The bundle itself is integrity-checked (SHA256 on
// Windows), so routing the download through a public GitHub reverse proxy is
// safe: a tampered/HTML response simply fails the checksum and the next
// candidate is tried.
//
// buildMirrorUrls() turns a single GitHub URL into an ordered list:
//   [ originalUrl, proxy1+url, proxy2+url, ... ]
// Non-GitHub URLs are returned unchanged (single element).

const GITHUB_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
]);

// Public GitHub proxies of the form `${mirror}${fullOriginalUrl}`.
// Ordered fastest-known-first; all accept the full https URL appended.
const DEFAULT_MIRRORS = [
  'https://ghfast.top/',
  'https://ghproxy.net/',
  'https://gh-proxy.com/',
  'https://mirror.ghproxy.com/',
];

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return null;
  }
}

/**
 * @param {string} url    original download URL
 * @param {string[]} [mirrors]  proxy prefixes (each must end with '/')
 * @returns {string[]}    [original, ...mirrored], de-duplicated. Non-GitHub
 *                        URLs yield just [original].
 */
function buildMirrorUrls(url, mirrors = DEFAULT_MIRRORS) {
  const candidates = [url];
  const host = hostOf(url);
  if (host && GITHUB_HOSTS.has(host)) {
    for (const mirror of mirrors) {
      const prefix = mirror.endsWith('/') ? mirror : `${mirror}/`;
      candidates.push(`${prefix}${url}`);
    }
  }
  // De-duplicate while preserving order.
  return [...new Set(candidates)];
}

module.exports = { buildMirrorUrls, GITHUB_HOSTS, DEFAULT_MIRRORS };

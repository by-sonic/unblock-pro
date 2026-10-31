'use strict';

// Port of the local tpws SOCKS proxy on macOS. tg-ws-proxy and other tools often
// sit on 1080 too, and a busy port stops the connection outright, so the user
// has to be able to move ours.
const DEFAULT_PROXY_PORT = 1080;
// Below 1024 macOS would need root to bind, and tpws runs as the user.
const MIN_PROXY_PORT = 1024;
const MAX_PROXY_PORT = 65535;

function normalizeProxyPort(value) {
  const text = String(value ?? '').trim();
  if (text === '') return DEFAULT_PROXY_PORT;
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < MIN_PROXY_PORT || port > MAX_PROXY_PORT) {
    throw new Error(`Порт должен быть числом от ${MIN_PROXY_PORT} до ${MAX_PROXY_PORT}`);
  }
  return port;
}

// A hand-edited settings file must not stop the connection.
function resolveProxyPort(value) {
  try {
    return normalizeProxyPort(value);
  } catch (e) {
    return DEFAULT_PROXY_PORT;
  }
}

module.exports = { DEFAULT_PROXY_PORT, normalizeProxyPort, resolveProxyPort };

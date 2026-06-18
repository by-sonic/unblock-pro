'use strict';

// Decides whether updates must be installed manually (notify-only) vs automatically.
// macOS is always manual (unsigned app can't self-replace). On other platforms the
// user opts out via the autoUpdate setting; only an explicit `false` means manual.
function resolveUpdateMode({ platform, autoUpdate } = {}) {
  const manualInstall = platform === 'darwin' || autoUpdate === false;
  return { manualInstall };
}

module.exports = { resolveUpdateMode };

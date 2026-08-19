'use strict';

// Rasterises the SVG sources in assets/ into every icon the app and the installers
// need, then packs .ico and .icns containers.
//
// Run with Electron, not node — Electron's Chromium is the renderer, so there is
// no image-processing dependency to install and no binary to trust:
//
//   npx electron scripts/build-icons.js
//
// Regenerate after editing assets/icon.svg, assets/tray-icon.svg or
// assets/tray-badge.svg, and commit the results: the build does not rasterise.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Without this the capture comes back scaled by the machine's display scaling, so
// the same sources would produce different icons on a 125% laptop and a 100%
// desktop. Must be set before the app is ready.
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const APP_ICONS = path.join(ROOT, 'src', 'main', 'icons');

// Windows accepts PNG-compressed .ico entries from Vista onward; 256 is the
// largest an .ico directory can describe (0 means 256).
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// icns entry types keyed by the pixel size of the PNG they carry. The @2x types
// (ic11..ic14) carry the same pixels as their 1x counterparts at double size.
const ICNS_ENTRIES = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic14', 512],
  ['ic09', 512],
  ['ic10', 1024]
];

function svgToDataUrl(file) {
  const svg = fs.readFileSync(file, 'utf8');
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

// Renders one SVG at one size. A fresh window per size guarantees the SVG is
// rasterised at its natural resolution rather than scaled from another render,
// which is what keeps the pixel grid crisp at 16px.
// One hidden window, reused for every render. Deliberately not capturePage(): a
// hidden window has no display surface to capture ("Current display surface not
// available"), and making it visible-but-transparent broke page loading outright.
// Drawing into a canvas needs no surface, keeps the alpha channel exact, and does
// not depend on what the display is doing.
let renderWindow = null;

async function getRenderWindow() {
  if (renderWindow) return renderWindow;
  renderWindow = new BrowserWindow({
    width: 64,
    height: 64,
    show: false,
    frame: false,
    webPreferences: { backgroundThrottling: false }
  });
  await renderWindow.loadURL('about:blank');
  return renderWindow;
}

async function render(svgFile, size) {
  const win = await getRenderWindow();
  const dataUrl = svgToDataUrl(svgFile);

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const img = new Image(${size}, ${size});
      img.src = ${JSON.stringify(dataUrl)};
      try { await img.decode(); } catch (e) { return { error: 'decode failed: ' + e.message }; }

      const canvas = document.createElement('canvas');
      canvas.width = ${size};
      canvas.height = ${size};
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, ${size}, ${size});
      ctx.drawImage(img, 0, 0, ${size}, ${size});

      // Guard against a silently blank render: an all-transparent canvas would
      // otherwise be written out as a perfectly valid, perfectly empty icon.
      const { data } = ctx.getImageData(0, 0, ${size}, ${size});
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque++;

      try {
        return { png: canvas.toDataURL('image/png'), opaque, total: data.length / 4 };
      } catch (e) {
        return { error: 'toDataURL failed: ' + e.message };
      }
    })()
  `);

  if (!result || result.error) {
    throw new Error(`${path.basename(svgFile)} @ ${size}: ${(result && result.error) || 'no result'}`);
  }
  if (result.opaque === 0) {
    throw new Error(`${path.basename(svgFile)} @ ${size}: rendered fully transparent`);
  }

  return Buffer.from(result.png.split(',')[1], 'base64');
}

function buildIco(pngsBySize) {
  const entries = ICO_SIZES.map((size) => ({ size, png: pngsBySize.get(size) }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;

  entries.forEach((entry, i) => {
    const at = i * 16;
    // 0 means 256 — the field is a single byte.
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at);
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1);
    directory.writeUInt8(0, at + 2); // palette size
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((e) => e.png)]);
}

function buildIcns(pngsBySize) {
  const chunks = ICNS_ENTRIES.map(([type, size]) => {
    const png = pngsBySize.get(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(png.length + 8, 4); // length includes this header
    return Buffer.concat([head, png]);
  });

  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

function write(file, data) {
  fs.writeFileSync(file, data);
  console.log(`  ${path.relative(ROOT, file).padEnd(34)} ${String(data.length).padStart(8)} bytes`);
}

async function main() {
  const iconSvg = path.join(ASSETS, 'icon.svg');
  const traySvg = path.join(ASSETS, 'tray-icon.svg');
  const badgeSvg = path.join(ASSETS, 'tray-badge.svg');

  for (const file of [iconSvg, traySvg, badgeSvg]) {
    if (!fs.existsSync(file)) throw new Error(`missing source: ${file}`);
  }
  fs.mkdirSync(APP_ICONS, { recursive: true });

  console.log('Rendering app icon...');
  const appSizes = [...new Set([...ICO_SIZES, ...ICNS_ENTRIES.map(([, s]) => s), 512, 1024])]
    .sort((a, b) => a - b);
  const appPngs = new Map();
  for (const size of appSizes) appPngs.set(size, await render(iconSvg, size));

  write(path.join(ASSETS, 'icon.png'), appPngs.get(1024));
  write(path.join(ASSETS, 'icon.ico'), buildIco(appPngs));
  write(path.join(ASSETS, 'icon.icns'), buildIcns(appPngs));
  // Window icon: what Windows shows in the title bar and Alt-Tab.
  write(path.join(APP_ICONS, 'app-icon.png'), appPngs.get(256));

  console.log('Rendering tray icons...');
  // macOS: monochrome template glyph, plus the @2x file Electron picks up
  // automatically for retina menu bars.
  write(path.join(APP_ICONS, 'tray-16.png'), await render(traySvg, 16));
  write(path.join(APP_ICONS, 'tray-16@2x.png'), await render(traySvg, 32));
  // Windows/Linux: coloured badge, legible on a light or a dark taskbar.
  write(path.join(APP_ICONS, 'tray-32.png'), await render(badgeSvg, 32));
  write(path.join(APP_ICONS, 'tray-64.png'), await render(badgeSvg, 64));

  console.log('Done.');
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((err) => {
    console.error(`icon build failed: ${err.stack || err.message}`);
    app.exit(1);
  });

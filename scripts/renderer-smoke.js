'use strict';

// Run with: npx electron scripts/renderer-smoke.js
// Tests real Chromium layout and renderer event handling without loading main.js.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const errors = [];
const measurements = [];
const tick = async (win) => {
  await new Promise(resolve => setTimeout(resolve, 100));
  await win.webContents.executeJavaScript('document.body.getBoundingClientRect().height');
};
let win;
app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    const { systemPowerShellPath } = require('../src/main/windows-protected-runtime');
    assert.ok(fs.existsSync(systemPowerShellPath()), 'Electron exposes loaded Windows KnownDLL paths');
  }
  win = new BrowserWindow({
    show: false, width: 420, height: 680, useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      preload: path.join(__dirname, 'renderer-smoke-preload.js') }
  });
  win.webContents.on('console-message', (_event, ...args) => {
    const detail = args[0];
    if (detail && typeof detail === 'object' && detail.level === 'error') errors.push(detail.message);
    else if (detail === 3) errors.push(args[1]);
  });
  await win.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  await tick(win);
  assert.equal(await win.webContents.executeJavaScript('document.querySelector("#platformBadge").textContent'), 'macOS');

  for (const height of [560, 680, 900]) {
    win.setContentSize(420, height);
    for (const expanded of [false, true]) {
      await win.webContents.executeJavaScript(`
        for (const [body, toggle] of [['domainsBody','domainsToggle'], ['logsBody','logsToggle']]) {
          if ((document.getElementById(body).style.display !== 'none') !== ${expanded}) document.getElementById(toggle).click();
        }
      `);
      win.webContents.send('fixture-update', { status: 'manual-available', version: '99.0.0' });
      win.webContents.send('fixture-status', { connected: false, binaryExists: true,
        errorCode: 'PROCESS_CRASHED', error: 'Диагностическое сообщение '.repeat(18) });
      await tick(win);
      const geometry = await win.webContents.executeJavaScript(`(() => {
        const main = document.querySelector('.main-content');
        const domains = document.getElementById('domainsCard');
        const logs = document.getElementById('logsCard');
        domains.scrollIntoView({block:'center'});
        const header = document.getElementById('domainsToggle').getBoundingClientRect();
        const pane = main.getBoundingClientRect();
        const point = document.elementFromPoint(header.x + header.width / 2, Math.max(pane.top + 1, header.top + 10));
        return { height: innerHeight, expanded: ${expanded}, domains: domains.getBoundingClientRect().height,
          logs: logs.getBoundingClientRect().height, scrollHeight: main.scrollHeight,
          clientHeight: main.clientHeight, horizontal: main.scrollWidth > main.clientWidth,
          headerReachable: !!point && document.getElementById('domainsToggle').contains(point) };
      })()`);
      assert.ok(geometry.domains >= (expanded ? 200 : 40), JSON.stringify(geometry));
      assert.ok(geometry.logs >= (expanded ? 100 : 40), JSON.stringify(geometry));
      assert.equal(geometry.horizontal, false, JSON.stringify(geometry));
      assert.equal(geometry.headerReachable, true, JSON.stringify(geometry));
      measurements.push(geometry);
    }
  }
  win.webContents.send('fixture-status', { connected: true, binaryExists: true,
    outcome: { level: 'partial', services: { youtube: true, discord: false } } });
  await tick(win);
  const partial = await win.webContents.executeJavaScript(`({
    text: document.getElementById('statusText').textContent,
    partial: document.getElementById('statusIndicator').classList.contains('partial'),
    discord: document.getElementById('badgeDiscord').classList.contains('is-blocked'),
    youtube: document.getElementById('badgeYoutube').classList.contains('is-blocked')
  })`);
  assert.equal(partial.text, 'Защита частичная');
  assert.equal(partial.partial, true);
  assert.equal(partial.discord, true);
  assert.equal(partial.youtube, false);
  win.webContents.send('fixture-status', { connected: true, binaryExists: true,
    outcome: { targetUrl: 'https://example.com/path', level: 'full', services: { youtube: null, discord: null, target: true } } });
  await tick(win);
  const targetState = await win.webContents.executeJavaScript(`({
    badges: getComputedStyle(document.getElementById('serviceBadges')).display,
    note: document.getElementById('partialNote').textContent
  })`);
  assert.equal(targetState.badges, 'none');
  assert.match(targetState.note, /YouTube и Discord не проверялись/);
  win.webContents.send('fixture-status', { connected: false, binaryExists: true });
  await tick(win);
  const saved = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById('targetUrl').value = 'https://example.com/path';
    document.getElementById('saveTargetBtn').click();
    await new Promise(resolve => setTimeout(resolve, 50));
    return document.getElementById('targetMessage').textContent;
  })()`);
  assert.ok(saved.length > 0, 'custom target save reports its result');
  assert.equal(await win.webContents.executeJavaScript(`(async () => {
    document.getElementById('logsCopy').click();
    await new Promise(resolve => setTimeout(resolve, 50));
    return document.getElementById('logsCopyLabel').textContent;
  })()`), 'Скопировано');
  assert.deepEqual(errors, []);
  fs.mkdirSync(path.join(__dirname, '../temp'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '../temp/renderer-smoke.json'), JSON.stringify({ electron: process.versions.electron, measurements, partial, targetState, saved, errors }, null, 2));
  console.log(JSON.stringify({ ok: true, electron: process.versions.electron, layouts: measurements.length, partial, errors }));
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

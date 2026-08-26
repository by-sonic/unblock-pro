'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_LOG_BYTES,
  appendLogLine,
  buildLogReport,
  formatLogLine,
  readLogTail
} = require('../src/main/log-report');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-pro-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const AT = Date.UTC(2026, 7, 26, 13, 5, 11, 123);

test('formats an entry with an absolute timestamp and level', () => {
  const line = formatLogLine({ type: 'warning', message: 'проверка не пройдена', timestamp: AT });
  assert.equal(line, '2026-08-26T13:05:11.123Z  warning  проверка не пройдена');
});

test('falls back to info when the level is missing', () => {
  const line = formatLogLine({ message: 'без уровня', timestamp: AT });
  assert.match(line, /  info  без уровня$/);
});

test('collapses newlines so one entry stays one line', () => {
  const line = formatLogLine({ type: 'error', message: 'первая\nвторая', timestamp: AT });
  assert.equal(line.split('\n').length, 1);
  assert.match(line, /первая ⏎ вторая/);
});

test('appends entries to the file in order', (t) => {
  const file = path.join(tmpDir(t), 'app.log');

  appendLogLine(file, { type: 'info', message: 'первая', timestamp: AT });
  appendLogLine(file, { type: 'info', message: 'вторая', timestamp: AT });

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /первая$/);
  assert.match(lines[1], /вторая$/);
});

test('creates the directory when it does not exist yet', (t) => {
  const file = path.join(tmpDir(t), 'nested', 'app.log');

  appendLogLine(file, { type: 'info', message: 'первый запуск', timestamp: AT });

  assert.ok(fs.existsSync(file));
});

test('rotates into .1 instead of growing without bound', (t) => {
  const file = path.join(tmpDir(t), 'app.log');
  const entry = (n) => ({ type: 'info', message: `строка ${n}`, timestamp: AT });

  for (let i = 0; i < 40; i++) appendLogLine(file, entry(i), { maxBytes: 200 });

  assert.ok(fs.existsSync(file + '.1'), 'предыдущий файл сохранён');
  assert.ok(fs.statSync(file).size <= 200, 'текущий файл в пределах лимита');
  const newest = fs.readFileSync(file, 'utf8');
  assert.match(newest, /строка 39/, 'последняя запись не потеряна');
});

test('rotation keeps exactly one previous file', (t) => {
  const file = path.join(tmpDir(t), 'app.log');
  for (let i = 0; i < 200; i++) {
    appendLogLine(file, { type: 'info', message: `строка ${i}`, timestamp: AT }, { maxBytes: 200 });
  }

  const dir = path.dirname(file);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['app.log', 'app.log.1']);
});

test('a write failure never throws at the caller', (t) => {
  const dir = tmpDir(t);
  // A directory where the log file should be: every write fails with EISDIR.
  const file = path.join(dir, 'app.log');
  fs.mkdirSync(file);

  assert.doesNotThrow(() => appendLogLine(file, { type: 'info', message: 'тест', timestamp: AT }));
});

test('reads the rotated file and the current one as one history', (t) => {
  const file = path.join(tmpDir(t), 'app.log');
  fs.writeFileSync(file + '.1', 'старое\n');
  fs.writeFileSync(file, 'новое\n');

  assert.equal(readLogTail(file), 'старое\nновое\n');
});

test('reading a missing log returns an empty string', (t) => {
  assert.equal(readLogTail(path.join(tmpDir(t), 'absent.log')), '');
});

test('report starts with the exact facts the issue form asks for', () => {
  const report = buildLogReport({
    fileText: '2026-08-26T13:05:11.123Z  info  подключение\n',
    systemInfo: {
      appVersion: '2.0.20',
      osName: 'macOS',
      osVersion: '15.7.7',
      arch: 'arm64',
      strategy: 'multi:disorder+tlsrec'
    },
    generatedAt: AT
  });

  assert.match(report, /UnblockPro 2\.0\.20/);
  assert.match(report, /macOS 15\.7\.7 \(arm64\)/);
  assert.match(report, /Стратегия: multi:disorder\+tlsrec/);
  assert.match(report, /2026-08-26T13:05:11\.123Z  info  подключение/);
});

test('report says so plainly when no strategy is connected', () => {
  const report = buildLogReport({
    fileText: 'x\n',
    systemInfo: { appVersion: '2.0.20', osName: 'Windows', osVersion: '11', arch: 'x64', strategy: null },
    generatedAt: AT
  });

  assert.match(report, /Стратегия: не подключена/);
});

test('report falls back to in-memory entries when the file is unavailable', () => {
  const report = buildLogReport({
    fileText: '',
    entries: [{ type: 'error', message: 'из памяти', timestamp: AT }],
    systemInfo: { appVersion: '2.0.20', osName: 'macOS', osVersion: '15.7.7', arch: 'arm64' },
    generatedAt: AT
  });

  assert.match(report, /из памяти/);
});

test('report is honest about an empty log rather than returning a bare header', () => {
  const report = buildLogReport({
    fileText: '',
    entries: [],
    systemInfo: { appVersion: '2.0.20', osName: 'macOS', osVersion: '15.7.7', arch: 'arm64' },
    generatedAt: AT
  });

  assert.match(report, /Журнал пуст/);
});

test('the size cap is a real number of bytes', () => {
  assert.equal(typeof MAX_LOG_BYTES, 'number');
  assert.ok(MAX_LOG_BYTES > 0);
});

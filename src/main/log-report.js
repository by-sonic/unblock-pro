'use strict';

// Diagnostics the user can actually hand over.
//
// The in-app log used to be a 100-entry array in memory with no way out of the
// window: no file, no copy button. Asking a reporter for "журнал" therefore
// asked for something that did not exist — in #46 and #56 the answer was
// literally "не понимаю, где его взять". Worse, one auto-select sweep walks 52
// macOS strategies through 68 logging points, so the beginning of the run — the
// part that says which probe rejected which strategy — was already evicted from
// the ring buffer by the time the error appeared on screen.
//
// This module gives the log a file with a bounded size, and formats a report
// that leads with the facts the issue form asks for (app version, OS, strategy)
// so a paste into GitHub is self-contained.
//
// Logging must never be able to break the app: every filesystem failure here is
// swallowed. A missing log is an inconvenience; a crashed connect flow is not.

const fs = require('node:fs');
const path = require('node:path');

// One megabyte of plain text is far more than one sweep produces, and small
// enough to paste-quote or attach without thinking about it.
const MAX_LOG_BYTES = 1024 * 1024;

const ROTATED_SUFFIX = '.1';

const SEPARATOR = '-'.repeat(52);

function formatLogLine(entry = {}) {
  const at = new Date(entry.timestamp || Date.now()).toISOString();
  const level = entry.type || 'info';
  // One entry stays one line: a multi-line message would otherwise be
  // indistinguishable from separate events when read back.
  const message = String(entry.message == null ? '' : entry.message).replace(/\r?\n/g, ' ⏎ ');
  return `${at}  ${level}  ${message}`;
}

function rotate(filePath) {
  const rotated = filePath + ROTATED_SUFFIX;
  // renameSync onto an existing path fails on Windows, so clear the target
  // first. Only one generation is kept — the previous sweep is the useful
  // history, anything older is noise.
  try { fs.rmSync(rotated, { force: true }); } catch (e) {}
  fs.renameSync(filePath, rotated);
}

function appendLogLine(filePath, entry, { maxBytes = MAX_LOG_BYTES } = {}) {
  try {
    const line = formatLogLine(entry) + '\n';
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    let size = 0;
    try { size = fs.statSync(filePath).size; } catch (e) {}
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) rotate(filePath);

    fs.appendFileSync(filePath, line, 'utf8');
  } catch (e) {
    // Deliberately silent — see the header.
  }
}

function readFileOrEmpty(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return '';
  }
}

// The rotated file plus the current one, oldest first, so a sweep that spanned a
// rotation still reads as one history.
function readLogTail(filePath) {
  return readFileOrEmpty(filePath + ROTATED_SUFFIX) + readFileOrEmpty(filePath);
}

function buildLogReport({ fileText = '', entries = [], systemInfo = {}, generatedAt = Date.now() } = {}) {
  const {
    appVersion = 'неизвестно',
    osName = 'неизвестно',
    osVersion = '',
    arch = '',
    strategy = null
  } = systemInfo;

  const body = fileText.trim()
    || entries.map(formatLogLine).join('\n').trim()
    || 'Журнал пуст — приложение ещё ничего не записало.';

  return [
    `UnblockPro ${appVersion}`,
    `${osName} ${osVersion} (${arch})`.replace(/\s+\(\)$/, ''),
    `Стратегия: ${strategy || 'не подключена'}`,
    `Сформировано: ${new Date(generatedAt).toISOString()}`,
    SEPARATOR,
    body,
    ''
  ].join('\n');
}

module.exports = {
  MAX_LOG_BYTES,
  appendLogLine,
  buildLogReport,
  formatLogLine,
  readLogTail
};

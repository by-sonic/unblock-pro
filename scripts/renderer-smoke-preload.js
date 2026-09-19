'use strict';

// Renderer-only fixture: no production main process, network or system changes.
const { contextBridge, ipcRenderer } = require('electron');
const status = { connected: false, binaryExists: true };
const noop = async () => ({ success: true });
contextBridge.exposeInMainWorld('api', {
  getSystemInfo: async () => ({ platform: 'darwin', version: 'test', binaryExists: true }),
  getStrategies: async () => ['Test strategy'],
  getStatus: async () => status,
  getSettings: async () => ({ selectedStrategy: 'auto', customTargetUrl: '' }),
  getLogs: async () => [{ type: 'info', message: 'Renderer smoke fixture', timestamp: Date.now() }],
  getCustomDomains: async () => ({ include: [], exclude: [] }),
  startProxy: noop, stopProxy: noop, downloadBinaries: noop,
  minimizeWindow: noop, closeWindow: noop, setAutoStart: noop,
  setAutoConnect: noop, setSelectedStrategy: noop, installUpdate: noop,
  checkForUpdates: noop, setAutoUpdate: noop, copyLogs: noop,
  showLogFile: noop, clearError: noop, setCustomDomains: noop,
  openExternal: noop, updateHostsForDiscord: noop, cleanHosts: noop,
  clearDiscordCache: noop, setCustomTarget: async (url) => ({ success: true, url }),
  onStatus: (callback) => ipcRenderer.on('fixture-status', (_, data) => callback(data)),
  onUpdateStatus: (callback) => ipcRenderer.on('fixture-update', (_, data) => callback(data)),
  onDownloadProgress: () => {}, onUpdateDownloadProgress: () => {}, onLogEntry: () => {}
});

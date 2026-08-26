const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Proxy control
  startProxy: () => ipcRenderer.invoke('start-proxy'),
  stopProxy: () => ipcRenderer.invoke('stop-proxy'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  
  // Binary download
  downloadBinaries: () => ipcRenderer.invoke('download-binaries'),
  
  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  
  // System info
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setAutoStart: (enabled) => ipcRenderer.invoke('set-auto-start', enabled),
  setAutoConnect: (enabled) => ipcRenderer.invoke('set-auto-connect', enabled),
  
  // Strategy selection
  getStrategies: () => ipcRenderer.invoke('get-strategies'),
  setSelectedStrategy: (name) => ipcRenderer.invoke('set-selected-strategy', name),
  
  // Updates
  installUpdate: () => ipcRenderer.invoke('install-update'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  setAutoUpdate: (enabled) => ipcRenderer.invoke('set-auto-update', enabled),
  
  // Logs & errors
  getLogs: () => ipcRenderer.invoke('get-logs'),
  clearError: () => ipcRenderer.invoke('clear-error'),
  
  // Custom domains
  getCustomDomains: () => ipcRenderer.invoke('get-custom-domains'),
  setCustomDomains: (data) => ipcRenderer.invoke('set-custom-domains', data),

  // External links
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  updateHostsForDiscord: () => ipcRenderer.invoke('update-hosts-for-discord'),
  cleanHosts: () => ipcRenderer.invoke('clean-hosts'),
  clearDiscordCache: () => ipcRenderer.invoke('clear-discord-cache'),
  
  // Event listeners
  onStatus: (callback) => {
    ipcRenderer.on('status', (event, data) => callback(data));
  },
  onDownloadProgress: (callback) => {
    ipcRenderer.on('download-progress', (event, data) => callback(data));
  },
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (event, data) => callback(data));
  },
  onUpdateDownloadProgress: (callback) => {
    ipcRenderer.on('update-download-progress', (event, data) => callback(data));
  },
  onLogEntry: (callback) => {
    ipcRenderer.on('log-entry', (event, data) => callback(data));
  }
});

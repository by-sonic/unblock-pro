// DOM Elements
const statusIndicator = document.getElementById('statusIndicator');
const statusIcon = document.getElementById('statusIcon');
const statusText = document.getElementById('statusText');
const strategyText = document.getElementById('strategyText');
const footerStrategy = document.getElementById('footerStrategy');
const strategyName = document.getElementById('strategyName');
const progressCircle = document.getElementById('progressCircle');
const minimizeBtn = document.getElementById('minimizeBtn');
const closeBtn = document.getElementById('closeBtn');
const platformBadge = document.getElementById('platformBadge');
const binaryStatus = document.getElementById('binaryStatus');
const downloadSection = document.getElementById('downloadSection');
const downloadText = document.getElementById('downloadText');
const progressFill = document.getElementById('progressFill');
const downloadPercent = document.getElementById('downloadPercent');
const autostartToggle = document.getElementById('autostartToggle');
const autoconnectToggle = document.getElementById('autoconnectToggle');
const strategySelect = document.getElementById('strategySelect');
const progressStatus = document.getElementById('progressStatus');
const strategyStatus = document.getElementById('strategyStatus');

// New UI elements
const connectionTimer = document.getElementById('connectionTimer');
const timerText = document.getElementById('timerText');
const connectionTimerLarge = document.getElementById('connectionTimerLarge');
const timerTextLarge = document.getElementById('timerTextLarge');
const errorCard = document.getElementById('errorCard');
const errorTitle = document.getElementById('errorTitle');
const errorMessage = document.getElementById('errorMessage');
const errorDismiss = document.getElementById('errorDismiss');
const retryBtn = document.getElementById('retryBtn');
const logsCard = document.getElementById('logsCard');
const logsToggle = document.getElementById('logsToggle');
const logsChevron = document.getElementById('logsChevron');
const logsBody = document.getElementById('logsBody');
const logsList = document.getElementById('logsList');
const logsCount = document.getElementById('logsCount');

// Custom domains elements
const domainsToggle = document.getElementById('domainsToggle');
const domainsChevron = document.getElementById('domainsChevron');
const domainsBody = document.getElementById('domainsBody');
const includeList = document.getElementById('includeList');
const excludeList = document.getElementById('excludeList');
const includeInput = document.getElementById('includeInput');
const excludeInput = document.getElementById('excludeInput');
const includeAddBtn = document.getElementById('includeAddBtn');
const excludeAddBtn = document.getElementById('excludeAddBtn');

// State
let isConnected = false;
let isConnecting = false;
let isDownloading = false;
let timerInterval = null;
let connectedSinceTime = null;
let logsOpen = false;
let logCount = 0;
let domainsOpen = false;
let customIncludeDomains = [];
let customExcludeDomains = [];
let menuOpen = false;

// Update elements
const updateBanner = document.getElementById('updateBanner');
const updateText = document.getElementById('updateText');
const updateBtn = document.getElementById('updateBtn');

// Error code to user-friendly title mapping
const ERROR_TITLES = {
  'NO_BINARY': 'Бинарник не найден',
  'DOWNLOAD_FAILED': 'Ошибка скачивания',
  'ALL_STRATEGIES_FAILED': 'Стратегии не сработали',
  'PROCESS_CRASHED': 'Процесс завершился',
  'PERMISSION_DENIED': 'Нет прав доступа',
  'PORT_IN_USE': 'Порт занят',
  'NETWORK_UNAVAILABLE': 'Нет сети',
  'ALREADY_RUNNING': 'Уже подключено'
};

// Initialize
async function init() {
  if (typeof window.api === 'undefined') {
    const statusTextEl = document.getElementById('statusText');
    const binaryTextEl = binaryStatus && binaryStatus.querySelector('.binary-text');
    if (statusTextEl) statusTextEl.textContent = 'Ошибка инициализации';
    if (binaryTextEl) binaryTextEl.textContent = 'Перезапустите приложение';
    return;
  }
  try {
    setupEventListeners();
    ensureCardsInCorrectContainer();
    await Promise.race([
      Promise.all([
        loadSystemInfo(),
        loadStrategies(),
        loadStatus(),
        loadSettings(),
        loadLogs(),
        loadCustomDomains()
      ]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
    ]);
  } catch (e) {
    const binaryTextEl = binaryStatus && binaryStatus.querySelector('.binary-text');
    if (binaryTextEl) binaryTextEl.textContent = 'Готов';
    updateBinaryStatus(false);
  }
  if (typeof window.api === 'undefined') return;
  window.api.onStatus(handleStatusUpdate);
  window.api.onDownloadProgress(handleDownloadProgress);
  window.api.onUpdateStatus(handleUpdateStatus);
  window.api.onUpdateDownloadProgress(handleUpdateDownloadProgress);
  window.api.onLogEntry(handleLogEntry);
  updateBtn?.addEventListener('click', handleUpdateBtnClick);
}

function setupEventListeners() {
  minimizeBtn.addEventListener('click', () => window.api.minimizeWindow());
  closeBtn.addEventListener('click', () => window.api.closeWindow());
  statusIndicator.addEventListener('click', handleConnectClick);
  
  autostartToggle.addEventListener('change', async () => {
    await window.api.setAutoStart(autostartToggle.checked);
  });
  
  autoconnectToggle.addEventListener('change', async () => {
    await window.api.setAutoConnect(autoconnectToggle.checked);
  });
  
  // Strategy selector
  strategySelect.addEventListener('change', async () => {
    await window.api.setSelectedStrategy(strategySelect.value);
  });
  
  // Error card dismiss
  errorDismiss.addEventListener('click', () => {
    hideError();
    window.api.clearError();
  });
  
  // Retry button
  retryBtn.addEventListener('click', async () => {
    hideError();
    window.api.clearError();
    handleConnectClick();
  });
  
  // Domains toggle
  domainsToggle.addEventListener('click', () => {
    domainsOpen = !domainsOpen;
    domainsBody.style.display = domainsOpen ? 'block' : 'none';
    domainsChevron.classList.toggle('open', domainsOpen);
  });

  // Domain add buttons
  includeAddBtn.addEventListener('click', () => addDomain('include'));
  excludeAddBtn.addEventListener('click', () => addDomain('exclude'));
  includeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addDomain('include'); });
  excludeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addDomain('exclude'); });

  // Logs toggle
  logsToggle.addEventListener('click', () => {
    logsOpen = !logsOpen;
    logsBody.style.display = logsOpen ? 'block' : 'none';
    logsChevron.classList.toggle('open', logsOpen);

    // Scroll to bottom when opening
    if (logsOpen) {
      logsList.scrollTop = logsList.scrollHeight;
    }
  });

  // Hamburger menu
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const menuPanel = document.getElementById('menuPanel');
  const menuOverlay = document.getElementById('menuOverlay');
  const menuClose = document.getElementById('menuClose');
  const menuContent = document.getElementById('menuContent');

  if (hamburgerBtn && menuPanel) {
    hamburgerBtn.addEventListener('click', openMenu);
    menuClose.addEventListener('click', closeMenu);
    menuOverlay.addEventListener('click', closeMenu);

    // Keyboard support
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menuOpen) {
        closeMenu();
      }
    });
  }
}

function openMenu() {
  menuOpen = true;
  const menuPanel = document.getElementById('menuPanel');
  const menuOverlay = document.getElementById('menuOverlay');
  const menuContent = document.getElementById('menuContent');
  const menuClose = document.getElementById('menuClose');

  menuPanel.classList.add('active');
  menuOverlay.classList.add('active');
  document.body.classList.add('menu-open');

  // Move sections to menu on small screens (except settings-card which stays on main screen)
  if (window.innerWidth <= 500) {
    const domainsCard = document.querySelector('.domains-card');
    const logsCard = document.querySelector('.logs-card');
    const infoCard = document.querySelector('.info-card');

    if (domainsCard) menuContent.appendChild(domainsCard);
    if (logsCard) menuContent.appendChild(logsCard);
    if (infoCard) menuContent.appendChild(infoCard);
  }

  // Focus management
  if (menuClose) menuClose.focus();
}

function closeMenu() {
  menuOpen = false;
  const menuPanel = document.getElementById('menuPanel');
  const menuOverlay = document.getElementById('menuOverlay');
  const hamburgerBtn = document.getElementById('hamburgerBtn');

  menuPanel.classList.remove('active');
  menuOverlay.classList.remove('active');
  document.body.classList.remove('menu-open');

  // Move sections back to main content (except settings-card which stays on main screen)
  if (window.innerWidth <= 500) {
    const contentScroll = document.querySelector('.content-scroll');
    const domainsCard = document.querySelector('.domains-card');
    const logsCard = document.querySelector('.logs-card');
    const infoCard = document.querySelector('.info-card');

    if (contentScroll && domainsCard) contentScroll.appendChild(domainsCard);
    if (contentScroll && logsCard) contentScroll.appendChild(logsCard);
    if (contentScroll && infoCard) contentScroll.appendChild(infoCard);
  }

  // Return focus to hamburger button
  if (hamburgerBtn) hamburgerBtn.focus();
}

// Ensure cards are in the correct container based on screen size
function ensureCardsInCorrectContainer() {
  const contentScroll = document.querySelector('.content-scroll');
  const menuContent = document.getElementById('menuContent');
  const settingsCard = document.querySelector('.settings-card');
  const domainsCard = document.querySelector('.domains-card');
  const logsCard = document.querySelector('.logs-card');
  const infoCard = document.querySelector('.info-card');

  if (window.innerWidth > 500) {
    // On larger screens, cards should be in main content (settings-card always stays in main content)
    if (contentScroll && settingsCard && !contentScroll.contains(settingsCard)) {
      contentScroll.appendChild(settingsCard);
    }
    if (contentScroll && domainsCard && !contentScroll.contains(domainsCard)) {
      contentScroll.appendChild(domainsCard);
    }
    if (contentScroll && logsCard && !contentScroll.contains(logsCard)) {
      contentScroll.appendChild(logsCard);
    }
    if (contentScroll && infoCard && !contentScroll.contains(infoCard)) {
      contentScroll.appendChild(infoCard);
    }
  } else {
    // On small screens, ensure settings-card stays in main content
    if (contentScroll && settingsCard && !contentScroll.contains(settingsCard)) {
      contentScroll.appendChild(settingsCard);
    }
  }
}

// Handle window resize
window.addEventListener('resize', () => {
  if (window.innerWidth > 500 && menuOpen) {
    closeMenu();
  }
  ensureCardsInCorrectContainer();
});

async function loadSystemInfo() {
  try {
    const info = await window.api.getSystemInfo();

    const platformNames = {
      darwin: 'macOS',
      win32: 'Windows',
      linux: 'Linux'
    };

    const platformName = platformNames[info.platform] || info.platform;

    // Update main footer
    platformBadge.textContent = platformName;

    const versionEl = document.getElementById('versionText');
    if (versionEl && info.version) versionEl.textContent = `v${info.version}`;

    // Update menu footer
    const platformBadgeMenu = document.getElementById('platformBadgeMenu');
    const versionTextMenu = document.getElementById('versionTextMenu');
    if (platformBadgeMenu) platformBadgeMenu.textContent = platformName;
    if (versionTextMenu && info.version) versionTextMenu.textContent = `v${info.version}`;

    updateBinaryStatus(info.binaryExists);
  } catch (error) {
    // silently handle
  }
}

function updateBinaryStatus(exists, downloading = false) {
  const binaryTextEl = binaryStatus.querySelector('.binary-text');
  
  binaryStatus.classList.remove('ready', 'error', 'downloading');
  
  if (downloading) {
    binaryStatus.classList.add('downloading');
    binaryTextEl.textContent = 'Скачивание...';
  } else if (exists) {
    binaryStatus.classList.add('ready');
    binaryTextEl.textContent = 'Готов';
  } else {
    binaryStatus.classList.add('error');
    binaryTextEl.textContent = 'Нет бинарника';
  }
}

async function loadStatus() {
  try {
    const status = await window.api.getStatus();
    handleStatusUpdate(status);
  } catch (error) {
    // silently handle
  }
}

async function loadStrategies() {
  try {
    const strategies = await window.api.getStrategies();
    // Clear existing options except "Автоподбор"
    strategySelect.innerHTML = '<option value="auto">Автоподбор</option>';
    for (const name of strategies) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      strategySelect.appendChild(option);
    }
  } catch (error) {
    // silently handle — dropdown will just show "Автоподбор"
  }
}

async function loadSettings() {
  try {
    const settings = await window.api.getSettings();
    autostartToggle.checked = settings.autoStart || false;
    autoconnectToggle.checked = settings.autoConnect || false;
    
    // Set strategy selector
    if (settings.selectedStrategy && settings.selectedStrategy !== 'auto') {
      strategySelect.value = settings.selectedStrategy;
    } else {
      strategySelect.value = 'auto';
    }
  } catch (error) {
    // silently handle
  }
}

async function loadLogs() {
  try {
    const logs = await window.api.getLogs();
    if (logs && logs.length > 0) {
      logs.forEach(entry => addLogEntry(entry));
    }
  } catch (error) {
    // silently handle
  }
}

function handleStatusUpdate(status) {
  isConnected = status.connected;
  isDownloading = status.downloading;

  // When backend confirms connected, clear local connecting state
  if (isConnected) {
    isConnecting = false;
  }

  // Update status indicator
  statusIndicator.classList.remove('connected', 'connecting', 'searching', 'downloading', 'error');
  statusText.classList.remove('error-text');

  // Update footer status
  const footer = document.getElementById('footer');
  footer.classList.remove('status-connected', 'status-connecting', 'status-searching', 'status-downloading', 'status-error');

  if (isDownloading) {
    statusIndicator.classList.add('downloading');
    statusText.textContent = 'Скачивание...';
    statusIndicator.setAttribute('aria-label', 'Скачивание...');
    downloadSection.style.display = 'block';
    updateBinaryStatus(false, true);
    hideStrategyToolbar();
    hideConnectionTimer();
    footer.classList.add('status-downloading');
  } else if (status.searching) {
    statusIndicator.classList.add('searching');
    statusText.textContent = 'Поиск стратегии...';
    statusIndicator.setAttribute('aria-label', 'Поиск стратегии...');
    downloadSection.style.display = 'none';
    hideConnectionTimer();
    footer.classList.add('status-searching');

    // Show strategy toolbar
    if (status.strategyProgress) {
      showStrategyToolbar(status.strategyProgress);
    }
  } else if (isConnected) {
    statusIndicator.classList.add('connected');
    statusText.textContent = 'Обход активен';
    statusIndicator.setAttribute('aria-label', 'Отключить');
    downloadSection.style.display = 'none';
    hideStrategyToolbar();
    hideError();
    footer.classList.add('status-connected');

    // Start connection timer
    if (status.connectedSince) {
      startConnectionTimer(status.connectedSince);
    }
  } else if (isConnecting) {
    statusIndicator.classList.add('connecting');
    statusText.textContent = 'Подключение...';
    statusIndicator.setAttribute('aria-label', 'Подключение...');
    downloadSection.style.display = 'none';
    hideConnectionTimer();
    footer.classList.add('status-connecting');
  } else {
    // Disconnected state
    statusIndicator.setAttribute('aria-label', 'Подключить');
    downloadSection.style.display = 'none';
    hideStrategyToolbar();
    hideConnectionTimer();

    // Check for errors
    if (status.error || status.errorCode) {
      statusIndicator.classList.add('error');
      statusText.textContent = 'Ошибка';
      statusText.classList.add('error-text');
      showError(status.errorCode, status.error);
      footer.classList.add('status-error');
    } else if (status.disconnectReason) {
      statusIndicator.classList.add('error');
      statusText.textContent = 'Отключено';
      showDisconnectReason(status.disconnectReason);
      footer.classList.add('status-error');
    } else {
      statusText.textContent = 'Отключено';
    }
  }

  // Update strategy text
  if (status.strategy) {
    strategyText.innerHTML = `Стратегия: <span class="strategy-badge">${status.strategy}</span>`;
    // Show strategy name in footer toolbar
    if (footerStrategy && strategyName) {
      strategyName.textContent = status.strategy;
      footerStrategy.style.display = 'flex';
    }
  } else if (status.strategyProgress && status.strategyProgress.name) {
    strategyText.textContent = '';
    // Hide footer strategy during testing
    if (footerStrategy) {
      footerStrategy.style.display = 'none';
    }
  } else {
    strategyText.textContent = '';
    // Hide footer strategy when disconnected
    if (footerStrategy) {
      footerStrategy.style.display = 'none';
    }
  }
  
  // Update binary status
  if (!isDownloading) {
    updateBinaryStatus(status.binaryExists);
  }
}

// ============= Strategy Toolbar =============

function showStrategyToolbar(progress) {
  if (strategyStatus) {
    strategyStatus.style.display = 'flex';
    const statusText = strategyStatus.querySelector('.strategy-status-text');
    if (statusText) {
      if (progress.name) {
        statusText.innerHTML = `Тест ${progress.current}/${progress.total} <span class="strategy-badge">${progress.name}</span>`;
      } else {
        statusText.textContent = `Тест ${progress.current}/${progress.total}`;
      }
    }
  }
}

function hideStrategyToolbar() {
  if (strategyStatus) {
    strategyStatus.style.display = 'none';
  }
}

// ============= Connection Timer =============

function startConnectionTimer(sinceTimestamp) {
  connectedSinceTime = sinceTimestamp;
  connectionTimer.style.display = 'flex';
  connectionTimerLarge.style.display = 'flex';
  updateTimerDisplay();

  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(updateTimerDisplay, 1000);
}

function hideConnectionTimer() {
  connectionTimer.style.display = 'none';
  connectionTimerLarge.style.display = 'none';
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  connectedSinceTime = null;
}

function updateTimerDisplay() {
  if (!connectedSinceTime) return;

  const elapsed = Math.floor((Date.now() - connectedSinceTime) / 1000);
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;

  const timeStr = `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  timerText.textContent = timeStr;
  timerTextLarge.textContent = timeStr;
}

// ============= Error Display =============

function showError(errorCode, errorMsg) {
  errorCard.style.display = 'block';
  
  const title = ERROR_TITLES[errorCode] || 'Ошибка подключения';
  errorTitle.textContent = title;
  errorMessage.textContent = errorMsg || 'Произошла неизвестная ошибка';
  
  // Show retry button for recoverable errors
  const retryable = ['ALL_STRATEGIES_FAILED', 'PROCESS_CRASHED', 'DOWNLOAD_FAILED', 'NETWORK_UNAVAILABLE'];
  retryBtn.style.display = retryable.includes(errorCode) ? 'flex' : 'none';
}

function showDisconnectReason(reason) {
  const reasons = {
    'PROCESS_CRASHED': 'Процесс обхода завершился неожиданно. Попробуйте подключиться снова.',
    'PROCESS_EXITED': 'Процесс обхода остановился. Попробуйте подключиться снова.'
  };
  
  const msg = reasons[reason] || 'Соединение было прервано';
  showError(reason, msg);
}

function hideError() {
  errorCard.style.display = 'none';
}

// ============= Logs =============

function handleLogEntry(entry) {
  addLogEntry(entry);
}

function addLogEntry(entry) {
  logCount++;
  logsCount.textContent = logCount;
  
  const el = document.createElement('div');
  el.className = `log-entry ${entry.type || 'info'}`;
  
  const time = new Date(entry.timestamp);
  const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}`;
  
  el.innerHTML = `
    <span class="log-time">${timeStr}</span>
    <span class="log-dot"></span>
    <span class="log-message">${escapeHtml(entry.message)}</span>
  `;
  
  logsList.appendChild(el);
  
  // Keep only last 100 entries in DOM
  while (logsList.children.length > 100) {
    logsList.removeChild(logsList.firstChild);
  }
  
  // Auto-scroll if at bottom
  if (logsOpen) {
    const isAtBottom = logsList.scrollHeight - logsList.scrollTop - logsList.clientHeight < 50;
    if (isAtBottom) {
      logsList.scrollTop = logsList.scrollHeight;
    }
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============= Progress Status =============

function showProgressStatus(text = 'Обработка...') {
  if (progressStatus) {
    progressStatus.style.display = 'flex';
    const progressText = progressStatus.querySelector('.progress-text');
    if (progressText) progressText.textContent = text;
  }
}

function hideProgressStatus() {
  if (progressStatus) {
    progressStatus.style.display = 'none';
  }
}

// ============= Download Progress =============

function handleDownloadProgress(progress) {
  downloadSection.style.display = 'block';
  progressFill.style.width = `${progress.percent}%`;
  downloadPercent.textContent = `${progress.percent}%`;
  
  if (progress.total) {
    const downloadedMB = (progress.downloaded / 1024 / 1024).toFixed(1);
    const totalMB = (progress.total / 1024 / 1024).toFixed(1);
    downloadText.textContent = `Скачивание: ${downloadedMB} / ${totalMB} MB`;
  }
}

// ============= Connect/Disconnect =============

async function handleConnectClick() {
  if (isConnecting || isDownloading) return;
  
  if (isConnected) {
    // Disconnect
    try {
      await window.api.stopProxy();
    } catch (error) {
      showError(null, `Ошибка при отключении: ${error.message}`);
    }
  } else {
    // Connect
    isConnecting = true;
    hideError();
    statusIndicator.classList.remove('error');
    statusIndicator.classList.add('connecting');
    statusText.textContent = 'Подключение...';
    statusText.classList.remove('error-text');
    statusIndicator.setAttribute('aria-label', 'Подключение...');
    
    try {
      const result = await window.api.startProxy();
      if (!result.success && result.error) {
        // Error is handled via status update from backend
      }
    } catch (error) {
      showError(null, `Ошибка подключения: ${error.message}`);
    } finally {
      isConnecting = false;
      // Sync UI with actual backend state after connect attempt
      await loadStatus();
    }
  }
}

// ============= Auto-update handlers =============

let updateDownloadedVersion = null;

function handleUpdateStatus(data) {
  const { status, version } = data;
  
  switch (status) {
    case 'available':
      updateDownloadedVersion = null;
      updateBanner.style.display = 'flex';
      updateBanner.classList.remove('downloading');
      updateText.textContent = `Обновление v${version} загружается...`;
      updateBtn.style.display = 'none';
      break;
    case 'downloaded':
      updateDownloadedVersion = version;
      updateBanner.style.display = 'flex';
      updateBanner.classList.remove('downloading');
      updateText.textContent = `Обновление v${version} готово`;
      updateBtn.textContent = 'Перезапустить';
      updateBtn.style.display = 'block';
      updateBtn.disabled = false;
      updateBtn.title = 'Нажмите, чтобы перезапустить и установить';
      break;
    case 'restarting':
      updateBtn.disabled = true;
      updateBtn.textContent = 'Перезапуск...';
      updateText.textContent = 'Закрытие приложения...';
      break;
    case 'error':
    case 'not-available':
    case 'checking':
      updateDownloadedVersion = null;
      break;
  }
}

async function handleUpdateBtnClick() {
  if (!updateDownloadedVersion || !window.api) return;
  try {
    updateBtn.disabled = true;
    updateBtn.textContent = 'Перезапуск...';
    updateText.textContent = 'Закрытие приложения...';
    await window.api.installUpdate();

    // If we're still here after 8 seconds, the restart likely failed silently.
    // Show retry button so the user isn't stuck on "Closing app..." forever.
    setTimeout(() => {
      if (!updateBtn) return;
      updateBtn.disabled = false;
      updateBtn.textContent = 'Повторить';
      updateText.textContent = 'Перезапуск не удался. Попробуйте ещё раз или закройте вручную.';
    }, 8000);
  } catch (e) {
    updateBtn.disabled = false;
    updateBtn.textContent = 'Перезапустить';
    updateText.textContent = 'Ошибка: ' + (e.message || 'не удалось перезапустить');
  }
}

function handleUpdateDownloadProgress(progress) {
  updateBanner.style.display = 'flex';
  updateBanner.classList.add('downloading');
  updateText.textContent = `Загрузка обновления: ${progress.percent}%`;
  updateBtn.style.display = 'none';
}

document.getElementById('updateHostsBtn')?.addEventListener('click', async () => {
  showProgressStatus('Обновление hosts...');
  try {
    const result = await window.api.updateHostsForDiscord();
    hideProgressStatus();
    if (result?.success) {
      alert('Hosts обновлён. Перезапустите Discord при необходимости.');
    } else {
      alert('Ошибка: ' + (result?.error || 'неизвестная ошибка') + '\n\nРазрешите UAC, если запрос прав был отклонён.');
    }
  } catch (e) {
    hideProgressStatus();
    alert('Ошибка: ' + (e.message || 'неизвестная ошибка'));
  }
});

document.getElementById('clearDiscordCacheBtn')?.addEventListener('click', async () => {
  showProgressStatus('Очистка кэша...');
  try {
    await window.api.clearDiscordCache();
    hideProgressStatus();
    alert('Готово. Закройте Discord и запустите снова.');
  } catch (e) {
    hideProgressStatus();
    alert('Ошибка: ' + (e.message || 'неизвестная ошибка'));
  }
});

// ============= Custom Domains =============

async function loadCustomDomains() {
  try {
    const data = await window.api.getCustomDomains();
    customIncludeDomains = data.include || [];
    customExcludeDomains = data.exclude || [];
    renderDomainList('include');
    renderDomainList('exclude');
  } catch (e) {}
}

function renderDomainList(type) {
  const list = type === 'include' ? includeList : excludeList;
  const domains = type === 'include' ? customIncludeDomains : customExcludeDomains;

  list.innerHTML = '';
  if (domains.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'domain-empty';
    empty.textContent = type === 'include' ? 'Нет добавленных доменов' : 'Нет исключённых доменов';
    list.appendChild(empty);
    return;
  }

  domains.forEach((domain, i) => {
    const tag = document.createElement('span');
    tag.className = `domain-tag ${type}`;
    tag.innerHTML = `
      ${escapeHtml(domain)}
      <button class="domain-remove" title="Удалить">
        <svg width="10" height="10" viewBox="0 0 14 14">
          <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
    `;
    tag.querySelector('.domain-remove').addEventListener('click', () => removeDomain(type, i));
    list.appendChild(tag);
  });
}

function isValidDomain(str) {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(str);
}

async function addDomain(type) {
  const input = type === 'include' ? includeInput : excludeInput;
  const domain = input.value.trim().toLowerCase();

  if (!domain) return;
  if (!isValidDomain(domain)) {
    input.style.borderColor = 'var(--accent-red)';
    setTimeout(() => { input.style.borderColor = ''; }, 1500);
    return;
  }

  const domains = type === 'include' ? customIncludeDomains : customExcludeDomains;
  if (domains.includes(domain)) {
    input.value = '';
    return;
  }

  domains.push(domain);
  input.value = '';
  renderDomainList(type);
  await saveCustomDomains();
}

async function removeDomain(type, index) {
  const domains = type === 'include' ? customIncludeDomains : customExcludeDomains;
  domains.splice(index, 1);
  renderDomainList(type);
  await saveCustomDomains();
}

async function saveCustomDomains() {
  try {
    await window.api.setCustomDomains({
      include: customIncludeDomains,
      exclude: customExcludeDomains
    });
  } catch (e) {}
}

// Start
init();

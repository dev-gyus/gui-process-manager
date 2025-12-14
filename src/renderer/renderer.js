const { ipcRenderer } = require("electron");
const {NOW_SAVING_SPAN} = require("./constants.js");

class App {
  constructor() {
    this.servers = [];
    this.currentDetailServer = null;
    this.statusLockUntil = 0;
    this.justOpenedModal = null;
  }

  normalizeStatus(status) {
    return String(status || '').trim().toLowerCase();
  }

  isRunningLike(status) {
    const normalized = this.normalizeStatus(status);
    return normalized === 'running' || normalized === 'starting' || normalized === 'restarting';
  }

  setServerLocalStatus(serverId, status) {
    const index = this.servers.findIndex(s => s.id === serverId);
    if (index === -1) return;
    this.servers[index] = { ...this.servers[index], status };
    this.renderServerList();
    this.updateStatusBar();
  }

  forceModalLayout(modal) {
    if (!modal) return;
    // In some transparent/framelss Electron windows, overlays outside the main
    // container can end up with a 0x0 layout rect. Ensure the modal lives under
    // #app (which has a real size) and force explicit pixel sizing.
    const appEl = document.getElementById('app');
    if (appEl && modal.parentElement !== appEl) {
      appEl.appendChild(modal);
    }

    const width = appEl?.clientWidth || document.body?.clientWidth || window.innerWidth || 400;
    const height = appEl?.clientHeight || document.body?.clientHeight || window.innerHeight || 600;

    modal.style.position = 'absolute';
    modal.style.left = '0';
    modal.style.top = '0';
    modal.style.right = 'auto';
    modal.style.bottom = 'auto';
    modal.style.width = `${width}px`;
    modal.style.height = `${height}px`;
    // Do not set `display` inline; `.modal.hidden { display: none; }` must be able to hide it.
    modal.style.display = '';
    modal.style.alignItems = '';
    modal.style.justifyContent = '';
    modal.style.zIndex = '';
  }

  async init() {
    this.setupEventListeners();
    this.setupIpcListeners();
    // 서버 로드는 ready 이벤트 후에 수행
    // await this.loadServers();
    // Polling is resource-intensive, status is updated via IPC
    // this.startPolling(); 
  }

  async loadServers() {
    try {
      this.servers = await ipcRenderer.invoke('get-servers');
      this.renderServerList();
      this.updateStatusBar();
    } catch (error) {
      const statusText = document.getElementById('status-text');
      if(statusText) statusText.textContent = 'Error loading servers.';
    }
  }

  setupEventListeners() {
    const setTempStatus = (text, ttlMs = 2500) => {
      this.setStatusMessage(text, { ttlMs });
    };

    const openAddServerDeferred = () => {
      setTimeout(() => this.showAddServerModal(), 0);
    };

    const openSettingsDeferred = () => {
      setTimeout(() => this.showSettings(), 0);
    };

    // Ensure Add Server works even if click events are unreliable in some environments.
    document.addEventListener('pointerdown', (e) => {
      const addServerBtn = e.target.closest('#add-server-btn');
      if (!addServerBtn) return;
      e.preventDefault();
      e.stopPropagation();
      setTempStatus('Opening Add Server…', 1500);
      try {
        openAddServerDeferred();
      } catch (error) {
        this.setStatusMessage(`Add Server error: ${error?.message || error}`, { ttlMs: 8000 });
      }
    }, true);

    // Ensure Settings works even if click events are unreliable in some environments.
    document.addEventListener('pointerdown', (e) => {
      const settingsBtn = e.target.closest('#settings-btn');
      if (!settingsBtn) return;
      e.preventDefault();
      e.stopPropagation();
      setTempStatus('Opening Settings…', 1500);
      try {
        openSettingsDeferred();
      } catch (error) {
        this.setStatusMessage(`Settings error: ${error?.message || error}`, { ttlMs: 8000 });
      }
    }, true);

    // Use only event delegation for ALL buttons to avoid timing issues
    document.addEventListener('click', async (e) => {
      const buttonEl = e.target.closest('button');
      const buttonId = buttonEl?.id;
      if (!buttonId) return;

      if (buttonId === 'start-all-btn') {
        setTempStatus('Starting all servers…', 4000);
        try {
          // Optimistic UI: immediately reflect "starting" so buttons react right away.
          this.servers = this.servers.map(s => (
            this.isRunningLike(s.status) ? s : { ...s, status: 'starting' }
          ));
          this.renderServerList();
          this.updateStatusBar();

          const results = await ipcRenderer.invoke('start-all');
          await this.loadServers();
          const started = Array.isArray(results) ? results.filter(r => r && r.success && !r.skipped).length : 0;
          const skipped = Array.isArray(results) ? results.filter(r => r && r.skipped).length : 0;
          const failed = Array.isArray(results) ? results.filter(r => r && r.success === false && !r.skipped).length : 0;
          setTempStatus(`Start all: started ${started}, skipped ${skipped}, failed ${failed}`, 5000);
        } catch (error) {
          setTempStatus('Start all failed.', 6000);
          // Re-sync from main process state.
          await this.loadServers();
        }
      } else if (buttonId === 'stop-all-btn') {
        setTempStatus('Stopping all servers…', 4000);
        try {
          await ipcRenderer.invoke('stop-all');
          await this.loadServers();
          setTempStatus('Stopped all servers.', 3000);
        } catch (error) {
          setTempStatus('Stop all failed.', 6000);
        }
      } else if (buttonId === 'clear-all-btn') {
        e.preventDefault();
        e.stopPropagation();
        
        // Add busy state to prevent multiple clicks
        const button = buttonEl;
        if (!button || button.disabled) {
          return;
        }
        
        button.disabled = true;
        button.textContent = 'Clearing...';
        
        try {
          await this.clearAllServers();
        } catch (error) {
        } finally {
          button.disabled = false;
          button.innerHTML = `
            <svg viewBox="0 0 24 24">
              <path d="M19 4h-3.5l-1-1h-5l-1 1H5v2h14V4zM6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12z"/>
            </svg>
            Clear All
          `;
        }
      } else if (buttonId === 'settings-btn') {
        setTempStatus('Opening Settings…', 1500);
        openSettingsDeferred();
      } else if (buttonId === 'add-server-btn') {
        setTempStatus('Opening Add Server…', 1500);
        openAddServerDeferred();
      } else if (buttonId === 'delete-all-servers-btn') {
        e.preventDefault();
        e.stopPropagation();
        
        // Add busy state to prevent multiple clicks
        const button = buttonEl;
        if (!button || button.disabled) {
          return;
        }
        
        button.disabled = true;
        button.textContent = 'Deleting...';
        
        try {
          await this.clearAllServers();
        } catch (error) {
        } finally {
          button.disabled = false;
          button.innerHTML = `
            <svg viewBox="0 0 24 24">
              <path d="M19 4h-3.5l-1-1h-5l-1 1H5v2h14V4zM6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12z"/>
            </svg>
            Delete All Servers
          `;
        }
      }
    });
    
    this.setupModalEventListeners();
  }

  setupModalEventListeners() {
    // Server detail modal
    document.getElementById('close-detail')?.addEventListener('click', () => this.hideServerDetail());
    document.getElementById('server-detail')?.addEventListener('click', (e) => {
      if (e.target !== e.currentTarget) return;
      {
        if (this.justOpenedModal?.id === 'server-detail' && Date.now() - this.justOpenedModal.ts < 400) return;
        this.hideServerDetail();
      }
    });

    // Settings modal
    document.getElementById('close-settings')?.addEventListener('click', () => this.hideSettings());
    document.getElementById('settings-modal')?.addEventListener('click', (e) => {
      if (e.target !== e.currentTarget) return;
      {
        if (this.justOpenedModal?.id === 'settings-modal' && Date.now() - this.justOpenedModal.ts < 400) return;
        this.hideSettings();
      }
    });

    // Add Server modal
    document.getElementById('close-add-server')?.addEventListener('click', () => this.hideAddServerModal());
    document.getElementById('add-server-modal')?.addEventListener('click', (e) => {
      if (e.target !== e.currentTarget) return;
      {
        if (this.justOpenedModal?.id === 'add-server-modal' && Date.now() - this.justOpenedModal.ts < 400) return;
        this.hideAddServerModal();
      }
    });
    document.getElementById('browse-server-path-btn')?.addEventListener('click', async () => {
      const path = await ipcRenderer.invoke('select-folder');
      if (path) {
        document.getElementById('server-path').value = path;
      }
    });
    document.getElementById('save-add-server-btn')?.addEventListener('click', async () => {
      await this.saveServer();
    });
    document.getElementById('cancel-add-server-btn')?.addEventListener('click', () => this.hideAddServerModal());
    document.getElementById('browse-btn')?.addEventListener('click', async () => {
      const path = await ipcRenderer.invoke('select-folder');
      if (path) {
        document.getElementById('root-path').value = path;
      }
    });
    document.getElementById('save-settings-btn')?.addEventListener('click', async () => {
      const rootPath = document.getElementById('root-path').value;
      const runCommand = document.getElementById('run-command').value;
      const nodePath = document.getElementById('node-path').value;
      const npmPath = document.getElementById('npm-path').value;
      
      // 동적 설정 저장
      await ipcRenderer.invoke('save-dynamic-config', { rootPath, runCommand });
      
      // Node 경로 저장
      if (nodePath || npmPath) {
        await ipcRenderer.invoke('save-node-paths', { node: nodePath, npm: npmPath });
      }
      
      this.hideSettings();
      await this.loadServers(); // Refresh server list
    });
    document.getElementById('cancel-settings-btn')?.addEventListener('click', () => this.hideSettings());

    // Preset controls
    document.getElementById('preset-select')?.addEventListener('change', (e) => this.handlePresetSelect(e.target.value));
    document.getElementById('save-preset-btn')?.addEventListener('click', () => this.savePreset());
    document.getElementById('delete-preset-btn')?.addEventListener('click', () => this.deletePreset());

    // Node path controls
    document.getElementById('detect-paths-btn')?.addEventListener('click', async () => {
      await this.detectNodePaths();
    });

    // Server detail edit controls (legacy form - now hidden by default)
    document.getElementById('cancel-edit-btn')?.addEventListener('click', () => this.cancelEditingServer());
    document.getElementById('save-edit-btn')?.addEventListener('click', async () => {
      await this.saveServerChanges();
    });
    document.getElementById('browse-edit-path-btn')?.addEventListener('click', async () => {
      const path = await ipcRenderer.invoke('select-folder');
      if (path) {
        document.getElementById('edit-server-path').value = path;
      }
    });

    // Individual field editing event delegation - using closest() for better click detection
    document.addEventListener('click', async (e) => {
      // Find the closest button element (handles clicks on SVG/path inside buttons)
      const editBtn = e.target.closest('.edit-field-btn');
      const saveBtn = e.target.closest('.save-field-btn');
      const cancelBtn = e.target.closest('.cancel-field-btn');
      const browseBtn = e.target.closest('.browse-btn');

      if (editBtn) {
        e.preventDefault();
        e.stopPropagation();
        this.startFieldEditing(editBtn.dataset.field);
      } else if (saveBtn) {
        e.preventDefault();
        e.stopPropagation();
        await this.saveField(saveBtn.dataset.field);
      } else if (cancelBtn) {
        e.preventDefault();
        e.stopPropagation();
        this.cancelFieldEditing(cancelBtn.dataset.field);
      } else if (browseBtn && browseBtn.dataset.field) {
        e.preventDefault();
        e.stopPropagation();
        await this.browseForField(browseBtn.dataset.field);
      }
    });

    // Keyboard shortcuts for field editing
    document.addEventListener('keydown', (e) => {
      // Find the currently active field input
      const activeInput = document.querySelector('.field-editing .field-input:focus');
      
      if (activeInput) {
        const fieldName = activeInput.closest('.editable-field').id.replace('-field', '');
        
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.saveField(fieldName);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.cancelFieldEditing(fieldName);
          // Remove focus from input
          activeInput.blur();
        }
      }
    });

    // Global keydown
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideServerDetail();
        this.hideSettings();
        ipcRenderer.send('hide-window');
      }
    });
  }

  setupIpcListeners() {
    ipcRenderer.on('server-status-changed', (event, server) => {
      const index = this.servers.findIndex(s => s.id === server.id);
      if (index !== -1) {
        this.servers[index] = { ...this.servers[index], ...server };
        this.renderServerList();
        this.updateStatusBar();
        if (this.currentDetailServer && this.currentDetailServer.id === server.id) {
          this.updateServerDetail(this.servers[index]);
        }
      }
    });

    ipcRenderer.on('log-update', (event, { serverId, log }) => {
      if (this.currentDetailServer && this.currentDetailServer.id === serverId) {
        this.appendLog(log);
      }
    });

    ipcRenderer.on('navigate', (event, page) => {
      if (page === 'settings') {
        this.showSettings();
      }
    });

  }

  renderServerList() {
    const container = document.getElementById('server-list');
    if (!container) return;
    container.innerHTML = '';

    // Add Server 버튼과 Delete All Server 버튼 항상 표시 (이벤트 리스너는 setupEventListeners에서 delegation 방식으로 처리)
    const addServerSection = document.createElement('div');
    addServerSection.className = 'add-server-section';
    addServerSection.innerHTML = `
      <button type="button" class="action-button primary" id="add-server-btn">
        <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
        Add Server
      </button>
      <button type="button" class="action-button danger" id="delete-all-servers-btn">
        <svg viewBox="0 0 24 24"><path d="M19 4h-3.5l-1-1h-5l-1 1H5v2h14V4zM6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12z"/></svg>
        Delete All Servers
      </button>
    `;
    container.appendChild(addServerSection);

    if (!this.servers || this.servers.length === 0) {
      const emptyState = document.createElement('div');
      emptyState.className = 'empty-state';
      emptyState.innerHTML = `<p>No servers configured.</p>`;
      container.appendChild(emptyState);
    }

    this.servers.forEach(server => {
      const item = document.createElement('div');
      item.className = 'server-item';
      const status = this.normalizeStatus(server.status) || 'stopped';
      item.innerHTML = `
        <div class="server-status ${status}"></div>
        <div class="server-info">
          <div class="server-name">
            ${server.name}
          </div>
          <div class="server-details">
            ${server.actualPort ? `<span>Port: ${server.actualPort}</span>` : ''}
            ${status === 'running' ? `<span>• Uptime: ${server.uptime || '0m'}</span>` : ''}
            ${status === 'running' && server.cpu !== null ? `<span>• CPU: ${server.cpu}%</span>` : ''}
            ${status === 'running' && server.memory !== null ? `<span>• Mem: ${server.memory}MB</span>` : ''}
            ${status === 'error' ? `<span class="error-text">• ${server.error || 'Unknown error'}</span>` : ''}
          </div>
        </div>
        <div class="server-actions">
          ${status === 'stopped' || status === 'error' ? `
            <button data-action="start" data-server-id="${server.id}" title="Start">
              <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            </button>
          ` : `
            <button data-action="restart" data-server-id="${server.id}" title="Restart">
              <svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            </button>
            <button data-action="stop" data-server-id="${server.id}" title="Stop">
              <svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>
            </button>
          `}
          <button data-action="info" data-server-id="${server.id}" title="Details">
            <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
          </button>
          <button data-action="delete" data-server-id="${server.id}" title="Delete Server" class="delete-btn">
            <svg viewBox="0 0 24 24"><path d="M19 4h-3.5l-1-1h-5l-1 1H5v2h14V4zM6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12z"/></svg>
          </button>
        </div>
      `;

      item.querySelectorAll('.server-actions button').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.handleServerAction(btn.dataset.action, btn.dataset.serverId);
        });
      });

      item.addEventListener('click', () => this.showServerDetail(server));
      container.appendChild(item);
    });
  }

  async handleServerAction(action, serverId) {
    try {
      if (action === 'info') {
        const server = this.servers.find(s => s.id === serverId);
        this.showServerDetail(server);
      } else if (action === 'delete') {
        const server = this.servers.find(s => s.id === serverId);
        if (server && confirm(`Are you sure you want to delete "${server.name}"?`)) {
          await ipcRenderer.invoke('delete-server', serverId);
          await this.loadServers();
        }
      } else {
        if (action === 'start') {
          this.setServerLocalStatus(serverId, 'starting');
        } else if (action === 'restart') {
          this.setServerLocalStatus(serverId, 'restarting');
        } else if (action === 'stop') {
          this.setServerLocalStatus(serverId, 'stopped');
        }

        await ipcRenderer.invoke(`${action}-server`, serverId);
      }
    } catch (error) {
      if (action === 'delete') {
        alert('Failed to delete server.');
      } else {
        // Re-sync from main process state on failures.
        await this.loadServers();
      }
    }
  }

  async showServerDetail(server) {
    this.currentDetailServer = server;
    document.getElementById('detail-server-name').textContent = server.name;
    document.getElementById('detail-name').textContent = server.name;
    document.getElementById('detail-path').textContent = server.path;
    document.getElementById('detail-script').textContent = server.command; // Use command
    document.getElementById('detail-actual-port').textContent = server.actualPort ? `${server.actualPort} ⚡` : '-';
    this.updateServerDetail(server);

    // Reset to view mode
    this.cancelEditingServer();

    const openBrowserBtn = document.getElementById('open-browser-btn');
    openBrowserBtn.onclick = () => ipcRenderer.invoke('open-browser', server.actualPort);
    openBrowserBtn.disabled = !server.actualPort;

    document.getElementById('open-terminal-btn').onclick = () => ipcRenderer.invoke('open-terminal', server.path);

    await this.loadServerLogs(server.id);
    document.getElementById('server-detail').classList.remove('hidden');
    
    // 윈도우 크기 조정을 위해 main process에 알림
    setTimeout(() => {
      ipcRenderer.send('window-content-changed');
    }, 100);
  }

  hideServerDetail() {
    document.getElementById('server-detail').classList.add('hidden');
    this.currentDetailServer = null;
    
    // 윈도우 크기 조정을 위해 main process에 알림
    setTimeout(() => {
      ipcRenderer.send('window-content-changed');
    }, 100);
  }

  updateServerDetail(server) {
    if (!this.currentDetailServer || this.currentDetailServer.id !== server.id) return;
    document.getElementById('detail-pid').textContent = server.pid || '-';
    document.getElementById('detail-actual-port').textContent = server.actualPort ? `${server.actualPort} ⚡` : '-';

    // Detail 화면에서는 초단위까지 표시
    const detailedUptime = server.startTime ? this.calculateUptimeWithSeconds(server.startTime) : '-';
    document.getElementById('detail-uptime').textContent = detailedUptime;

    document.getElementById('detail-cpu').textContent = server.cpu !== null ? `${server.cpu}%` : '-';
    document.getElementById('detail-memory').textContent = server.memory !== null ? `${server.memory}MB` : '-';

    // Open Browser 버튼 상태도 업데이트
    const openBrowserBtn = document.getElementById('open-browser-btn');
    if (openBrowserBtn) {
      openBrowserBtn.disabled = !server.actualPort;
    }
  }

  calculateUptimeWithSeconds(startTime) {
    if (!startTime) return '-';
    const diff = Date.now() - new Date(startTime).getTime();
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  async loadServerLogs(serverId) {
    const container = document.getElementById('log-container');
    container.innerHTML = '';
    const logs = await ipcRenderer.invoke('get-logs', serverId);
    if (logs.length === 0) {
      container.innerHTML = '<div class="log-empty-state">No logs available</div>';
      return;
    }
    logs.slice(-100).forEach(log => this.appendLog(log, container));
    container.scrollTop = container.scrollHeight;
  }

  appendLog(log, container = document.getElementById('log-container')) {
    if (!container) return;
    const wasScrolledToBottom = container.scrollHeight - container.clientHeight <= container.scrollTop + 1;

    const entry = document.createElement('div');
    entry.className = 'log-entry';
    const timeStr = new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false });
    entry.innerHTML = `
      <span class="log-time">${timeStr}</span>
      <span class="log-level ${log.level}">[${log.level}]</span>
      <span class="log-message">${this.escapeHtml(log.message)}</span>
    `;
    container.appendChild(entry);
    if (container.children.length > 200) { // Keep more logs
      container.removeChild(container.firstChild);
    }
    if (wasScrolledToBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }

  updateStatusBar() {
    const runningCount = this.servers.filter(s => this.isRunningLike(s.status)).length;
    const totalCount = this.servers.length;
    const startAllBtn = document.getElementById('start-all-btn');
    const stopAllBtn = document.getElementById('stop-all-btn');
    if (startAllBtn) startAllBtn.disabled = totalCount === 0 || runningCount === totalCount;
    if (stopAllBtn) stopAllBtn.disabled = runningCount === 0;

    // Keep buttons responsive even when status text is temporarily locked.
    if (Date.now() < (this.statusLockUntil || 0)) {
      return;
    }
    const statusText = document.getElementById('status-text');
    if (statusText) {
      statusText.textContent = `${runningCount} of ${totalCount} services running`;
    }
  }

  setStatusMessage(text, { ttlMs = 2500 } = {}) {
    const statusText = document.getElementById('status-text');
    if (!statusText) return;
    statusText.textContent = text;
    this.statusLockUntil = Date.now() + ttlMs;
  }

  async showSettings() {
    try {
      const modal = document.getElementById('settings-modal');
      const rootPathEl = document.getElementById('root-path');
      const runCommandEl = document.getElementById('run-command');
      const nodePathEl = document.getElementById('node-path');
      const npmPathEl = document.getElementById('npm-path');

      if (!modal || !rootPathEl || !runCommandEl || !nodePathEl || !npmPathEl) {
        throw new Error('Settings modal elements not found');
      }

      const config = await ipcRenderer.invoke('get-dynamic-config');
      rootPathEl.value = config?.rootPath || '';
      runCommandEl.value = config?.runCommand || '';
      
      // Node 경로 로드
      const nodePaths = await ipcRenderer.invoke('get-node-paths');
      nodePathEl.value = nodePaths?.node || '';
      npmPathEl.value = nodePaths?.npm || '';
      
      await this.loadPresets();
      modal.classList.remove('hidden');
      this.forceModalLayout(modal);
      this.justOpenedModal = { id: 'settings-modal', ts: Date.now() };
      rootPathEl.focus();
    } catch (error) {
      this.setStatusMessage('Failed to open Settings modal.', { ttlMs: 6000 });
    }
  }

  hideSettings() {
    document.getElementById('settings-modal').classList.add('hidden');
  }

  async loadPresets() {
    const presets = await ipcRenderer.invoke('get-presets');
    const select = document.getElementById('preset-select');
    select.innerHTML = '<option value="">Select a preset</option>';
    for (const name in presets) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    }
  }

  async handlePresetSelect(name) {
    if (!name) return;
    const presets = await ipcRenderer.invoke('get-presets');
    const config = presets[name];
    if (config) {
      document.getElementById('root-path').value = config.rootPath;
      document.getElementById('run-command').value = config.runCommand;
    }
  }

  async savePreset() {
    const name = prompt('Enter a name for this preset:');
    if (!name) return;

    const rootPath = document.getElementById('root-path').value;
    const runCommand = document.getElementById('run-command').value;
    const config = { rootPath, runCommand };

    await ipcRenderer.invoke('save-preset', { name, config });
    await this.loadPresets();
    document.getElementById('preset-select').value = name;
  }

  async deletePreset() {
    const select = document.getElementById('preset-select');
    const name = select.value;
    if (!name) {
      alert('Please select a preset to delete.');
      return;
    }

    if (confirm(`Are you sure you want to delete the preset "${name}"?`)) {
      await ipcRenderer.invoke('delete-preset', name);
      await this.loadPresets();
      document.getElementById('root-path').value = '';
      document.getElementById('run-command').value = '';
    }
  }

  showAddServerModal() {
    try {
      const modal = document.getElementById('add-server-modal');
      const nameInput = document.getElementById('server-name');
      const pathInput = document.getElementById('server-path');
      const commandInput = document.getElementById('server-command');

      if (!modal || !nameInput || !pathInput || !commandInput) {
        throw new Error('Add Server modal elements not found');
      }

      nameInput.value = '';
      pathInput.value = '';
      commandInput.value = '';
      modal.classList.remove('hidden');
      this.forceModalLayout(modal);
      this.justOpenedModal = { id: 'add-server-modal', ts: Date.now() };
      nameInput.focus();
    } catch (error) {
      this.setStatusMessage('Failed to open Add Server modal.', { ttlMs: 6000 });
    }
  }

  hideAddServerModal() {
    document.getElementById('add-server-modal').classList.add('hidden');
  }

  async saveServer() {
    const name = document.getElementById('server-name').value.trim();
    const path = document.getElementById('server-path').value.trim();
    const command = document.getElementById('server-command').value.trim();

    if (!name || !path || !command) {
      alert('Please fill in all required fields (Name, Path, Command).');
      return;
    }

    const serverConfig = {
      id: name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
      name,
      path,
      command
    };

    try {
      await ipcRenderer.invoke('add-manual-server', serverConfig);
      this.hideAddServerModal();
      await this.loadServers();
    } catch (error) {
      alert('Failed to add server.');
    }
  }

  async clearAllServers() {
    const serverCount = this.servers ? this.servers.length : 0;
    
    if (serverCount === 0) {
      alert('No servers to clear.');
      return;
    }

    const userConfirmed = confirm(`Are you sure you want to delete all ${serverCount} servers?\n\nThis action cannot be undone.`);
    
    if (userConfirmed) {
      try {
        await ipcRenderer.invoke('clear-all-servers');
        await this.loadServers();
      } catch (error) {
        alert('Failed to clear all servers.');
      }
    }
  }

  async detectNodePaths() {
    const button = document.getElementById('detect-paths-btn');
    const originalText = button.textContent;
    
    try {
      button.disabled = true;
      button.textContent = 'Detecting...';
      
      const paths = await ipcRenderer.invoke('detect-node-paths');
      
      if (paths.node) {
        document.getElementById('node-path').value = paths.node;
      }
      if (paths.npm) {
        document.getElementById('npm-path').value = paths.npm;
      }
      
      if (paths.node || paths.npm) {
        alert('Node.js paths detected successfully!');
      } else {
        alert('Could not auto-detect Node.js paths. Please set them manually.');
      }
    } catch (error) {
      alert('Failed to detect Node.js paths. Please set them manually.');
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  startEditingServer() {
    if (!this.currentDetailServer) return;

    // 편집 폼에 현재 값들 채우기
    document.getElementById('edit-server-name').value = this.currentDetailServer.name;
    document.getElementById('edit-server-path').value = this.currentDetailServer.path;
    document.getElementById('edit-server-command').value = this.currentDetailServer.command;
    document.getElementById('edit-server-port').value = this.currentDetailServer.port || '';

    // 뷰 모드 숨기고 편집 모드 표시
    document.getElementById('detail-view').classList.add('hidden');
  }

  cancelEditingServer() {
    // 편집 모드 숨기고 뷰 모드 표시
    document.getElementById('detail-view').classList.remove('hidden');
  }

  async saveServerChanges() {
    if (!this.currentDetailServer) return;

    const name = document.getElementById('edit-server-name').value.trim();
    const path = document.getElementById('edit-server-path').value.trim();
    const command = document.getElementById('edit-server-command').value.trim();
    const port = document.getElementById('edit-server-port').value.trim();

    if (!name || !path || !command) {
      alert('Please fill in all required fields (Name, Path, Command).');
      return;
    }

    const updatedServer = {
      id: this.currentDetailServer.id,
      name,
      path,
      command,
      port: port ? parseInt(port) : null
    };

    try {
      const result = await ipcRenderer.invoke('update-server', updatedServer);
      if (result.success) {
        // 서버 목록 새로고침
        await this.loadServers();
        
        // 업데이트된 서버 정보로 상세 화면 갱신
        const updatedServerFromList = this.servers.find(s => s.id === this.currentDetailServer.id);
        if (updatedServerFromList) {
          this.currentDetailServer = updatedServerFromList;
          document.getElementById('detail-server-name').textContent = updatedServerFromList.name;
          document.getElementById('detail-name').textContent = updatedServerFromList.name;
          document.getElementById('detail-path').textContent = updatedServerFromList.path;
          document.getElementById('detail-script').textContent = updatedServerFromList.command;
          document.getElementById('detail-actual-port').textContent = updatedServerFromList.actualPort ? `${updatedServerFromList.actualPort} ⚡` : '-';
        }
        
        // 편집 모드 종료
        this.cancelEditingServer();
      } else {
        alert('Failed to update server: ' + (result.error || 'Unknown error'));
      }
    } catch (error) {
      alert('Failed to update server.');
    }
  }

  // Individual field editing methods
  startFieldEditing(fieldName) {
    if (!this.currentDetailServer) return;

    // Cancel any other field editing
    this.cancelAllFieldEditing();

    const field = document.getElementById(`${fieldName}-field`);
    if (!field) return;

    // Add editing class to detail view
    document.getElementById('detail-view').classList.add('editing');
    field.classList.add('field-editing');

    // Show edit controls and hide value
    const editControls = field.querySelector('.edit-controls');
    const editButton = field.querySelector('.edit-field-btn');
    
    editControls.style.display = 'flex';
    editButton.style.display = 'none';

    // Set current value in the input
    const input = field.querySelector('.field-input');
    let currentValue = '';
    
    switch (fieldName) {
      case 'name':
        currentValue = this.currentDetailServer.name || '';
        break;
      case 'path':
        currentValue = this.currentDetailServer.path || '';
        break;
      case 'command':
        currentValue = this.currentDetailServer.command || '';
        break;
      case 'port':
        currentValue = this.currentDetailServer.port || '';
        break;
    }
    
    input.value = currentValue;
    input.focus();
    input.select();
  }

  async saveField(fieldName) {
    if (!this.currentDetailServer) return;

    const field = document.getElementById(`${fieldName}-field`);
    if (!field) return;

    const input = field.querySelector('.field-input');
    const newValue = input.value.trim();

    // Validation
    if (fieldName === 'name' && !newValue) {
      alert('Name cannot be empty');
      return;
    }
    if (fieldName === 'path' && !newValue) {
      alert('Path cannot be empty');
      return;
    }
    if (fieldName === 'command' && !newValue) {
      alert('Command cannot be empty');
      return;
    }

    // Create update object with only the changed field
    const updatedServer = {
      id: this.currentDetailServer.id,
      name: this.currentDetailServer.name,
      path: this.currentDetailServer.path,
      command: this.currentDetailServer.command,
      port: this.currentDetailServer.port
    };

    // Update the specific field
    switch (fieldName) {
      case 'name':
        updatedServer.name = newValue;
        break;
      case 'path':
        updatedServer.path = newValue;
        break;
      case 'command':
        updatedServer.command = newValue;
        break;
      case 'port':
        updatedServer.port = newValue ? parseInt(newValue) : null;
        break;
    }

    try {
      // Save button loading state
      const saveButton = field.querySelector('.save-field-btn');
      const originalSaveHtml = saveButton.innerHTML;
      saveButton.innerHTML = NOW_SAVING_SPAN
      saveButton.disabled = true;

      const result = await ipcRenderer.invoke('update-server', updatedServer);
      
      if (result.success) {
        // Update current server object
        this.currentDetailServer = { ...this.currentDetailServer, ...updatedServer };
        
        // Update the display value
        const displayElement = document.getElementById(`detail-${fieldName === 'command' ? 'script' : fieldName}`);
        if (displayElement) {
          if (fieldName === 'port') {
            displayElement.textContent = updatedServer.port || 'N/A';
          } else {
            displayElement.textContent = updatedServer[fieldName];
          }
        }

        // Update header name if name was changed
        if (fieldName === 'name') {
          document.getElementById('detail-server-name').textContent = updatedServer.name;
        }

        // Refresh server list to reflect changes
        await this.loadServers();
        
        // Cancel editing
        this.cancelFieldEditing(fieldName);
        // Button restore
        this.restoreButtonHtml(saveButton, originalSaveHtml);
      } else {
        alert('Failed to update server: ' + (result.error || 'Unknown error'));
      }
    } catch (error) {
      alert(`Failed to update ${fieldName}.`);
    }
  }

  cancelFieldEditing(fieldName) {
    const field = document.getElementById(`${fieldName}-field`);
    if (!field) return;

    // Hide edit controls and show edit button
    const editControls = field.querySelector('.edit-controls');
    const editButton = field.querySelector('.edit-field-btn');
    
    editControls.style.display = 'none';
    editButton.style.display = 'flex';

    // Remove editing classes
    field.classList.remove('field-editing');
    
    // Check if any fields are still being edited
    const detailView = document.getElementById('detail-view');
    const stillEditing = detailView.querySelector('.field-editing');
    if (!stillEditing) {
      detailView.classList.remove('editing');
    }
  }

  cancelAllFieldEditing() {
    const editingFields = document.querySelectorAll('.field-editing');
    editingFields.forEach(field => {
      const fieldName = field.id.replace('-field', '');
      this.cancelFieldEditing(fieldName);
    });
  }

  async browseForField(fieldName) {
    if (fieldName === 'path') {
      const path = await ipcRenderer.invoke('select-folder');
      if (path) {
        const input = document.getElementById('edit-path-input');
        input.value = path;
      }
    }
  }

  escapeHtml(text = '') {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.replace(/[&<>"']/g, m => map[m]);
  }

  restoreButtonHtml(saveButton, originalSaveHtml) {
    saveButton.innerHTML = originalSaveHtml;
    if (saveButton.disabled) {
      saveButton.disabled = false;
    }
  }
}

const app = new App();

// DOM이 완전히 로드된 후 앱 초기화
window.addEventListener('DOMContentLoaded', async () => {
  await app.init();
});

ipcRenderer.on('ready', async () => {
  // IPC 핸들러가 준비되었으므로 서버 목록을 로드
  await app.loadServers();
});


// Reload server list when window is shown
ipcRenderer.on('show', () => {
  app.loadServers();
});

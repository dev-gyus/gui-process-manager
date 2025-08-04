const { ipcRenderer } = require("electron");

class App {
  constructor() {
    this.servers = [];
    this.currentDetailServer = null;
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
      console.error('Failed to load servers:', error);
      const statusText = document.getElementById('status-text');
      if(statusText) statusText.textContent = 'Error loading servers.';
    }
  }

  setupEventListeners() {
    // Use only event delegation for ALL buttons to avoid timing issues
    document.addEventListener('click', async (e) => {
      if (e.target.id === 'start-all-btn') {
        await ipcRenderer.invoke('start-all');
      } else if (e.target.id === 'stop-all-btn') {
        await ipcRenderer.invoke('stop-all');
      } else if (e.target.id === 'clear-all-btn') {
        e.preventDefault();
        e.stopPropagation();
        
        // Add busy state to prevent multiple clicks
        const button = e.target;
        if (button.disabled) {
          return;
        }
        
        button.disabled = true;
        button.textContent = 'Clearing...';
        
        try {
          await this.clearAllServers();
        } catch (error) {
          console.error('clearAllServers failed:', error);
        } finally {
          button.disabled = false;
          button.innerHTML = `
            <svg viewBox="0 0 24 24">
              <path d="M19 4h-3.5l-1-1h-5l-1 1H5v2h14V4zM6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12z"/>
            </svg>
            Clear All
          `;
        }
      } else if (e.target.id === 'settings-btn') {
        await this.showSettings();
      } else if (e.target.id === 'add-server-btn') {
        this.showAddServerModal();
      } else if (e.target.id === 'go-to-settings') {
        e.preventDefault();
        await this.showSettings();
      }
    });
    
    this.setupModalEventListeners();
  }

  setupModalEventListeners() {
    // Server detail modal
    document.getElementById('close-detail')?.addEventListener('click', () => this.hideServerDetail());
    document.getElementById('server-detail')?.addEventListener('click', (e) => {
      if (e.target.id === 'server-detail') this.hideServerDetail();
    });

    // Settings modal
    document.getElementById('close-settings')?.addEventListener('click', () => this.hideSettings());
    document.getElementById('settings-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'settings-modal') this.hideSettings();
    });

    // Add Server modal
    document.getElementById('close-add-server')?.addEventListener('click', () => this.hideAddServerModal());
    document.getElementById('add-server-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'add-server-modal') this.hideAddServerModal();
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

    // Server detail edit controls
    document.getElementById('edit-server-btn')?.addEventListener('click', () => this.startEditingServer());
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

    // Add Server 버튼 항상 표시
    const addServerSection = document.createElement('div');
    addServerSection.className = 'add-server-section';
    addServerSection.innerHTML = `
      <button class="action-button primary" id="add-server-btn">
        <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
        Add Server
      </button>
    `;
    container.appendChild(addServerSection);

    if (!this.servers || this.servers.length === 0) {
      const emptyState = document.createElement('div');
      emptyState.className = 'empty-state';
      emptyState.innerHTML = `
        <p>No servers configured.</p>
        <a href="#" id="go-to-settings">Configure Project Folder</a>
      `;
      container.appendChild(emptyState);
    }

    this.servers.forEach(server => {
      const item = document.createElement('div');
      item.className = 'server-item';
      const status = server.status || 'stopped';
      item.innerHTML = `
        <div class="server-status ${status}"></div>
        <div class="server-info">
          <div class="server-name">${server.name}</div>
          <div class="server-details">
            ${server.port ? `<span>Port: ${server.port}</span>` : ''}
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
        await ipcRenderer.invoke(`${action}-server`, serverId);
      }
    } catch (error) {
      console.error(`Failed to ${action} server:`, error);
      if (action === 'delete') {
        alert('Failed to delete server. Please check the console for details.');
      }
    }
  }

  async showServerDetail(server) {
    this.currentDetailServer = server;
    document.getElementById('detail-server-name').textContent = server.name;
    document.getElementById('detail-name').textContent = server.name;
    document.getElementById('detail-path').textContent = server.path;
    document.getElementById('detail-script').textContent = server.command; // Use command
    document.getElementById('detail-port').textContent = server.port || 'N/A';
    this.updateServerDetail(server);

    // Reset to view mode
    this.cancelEditingServer();

    const openBrowserBtn = document.getElementById('open-browser-btn');
    openBrowserBtn.onclick = () => ipcRenderer.invoke('open-browser', server.port);
    openBrowserBtn.disabled = !server.port;

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
    document.getElementById('detail-port').textContent = server.port || 'N/A';
    
    // Detail 화면에서는 초단위까지 표시
    const detailedUptime = server.startTime ? this.calculateUptimeWithSeconds(server.startTime) : '-';
    document.getElementById('detail-uptime').textContent = detailedUptime;
    
    document.getElementById('detail-cpu').textContent = server.cpu !== null ? `${server.cpu}%` : '-';
    document.getElementById('detail-memory').textContent = server.memory !== null ? `${server.memory}MB` : '-';
    
    // Open Browser 버튼 상태도 업데이트
    const openBrowserBtn = document.getElementById('open-browser-btn');
    if (openBrowserBtn) {
      openBrowserBtn.disabled = !server.port;
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
    const runningCount = this.servers.filter(s => s.status === 'running').length;
    const totalCount = this.servers.length;
    document.getElementById('status-text').textContent = `${runningCount} of ${totalCount} services running`;
    document.getElementById('start-all-btn').disabled = runningCount === totalCount && totalCount > 0;
    document.getElementById('stop-all-btn').disabled = runningCount === 0;
  }

  async showSettings() {
    const config = await ipcRenderer.invoke('get-dynamic-config');
    document.getElementById('root-path').value = config.rootPath;
    document.getElementById('run-command').value = config.runCommand;
    
    // Node 경로 로드
    const nodePaths = await ipcRenderer.invoke('get-node-paths');
    document.getElementById('node-path').value = nodePaths.node || '';
    document.getElementById('npm-path').value = nodePaths.npm || '';
    
    await this.loadPresets();
    document.getElementById('settings-modal').classList.remove('hidden');
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
    document.getElementById('server-name').value = '';
    document.getElementById('server-path').value = '';
    document.getElementById('server-command').value = '';
    document.getElementById('server-port').value = '';
    document.getElementById('add-server-modal').classList.remove('hidden');
  }

  hideAddServerModal() {
    document.getElementById('add-server-modal').classList.add('hidden');
  }

  async saveServer() {
    const name = document.getElementById('server-name').value.trim();
    const path = document.getElementById('server-path').value.trim();
    const command = document.getElementById('server-command').value.trim();
    const port = document.getElementById('server-port').value.trim();

    if (!name || !path || !command) {
      alert('Please fill in all required fields (Name, Path, Command).');
      return;
    }

    const serverConfig = {
      id: name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
      name,
      path,
      command,
      port: port ? parseInt(port) : null
    };

    try {
      await ipcRenderer.invoke('add-manual-server', serverConfig);
      this.hideAddServerModal();
      await this.loadServers();
    } catch (error) {
      console.error('Failed to add server:', error);
      alert('Failed to add server. Please check the console for details.');
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
        console.error('Failed to clear all servers:', error);
        alert('Failed to clear all servers. Please check the console for details.');
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
      console.error('Failed to detect node paths:', error);
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
    document.getElementById('detail-edit-form').classList.remove('hidden');
    document.getElementById('edit-server-btn').style.display = 'none';
  }

  cancelEditingServer() {
    // 편집 모드 숨기고 뷰 모드 표시
    document.getElementById('detail-view').classList.remove('hidden');
    document.getElementById('detail-edit-form').classList.add('hidden');
    document.getElementById('edit-server-btn').style.display = 'block';
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
          document.getElementById('detail-port').textContent = updatedServerFromList.port || 'N/A';
        }
        
        // 편집 모드 종료
        this.cancelEditingServer();
      } else {
        alert('Failed to update server: ' + (result.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('Failed to update server:', error);
      alert('Failed to update server. Please check the console for details.');
    }
  }

  escapeHtml(text = '') {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.replace(/[&<>"']/g, m => map[m]);
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

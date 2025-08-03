import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, shell, Tray, dialog } from "electron";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import ServerManager from "./serverManager.js";
import Store from "electron-store";

import { exec } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class MSAServerManager {
  constructor() {
    this.tray = null;
    this.window = null;
    this.serverManager = new ServerManager();
    this.store = new Store();

    // 기본 서버 설정
    this.initializeServers();
  }

  async initializeServers() {
    const dynamicConfig = this.store.get('dynamicConfig');
    if (dynamicConfig && dynamicConfig.rootPath) {
      try {
        // 지정된 폴더 자체를 하나의 서버로 추가
        const folderName = path.basename(dynamicConfig.rootPath);
        const servers = [{
          id: folderName,
          name: folderName.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
          path: dynamicConfig.rootPath,
          command: dynamicConfig.runCommand || 'npm start',
        }];
        this.serverManager.loadServers(servers);
      } catch (error) {
        console.error('Failed to load servers from dynamic config:', error);
        this.serverManager.loadServers([]); // 에러 발생 시 빈 목록으로 시작
      }
    } else {
      // 동적 설정이 없으면 빈 목록으로 시작
      this.serverManager.loadServers([]);
    }
  }

  createTray() {
    // 트레이 아이콘 생성 (16x16 템플릿 이미지 권장)
    const iconPath = path.join(__dirname, '../assets/icon.png');
    const icon = nativeImage.createFromPath(iconPath);

    this.tray = new Tray(icon.resize({ width: 16, height: 16 }));
    this.tray.setToolTip('MSA Server Manager');

    // 트레이 클릭 이벤트
    this.tray.on('click', async () => {
      await this.toggleWindow();
    });

    this.tray.on('right-click', () => {
      this.showContextMenu();
    });

    // 초기 메뉴 업데이트
    this.updateTrayIcon();
  }

  async createWindow() {
    this.window = new BrowserWindow({
      width: 400,
      height: 600,
      show: false,
      frame: false,
      resizable: false,
      transparent: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        webSecurity: false
      }
    });

    this.window.webContents.on('did-finish-load', () => {
      this.window.webContents.send('ready');
    });

    await this.window.loadFile(path.join(__dirname, 'renderer/index.html'));

    // 윈도우가 포커스를 잃으면 숨기기
    this.window.on('blur', () => {
      this.window.hide();
    });

    // 개발 모드에서 DevTools 열기
    if (process.argv.includes('--dev')) {
      this.window.webContents.openDevTools({ mode: 'detach' });
    }
  }

  async toggleWindow() {
    if (!this.window) {
      await this.createWindow();
    }

    if (this.window.isVisible()) {
      this.window.hide();
    } else {
      this.showWindow();
    }
  }

  showWindow() {
    const position = this.getWindowPosition();
    this.window.setPosition(position.x, position.y, false);
    this.window.show();
    this.window.focus();
  }

  getWindowPosition() {
    const windowBounds = this.window.getBounds();
    const trayBounds = this.tray.getBounds();

    // macOS에서 트레이 아이콘 아래에 윈도우 위치시키기
    const x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
    const y = Math.round(trayBounds.y + trayBounds.height + 4);

    return { x, y };
  }

  showContextMenu() {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Start All Servers',
        click: () => this.serverManager.startAll(),
        enabled: !this.serverManager.areAllRunning()
      },
      {
        label: 'Stop All Servers',
        click: () => this.serverManager.stopAll(),
        enabled: this.serverManager.hasRunningServers()
      },
      { type: 'separator' },
      {
        label: 'Settings',
        click: () => {
          this.showWindow();
          this.window.webContents.send('navigate', 'settings');
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: async () => {
          await this.serverManager.stopAll();
          app.quit();
        }
      }
    ]);

    this.tray.popUpContextMenu(contextMenu);
  }

  updateTrayIcon() {
    const runningCount = this.serverManager.getRunningServers().length;
    const totalCount = this.serverManager.getAllServers().length;

    // 아이콘 색상 변경 (항상 icon.png 사용)
    const iconName = 'icon.png';
    const iconPath = path.join(__dirname, '../assets', iconName);
    const icon = nativeImage.createFromPath(iconPath);

    this.tray.setImage(icon.resize({ width: 16, height: 16 }));
    this.tray.setToolTip(`MSA Server Manager (${runningCount}/${totalCount} running)`);
  }

  refreshWindowFrame() {
    if (!this.window) return;
    
    // 윈도우 프레임을 강제로 새로고침하여 크기 변경을 반영
    const currentBounds = this.window.getBounds();
    
    // 작은 크기 변경을 통해 프레임 새로고침 트리거
    this.window.setBounds({
      ...currentBounds,
      width: currentBounds.width + 1
    });
    
    // 즉시 원래 크기로 되돌림
    setTimeout(() => {
      this.window.setBounds(currentBounds);
    }, 10);
  }

  setupIpcHandlers() {
    // 폴더 선택 대화상자
    ipcMain.handle('select-folder', async () => {
      const result = await dialog.showOpenDialog(this.window, {
        properties: ['openDirectory']
      });
      if (result.canceled) {
        return null;
      } else {
        return result.filePaths[0];
      }
    });

    // 동적 설정 가져오기
    ipcMain.handle('get-dynamic-config', () => {
      return this.store.get('dynamicConfig', {
        rootPath: '',
        runCommand: 'npm start'
      });
    });

    // 동적 설정 저장 및 서버 리로드
    ipcMain.handle('save-dynamic-config', async (event, config) => {
      this.store.set('dynamicConfig', config);
      await this.initializeServers(); // 설정을 저장하고 서버 목록을 다시 로드
      return true;
    });

    // 프리셋 가져오기
    ipcMain.handle('get-presets', () => {
      return this.store.get('presets', {});
    });

    // 프리셋 저장
    ipcMain.handle('save-preset', (event, { name, config }) => {
      const presets = this.store.get('presets', {});
      presets[name] = config;
      this.store.set('presets', presets);
      return true;
    });

    // 프리셋 삭제
    ipcMain.handle('delete-preset', (event, name) => {
      const presets = this.store.get('presets', {});
      delete presets[name];
      this.store.set('presets', presets);
      return true;
    });

    // 서버 상태 가져오기
    ipcMain.handle('get-servers', () => {
      return this.serverManager.getAllServers();
    });

    // 서버 시작
    ipcMain.handle('start-server', async (event, serverId) => {
      const result = await this.serverManager.startServer(serverId);
      this.updateTrayIcon();
      return result;
    });

    // 서버 중지
    ipcMain.handle('stop-server', async (event, serverId) => {
      const result = await this.serverManager.stopServer(serverId);
      this.updateTrayIcon();
      return result;
    });

    // 서버 재시작
    ipcMain.handle('restart-server', async (event, serverId) => {
      const result = await this.serverManager.restartServer(serverId);
      this.updateTrayIcon();
      return result;
    });

    // 모든 서버 시작
    ipcMain.handle('start-all', async () => {
      const result = await this.serverManager.startAll();
      this.updateTrayIcon();
      return result;
    });

    // 모든 서버 중지
    ipcMain.handle('stop-all', async () => {
      const result = await this.serverManager.stopAll();
      this.updateTrayIcon();
      return result;
    });

    // 로그 가져오기
    ipcMain.handle('get-logs', (event, serverId) => {
      return this.serverManager.getLogs(serverId);
    });

    // 브라우저에서 열기
    ipcMain.handle('open-browser', async (event, port) => {
      if (!port) return;
      await shell.openExternal(`http://localhost:${port}`);
    });

    // 터미널에서 열기
    ipcMain.handle('open-terminal', (event, path) => {
      exec(`open -a Terminal "${path}"`);
    });

    // 윈도우 숨기기
    ipcMain.on('hide-window', () => {
      this.window.hide();
    });

    // 윈도우 컨텐츠 변경 알림 처리
    ipcMain.on('window-content-changed', () => {
      this.refreshWindowFrame();
    });

    // 수동 서버 추가
    ipcMain.handle('add-manual-server', async (event, serverConfig) => {
      return this.serverManager.addManualServer(serverConfig);
    });

    // 서버 삭제
    ipcMain.handle('delete-server', async (event, serverId) => {
      const result = await this.serverManager.deleteServer(serverId);
      this.updateTrayIcon();
      return result;
    });

    // 모든 서버 삭제
    ipcMain.handle('clear-all-servers', async () => {
      const result = await this.serverManager.clearAllServers();
      this.updateTrayIcon();
      return result;
    });

    // 서버 상태 변경 알림
    this.serverManager.on('server-status-changed', (server) => {
      if (this.window) {
        this.window.webContents.send('server-status-changed', server);
      }
      this.updateTrayIcon();

      // 알림 표시
      if (this.store.get('settings.notifications', true)) {
        this.showNotification(server);
      }
    });

    // 로그 업데이트
    this.serverManager.on('log-update', (serverId, log) => {
      if (this.window) {
        this.window.webContents.send('log-update', { serverId, log });
      }
    });
  }

  showNotification(server) {
    const notification = new Notification({
      title: `${server.name} ${server.status}`,
      body: server.status === 'running'
        ? `Server started on port ${server.port || 'N/A'}`
        : server.status === 'error'
          ? `Server failed: ${server.error}`
          : 'Server stopped',
      icon: path.join(__dirname, '../assets/icon.png')
    });

    notification.show();
  }
}

// 앱 인스턴스
let manager;

// 앱 준비
app.whenReady().then(async () => {
  manager = new MSAServerManager();
  manager.setupIpcHandlers(); // IPC 핸들러를 먼저 설정
  manager.createTray();
  await manager.createWindow();

  // macOS에서 dock 아이콘 숨기기
  if (process.platform === 'darwin') {
    app.dock.hide();
  }
});

// 모든 윈도우가 닫혀도 앱은 계속 실행
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

// 앱 종료 전 정리
app.on('before-quit', async () => {
  await manager.serverManager.stopAll();
});
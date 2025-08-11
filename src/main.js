import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, shell, Tray, dialog } from "electron";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import ServerManager from "./serverManager.js";
import Store from "electron-store";

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 자동 경로 탐지 함수
async function detectNodePaths() {
  const store = new Store();
  const savedPaths = store.get('nodePaths');
  
  if (savedPaths && savedPaths.node && savedPaths.npm) {
    return savedPaths;
  }

  const paths = {
    node: null,
    npm: null
  };

  try {
    // node 경로 찾기
    const nodeResult = await execAsync('which node');
    paths.node = nodeResult.stdout.trim();
  } catch (error) {
    console.log('Node.js path not found via which command');
  }

  try {
    // npm 경로 찾기
    const npmResult = await execAsync('which npm');
    paths.npm = npmResult.stdout.trim();
  } catch (error) {
    console.log('npm path not found via which command');
  }

  // 경로를 찾았으면 저장
  if (paths.node && paths.npm) {
    store.set('nodePaths', paths);
  }

  return paths;
}

// PATH 환경변수 설정 (packaged 앱에서 필요)
async function setupEnvironmentPaths() {
  if (app.isPackaged) {
    const paths = await detectNodePaths();
    const pathDirs = [];
    
    // 감지된 경로들의 디렉토리 추가
    if (paths.node) {
      pathDirs.push(path.dirname(paths.node));
    }
    if (paths.npm) {
      pathDirs.push(path.dirname(paths.npm));
    }
    
    // 기본 경로들 추가
    pathDirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin');
    
    const currentPath = process.env.PATH || '';
    const pathSeparator = process.platform === 'win32' ? ';' : ':';
    const uniquePaths = [...new Set(pathDirs)]; // 중복 제거
    const newPath = uniquePaths.join(pathSeparator);
    
    process.env.PATH = currentPath ? `${newPath}${pathSeparator}${currentPath}` : newPath;
  }
}

class MSAServerManager {
  constructor() {
    this.tray = null;
    this.window = null;
    this.serverManager = new ServerManager();
    this.store = new Store();
    this.isQuitting = false; // 종료 상태 플래그

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
          await this.gracefulShutdown();
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

    // 서버 정보 업데이트
    ipcMain.handle('update-server', async (event, updatedServer) => {
      const result = await this.serverManager.updateServer(updatedServer);
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

    // Node 경로 가져오기
    ipcMain.handle('get-node-paths', () => {
      return this.store.get('nodePaths', { node: '', npm: '' });
    });

    // Node 경로 저장
    ipcMain.handle('save-node-paths', async (event, paths) => {
      this.store.set('nodePaths', paths);
      // 경로가 변경되면 PATH 환경변수도 다시 설정
      await setupEnvironmentPaths();
      return true;
    });

    // Node 경로 자동 탐지
    ipcMain.handle('detect-node-paths', async () => {
      // 저장된 경로 삭제하고 다시 탐지
      this.store.delete('nodePaths');
      return await detectNodePaths();
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

  async gracefulShutdown() {
    if (this.isQuitting) {
      return; // 이미 종료 중이면 중복 실행 방지
    }
    
    this.isQuitting = true;
    
    try {
      console.log('Starting graceful shutdown...');
      
      // 실행 중인 서버가 없으면 바로 종료
      if (!this.serverManager.hasRunningServers()) {
        console.log('No running servers, exiting immediately');
        this.serverManager.cleanup();
        app.exit(0);
        return;
      }
      
      // 모든 서버가 종료될 때까지 기다리는 Promise
      const waitForAllServersToStop = new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (!this.serverManager.hasRunningServers()) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100); // 100ms마다 체크

        // 최대 15초 타임아웃 (안전장치)
        setTimeout(() => {
          clearInterval(checkInterval);
          console.log('Timeout reached, forcing shutdown');
          resolve();
        }, 15000);
      });

      // 모든 서버 중지 시작
      await this.serverManager.stopAll();
      
      // 모든 서버가 실제로 종료될 때까지 대기
      await waitForAllServersToStop;
      
      // 리소스 정리
      if (this.serverManager) {
        this.serverManager.cleanup();
      }
      
      console.log('Graceful shutdown completed');
    } catch (error) {
      console.error('Error during graceful shutdown:', error);
    } finally {
      // 강제로 앱 종료
      app.exit(0);
    }
  }
}

// 앱 인스턴스
let manager;

// 앱 준비
app.whenReady().then(async () => {
  // 환경 경로 설정
  await setupEnvironmentPaths();
  
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
app.on('before-quit', async (event) => {
  if (manager && manager.serverManager && !manager.isQuitting) {
    event.preventDefault(); // 기본 종료 동작 방지
    await manager.gracefulShutdown();
  }
});

// 강제 종료 시그널 핸들링
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM signal');
  if (manager) {
    await manager.gracefulShutdown();
  } else {
    process.exit(0);
  }
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT signal');
  if (manager) {
    await manager.gracefulShutdown();
  } else {
    process.exit(0);
  }
});

// 전역 에러 핸들링 추가
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  
  // 에러 로깅
  const fs = require('fs');
  const path = require('path');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const logPath = path.join(__dirname, '../../debug.log');
  
  const logEntry = `\n[${new Date().toISOString()}] UNCAUGHT EXCEPTION: ${error.message}\n${error.stack}\n`;
  
  try {
    fs.appendFileSync(logPath, logEntry);
  } catch (writeError) {
    console.error('Failed to write error log:', writeError);
  }
  
  // graceful shutdown 시도
  if (manager && !manager.isQuitting) {
    manager.gracefulShutdown().finally(() => {
      process.exit(1);
    });
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  
  // 에러 로깅
  const fs = require('fs');
  const path = require('path');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const logPath = path.join(__dirname, '../../debug.log');
  
  const logEntry = `\n[${new Date().toISOString()}] UNHANDLED REJECTION: ${reason}\n`;
  
  try {
    fs.appendFileSync(logPath, logEntry);
  } catch (writeError) {
    console.error('Failed to write error log:', writeError);
  }
  
  // 심각한 에러가 아니라면 애플리케이션 계속 실행
  // 단, 메모리 관련 에러는 재시작 필요
  if (reason && reason.toString().includes('ENOMEM')) {
    console.error('Memory error detected, initiating graceful shutdown');
    if (manager && !manager.isQuitting) {
      manager.gracefulShutdown();
    }
  }
});
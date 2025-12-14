import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, shell, Tray, dialog } from "electron";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import ServerManager from "./serverManager.js";
import Store from "electron-store";
import net from "net";

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.argv.includes('--dev');

if (isDev) {
  // Reduce noisy DevTools/Electron security warnings and Chromium console spam during `npm run dev`.
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
  app.commandLine.appendSwitch('disable-logging');
  app.commandLine.appendSwitch('log-level', '3');
}
const APP_NAME = 'GUI Process Manager';

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
    this.isDialogOpen = false; // native dialog 표시 중 blur-hide 방지
    this._portToolWarned = false;

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
          port: dynamicConfig.port || null,
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
    this.tray.setToolTip(APP_NAME);

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
      if (this.isDialogOpen) return;
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
    this.tray.setToolTip(`${APP_NAME} (${runningCount}/${totalCount} running)`);
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

  normalizePortValue(rawPort) {
    const port = Number(rawPort);
    if (!Number.isInteger(port)) return null;
    if (port < 1 || port > 65535) return null;
    return port;
  }

  async getLsofCommand() {
    // Packaged 앱에서 PATH가 최소화되어 lsof를 못 찾는 경우가 있어 절대 경로 우선
    const candidates = ['/usr/sbin/lsof', '/usr/bin/lsof', 'lsof'];
    for (const cmd of candidates) {
      if (cmd === 'lsof') return cmd;
      try {
        await fs.access(cmd);
        return cmd;
      } catch (_) {
        // try next
      }
    }
    return 'lsof';
  }

  async isPortInUse(port) {
    const normalizedPort = this.normalizePortValue(port);
    if (!normalizedPort) return false;

    return await new Promise(resolve => {
      const tester = net.createServer();
      tester.once('error', (err) => {
        if (err && err.code === 'EADDRINUSE') return resolve(true);
        return resolve(false);
      });
      tester.once('listening', () => {
        tester.close(() => resolve(false));
      });
      // 127.0.0.1 기준으로 점유 여부 확인(0.0.0.0 리스닝도 대부분 EADDRINUSE로 잡힘)
      tester.listen({ port: normalizedPort, host: '127.0.0.1', exclusive: true });
    });
  }

  async confirmAndFreePort(port, { title, message, detail, confirmLabel = 'Kill and Continue', cancelLabel = 'Cancel' }) {
    const normalizedPort = this.normalizePortValue(port);
    if (!normalizedPort) return { freed: true };

    // 먼저 포트 점유 여부를 가볍게 확인
    const isInUse = await this.isPortInUse(normalizedPort);
    if (!isInUse) return { freed: true };

    const inUseProc = await this.findProcessUsingPort(normalizedPort);
    if (!inUseProc) {
      // 포트는 점유 중인데 PID를 찾지 못한 경우(lsof 미존재/권한/환경 이슈)
      this.isDialogOpen = true;
      try {
        if (this.window && !this.window.isVisible()) this.window.show();
        if (this.window) this.window.focus();

        await dialog.showMessageBox(this.window, {
          type: 'warning',
          buttons: ['OK'],
          defaultId: 0,
          title: title || 'Port In Use',
          message: `Port ${normalizedPort} is in use, but the owning process could not be identified.`,
          detail: 'Cannot auto-terminate without a PID. Please free the port manually and try again.',
          noLink: true
        });
      } finally {
        this.isDialogOpen = false;
      }
      return { freed: false, error: `Port ${normalizedPort} is in use (PID unknown)` };
    }

    const { pid, command } = inUseProc;
    this.isDialogOpen = true;
    try {
      if (this.window && !this.window.isVisible()) this.window.show();
      if (this.window) this.window.focus();

      const { response } = await dialog.showMessageBox(this.window, {
        type: 'warning',
        buttons: [confirmLabel, cancelLabel],
        defaultId: 0,
        cancelId: 1,
        title: title || 'Port In Use',
        message: message || `Port ${normalizedPort} is in use by ${command} (PID ${pid}).`,
        detail: detail || 'Do you want to terminate it (SIGTERM)?',
        noLink: true
      });

      if (response === 1) {
        return { freed: false, canceled: true, error: 'User canceled' };
      }

      try {
        process.kill(pid, 'SIGTERM');
      } catch (_) {
        // ignore and wait anyway
      }

      const freed = await this.waitForPortFree(normalizedPort, 6000);
      if (!freed) {
        return { freed: false, error: `Port ${normalizedPort} did not free in time` };
      }
      return { freed: true };
    } finally {
      this.isDialogOpen = false;
    }
  }

  async getProcessStartTimeMs(pid) {
    try {
      const { stdout } = await execAsync(`ps -p ${pid} -o lstart=`);
      const str = (stdout || '').trim();
      if (!str) return null;
      const ms = Date.parse(str);
      return Number.isNaN(ms) ? null : ms;
    } catch (_) {
      return null;
    }
  }

  async getProcessCwdByPid(pid) {
    try {
      const lsof = await this.getLsofCommand();
      // lsof -d cwd: 현재 작업 디렉토리
      const { stdout } = await execAsync(`${lsof} -a -p ${pid} -d cwd -Fn`);
      // 출력 예: "n/Users/xxx/project"
      const line = (stdout || '').split('\n').find(l => l.startsWith('n'));
      if (!line) return null;
      return line.slice(1).trim() || null;
    } catch (_) {
      return null;
    }
  }

  async terminateProcessGroupByPid(pid) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (e) {
      if (e.code !== 'ESRCH') {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (_) { /* ignore */ }
      }
    }

    const waitStart = Date.now();
    while (Date.now() - waitStart < 6000) {
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code === 'ESRCH') return true;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    // still alive -> SIGKILL
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (e) {
      if (e.code !== 'ESRCH') {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (_) { /* ignore */ }
      }
    }
    return !(await this.isProcessAlive(pid));
  }

  async isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return !(e && e.code === 'ESRCH');
    }
  }

  async cleanupStaleServerProcessForServer(server, { prompt = true } = {}) {
    if (!server || !server.id) return;
    const serverId = server.id;
    const runtimes = this.store.get('serverRuntimes', {});
    const rt = runtimes && runtimes[serverId] ? runtimes[serverId] : null;
    if (!rt || !rt.rootPid) return { ok: true, cleaned: false };

    const pid = Number(rt.rootPid);
    if (!Number.isInteger(pid)) {
      delete runtimes[serverId];
      this.store.set('serverRuntimes', runtimes);
      return { ok: true, cleaned: true };
    }

    const alive = await this.isProcessAlive(pid);
    if (!alive) {
      delete runtimes[serverId];
      this.store.set('serverRuntimes', runtimes);
      return { ok: true, cleaned: true };
    }

    // PID 재사용 방지: 프로세스 시작 시간이 저장된 startedAt과 크게 다르면 무시
    const procStart = await this.getProcessStartTimeMs(pid);
    if (procStart && rt.startedAt && Math.abs(procStart - Number(rt.startedAt)) > 2 * 60 * 1000) {
      delete runtimes[serverId];
      this.store.set('serverRuntimes', runtimes);
      return { ok: true, cleaned: true };
    }

    // 가능한 경우 cwd로 한 번 더 검증
    const cwd = await this.getProcessCwdByPid(pid);
    const expectedPath = rt.path || null;
    if (expectedPath && cwd && !cwd.startsWith(expectedPath)) {
      delete runtimes[serverId];
      this.store.set('serverRuntimes', runtimes);
      return { ok: true, cleaned: true };
    }

    const name = server.name || rt.name || serverId;

    if (!prompt) {
      const terminated = await this.terminateProcessGroupByPid(pid);
      delete runtimes[serverId];
      this.store.set('serverRuntimes', runtimes);
      if (!terminated) return { ok: false, error: `Failed to terminate leftover PID ${pid}` };
      return { ok: true, cleaned: true };
    }

    this.isDialogOpen = true;
    try {
      if (this.window && !this.window.isVisible()) this.window.show();
      if (this.window) this.window.focus();

      const { response } = await dialog.showMessageBox(this.window, {
        type: 'warning',
        buttons: ['Terminate', 'Continue', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'Leftover Server Process Detected',
        message: `"${name}" appears to still be running from a previous app session.`,
        detail: `PID: ${pid}${cwd ? `\nCWD: ${cwd}` : ''}\n\nTerminate it before starting?`,
        noLink: true
      });

      if (response === 2) {
        // Cancel: keep runtime record so we can ask again on next start attempt
        return { ok: false, canceled: true, error: 'Start canceled by user' };
      }

      if (response === 0) {
        const terminated = await this.terminateProcessGroupByPid(pid);
        if (!terminated) {
          return { ok: false, error: `Failed to terminate leftover PID ${pid}` };
        }
      }

      // Continue(1) or Terminate(0) -> clear runtime record to avoid repeated prompts
      delete runtimes[serverId];
      this.store.set('serverRuntimes', runtimes);
      return { ok: true, cleaned: true };
    } finally {
      this.isDialogOpen = false;
    }
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

    // 서버 시작 (포트 점유 확인 및 사용자 확인 포함)
    ipcMain.handle('start-server', async (event, serverId) => {
      try {
        // 대상 서버 조회
        const servers = this.serverManager.getAllServers();
        const target = servers.find(s => s.id === serverId);

        if (target) {
          const staleRes = await this.cleanupStaleServerProcessForServer(target);
          if (staleRes && staleRes.ok === false) {
            return { success: false, error: staleRes.error || 'Start canceled' };
          }
        }

        // actualPort(마지막 감지 포트)가 있으면 먼저 점유 확인 후 사용자 확인으로 종료
        if (target && target.actualPort) {
          const res = await this.confirmAndFreePort(target.actualPort, {
            title: 'Last Detected Port In Use',
            message: `Port ${target.actualPort} (last detected actual port) is in use.`,
            detail: 'This port may be from the previous run. Terminate the process on this port and start the server?',
            confirmLabel: 'Kill and Start',
            cancelLabel: 'Cancel'
          });
          if (!res.freed) {
            return { success: false, error: res.error || 'Start canceled: actualPort in use' };
          }
        }

        // 포트가 설정되어 있거나 커맨드에서 유추되면 점유 프로세스 확인
        const desiredPort = target ? (target.port || this.inferPortFromCommand(target.command)) : null;
        if (target && desiredPort) {
          // actualPort 확인에서 이미 처리한 포트면 중복 확인 스킵
          if (!target.actualPort || this.normalizePortValue(target.actualPort) !== this.normalizePortValue(desiredPort)) {
            const res = await this.confirmAndFreePort(desiredPort, {
              title: 'Port In Use',
              message: `Port ${desiredPort} is in use.`,
              detail: 'Do you want to terminate it (SIGTERM) and start this server?',
              confirmLabel: 'Kill and Start',
              cancelLabel: 'Cancel'
            });
            if (!res.freed) {
              return { success: false, error: res.error || 'Start canceled: port in use' };
            }
          }
        }

        const result = await this.serverManager.startServer(serverId);
        this.updateTrayIcon();
        return result;
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    // 서버 중지
    ipcMain.handle('stop-server', async (event, serverId) => {
      const result = await this.serverManager.stopServer(serverId);
      this.updateTrayIcon();
      return result;
    });

    // 서버 재시작
    ipcMain.handle('restart-server', async (event, serverId) => {
      try {
        const servers = this.serverManager.getAllServers();
        const target = servers.find(s => s.id === serverId);

        if (target) {
          const staleRes = await this.cleanupStaleServerProcessForServer(target, { prompt: false });
          if (staleRes && staleRes.ok === false) {
            return { success: false, error: staleRes.error || 'Restart canceled' };
          }
        }

        if (target && target.actualPort) {
          const res = await this.confirmAndFreePort(target.actualPort, {
            title: 'Last Detected Port In Use',
            message: `Port ${target.actualPort} (last detected actual port) is in use.`,
            detail: 'This port may be from the previous run. Terminate the process on this port and restart the server?',
            confirmLabel: 'Kill and Restart',
            cancelLabel: 'Cancel'
          });
          if (!res.freed) {
            return { success: false, error: res.error || 'Restart canceled: actualPort in use' };
          }
        }

        const desiredPort = target ? (target.port || this.inferPortFromCommand(target.command)) : null;
        if (target && desiredPort) {
          if (!target.actualPort || this.normalizePortValue(target.actualPort) !== this.normalizePortValue(desiredPort)) {
            const res = await this.confirmAndFreePort(desiredPort, {
              title: 'Port In Use',
              message: `Port ${desiredPort} is in use.`,
              detail: 'Do you want to terminate it (SIGTERM) and restart this server?',
              confirmLabel: 'Kill and Restart',
              cancelLabel: 'Cancel'
            });
            if (!res.freed) {
              return { success: false, error: res.error || 'Restart canceled: port in use' };
            }
          }
        }

        const result = await this.serverManager.restartServer(serverId);
        this.updateTrayIcon();
        return result;
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    // 모든 서버 시작 (각 서버별 포트 점유 확인 및 사용자 확인 포함)
    ipcMain.handle('start-all', async () => {
      const servers = this.serverManager.getAllServers();
      const results = [];

      for (const s of servers) {
        try {
          // 이미 실행 중이면 건너뜀
          if (s.status === 'running') {
            results.push({ id: s.id, success: true, skipped: true, reason: 'already running' });
            continue;
          }

          const staleRes = await this.cleanupStaleServerProcessForServer(s);
          if (staleRes && staleRes.ok === false) {
            results.push({ id: s.id, success: false, skipped: true, reason: 'user canceled (leftover process)' });
            continue;
          }

          if (s.actualPort) {
            const res = await this.confirmAndFreePort(s.actualPort, {
              title: 'Last Detected Port In Use',
              message: `Port ${s.actualPort} (last detected actual port) is in use.`,
              detail: `Terminate it (SIGTERM) and start "${s.name}"?`,
              confirmLabel: 'Kill and Start',
              cancelLabel: 'Skip'
            });
            if (!res.freed) {
              results.push({ id: s.id, success: false, skipped: true, reason: 'user skipped (actualPort in use)' });
              continue;
            }
          }

          // 포트 점유 확인 및 사용자 확인 (명시된 포트가 없으면 커맨드에서 유추)
          const desiredPort = s.port || this.inferPortFromCommand(s.command);
          if (desiredPort) {
            if (!s.actualPort || this.normalizePortValue(s.actualPort) !== this.normalizePortValue(desiredPort)) {
              const res = await this.confirmAndFreePort(desiredPort, {
                title: 'Port In Use',
                message: `Port ${desiredPort} is in use.`,
                detail: `Terminate it (SIGTERM) and start "${s.name}"?`,
                confirmLabel: 'Kill and Start',
                cancelLabel: 'Skip'
              });
              if (!res.freed) {
                results.push({ id: s.id, success: false, skipped: true, reason: 'user skipped (port in use)' });
                continue;
              }
            }
          }

          const res = await this.serverManager.startServer(s.id);
          results.push({ id: s.id, ...res });
        } catch (err) {
          results.push({ id: s.id, success: false, error: err.message });
        }
      }

      this.updateTrayIcon();
      return results;
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

    // 포트 불일치 알림 기능 제거됨
  }

  // 지정 포트 사용 중인 프로세스 탐지 (macOS)
  async findProcessUsingPort(port) {
    try {
      const lsof = await this.getLsofCommand();
      // PID 조회
      const pidResult = await execAsync(`${lsof} -nP -iTCP:${port} -sTCP:LISTEN -t | head -n1`);
      const pidStr = (pidResult.stdout || '').trim();
      if (!pidStr) return null;
      const pid = parseInt(pidStr, 10);
      if (!pid || Number.isNaN(pid)) return null;

      // 프로세스 명 조회
      const cmdResult = await execAsync(`ps -p ${pid} -o comm=`);
      const command = (cmdResult.stdout || '').trim() || 'unknown';
      
      // 자신 프로세스는 제외
      if (pid === process.pid) return null;
      return { pid, command };
    } catch (err) {
      if (!this._portToolWarned) {
        this._portToolWarned = true;
        console.warn('Port check failed (lsof/ps may be unavailable):', err && err.message ? err.message : err);
      }
      return null;
    }
  }

  // 포트가 비워질 때까지 대기
  async waitForPortFree(port, timeoutMs = 5000) {
    const start = Date.now();
    const lsof = await this.getLsofCommand();
    while (Date.now() - start < timeoutMs) {
      try {
        const { stdout } = await execAsync(`${lsof} -nP -iTCP:${port} -sTCP:LISTEN -t | head -n1`);
        if (!stdout.trim()) return true; // 포트 해제됨
      } catch (_) {
        return true; // lsof 실패 시 해제된 것으로 간주
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return false;
  }

  // 커맨드 문자열에서 포트 유추
  inferPortFromCommand(command = '') {
    try {
      if (!command) return null;
      const patterns = [
        /PORT\s*=\s*(\d{2,5})/i,
        /--port(?:=|\s+)(\d{2,5})/i,
        /-p(?:=|\s+)(\d{2,5})/i,
        /localhost:(\d{4,5})/i,
        /:(\d{4,5})/i
      ];
      for (const re of patterns) {
        const m = command.match(re);
        if (m && m[1]) {
          const p = parseInt(m[1], 10);
          if (p >= 3000 && p <= 65535) return p;
        }
      }
      return null;
    } catch (_) {
      return null;
    }
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

      // 모든 서버 중지 시작 (process map이 유실된 경우에도 PID 기반으로 SIGTERM 시도)
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

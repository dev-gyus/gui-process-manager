import { spawn } from 'child_process';
import EventEmitter from 'events';
import psList from 'ps-list';
import Store from 'electron-store';

class ServerManager extends EventEmitter {
  constructor() {
    super();
    this.servers = new Map();
    this.processes = new Map();
    this.logs = new Map();
  }

  loadServers(serverConfigs) {
    this.servers.clear();
    this.processes.clear();
    this.logs.clear();
    serverConfigs.forEach(config => {
      this.servers.set(config.id, { ...config, status: 'stopped' });
      this.logs.set(config.id, []);
    });
    
    // 수동으로 추가된 서버들도 로드
    this.loadManualServers();
  }

  loadManualServers() {
    const store = new Store();
    const manualServers = store.get('manualServers', []);
    
    manualServers.forEach(config => {
      if (!this.servers.has(config.id)) {
        this.servers.set(config.id, { ...config, status: 'stopped', isManual: true });
        this.logs.set(config.id, []);
      }
    });
  }

  addManualServer(serverConfig) {
    const store = new Store();
    
    // 기존 수동 서버 목록 가져오기
    const manualServers = store.get('manualServers', []);
    
    // 중복 ID 체크
    if (this.servers.has(serverConfig.id)) {
      throw new Error(`Server with ID '${serverConfig.id}' already exists`);
    }
    
    // 새 서버 추가
    manualServers.push(serverConfig);
    store.set('manualServers', manualServers);
    
    // 서버 매니저에 추가
    this.servers.set(serverConfig.id, { ...serverConfig, status: 'stopped', isManual: true });
    this.logs.set(serverConfig.id, []);
    
    return { success: true };
  }

  async deleteServer(serverId) {
    const server = this.servers.get(serverId);
    if (!server) {
      return { success: false, error: 'Server not found' };
    }

    try {
      // 서버가 실행 중이면 먼저 중지
      if (this.processes.has(serverId)) {
        await this.stopServer(serverId);
        // 프로세스가 완전히 종료될 시간을 줌
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // 저장소에서 제거 (수동 서버인 경우)
      if (server.isManual) {
        const store = new Store();
        const manualServers = store.get('manualServers', []);
        const filteredServers = manualServers.filter(s => s.id !== serverId);
        store.set('manualServers', filteredServers);
      }

      // 메모리에서 제거
      this.servers.delete(serverId);
      this.logs.delete(serverId);
      
      // 리소스 모니터링 정리
      const intervalId = `monitor_${serverId}`;
      if (this[intervalId]) {
        clearInterval(this[intervalId]);
        delete this[intervalId];
      }

      return { success: true };
    } catch (error) {
      console.error(`Failed to delete server ${serverId}:`, error);
      return { success: false, error: error.message };
    }
  }

  async clearAllServers() {
    try {
      // 모든 실행 중인 서버 중지
      await this.stopAll();
      
      // 프로세스가 완전히 종료될 시간을 줌
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 저장소에서 수동 서버 목록 삭제
      const store = new Store();
      store.set('manualServers', []);
      store.set('dynamicConfig', { rootPath: '', runCommand: 'npm start' });

      // 메모리에서 모든 서버 삭제
      this.servers.clear();
      this.processes.clear();
      this.logs.clear();

      // 모든 리소스 모니터링 정리
      Object.keys(this).forEach(key => {
        if (key.startsWith('monitor_')) {
          clearInterval(this[key]);
          delete this[key];
        }
      });

      return { success: true };
    } catch (error) {
      console.error('Failed to clear all servers:', error);
      return { success: false, error: error.message };
    }
  }

  async updateServer(updatedServer) {
    const server = this.servers.get(updatedServer.id);
    if (!server) {
      return { success: false, error: 'Server not found' };
    }

    try {
      // 서버가 실행 중이면 중지해야 함 (경로나 명령어가 변경되었을 수 있으므로)
      const wasRunning = server.status === 'running';
      if (wasRunning) {
        await this.stopServer(updatedServer.id);
        // 프로세스가 완전히 종료될 시간을 줌
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // 저장소 업데이트 (수동 서버인 경우)
      if (server.isManual) {
        const store = new Store();
        const manualServers = store.get('manualServers', []);
        const serverIndex = manualServers.findIndex(s => s.id === updatedServer.id);
        
        if (serverIndex !== -1) {
          manualServers[serverIndex] = {
            ...manualServers[serverIndex],
            name: updatedServer.name,
            path: updatedServer.path,
            command: updatedServer.command,
            port: updatedServer.port
          };
          store.set('manualServers', manualServers);
        }
      } else {
        // 동적 설정 서버인 경우 (rootPath에서 생성된 서버)
        const store = new Store();
        const dynamicConfig = store.get('dynamicConfig');
        if (dynamicConfig) {
          dynamicConfig.runCommand = updatedServer.command;
          store.set('dynamicConfig', dynamicConfig);
        }
      }

      // 메모리의 서버 정보 업데이트
      const updatedServerData = {
        ...server,
        name: updatedServer.name,
        path: updatedServer.path,
        command: updatedServer.command,
        port: updatedServer.port,
        status: 'stopped', // 중지된 상태로 설정
        pid: null,
        startTime: null,
        error: null,
        cpu: null,
        memory: null
      };

      this.servers.set(updatedServer.id, updatedServerData);

      // 서버가 실행 중이었다면 다시 시작
      if (wasRunning) {
        setTimeout(async () => {
          await this.startServer(updatedServer.id);
        }, 500);
      }

      return { success: true };
    } catch (error) {
      console.error(`Failed to update server ${updatedServer.id}:`, error);
      return { success: false, error: error.message };
    }
  }

  async startServer(serverId) {
    const server = this.servers.get(serverId);
    if (!server || this.processes.has(serverId)) {
      return { success: false, error: 'Server is already running or not found' };
    }

    try {
      const [command, ...args] = server.command.split(' ');

      const serverProcess = spawn(command, args, {
        cwd: server.path,
        shell: true, // 'npm' 같은 명령어를 직접 실행하기 위해 필요
        detached: true, // 부모 프로세스와 분리
        env: {
          ...process.env,
          PATH: process.env.PATH
        }
      });

      this.processes.set(serverId, serverProcess);

      serverProcess.stdout.on('data', (data) => {
        const output = data.toString();
        this.addLog(serverId, 'info', output);
        
        // 포트 번호 추출
        this.extractPortFromOutput(serverId, output);
      });

      serverProcess.stderr.on('data', (data) => {
        this.addLog(serverId, 'error', data.toString());
      });

      serverProcess.on('close', (code) => {
        const currentServer = this.servers.get(serverId);
        if (currentServer) {
          currentServer.status = code === 0 ? 'stopped' : 'error';
          currentServer.pid = null;
          currentServer.cpu = null;
          currentServer.memory = null;
          currentServer.error = code !== 0 ? `Process exited with code ${code}` : null;
          this.emit('server-status-changed', { ...currentServer });
        }
        this.processes.delete(serverId);
        
        // 리소스 모니터링 정리
        const intervalId = `monitor_${serverId}`;
        if (this[intervalId]) {
          clearInterval(this[intervalId]);
          delete this[intervalId];
        }
        
        if (code !== 0) {
          this.addLog(serverId, 'error', `Process exited with code ${code}`);
        }
      });

      serverProcess.on('error', (error) => {
        const currentServer = this.servers.get(serverId);
        if (currentServer) {
          currentServer.status = 'error';
          currentServer.error = error.message;
          this.emit('server-status-changed', { ...currentServer });
        }
        this.processes.delete(serverId);
        this.addLog(serverId, 'error', `Failed to start server: ${error.message}`);
      });

      server.status = 'running';
      server.pid = serverProcess.pid;
      server.startTime = new Date();
      server.error = null;

      this.emit('server-status-changed', { ...server });
      this.addLog(serverId, 'info', `Server starting with command: "${server.command}" (PID: ${serverProcess.pid})`);

      await this.startResourceMonitoring(serverId);

      return { success: true };
    } catch (error) {
      server.status = 'error';
      server.error = error.message;
      this.emit('server-status-changed', { ...server });
      return { success: false, error: error.message };
    }
  }

  async stopServer(serverId) {
    const serverProcess = this.processes.get(serverId);
    if (!serverProcess) {
      return { success: false, error: 'Server process not found' };
    }

    try {
      // 프로세스 그룹 전체에 SIGTERM 전송
      process.kill(-serverProcess.pid, 'SIGTERM');
      this.addLog(serverId, 'info', 'Stopping server...');

      // 5초 후 강제 종료
      setTimeout(() => {
        if (this.processes.has(serverId)) {
          process.kill(-serverProcess.pid, 'SIGKILL');
          this.addLog(serverId, 'info', 'Server forcefully killed.');
        }
      }, 5000);

      return { success: true };
    } catch (error) {
      // 프로세스가 이미 종료된 경우 등
      if (error.code === 'ESRCH') {
        this.processes.delete(serverId);
        return { success: true };
      }
      console.error(`Failed to stop server ${serverId}:`, error);
      this.addLog(serverId, 'error', `Failed to stop server: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async restartServer(serverId) {
    const server = this.servers.get(serverId);
    if (!server) return { success: false, error: 'Server not found' };

    if (this.processes.has(serverId)) {
      await this.stopServer(serverId);
      // 프로세스가 완전히 종료될 시간을 줌
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    return this.startServer(serverId);
  }

  async startAll() {
    const promises = Array.from(this.servers.keys()).map(id => this.startServer(id));
    return Promise.all(promises);
  }

  async stopAll() {
    const promises = Array.from(this.processes.keys()).map(id => this.stopServer(id));
    return Promise.all(promises);
  }

  getAllServers() {
    return Array.from(this.servers.values()).map(server => ({
      ...server,
      uptime: this.calculateUptime(server.startTime)
    }));
  }

  getRunningServers() {
    return this.getAllServers().filter(server => server.status === 'running');
  }

  hasRunningServers() {
    return this.getRunningServers().length > 0;
  }

  areAllRunning() {
    const allServers = this.getAllServers();
    if (allServers.length === 0) return false;
    return allServers.every(server => server.status === 'running');
  }

  getLogs(serverId) {
    return this.logs.get(serverId) || [];
  }

  addLog(serverId, level, message) {
    const logs = this.logs.get(serverId);
    if (!logs) return;

    const logEntry = {
      timestamp: new Date(),
      level,
      message: message.trim()
    };

    logs.push(logEntry);
    if (logs.length > 1000) {
      logs.shift();
    }
    this.emit('log-update', serverId, logEntry);
  }

  calculateUptime(startTime, includeSeconds = false) {
    if (!startTime) return '-';
    const diff = Date.now() - new Date(startTime).getTime();
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    
    if (includeSeconds) {
      return `${hours}h ${minutes}m ${seconds}s`;
    }
    return `${hours}h ${minutes}m`;
  }

  extractPortFromOutput(serverId, output) {
    const server = this.servers.get(serverId);
    if (!server || server.port) return; // 이미 포트가 설정되어 있으면 건너뛰기

    // 다양한 포트 패턴 매칭
    const portPatterns = [
      /listening on port (\d+)/i,
      /server.*running.*port (\d+)/i,
      /listening.*:(\d+)/i,
      /port (\d+)/i,
      /localhost:(\d+)/i,
      /:(\d{4,5})/g
    ];

    for (const pattern of portPatterns) {
      const match = output.match(pattern);
      if (match && match[1]) {
        const port = parseInt(match[1]);
        if (port >= 3000 && port <= 65535) { // 유효한 포트 범위
          server.port = port;
          this.emit('server-status-changed', { ...server });
          break;
        }
      }
    }
  }

  async startResourceMonitoring(serverId) {
    const intervalId = `monitor_${serverId}`;
    // 이전 모니터링이 있다면 중지
    if (this[intervalId]) clearInterval(this[intervalId]);

    // 초기 리소스 정보 설정
    const server = this.servers.get(serverId);
    if (server) {
      server.cpu = '0.0';
      server.memory = '0';
      this.emit('server-status-changed', { ...server });
    }

    this[intervalId] = setInterval(async () => {
      const currentServer = this.servers.get(serverId);
      const processInfo = this.processes.get(serverId);

      if (!currentServer || !processInfo || currentServer.status !== 'running') {
        clearInterval(this[intervalId]);
        delete this[intervalId];
        return;
      }

      try {
        const processes = await psList();
        
        // 메인 프로세스 찾기
        const mainProcess = processes.find(p => p.pid === processInfo.pid);
        
        if (mainProcess) {
          // 메인 프로세스가 있으면 자식 프로세스들도 찾기
          const childProcesses = processes.filter(p => p.ppid === processInfo.pid);
          const allRelatedProcesses = [mainProcess, ...childProcesses];
          
          // 모든 관련 프로세스의 리소스 사용량 합계
          const totalCpu = allRelatedProcesses.reduce((sum, p) => sum + (p.cpu || 0), 0);
          const totalMemory = allRelatedProcesses.reduce((sum, p) => sum + (p.memory || 0), 0);

          // ps-list의 memory는 이미 MB 단위임
          const memoryInMB = Math.round(totalMemory);

          currentServer.cpu = Math.min(totalCpu, 100).toFixed(1);
          currentServer.memory = memoryInMB;
          
          this.emit('server-status-changed', { 
            ...currentServer,
            uptime: this.calculateUptime(currentServer.startTime)
          });
        } else {
          currentServer.cpu = '0.0';
          currentServer.memory = '0';
          this.emit('server-status-changed', { ...currentServer });
        }
      } catch (error) {
        console.error(`ps-list error for ${serverId}:`, error);
        const currentServer = this.servers.get(serverId);
        if (currentServer) {
          currentServer.cpu = '0.0';
          currentServer.memory = '0';
          this.emit('server-status-changed', { ...currentServer });
        }
      }
    }, 1000); // 1초마다 갱신
  }
}

export default ServerManager;
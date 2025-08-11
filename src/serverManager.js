import { spawn } from 'child_process';
import EventEmitter from 'events';
import psList from 'ps-list';
import Store from 'electron-store';
import path from 'path';

class ServerManager extends EventEmitter {
  constructor() {
    super();
    this.servers = new Map();
    this.processes = new Map();
    this.logs = new Map();
    this.healthCheckInterval = null;
    this.startHealthCheck();
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

      // 저장소에서 제거
      const store = new Store();
      if (server.isManual) {
        // 수동 서버인 경우
        const manualServers = store.get('manualServers', []);
        const filteredServers = manualServers.filter(s => s.id !== serverId);
        store.set('manualServers', filteredServers);
      } else {
        // 동적 설정 서버인 경우 - dynamicConfig 삭제
        const dynamicConfig = store.get('dynamicConfig');
        if (dynamicConfig && dynamicConfig.rootPath && path.basename(dynamicConfig.rootPath) === serverId) {
          store.set('dynamicConfig', { rootPath: '', runCommand: 'npm start' });
        }
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
      const server = this.servers.get(serverId);
      if (server) {
        server.status = 'stopping';
        this.emit('server-status-changed', { ...server });
      }

      this.addLog(serverId, 'info', 'Stopping server...');

      // 1단계: SIGTERM으로 정상 종료 요청
      try {
        process.kill(-serverProcess.pid, 'SIGTERM');
      } catch (killError) {
        if (killError.code !== 'ESRCH') {
          throw killError;
        }
      }

      // 프로세스가 정상 종료되기를 기다림
      await new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (!this.processes.has(serverId)) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);

        // 5초 후 강제 종료
        setTimeout(() => {
          clearInterval(checkInterval);
          if (this.processes.has(serverId)) {
            try {
              process.kill(-serverProcess.pid, 'SIGKILL');
              this.addLog(serverId, 'info', 'Server forcefully killed.');
            } catch (killError) {
              if (killError.code !== 'ESRCH') {
                console.error(`Failed to force kill server ${serverId}:`, killError);
              }
            }
          }
          resolve();
        }, 5000);
      });

      return { success: true };
    } catch (error) {
      // 프로세스가 이미 종료된 경우 등
      if (error.code === 'ESRCH') {
        this.processes.delete(serverId);
        const server = this.servers.get(serverId);
        if (server) {
          server.status = 'stopped';
          server.pid = null;
          server.cpu = null;
          server.memory = null;
          this.emit('server-status-changed', { ...server });
        }
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

    // 빈 메시지나 너무 긴 메시지 필터링
    const trimmedMessage = message.trim();
    if (!trimmedMessage || trimmedMessage.length > 2000) return;

    const logEntry = {
      timestamp: new Date(),
      level,
      message: trimmedMessage
    };

    logs.push(logEntry);
    
    // 로그 크기 제한 - 500개로 줄여서 메모리 사용량 감소
    if (logs.length > 500) {
      // 한 번에 100개씩 제거하여 GC 부담 줄이기
      logs.splice(0, 100);
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
    if (this[intervalId]) {
      clearInterval(this[intervalId]);
      delete this[intervalId];
    }

    // 초기 리소스 정보 설정
    const server = this.servers.get(serverId);
    if (!server) return;
    
    server.cpu = '0.0';
    server.memory = '0';
    this.emit('server-status-changed', { ...server });

    // 에러 카운터 추가
    let errorCount = 0;
    const maxErrors = 5;

    this[intervalId] = setInterval(async () => {
      const currentServer = this.servers.get(serverId);
      const processInfo = this.processes.get(serverId);

      // 서버가 존재하지 않거나 실행 중이 아니면 모니터링 중지
      if (!currentServer || !processInfo || currentServer.status !== 'running') {
        clearInterval(this[intervalId]);
        delete this[intervalId];
        return;
      }

      try {
        // ps-list 실행 시간 제한 (3초)
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('ps-list timeout')), 3000)
        );
        
        const processes = await Promise.race([psList(), timeoutPromise]);
        
        // 메인 프로세스 찾기
        const mainProcess = processes.find(p => p.pid === processInfo.pid);
        
        if (mainProcess) {
          // 메인 프로세스가 있으면 자식 프로세스들도 찾기 (최대 10개로 제한)
          const childProcesses = processes
            .filter(p => p.ppid === processInfo.pid)
            .slice(0, 10); // 자식 프로세스 수 제한
          const allRelatedProcesses = [mainProcess, ...childProcesses];
          
          // 모든 관련 프로세스의 리소스 사용량 합계 (안전한 계산)
          const totalCpu = allRelatedProcesses.reduce((sum, p) => {
            const cpu = parseFloat(p.cpu) || 0;
            return sum + (isNaN(cpu) ? 0 : cpu);
          }, 0);
          
          const totalMemory = allRelatedProcesses.reduce((sum, p) => {
            const memory = parseFloat(p.memory) || 0;
            return sum + (isNaN(memory) ? 0 : memory);
          }, 0);

          // 안전한 값 설정
          const memoryInMB = Math.max(0, Math.round(totalMemory));
          const cpuPercent = Math.max(0, Math.min(totalCpu, 100)).toFixed(1);

          currentServer.cpu = cpuPercent;
          currentServer.memory = memoryInMB;
          
          this.emit('server-status-changed', { 
            ...currentServer,
            uptime: this.calculateUptime(currentServer.startTime)
          });
          
          // 성공 시 에러 카운터 리셋
          errorCount = 0;
        } else {
          // 프로세스를 찾을 수 없으면 0으로 설정
          currentServer.cpu = '0.0';
          currentServer.memory = '0';
          this.emit('server-status-changed', { ...currentServer });
        }
      } catch (error) {
        errorCount++;
        console.warn(`Resource monitoring error for ${serverId} (${errorCount}/${maxErrors}):`, error.message);
        
        // 연속 에러가 너무 많으면 모니터링 중지
        if (errorCount >= maxErrors) {
          console.error(`Too many monitoring errors for ${serverId}, stopping monitoring`);
          clearInterval(this[intervalId]);
          delete this[intervalId];
          
          // 마지막으로 0 값 설정
          const currentServer = this.servers.get(serverId);
          if (currentServer) {
            currentServer.cpu = '0.0';
            currentServer.memory = '0';
            this.emit('server-status-changed', { ...currentServer });
          }
          return;
        }
        
        // 에러 시에도 안전한 값 설정
        const currentServer = this.servers.get(serverId);
        if (currentServer) {
          currentServer.cpu = '0.0';
          currentServer.memory = '0';
          this.emit('server-status-changed', { ...currentServer });
        }
      }
    }, 2000); // 2초로 변경하여 부하 감소
  }

  // 헬스 체크 시스템
  startHealthCheck() {
    // 30초마다 전체 시스템 상태 점검
    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.performHealthCheck();
      } catch (error) {
        console.warn('Health check failed:', error.message);
      }
    }, 30000);
  }

  async performHealthCheck() {
    let issuesFound = 0;
    
    // 실행 중으로 표시된 서버의 프로세스 실제 존재 여부 확인
    for (const [serverId, server] of this.servers.entries()) {
      if (server.status === 'running') {
        const process = this.processes.get(serverId);
        if (!process || !process.pid) {
          console.warn(`Server ${serverId} marked as running but no process found`);
          server.status = 'error';
          server.error = 'Process lost - health check failed';
          this.emit('server-status-changed', { ...server });
          issuesFound++;
          continue;
        }
        
        // 프로세스가 실제로 존재하는지 확인
        try {
          process.kill(0); // 시그널 0은 프로세스 존재 확인용
        } catch (error) {
          if (error.code === 'ESRCH') {
            console.warn(`Process ${process.pid} for server ${serverId} no longer exists`);
            server.status = 'error';
            server.error = 'Process terminated unexpectedly';
            server.pid = null;
            this.processes.delete(serverId);
            this.emit('server-status-changed', { ...server });
            issuesFound++;
            
            // 리소스 모니터링도 정리
            const intervalId = `monitor_${serverId}`;
            if (this[intervalId]) {
              clearInterval(this[intervalId]);
              delete this[intervalId];
            }
          }
        }
      }
    }

    // 메모리 사용량 점검 (Node.js 프로세스)
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const rss = Math.round(memUsage.rss / 1024 / 1024);
    
    // 메모리 사용량이 너무 높으면 경고
    if (heapUsedMB > 200 || rss > 500) {
      console.warn(`High memory usage detected - Heap: ${heapUsedMB}MB, RSS: ${rss}MB`);
      
      // 강제 가비지 컬렉션 (가능한 경우)
      if (global.gc) {
        global.gc();
      }
    }

    if (issuesFound === 0) {
      console.log(`Health check completed - ${this.servers.size} servers, ${this.getRunningServers().length} running`);
    } else {
      console.warn(`Health check completed - ${issuesFound} issues found and resolved`);
    }
  }

  cleanup() {
    console.log('Cleaning up ServerManager resources...');
    
    // 헬스 체크 중지
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    
    // 모든 리소스 모니터링 정리
    Object.keys(this).forEach(key => {
      if (key.startsWith('monitor_')) {
        clearInterval(this[key]);
        delete this[key];
      }
    });

    // 남아있는 프로세스들 강제 종료
    this.processes.forEach((process, serverId) => {
      try {
        console.log(`Force killing remaining process for server ${serverId} (PID: ${process.pid})`);
        process.kill('SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') {
          console.error(`Failed to kill process for server ${serverId}:`, error);
        }
      }
    });

    // 모든 맵 정리
    this.processes.clear();
    this.servers.clear();
    this.logs.clear();

    // 이벤트 리스너 정리
    this.removeAllListeners();

    console.log('ServerManager cleanup completed');
  }
}

export default ServerManager;
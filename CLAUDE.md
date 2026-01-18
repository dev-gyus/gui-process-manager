# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 빌드 및 실행 명령어

```bash
# 의존성 설치
npm install

# 개발 모드 실행 (DevTools 자동 열림)
npm run dev

# 프로덕션 모드 실행
npm start

# 현재 플랫폼용 빌드
npm run build

# macOS DMG 인스톨러 빌드
npm run dist
```

## 아키텍처 개요

macOS용 개발 서버 관리 Electron 트레이 애플리케이션입니다. 전체적으로 ES 모듈(`"type": "module"`)을 사용합니다.

### 프로세스 아키텍처

```
Main Process (src/main.js)
    ├── MSAServerManager 클래스 - 윈도우, 트레이, IPC 조정
    ├── ServerManager (src/serverManager.js) - 자식 프로세스 생명주기 관리
    │   └── EventEmitter 기반 상태 업데이트
    └── electron-store - 영속적 설정 저장

Preload (src/preload.js)
    └── 화이트리스트 기반 IPC 브릿지 (window.electronAPI)

Renderer (src/renderer/)
    ├── index.html - UI 구조
    ├── renderer.js - App 클래스, UI 로직
    └── styles.css - 다크 테마 스타일링
```

### 주요 데이터 흐름

1. **사용자 액션** → Renderer가 `electronAPI.invoke(channel, args)` 호출
2. **IPC 핸들러** → Main 프로세스가 요청 처리, ServerManager에 위임
3. **ServerManager** → 자식 프로세스 생성/관리, 상태 이벤트 발생
4. **상태 업데이트** → Main이 `webContents.send()`로 Renderer에 전송

### 서버 객체 모델

```javascript
{
  id: string,           // 고유 식별자
  name: string,         // 표시 이름
  path: string,         // 작업 디렉토리
  command: string,      // 실행 명령어 (예: "npm run dev")
  port: number | null,  // 설정된 포트
  actualPort: number,   // 감지된 리스닝 포트
  status: 'stopped' | 'running' | 'error' | 'stopping',
  pid: number | null,   // 프로세스 ID
  isManual: boolean     // 수동 추가 여부
}
```

### IPC 채널 카테고리

- **34개 invoke 채널**: 요청-응답 방식 (get-servers, start-server, stop-server 등)
- **2개 send 채널**: Main으로 단방향 전송 (hide-window, window-content-changed)
- **5개 on 채널**: Renderer로 이벤트 전송 (server-status-changed, log-update 등)

모든 채널은 보안을 위해 `src/preload.js`에서 화이트리스트로 관리됩니다.

## 주요 구현 세부사항

### 프로세스 관리
- 자식 프로세스는 `detached: true`로 독립적으로 생성
- 프로세스 그룹 ID (PGID)를 사용한 트리 기반 종료
- 우아한 종료: SIGTERM → 5초 대기 → SIGKILL
- 30초마다 헬스 체크 수행

### 포트 감지 알고리즘
- `lsof -iTCP -sTCP:LISTEN`으로 프로세스 트리 스캔
- 우선순위: 설정된 포트 → 메인 프로세스 포트 → 일반 서버 포트 (3000-9999)
- 디버거 포트 (9229-9239) 필터링
- NestJS 마이크로서비스와 HTTP 서버 구분 처리

### 셸 실행
명령어는 `/bin/bash -lc`로 래핑하여 bash 프로파일을 소싱하고 사용자 설치 도구(nvm 등)에 접근합니다.

## 플랫폼 참고사항

- **macOS 전용** (Apple Silicon 우선, x64 지원)
- JIT 컴파일 및 네이티브 모듈(node-pty)을 위한 entitlements 필요
- LSUIElement=1로 트레이 전용 앱 (Dock 아이콘 없음)
- Homebrew 설치: `brew install --cask --no-quarantine gui-process-manager`

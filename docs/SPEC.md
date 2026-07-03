# DiligentHours — 설계 문서 / 요구사항 명세

- 작성일: 2026-07-02 (v0.4 개정: 2026-07-03)
- 상태: 기획 확정 · v0.1 구현 중 — **기술 스택 확정: Tauri** (v0.4)
- 대상 플랫폼: (1차) Windows 데스크탑 설치형 / (2차) macOS

---

## 1. 개요 (Overview)

**DiligentHours** 는 데스크탑 PC 사용자가 근무 장소에 도착하여 **처음으로 키보드/마우스를 조작한 시각**을 업무 시작 시각으로 간주하고, 사전에 **합의된 근무시간**(예: 9시간)이 끝날 때까지 **남은 시간을 화면에 상시 표시**하며, **근무시간 종료 시 알림**을 주는 경량 타이머 앱이다.

이름은 *Diligent*(성실한·부지런한) + *Hours*(시간)의 합성으로, **약속된 시간 동안 성실히 집중해서 일한다**는 취지를 담는다. 출퇴근 기록기(근태 시스템)를 대체하려는 것이 아니라, 개인이 "오늘 정해진 근무 시간이 언제 끝나는가"를 직관적으로 인지하도록 돕는 **개인용 보조 도구**다.

### 1.1 핵심 가치

- 별도 조작 없이 자동으로 근무 시작을 감지 (앱을 켜 두기만 하면 됨)
- 남은 시간을 항상 눈에 보이게 하여 업무 몰입/종료 시각 예측 지원
- 가볍고 방해되지 않는 UI (반투명 플로팅 / 트레이)

---

## 2. 핵심 동작 흐름 (Core Behavior)

```
[앱 시작(부팅 시 자동실행 권장)]
        │
        ▼
[전역 입력 이벤트 감지 대기]  ◄──────────────┐
        │                                    │
        │ 당일 00시 이후 "첫" 입력 발생        │
        ▼                                    │
[근무 시작 시각(startTime) 기록]              │
        │                                    │
        ▼                                    │
[카운트다운 시작: remaining = duration]       │
   endTime = startTime + duration            │
        │                                    │
        ▼                                    │
[남은 시간 표시 (초 or 시:분:초)]             │
        │                                    │
        │ remaining == 0                     │
        ▼                                    │
[종료 알림 / 표시 영역 하이라이트]            │
        │                                    │
        │ (0 이후 입력이 있어도 당일엔 리셋 안함) │
        ▼                                    │
[자정(로컬 날짜 변경) 경과]                   │
        │                                    │
        └───────── 다음 날 첫 입력 → 새 사이클 ─┘
```

### 2.1 상태 정의 (State Machine)

| 상태 | 설명 | 진입 조건 | 표시 |
|------|------|-----------|------|
| `IDLE` | 오늘 아직 첫 입력 없음 | 앱 시작 / 자정 경과 후 | "대기 중" 또는 비표시 |
| `RUNNING` | 카운트다운 진행 중 | 당일 첫 입력 감지 | 남은 시간 |
| `FINISHED` | 근무시간 종료(0 도달) | remaining ≤ 0 | 하이라이트 + "종료" |

- `FINISHED` 상태에서 추가 입력이 있어도 **당일에는** `IDLE`/`RUNNING`으로 되돌아가지 않는다.
- **날짜(로컬 캘린더 date)가 바뀐** 뒤의 첫 입력에서만 `IDLE → RUNNING` 전이가 다시 발생한다.

### 2.2 "당일"과 "첫 입력"의 정의

- 기준: **로컬 타임존의 캘린더 날짜(YYYY-MM-DD)**. 자정(00:00) 경계로 하루를 구분.
- "첫 입력" = 현재 날짜에 대해 아직 `startTime`이 기록되지 않은 상태에서 최초로 감지된 마우스 또는 키보드 이벤트.
- 하루 1회만 사이클이 실행됨 (하루 1 사이클 원칙).

---

## 3. 기능 요구사항 (Functional Requirements)

### FR-1. 전역 입력 이벤트 감지
- OS 전역(포커스 무관)으로 키보드/마우스 이벤트를 감지한다.
- Windows: Low-Level Hook (`SetWindowsHookEx` + `WH_KEYBOARD_LL`, `WH_MOUSE_LL`) 사용.
- 감지 대상: 키 입력, 마우스 이동/클릭/스크롤. (마우스 이동만으로도 시작으로 볼지 여부는 설정 옵션 — 3.7 참고)
- **개인정보**: 입력 "발생 여부(타임스탬프)"만 사용하고 **키 내용(keylogging)은 저장/전송하지 않는다.** (문서에 명시, 신뢰 확보 목적)

### FR-2. 근무 시작 감지 및 기록
- 당일 첫 입력 시각을 `startTime`으로 기록하고 영속화(재시작 대비)한다.
- `endTime = startTime + workDuration`.

### FR-3. 카운트다운
- 남은 시간 `remaining = endTime - now` 를 1초 주기로 갱신.
- 0 이하가 되면 `FINISHED` 전이.

### FR-4. 남은 시간 표시 형식 (설정)
- (a) 초 단위만: 예 `27939 초 남음`
- (b) 시:분:초: 예 `07:45:39 남음`
- 설정으로 (a)/(b) 전환.

### FR-5. 표시 방식 (설정, 동시 사용 가능)
- (1) **트레이 아이콘 영역**: 아이콘 + 툴팁/텍스트 배지로 남은 시간 표시.
- (2) **플로팅 윈도우**: 테두리 없음(borderless), 항상 위(topmost), 반투명 숫자 오버레이. 드래그로 위치 이동, 위치 기억.

### FR-6. 종료 알림
- `FINISHED` 시 표시 영역(플로팅/트레이)을 하이라이트(색상 변화/점멸 등).
- 선택: OS 토스트 알림, 사운드(설정으로 on/off).

### FR-7. 일 단위 리셋 규칙
- `FINISHED` 이후 입력은 무시(당일 재시작 없음).
- 자정 경과 감지(타이머 또는 시스템 시계 비교) 후, 다음 첫 입력에서 새 사이클.

### FR-8. 설정 (Settings)
- 근무시간 `workDuration` (기본 9h, 분 단위 조정 가능)
- 표시 형식 (초 / 시:분:초)
- 표시 방식 (트레이 / 플로팅 / 둘 다)
- 플로팅 투명도, 글꼴 크기, 색상
- 시작 트리거(마우스 이동 포함 여부)
- 알림 방식(하이라이트/토스트/사운드)
- 부팅 시 자동 실행 on/off
- 설정/상태 파일 저장 위치: **Tauri 앱 설정 디렉터리** (앱 identifier `com.winm2m.diligenthours.desktop` 기준)
  - Windows: `%APPDATA%\com.winm2m.diligenthours.desktop\`
  - macOS: `~/Library/Application Support/com.winm2m.diligenthours.desktop/`

### FR-9. 상태 영속화 (Persistence)
- `startTime`, 대상 날짜, 상태를 로컬 파일(JSON)에 저장.
- 앱이 재시작되어도 당일 이미 시작된 사이클을 복원(자정 이전이면 이어서 카운트다운).

### FR-10. 수동 제어 (선택)
- 트레이 우클릭 메뉴: 현재 상태 보기, 오늘 강제 시작/리셋(디버그/예외 상황용), 설정 열기, 종료.

---

## 4. 비기능 요구사항 (Non-Functional)

- **경량**: 유휴 시 CPU ~0%, 낮은 메모리 사용.
- **부팅 자동 실행** 지원 (근무 시작 감지를 위해 상시 실행 권장).
- **안정성**: 후킹 실패/권한 문제 시 graceful degradation 및 사용자 안내.
- **정확성**: 시스템 절전/최대 절전(sleep/hibernate) 복귀 시 벽시계(wall clock) 기준으로 `remaining` 재계산 (경과 시간 손실 방지).
- **개인정보/보안**: 키 입력 내용 미기록, 네트워크 전송 없음(오프라인 동작). 백신 오탐(전역 후킹) 대비 코드 서명 권장.
- **국제화**: 우선 한국어, 문자열 분리로 영어 확장 대비.

---

## 5. 엣지 케이스 (Edge Cases)

| 상황 | 처리 |
|------|------|
| 앱이 근무 시작 이후 실행됨 | 실행 시점의 입력을 당일 첫 입력으로 기록(그 이전 입력은 알 수 없음). 사용자에게 "감지 시작" 안내 고려 |
| PC 절전 후 복귀 | 벽시계 기준 재계산. 자정을 넘겼으면 새 날짜로 IDLE 전환 |
| 타임존/서머타임 변경 | 로컬 캘린더 date 기준 유지 |
| 자정 직전 시작 | 당일 사이클 진행, 자정 지나면 FINISHED 여부와 무관하게 다음날 새 사이클 대기 |
| 멀티 모니터 | 플로팅 윈도우 위치를 모니터 기준으로 저장/복원 |
| 하루 여러 번 출퇴근(외출 등) | 하루 1 사이클 원칙 유지. 필요 시 수동 리셋(FR-10) |
| 후킹 권한 없음/실패 | 폴백: 저수준 폴링 또는 안내 메시지 |

---

## 6. 기술 스택 (Tech Stack) — 확정: Tauri

기술 스택은 **Tauri v2 (Rust 백엔드 + 정적 웹 UI)** 로 **확정**한다.

### 6.1 선정 근거

- **경량 상시 실행**: OS 내장 WebView를 사용하므로 바이너리·메모리 풋프린트가 작다. 트레이에 상주하며 하루 종일 실행되는 앱의 경량 요건(4절)에 부합.
- **트레이 + 오버레이 1급 지원**: 트레이 아이콘(tray-icon), 투명(transparent)·테두리 없음(decorations: false)·항상 위(always-on-top) 윈도우를 Tauri가 기본 기능으로 제공 — FR-5의 두 표시 방식을 그대로 구현 가능.
- **릴리스 자동화**: GitHub Actions의 `tauri-apps/tauri-action`으로 태그 푸시만으로 Windows(NSIS `.exe`)/macOS(`.app`/`.dmg`) 빌드와 GitHub Release 업로드가 자동화됨.
- **크로스플랫폼**: 1차 Windows, 2차 macOS를 단일 코드베이스로 커버. 전역 입력 감지는 Rust `rdev` crate가 양 플랫폼을 지원.

### 6.2 구성 요소 (Components)

| 구성 요소 | 선택 | 비고 |
|-----------|------|------|
| UI | Tauri 윈도우 + vanilla HTML/CSS/JS | `withGlobalTauri` 사용, 번들러/Node 빌드 없음 — 정적 `ui/` 디렉터리 그대로 서빙 |
| 전역 입력 감지 | `rdev` crate | Windows: `SetWindowsHookEx` 저수준 훅 / macOS: `CGEventTap` |
| 트레이 | Tauri tray-icon | 아이콘/툴팁/컨텍스트 메뉴 |
| 알림 | `tauri-plugin-notification` | OS 토스트 알림 |
| 자동 실행 | `tauri-plugin-autostart` | 부팅 시 자동 시작 |
| 단일 인스턴스 | `tauri-plugin-single-instance` | 중복 실행 방지 |
| 영속화 | `serde_json` → 앱 설정 디렉터리 | identifier `com.winm2m.diligenthours.desktop` (FR-8 참고) |

### 6.3 검토했던 대안

- **.NET (C#) + WPF**: Win32 API(저수준 후킹, NotifyIcon) 접근이 가장 자연스럽고 Windows 특화도가 높으나, **Windows 전용**이라 macOS 확장이 불가. 크로스플랫폼 로드맵과 상충하여 제외.
- **Electron**: UI 개발이 빠르고 트레이/투명창을 지원하지만, 상시 실행 앱치고 **메모리/디스크 사용이 커** 경량 요건과 상충. 네이티브 후킹 모듈(`uiohook-napi`) 유지보수 부담도 있어 제외.

---

## 7. 아키텍처 스케치 (Modules)

```
DiligentHours (Tauri v2)
├── src-tauri/ (Rust 백엔드)
│   ├── InputHook        rdev 전역 키/마우스 이벤트 감지 → "입력 발생" 시그널만 상위로 전달
│   ├── SessionManager   상태머신(IDLE/RUNNING/FINISHED), 날짜 경계, 첫입력 판정, endTime 계산
│   ├── Ticker           1초 주기 remaining 갱신, sleep 복귀 시 벽시계 재동기화
│   ├── Persistence      startTime/날짜/상태/설정 JSON 저장·복원
│   │                    (Tauri app-config dir: Windows %APPDATA%\com.winm2m.diligenthours.desktop)
│   └── Tray             트레이 아이콘/툴팁/컨텍스트 메뉴, FINISHED 하이라이트/토스트
└── ui/ (정적 웹 프론트엔드, withGlobalTauri)
    ├── FloatingWin      borderless, topmost, 반투명 숫자 오버레이, 드래그 이동
    └── Settings         설정 화면
```

데이터 예시 (`state.json`):
```json
{
  "date": "2026-07-02",
  "startTime": "2026-07-02T09:12:33+09:00",
  "workDurationSeconds": 32400,
  "state": "RUNNING"
}
```

---

## 8. 로드맵 (Milestones)

- **M0 — 기획 확정**: 본 문서 리뷰, 이름/스택 확정. ✅ (Tauri 확정)
- **M1 — 코어 PoC**: 전역 후킹(rdev)으로 첫 입력 감지 → 남은 시간 계산 + 상태머신/영속화.
- **M2 — 트레이 표시**: 트레이 아이콘/툴팁으로 남은 시간(초/시분초) 표시 + 설정 최소본.
- **M3 — 플로팅 오버레이**: borderless/topmost/반투명 윈도우, 위치 저장, FINISHED 하이라이트.
- **M4 — 설정 UI & 자동실행**: 설정 화면, 부팅 자동 실행(tauri-plugin-autostart), 알림 옵션.
- **M5 — 배포**: tauri-action 릴리스 파이프라인(NSIS/.dmg) + 코드 서명 + 절전/자정 엣지케이스 안정화.

---

## 9. 열린 질문 (Open Questions / 결정 필요)

1. ~~기술 스택: A(.NET/WPF) vs B(Tauri)~~ → **결정됨: Tauri** (6절 참고, v0.4)
2. 시작 트리거에 **마우스 단순 이동**을 포함할지(오탐 가능) vs 클릭/키입력만?
3. 앱이 근무 시작 후 뒤늦게 켜졌을 때 정책(그 시점 시작 인정 / 수동 보정 요구)?
4. 점심시간 등 휴게시간을 근무시간에서 제외/일시정지할 필요가 있는가? (단순화를 위해 v1 제외 제안)
5. 여러 번 출퇴근 시나리오 대응 범위 (v1은 하루 1사이클 + 수동리셋 제안)?
6. 알림 강도: 조용한 하이라이트만 vs 토스트+사운드 기본 on?

---

## 10. 빌드 및 배포 (Build & Release)

상세 단계별 절차는 [docs/BUILD.md](BUILD.md) 참고. 여기서는 개요만 정리한다.

### 10.1 로컬 개발 (OS별)

- **공통**: Rust stable + `tauri-cli` (`cargo install tauri-cli --version "^2"`). 프론트엔드는 정적 `ui/` 디렉터리이므로 **Node/번들러 불필요** — `cargo tauri dev` 만으로 실행.
- **Windows**: Visual Studio Build Tools(MSVC C++), WebView2 런타임(Win10/11 기본 탑재).
- **macOS**: Xcode Command Line Tools (`xcode-select --install`).
- **Linux(개발 확인용)**: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev` 등 시스템 패키지. 단, 전역 후킹 동작 확인의 1차 기준은 Windows.

### 10.2 Linux → Windows 크로스 컴파일 (cargo-xwin)

Linux 개발 머신에서 Windows용 NSIS 인스톨러까지 빌드할 수 있다.

```bash
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin
sudo apt install nsis lld llvm clang        # NSIS 패키징 + lld-link 링커
cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

- `cargo-xwin`이 Microsoft CRT/Windows SDK 헤더·라이브러리를 자동 다운로드(최초 1회, 라이선스 동의 필요).
- 산출물: `src-tauri/target/x86_64-pc-windows-msvc/release/` (exe) 및 `.../release/bundle/nsis/` (설치 프로그램).

### 10.3 GitHub Actions 릴리스 플로우

- `v*` 태그 푸시 → `.github/workflows/release.yml` 트리거.
- `windows-latest` / `macos-latest` 매트릭스에서 `tauri-apps/tauri-action@v0` 실행.
- 산출물(NSIS `.exe`, macOS `.dmg`)을 **드래프트 GitHub Release**에 자동 업로드 → 릴리스 노트 검토 후 수동 공개.

### 10.4 플랫폼별 주의사항 (Caveats)

- **macOS 권한**: 전역 입력 감지(rdev → `CGEventTap`)에는 **입력 모니터링(Input Monitoring)** 및 **손쉬운 사용(Accessibility)** 권한이 필요하다. 최초 실행 시 시스템 설정 > 개인정보 보호 및 보안에서 허용해야 후킹이 동작한다.
- **rdev 런루프 제약**: macOS에서 `rdev::listen`은 메인 스레드의 CFRunLoop을 필요로 하는 제약이 있어, Tauri 이벤트 루프와의 통합(스레드 배치)에 주의가 필요하다.
- **Gatekeeper/공증(macOS)**: Apple Developer ID 서명 + notarization이 없는 빌드는 "확인되지 않은 개발자" 경고가 뜬다. 미서명 빌드는 **우클릭 → 열기**로 실행 가능함을 다운로드 안내에 명시. 정식 배포 시 Developer ID 인증서 확보 필요.
- **Windows SmartScreen**: 코드 서명이 없는 `.exe`는 SmartScreen 경고("추가 정보 → 실행")가 표시된다. 코드 서명 인증서 확보 전까지 README/릴리스 노트에 안내 문구를 포함한다.

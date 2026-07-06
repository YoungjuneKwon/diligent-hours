# DiligentHours

> 출근 후 첫 키보드/마우스 입력을 "업무 시작"으로 간주하여, 합의된 근무시간이 끝날 때까지 남은 시간을 데스크탑에 표시하고 종료 시각을 알려주는 데스크탑 타이머. 약속된 시간 동안 성실히 집중해서 일하고, 그 시간이 끝나면 깔끔하게 마무리하도록 돕는다.

## 한 줄 요약

- **감지**: 당일 00시 이후 첫 전역 입력(마우스/키보드) 이벤트를 근무 시작 시각으로 기록
- **카운트다운**: 시작 시각 + 설정 근무시간(예: 9시간)까지 남은 시간 표시
- **표시**: 트레이 아이콘 또는 반투명 플로팅 윈도우 (초 단위 / 시:분:초 선택)
- **알림**: 남은 시간이 0이 되면 하이라이트로 종료 시각 알림
- **일 단위 리셋**: 0이 된 후 입력이 있어도 당일에는 재시작 안 함. 날짜가 바뀐 뒤 첫 입력에서 새 사이클 시작

## 이름의 의미

**DiligentHours** = *Diligent*(성실한·부지런한) + *Hours*(시간). 약속된 시간 동안 성실하게 집중해서 일한다는 앱의 취지를 담았다.

## 기술 스택

- **[Tauri v2](https://tauri.app/)** — Rust 백엔드 + OS 내장 WebView. 경량 바이너리/메모리로 트레이 상주형 앱에 적합
- **Rust** — 상태머신, 카운트다운, 영속화 등 코어 로직
- **[rdev](https://crates.io/crates/rdev)** — 전역 키보드/마우스 입력 감지 (Windows: `SetWindowsHookEx`, macOS: `CGEventTap`)
- **vanilla HTML/CSS/JS** — 정적 UI, 번들러/Node 빌드 없음 (`withGlobalTauri`)
- 대상 플랫폼: **Windows (1차)**, **macOS (2차)**

## 폴더 구조

```
diligent-hours/
├── src-tauri/   Rust 백엔드 (Tauri 앱, 전역 후킹, 상태머신, 트레이)
├── ui/          정적 웹 프론트엔드 (플로팅 오버레이, 설정 화면)
└── docs/        설계 문서(SPEC.md), 빌드 가이드(BUILD.md)
```

## 빌드 방법

상세 절차는 [docs/BUILD.md](docs/BUILD.md) 참고. 요약:

```bash
# 개발 실행 (Node/번들러 불필요)
cargo tauri dev

# 릴리스 빌드 (각 OS 네이티브)
cargo tauri build

# Linux에서 Windows용 크로스 컴파일 (cargo-xwin)
cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

## 다운로드

- **GitHub Releases** (예정): `v*` 태그 릴리스 시 Windows NSIS 설치 파일(`.exe`)과 macOS `.dmg`가 자동 빌드되어 올라간다.
- 미서명 빌드 주의: Windows SmartScreen 경고 시 "추가 정보 → 실행", macOS는 우클릭 → 열기로 실행.

## 개인정보 원칙

- 전역 입력에서 **"입력이 발생했다"는 사실(타임스탬프)만** 사용한다. **키 입력 내용은 일절 기록·저장·전송하지 않는다** (키로깅 없음).
- **네트워크 통신 없음** — 완전 오프라인으로 동작하며, 모든 데이터(시작 시각/설정)는 로컬 앱 설정 폴더에만 저장된다.

## 문서

- [설계 문서 / 요구사항 명세](docs/SPEC.md)
- [빌드 가이드](docs/BUILD.md)

## 상태

- **v0.2.2 릴리스** — [GitHub Releases](https://github.com/YoungjuneKwon/diligent-hours/releases)
- v0.2 추가: 플로팅 창 `⋯` 팝오버(카운트다운 시간·표시 방식·종료 시각 지정·트레이로 내리기·초기화·어플 종료), 트레이 아이콘 남은 시간 파이차트, 표시 형식 정리(시:분:초 / 콤마 초)
- v0.2.1 추가: 팝오버를 본 창을 가리지 않는 위치(기본 우측)에 표시, 종료 시각 지정 값 영속화, 설정 창 배경색·투명도 조절, 여백 축소
- v0.2.2 수정: 창이 화면 우측 끝에 있을 때 팝오버가 화면 밖으로 밀리던 문제(우측 공간 부족 시 아래→위 순으로 배치), 패널 크기 실측

## 라이선스

[MIT](LICENSE)

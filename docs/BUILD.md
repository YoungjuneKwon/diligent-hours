# DiligentHours 빌드 가이드

Tauri v2 앱 빌드 절차. 프론트엔드는 정적 `ui/` 디렉터리라서 **Node.js/번들러가 필요 없다** — Rust 툴체인과 Tauri CLI만 있으면 된다.

## 사전 준비물 (Prerequisites)

| 항목 | Windows 네이티브 | macOS 네이티브 | Linux → Windows 크로스 |
|------|------------------|----------------|------------------------|
| Rust (stable) | ✅ [rustup](https://rustup.rs/) | ✅ rustup | ✅ rustup |
| Tauri CLI | `cargo install tauri-cli --version "^2"` | 동일 | 동일 |
| C/C++ 툴체인 | Visual Studio Build Tools (MSVC, "C++ 데스크톱 개발") | Xcode Command Line Tools (`xcode-select --install`) | `clang`, `lld`, `llvm` (apt) |
| WebView | WebView2 런타임 (Win10/11 기본 탑재) | 시스템 WKWebView (내장) | — (타겟 머신에서 필요) |
| 패키징 도구 | NSIS는 tauri가 자동 다운로드 | — | `nsis` (apt) |
| 크로스 러너 | — | — | `cargo-xwin` |

공통:

```bash
rustup update stable
cargo install tauri-cli --version "^2"
```

---

## (a) Windows 네이티브 빌드

1. [rustup](https://rustup.rs/) 으로 Rust stable 설치 (MSVC 툴체인 기본).
2. **Visual Studio Build Tools** 설치 — "C++를 사용한 데스크톱 개발" 워크로드 선택.
3. Tauri CLI 설치: `cargo install tauri-cli --version "^2"`
4. 저장소 루트에서:

```powershell
# 개발 실행
cargo tauri dev

# 릴리스 빌드 (NSIS 인스톨러 포함)
cargo tauri build
```

5. 산출물:
   - 실행 파일: `src-tauri\target\release\diligent-hours.exe`
   - NSIS 인스톨러: `src-tauri\target\release\bundle\nsis\*.exe`

---

## (b) macOS 네이티브 빌드

1. Xcode Command Line Tools: `xcode-select --install`
2. Rust stable + Tauri CLI 설치 (위 공통 참고).
3. 저장소 루트에서:

```bash
# 개발 실행
cargo tauri dev

# 릴리스 빌드 (.app + .dmg)
cargo tauri build
```

4. 산출물:
   - 앱 번들: `src-tauri/target/release/bundle/macos/*.app`
   - 디스크 이미지: `src-tauri/target/release/bundle/dmg/*.dmg`

### macOS 주의사항

- **전역 입력 감지 권한**: rdev(`CGEventTap`)는 **시스템 설정 > 개인정보 보호 및 보안 > 입력 모니터링 / 손쉬운 사용** 허용이 필요하다. 최초 실행 후 권한을 부여하고 앱을 재시작해야 후킹이 동작한다.
- **미서명 빌드**: Apple Developer ID 서명/공증이 없으면 Gatekeeper가 실행을 차단한다 → Finder에서 **우클릭 → 열기** 로 우회 실행.

---

## (c) Linux에서 Windows용 크로스 컴파일 (cargo-xwin)

Linux 머신에서 Windows용 `.exe` + NSIS 인스톨러까지 빌드하는 경로.

### 1. 시스템 패키지 설치

```bash
sudo apt update
sudo apt install nsis lld llvm clang
```

- `nsis`: Windows 인스톨러 패키징 (makensis)
- `lld`: MSVC 타겟 링크에 쓰이는 `lld-link` 제공
- `llvm`, `clang`: MSVC ABI용 컴파일러/도구

### 2. Rust 타겟 + cargo-xwin 설치

```bash
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin
```

### 3. 빌드

```bash
cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

- 최초 실행 시 `cargo-xwin`(내부적으로 xwin)이 **Microsoft CRT/Windows SDK** 헤더·라이브러리를 다운로드한다(수 분 소요, 캐시됨).
- Microsoft 라이선스 동의가 필요하다. 비대화형 환경(CI 등)에서는 환경 변수로 자동 동의:

```bash
XWIN_ACCEPT_LICENSE=1 cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

### 4. 산출물

- 실행 파일: `src-tauri/target/x86_64-pc-windows-msvc/release/diligent-hours.exe`
- NSIS 인스톨러: `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe`

---

## (d) GitHub Actions 릴리스

`v*` 태그를 푸시하면 `.github/workflows/release.yml`이 `windows-latest`/`macos-latest`에서 tauri-action으로 빌드하여 **드래프트 GitHub Release**에 산출물을 업로드한다.

```bash
git tag v0.1.0
git push origin v0.1.0
```

릴리스 노트를 검토한 뒤 드래프트를 수동으로 공개한다.

---

## (e) 트러블슈팅

| 증상 | 원인 / 해결 |
|------|-------------|
| 크로스 빌드 최초 실행이 오래 걸리거나 다운로드 중 멈춤 | xwin이 Microsoft CRT/Windows SDK를 받는 중. 네트워크 확인 후 재시도 — 캐시(`~/.cache/cargo-xwin` 또는 xwin 지정 경로)에 저장되어 이후엔 빠름. 라이선스 프롬프트에서 멈춘 경우 `XWIN_ACCEPT_LICENSE=1` 지정 |
| `lld-link: not found` / 링크 에러 | `sudo apt install lld llvm` 으로 `lld-link` 설치. 설치 후에도 못 찾으면 `which lld-link` 로 PATH 확인 |
| `makensis: not found` | `sudo apt install nsis` |
| NSIS 플러그인 관련 에러 | Tauri가 필요한 NSIS 플러그인(NSIS-ApplicationID 등)을 **`~/.cache/tauri`에 자동 다운로드**한다. 네트워크 문제로 실패했으면 해당 캐시를 지우고 재빌드 |
| macOS에서 입력이 감지되지 않음 | 입력 모니터링/손쉬운 사용 권한 미허용. 시스템 설정에서 허용 후 앱 재시작 |
| Windows에서 SmartScreen 경고 | 미서명 빌드의 정상 동작. "추가 정보 → 실행". 배포용은 코드 서명 인증서 필요 |

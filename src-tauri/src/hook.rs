//! 전역 입력 감지 (InputHook).
//!
//! ## PRIVACY — 절대 규칙 (SPEC FR-1)
//! 이 모듈은 "입력이 발생했다"는 사실만 유닛 `()` 신호로 상위에 전달한다.
//! 어떤 키가 눌렸는지, 어떤 버튼인지, 마우스 좌표가 어디인지 **절대**
//! 검사/기록/저장/전송하지 않는다. 이벤트는 "종류"(키/버튼/휠/이동)와
//! "주입 여부" 플래그만 본다. 키로깅 코드가 되지 않도록,
//! 이 파일을 수정할 때도 키 코드·스캔 코드·좌표 필드에 접근하는 코드를 넣지 말 것.
//!
//! ## 주입(INJECTED) 입력 무시 — v0.5.1
//! `SendInput` 등으로 프로그램이 넣은 입력은 근무 시작 신호로 치지 않는다.
//! 화면 잠금 중에도 아이들 방지 스크립트(9분마다 커서 이동 + F13)가 넣은 입력이
//! 자정 직후 "첫 입력"으로 잡혀 새벽 0시대에 근무가 시작되던 문제의 대응이다.
//! 판별은 Windows 저수준 훅 구조체의 flags 비트로 한다.
//! - 키보드 `KBDLLHOOKSTRUCT.flags`: `LLKHF_INJECTED`(0x10), `LLKHF_LOWER_IL_INJECTED`(0x02)
//! - 마우스 `MSLLHOOKSTRUCT.flags`: `LLMHF_INJECTED`(0x01), `LLMHF_LOWER_IL_INJECTED`(0x02)
//! rdev 는 이 플래그를 노출하지 않으므로 Windows 에서는 훅을 직접 건다.
//! 부작용: 원격 데스크톱 도구(예: Chrome 원격 데스크톱)가 넣는 입력도 주입으로
//! 분류되어 시작 신호가 되지 않는다. 그때는 "지금 시작"을 쓴다.
//!
//! ## 플랫폼 참고
//! - Windows: `SetWindowsHookExW(WH_KEYBOARD_LL / WH_MOUSE_LL)` 를 직접 건다.
//! - macOS/Linux: rdev 를 쓴다 (주입 판별 없음). macOS 는 `CGEventTap` 기반이라
//!   손쉬운 접근(Accessibility) 권한이 필요하고, 실패 시 graceful degradation 한다
//!   (앱/트레이/수동 시작은 계속 동작).

use std::sync::atomic::AtomicBool;
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 채널 플러딩 방지: 신호는 최대 500ms 에 1회만 보낸다.
/// (첫 입력 판정에는 "언제든 한 번"이면 충분하므로 손실은 문제 없음)
const MIN_SEND_INTERVAL: Duration = Duration::from_millis(500);

/// 스로틀링된 신호 전송기. 훅 스레드 안에서만 쓴다.
struct Throttled {
    tx: Sender<()>,
    last_sent: Option<Instant>,
}

impl Throttled {
    fn new(tx: Sender<()>) -> Self {
        Self { tx, last_sent: None }
    }

    fn signal(&mut self) {
        let now = Instant::now();
        let due = self
            .last_sent
            .map_or(true, |t| now.duration_since(t) >= MIN_SEND_INTERVAL);
        if due {
            self.last_sent = Some(now);
            // 유닛 신호만 전달 — 내용 없음.
            let _ = self.tx.send(());
        }
    }
}

pub fn spawn(tx: Sender<()>, include_mouse_move: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        #[cfg(windows)]
        let result = win::listen(Throttled::new(tx), include_mouse_move);
        #[cfg(not(windows))]
        let result = rdev_listen(Throttled::new(tx), include_mouse_move);

        if let Err(e) = result {
            // 훅 실패(권한 등): 한 번만 로그를 남기고 스레드를 조용히 종료.
            // 앱은 계속 실행되며 트레이/수동 시작("지금 시작")은 정상 동작한다.
            eprintln!(
                "[diligent-hours] 전역 입력 훅 시작 실패 — 자동 감지가 비활성화됩니다. \
                 트레이의 '지금 시작'을 사용하세요. (에러: {e})"
            );
        }
    });
}

#[cfg(not(windows))]
fn rdev_listen(mut out: Throttled, include_mouse_move: Arc<AtomicBool>) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    rdev::listen(move |event| {
        // PRIVACY: 이벤트 종류만 판별. 키/버튼 값과 좌표는 바인딩하지 않는다.
        let is_signal = match event.event_type {
            rdev::EventType::KeyPress(_)
            | rdev::EventType::KeyRelease(_)
            | rdev::EventType::ButtonPress(_)
            | rdev::EventType::ButtonRelease(_)
            | rdev::EventType::Wheel { .. } => true,
            // 마우스 단순 이동은 설정(includeMouseMove)에 따라 트리거 인정
            rdev::EventType::MouseMove { .. } => include_mouse_move.load(Ordering::Relaxed),
        };
        if is_signal {
            out.signal();
        }
    })
    .map_err(|e| format!("{e:?}"))
}

#[cfg(windows)]
mod win {
    //! Windows 저수준 훅. 외부 크레이트 없이 user32/kernel32 를 직접 선언한다.
    //! 훅 콜백은 훅을 건 스레드의 메시지 루프에서 호출되므로 상태는 thread_local 에 둔다.

    use super::Throttled;
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    type Hhook = *mut c_void;
    type Hinstance = *mut c_void;
    type Hwnd = *mut c_void;
    type Wparam = usize;
    type Lparam = isize;
    type Lresult = isize;
    type HookProc = unsafe extern "system" fn(i32, Wparam, Lparam) -> Lresult;

    const WH_KEYBOARD_LL: i32 = 13;
    const WH_MOUSE_LL: i32 = 14;
    const HC_ACTION: i32 = 0;
    const WM_MOUSEMOVE: Wparam = 0x0200;

    const LLKHF_LOWER_IL_INJECTED: u32 = 0x02;
    const LLKHF_INJECTED: u32 = 0x10;
    const LLMHF_INJECTED: u32 = 0x01;
    const LLMHF_LOWER_IL_INJECTED: u32 = 0x02;

    #[repr(C)]
    #[allow(dead_code)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    #[allow(dead_code)]
    struct Msg {
        hwnd: Hwnd,
        message: u32,
        wparam: Wparam,
        lparam: Lparam,
        time: u32,
        pt: Point,
        private: u32,
    }

    /// PRIVACY: `flags` 외의 필드(vk_code/scan_code)는 레이아웃 맞춤용이며 읽지 않는다.
    #[repr(C)]
    #[allow(dead_code)]
    struct KbdLlHookStruct {
        vk_code: u32,
        scan_code: u32,
        flags: u32,
        time: u32,
        extra_info: usize,
    }

    /// PRIVACY: `flags` 외의 필드(pt/mouse_data)는 레이아웃 맞춤용이며 읽지 않는다.
    #[repr(C)]
    #[allow(dead_code)]
    struct MsLlHookStruct {
        pt: Point,
        mouse_data: u32,
        flags: u32,
        time: u32,
        extra_info: usize,
    }

    #[link(name = "user32")]
    extern "system" {
        fn SetWindowsHookExW(id: i32, proc_: Option<HookProc>, hmod: Hinstance, tid: u32) -> Hhook;
        fn UnhookWindowsHookEx(hhk: Hhook) -> i32;
        fn CallNextHookEx(hhk: Hhook, code: i32, wparam: Wparam, lparam: Lparam) -> Lresult;
        fn GetMessageW(msg: *mut Msg, hwnd: Hwnd, min: u32, max: u32) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(name: *const u16) -> Hinstance;
        fn GetLastError() -> u32;
    }

    struct Ctx {
        out: Throttled,
        include_mouse_move: Arc<AtomicBool>,
    }

    thread_local! {
        static CTX: RefCell<Option<Ctx>> = const { RefCell::new(None) };
    }

    fn emit(is_move: bool) {
        CTX.with(|c| {
            if let Ok(mut guard) = c.try_borrow_mut() {
                if let Some(ctx) = guard.as_mut() {
                    if is_move && !ctx.include_mouse_move.load(Ordering::Relaxed) {
                        return;
                    }
                    ctx.out.signal();
                }
            }
        });
    }

    /// 주입 플래그 판별 (단위 테스트 대상).
    pub(super) fn kbd_is_injected(flags: u32) -> bool {
        flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED) != 0
    }

    pub(super) fn mouse_is_injected(flags: u32) -> bool {
        flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED) != 0
    }

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: Wparam, lparam: Lparam) -> Lresult {
        if code == HC_ACTION && lparam != 0 {
            // SAFETY: WH_KEYBOARD_LL 의 HC_ACTION 에서 lParam 은 KBDLLHOOKSTRUCT 포인터다.
            let flags = (*(lparam as *const KbdLlHookStruct)).flags;
            if !kbd_is_injected(flags) {
                emit(false);
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    unsafe extern "system" fn mouse_proc(code: i32, wparam: Wparam, lparam: Lparam) -> Lresult {
        if code == HC_ACTION && lparam != 0 {
            // SAFETY: WH_MOUSE_LL 의 HC_ACTION 에서 lParam 은 MSLLHOOKSTRUCT 포인터다.
            let flags = (*(lparam as *const MsLlHookStruct)).flags;
            if !mouse_is_injected(flags) {
                // 메시지 종류만 본다: 이동인지 아닌지(버튼/휠).
                emit(wparam == WM_MOUSEMOVE);
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    pub fn listen(out: Throttled, include_mouse_move: Arc<AtomicBool>) -> Result<(), String> {
        CTX.with(|c| {
            *c.borrow_mut() = Some(Ctx {
                out,
                include_mouse_move,
            })
        });
        unsafe {
            let hmod = GetModuleHandleW(std::ptr::null());
            let kb = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), hmod, 0);
            if kb.is_null() {
                return Err(format!("WH_KEYBOARD_LL 설치 실패 (GetLastError={})", GetLastError()));
            }
            let ms = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), hmod, 0);
            if ms.is_null() {
                let err = GetLastError();
                UnhookWindowsHookEx(kb);
                return Err(format!("WH_MOUSE_LL 설치 실패 (GetLastError={err})"));
            }
            // 저수준 훅은 이 스레드의 메시지 루프가 돌아야 콜백이 불린다.
            let mut msg: Msg = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
            UnhookWindowsHookEx(ms);
            UnhookWindowsHookEx(kb);
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn injected_flags() {
            assert!(!kbd_is_injected(0));
            assert!(!kbd_is_injected(0x01 | 0x20 | 0x80)); // EXTENDED/ALTDOWN/UP 은 사람 입력
            assert!(kbd_is_injected(LLKHF_INJECTED));
            assert!(kbd_is_injected(LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED));
            assert!(!mouse_is_injected(0));
            assert!(mouse_is_injected(LLMHF_INJECTED));
            assert!(mouse_is_injected(LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED));
        }
    }
}

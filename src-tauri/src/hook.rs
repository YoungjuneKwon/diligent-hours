//! 전역 입력 감지 (InputHook).
//!
//! ## PRIVACY — 절대 규칙 (SPEC FR-1)
//! 이 모듈은 "입력이 발생했다"는 사실만 유닛 `()` 신호로 상위에 전달한다.
//! 어떤 키가 눌렸는지, 어떤 버튼인지, 마우스 좌표가 어디인지 **절대**
//! 검사/기록/저장/전송하지 않는다. 아래 match 는 이벤트 "종류"만 구분하며
//! 값은 전부 `_` / `..` 로 무시한다. 키로깅 코드가 되지 않도록,
//! 이 파일을 수정할 때도 이벤트의 내용(payload)에 접근하는 코드를 넣지 말 것.
//!
//! ## 플랫폼 참고
//! - Windows: rdev 가 `SetWindowsHookEx` 저수준 훅을 사용. v0.1 1차 타겟.
//! - macOS 주의: `CGEventTap` 기반이라 손쉬운 접근(Accessibility) 권한이 필요하고,
//!   rdev::listen 은 메인 스레드 run loop 에서 돌아야 안정적이다.
//!   v0.1 은 Windows 우선이므로 백그라운드 스레드에서 실행하고, 실패 시
//!   graceful degradation 한다 (앱/트레이/수동 시작은 계속 동작).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 채널 플러딩 방지: 신호는 최대 500ms 에 1회만 보낸다.
/// (첫 입력 판정에는 "언제든 한 번"이면 충분하므로 손실은 문제 없음)
const MIN_SEND_INTERVAL: Duration = Duration::from_millis(500);

pub fn spawn(tx: Sender<()>, include_mouse_move: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut last_sent: Option<Instant> = None;

        let result = rdev::listen(move |event| {
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
            if !is_signal {
                return;
            }
            let now = Instant::now();
            let due = last_sent.map_or(true, |t| now.duration_since(t) >= MIN_SEND_INTERVAL);
            if due {
                last_sent = Some(now);
                // 유닛 신호만 전달 — 내용 없음.
                let _ = tx.send(());
            }
        });

        if let Err(e) = result {
            // 훅 실패(권한 등): 한 번만 로그를 남기고 스레드를 조용히 종료.
            // 앱은 계속 실행되며 트레이/수동 시작("지금 시작")은 정상 동작한다.
            eprintln!(
                "[diligent-hours] 전역 입력 훅 시작 실패 — 자동 감지가 비활성화됩니다. \
                 트레이의 '지금 시작'을 사용하세요. (에러: {e:?})"
            );
        }
    });
}

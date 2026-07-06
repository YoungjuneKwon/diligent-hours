//! DiligentHours — 첫 입력 감지 기반 근무시간 카운트다운 (Tauri v2).
//!
//! 스레드 구성:
//! - hook 스레드: rdev 전역 입력 감지 → mpsc 로 유닛 신호만 전달 (privacy: 내용 없음)
//! - manager 스레드: 신호 소비 → session::on_input (첫 입력 판정)
//! - ticker 스레드: 1초 주기 session::tick (자정 롤오버 / FINISHED 전이 / "tick" emit)
//!
//! 네트워크 I/O 없음 — 모든 데이터는 로컬 앱 설정 디렉터리의 JSON 파일에만 저장된다.

mod commands;
mod hook;
mod session;
mod tray;

use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc, Mutex};

use chrono::Local;
use tauri::Manager;

use session::{AppData, Phase, SessionState};

/// Tauri managed state.
pub struct AppState {
    pub data: Mutex<AppData>,
    /// hook 스레드가 lock 없이 읽는 "마우스 이동 트리거 인정" 플래그.
    pub include_mouse_move: Arc<AtomicBool>,
}

pub fn run() {
    tauri::Builder::default()
        // 단일 인스턴스: 두 번째 실행 시 기존 플로팅 창 표시+포커스
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("floating") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // --- 영속 데이터 로드 -------------------------------------------
            let config_dir = app.path().app_config_dir().unwrap_or_else(|e| {
                eprintln!("[diligent-hours] 앱 설정 디렉터리 조회 실패, temp 사용: {e}");
                std::env::temp_dir().join("com.winm2m.diligenthours.desktop")
            });
            let settings = session::load_settings(&config_dir);

            let now = Local::now();
            let today = session::today_string(&now);
            // 당일 세션 복원: 날짜가 같으면 RUNNING/FINISHED 이어감, 다르면 IDLE.
            let session_state = match session::load_state(&config_dir) {
                Some(s) if s.date == today => s,
                _ => SessionState::idle_for(today),
            };
            if session_state.state != Phase::Idle {
                // 복원된 세션은 다음 tick 에서 벽시계 기준으로 remaining 재계산됨.
                eprintln!(
                    "[diligent-hours] 당일 세션 복원: {} ({:?})",
                    session_state.date, session_state.state
                );
            }

            let include_mouse_move = Arc::new(AtomicBool::new(settings.include_mouse_move));

            // --- 플로팅 창 위치/표시 복원 ------------------------------------
            if let Some(win) = app.get_webview_window("floating") {
                if let Some((x, y)) = settings.floating_pos {
                    // 모니터 분리/해상도 변경 등으로 저장 위치가 화면 밖이면
                    // 복원하지 않고 기본 위치 사용 (창을 되찾을 방법이 없으므로).
                    let on_screen = win
                        .available_monitors()
                        .map(|monitors| {
                            monitors.iter().any(|m| {
                                let p = m.position();
                                let s = m.size();
                                x >= p.x
                                    && x < p.x + s.width as i32
                                    && y >= p.y
                                    && y < p.y + s.height as i32
                            })
                        })
                        .unwrap_or(true);
                    if on_screen {
                        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
                    } else {
                        eprintln!(
                            "[diligent-hours] 저장된 플로팅 위치 ({x}, {y}) 가 화면 밖 — 기본 위치 사용"
                        );
                    }
                }
                if settings.show_floating {
                    let _ = win.show();
                } else {
                    let _ = win.hide();
                }
            }

            // --- autostart 설정 동기화 (켜짐일 때만 enable 시도) --------------
            if settings.autostart {
                use tauri_plugin_autostart::ManagerExt;
                if let Err(e) = app.autolaunch().enable() {
                    eprintln!("[diligent-hours] autostart enable 실패: {e}");
                }
            }

            app.manage(AppState {
                data: Mutex::new(AppData {
                    settings,
                    session: session_state,
                    config_dir,
                }),
                include_mouse_move: include_mouse_move.clone(),
            });

            // --- 트레이 ------------------------------------------------------
            tray::build(app.handle())?;

            // --- 입력 훅 + 매니저 스레드 -------------------------------------
            let (tx, rx) = mpsc::channel::<()>();
            hook::spawn(tx, include_mouse_move);

            let input_handle = app.handle().clone();
            std::thread::spawn(move || {
                // hook 스레드가 죽으면 recv 가 Err → 조용히 종료.
                while rx.recv().is_ok() {
                    session::on_input(&input_handle, Local::now());
                }
            });

            // --- 1초 티커 ----------------------------------------------------
            let tick_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                session::tick(&tick_handle, Local::now());
                std::thread::sleep(std::time::Duration::from_secs(1));
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::get_settings,
            commands::set_settings,
            commands::save_floating_pos,
            commands::manual_start,
            commands::manual_reset,
            commands::set_target_time,
            commands::quit_app,
        ])
        .on_window_event(|window, event| {
            // 플로팅 창 닫기 = 숨기기. 종료는 트레이 "종료" 메뉴에서만.
            if window.label() == "floating" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                    // 트레이 토글과 동일하게 showFloating=false 영속화 + 설정 창 동기화
                    tray::persist_floating_visibility(window.app_handle(), false);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

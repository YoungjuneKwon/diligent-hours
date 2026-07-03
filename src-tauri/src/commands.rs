//! 프론트엔드 invoke 커맨드.
//! 이름은 프론트엔드 invoke 문자열과 정확히 일치해야 한다:
//! get_status / get_settings / set_settings / save_floating_pos / manual_start / manual_reset

use std::sync::atomic::Ordering;

use chrono::Local;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::session::{self, Settings, StatusPayload};
use crate::AppState;

#[tauri::command]
pub fn get_status(state: State<'_, AppState>) -> StatusPayload {
    let data = session::lock_data(&state.data);
    session::build_payload(&data, Local::now())
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    session::lock_data(&state.data).settings.clone()
}

/// 설정 저장 + 부수효과 적용 (autostart, 플로팅 표시/숨김, "settings-changed" emit).
/// 프론트엔드: invoke('set_settings', { newSettings: {...} })
#[tauri::command]
pub fn set_settings(app: AppHandle, state: State<'_, AppState>, new_settings: Settings) {
    let mut new_settings = new_settings;
    // 값 정규화 (프론트 검증과 별개로 방어)
    new_settings.normalize();

    {
        let mut data = session::lock_data(&state.data);
        // 설정 창은 floatingPos 를 편집하지 않으므로 항상 백엔드의 최신 위치를 유지.
        // (설정 창이 열려 있는 동안 드래그로 위치가 바뀌면 프론트가 들고 있는
        //  floatingPos 는 낡은 값이므로, 들어온 값은 무시한다 — FR-5 위치 기억)
        new_settings.floating_pos = data.settings.floating_pos;
        data.settings = new_settings.clone();
        session::save_settings(&data.config_dir, &data.settings);
    }

    // 훅 스레드가 참조하는 마우스 이동 트리거 플래그 갱신
    state
        .include_mouse_move
        .store(new_settings.include_mouse_move, Ordering::Relaxed);

    // 부팅 시 자동 실행
    {
        use tauri_plugin_autostart::ManagerExt;
        let autolaunch = app.autolaunch();
        let result = if new_settings.autostart {
            autolaunch.enable()
        } else {
            autolaunch.disable()
        };
        if let Err(e) = result {
            eprintln!("[diligent-hours] autostart 적용 실패: {e}");
        }
    }

    // 플로팅 창 표시/숨김
    if let Some(win) = app.get_webview_window("floating") {
        if new_settings.show_floating {
            let _ = win.show();
        } else {
            let _ = win.hide();
        }
    }

    if let Err(e) = app.emit("settings-changed", &new_settings) {
        eprintln!("[diligent-hours] settings-changed emit 실패: {e}");
    }

    // 표시 형식/근무시간 변경이 트레이 툴팁·남은 시간에 즉시 반영되도록 한 번 tick.
    session::tick(&app, Local::now());
}

/// 플로팅 창 이동 시 프론트엔드가 debounce 후 호출.
#[tauri::command]
pub fn save_floating_pos(x: i32, y: i32, state: State<'_, AppState>) {
    let mut data = session::lock_data(&state.data);
    data.settings.floating_pos = Some((x, y));
    session::save_settings(&data.config_dir, &data.settings);
}

/// 트레이/설정 화면의 "지금 시작" — IDLE 일 때만 동작.
#[tauri::command]
pub fn manual_start(app: AppHandle) {
    session::manual_start(&app, Local::now());
}

/// "오늘 리셋" — 오늘 세션을 IDLE 로 (다음 입력부터 재감지).
#[tauri::command]
pub fn manual_reset(app: AppHandle) {
    session::manual_reset(&app, Local::now());
}

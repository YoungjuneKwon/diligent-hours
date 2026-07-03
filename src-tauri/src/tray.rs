//! 트레이 아이콘 / 툴팁 / 컨텍스트 메뉴 (Tray).
//! 종료(quit)는 오직 이 트레이 메뉴에서만 가능하다 — 플로팅 창 닫기는 숨기기.

use std::sync::atomic::{AtomicBool, Ordering};

use chrono::Local;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::session;
use crate::AppState;

pub const TRAY_ID: &str = "main";

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(
        app,
        "toggle-floating",
        "플로팅 창 표시/숨기기",
        true,
        None::<&str>,
    )?;
    let start = MenuItem::with_id(app, "manual-start", "지금 시작", true, None::<&str>)?;
    let reset = MenuItem::with_id(app, "manual-reset", "오늘 리셋", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let open_settings = MenuItem::with_id(app, "open-settings", "설정", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&toggle, &start, &reset, &sep1, &open_settings, &sep2, &quit],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("DiligentHours — 대기 중")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle-floating" => toggle_floating(app),
            "manual-start" => session::manual_start(app, Local::now()),
            "manual-reset" => session::manual_reset(app, Local::now()),
            "open-settings" => open_settings_window(app),
            "quit" => app.exit(0),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    // TrayIcon 핸들은 별도 저장 없이 app.tray_by_id(TRAY_ID) 로 다시 얻는다.
    builder.build(app)?;
    Ok(())
}

/// 현재 트레이 아이콘이 FINISHED 하이라이트 상태인지 (불필요한 set_icon 반복 방지).
static ICON_HIGHLIGHTED: AtomicBool = AtomicBool::new(false);

/// session::tick 이 매초 호출 — 툴팁(+ macOS 는 타이틀) 갱신.
/// FR-6: FINISHED 시 트레이 아이콘을 빨간색으로 하이라이트, 해제 시 원복.
pub fn update_tray_text(app: &AppHandle, text: &str, finished: bool) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("DiligentHours — {text}")));
        #[cfg(target_os = "macos")]
        {
            let _ = tray.set_title(Some(text));
        }
        if ICON_HIGHLIGHTED.swap(finished, Ordering::Relaxed) != finished {
            let icon = if finished {
                app.default_window_icon().map(highlight_icon)
            } else {
                app.default_window_icon().cloned()
            };
            if let Some(icon) = icon {
                let _ = tray.set_icon(Some(icon));
            }
        }
    }
}

/// 기본 아이콘을 빨간색 쪽으로 블렌드한 FINISHED 하이라이트 아이콘 생성.
fn highlight_icon(base: &Image<'_>) -> Image<'static> {
    let mut rgba = base.rgba().to_vec();
    for px in rgba.chunks_exact_mut(4) {
        // 알파는 유지하고 색만 빨간색으로 치우치게.
        px[0] = px[0].saturating_add(((255 - px[0] as u16) * 3 / 5) as u8);
        px[1] = (px[1] as u16 * 2 / 5) as u8;
        px[2] = (px[2] as u16 * 2 / 5) as u8;
    }
    Image::new_owned(rgba, base.width(), base.height())
}

/// 플로팅 창 표시 여부를 showFloating 설정으로 영속화 + "settings-changed" 로
/// 설정 창 등과 동기화 (트레이 토글 / 플로팅 창 닫기(숨기기) 공용).
pub fn persist_floating_visibility(app: &AppHandle, show: bool) {
    let settings_clone = {
        let state = app.state::<AppState>();
        let mut data = session::lock_data(&state.data);
        data.settings.show_floating = show;
        session::save_settings(&data.config_dir, &data.settings);
        data.settings.clone()
    };
    let _ = app.emit("settings-changed", &settings_clone);
}

fn toggle_floating(app: &AppHandle) {
    let Some(win) = app.get_webview_window("floating") else {
        return;
    };
    let show = !win.is_visible().unwrap_or(false);
    if show {
        let _ = win.show();
        let _ = win.set_focus();
    } else {
        let _ = win.hide();
    }
    persist_floating_visibility(app, show);
}

fn open_settings_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    // 설정 창: 일반 데코레이션, always-on-top 아님.
    let result = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("DiligentHours 설정")
        .inner_size(440.0, 600.0)
        .resizable(false)
        .build();
    if let Err(e) = result {
        eprintln!("[diligent-hours] 설정 창 생성 실패: {e}");
    }
}

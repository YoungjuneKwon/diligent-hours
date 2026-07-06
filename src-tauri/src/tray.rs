//! 트레이 아이콘 / 툴팁 / 컨텍스트 메뉴 (Tray).
//! 종료(quit)는 오직 이 트레이 메뉴에서만 가능하다 — 플로팅 창 닫기는 숨기기.

use std::sync::atomic::{AtomicU8, Ordering};

use chrono::Local;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::session::{self, Phase};
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

// ---------------------------------------------------------------------------
// Tray pie-chart (남은 시간 진행율) — 동적 RGBA 래스터라이즈
// ---------------------------------------------------------------------------
//
// FR: 트레이 아이콘이 "남은 근무시간 진행율" 파이 차트를 그린다.
//  - 채워진(sweep) 섹터 = 남은 비율 = clamp(remaining/total, 0, 1)
//  - 12시 방향에서 시작해 시간이 갈수록 시계방향으로 줄어든다
//    (시작: 꽉 찬 원 → 종료: 빈 원). 즉 채워진 각도 = fraction * 360°.
//  - RUNNING: 청록 accent(#38bdf8), FINISHED: 빨강(#ef4444) 꽉 찬 원,
//    IDLE: 흐린 회색(#64748b) 링(대기 표시).
//  - 원/섹터 가장자리는 2x 슈퍼샘플 후 박스 다운스케일로 안티에일리어싱.
//
// 외부 크레이트 없이 직접 래스터라이즈하며, Image::new_owned(raw RGBA8) 로 넘긴다.

/// 트레이 아이콘 최종 출력 크기(px). 32x32 는 대부분 OS 트레이에서 선명하다.
const ICON_SIZE: u32 = 32;
/// 슈퍼샘플 배수 (2x → 64x64 에서 렌더 후 박스 다운스케일).
const SS: u32 = 2;

/// (R, G, B) 색상 상수.
const COLOR_RUNNING: (u8, u8, u8) = (0x38, 0xbd, 0xf8); // teal/blue accent
const COLOR_FINISHED: (u8, u8, u8) = (0xef, 0x44, 0x44); // red
const COLOR_IDLE: (u8, u8, u8) = (0x64, 0x74, 0x8b); // dim gray

/// 마지막으로 렌더된 파이의 정수 퍼센트(0..=100). 초기값 255 = "아직 없음".
static LAST_PERCENT: AtomicU8 = AtomicU8::new(255);
/// 마지막으로 렌더된 phase 판별자 (0=idle, 1=running, 2=finished, 255=없음).
static LAST_PHASE: AtomicU8 = AtomicU8::new(255);

fn phase_code(phase: Phase) -> u8 {
    match phase {
        Phase::Idle => 0,
        Phase::Running => 1,
        Phase::Finished => 2,
    }
}

/// session::tick 이 매초 호출 — 툴팁(+ macOS 타이틀)은 매 tick 갱신,
/// 파이 아이콘은 "보이는 상태(정수 퍼센트 또는 phase)가 바뀔 때만" 재생성한다.
///
/// `fraction` 은 남은 비율(0.0..=1.0). RUNNING 에서만 의미가 있으며
/// IDLE/FINISHED 는 phase 색으로 꽉 찬/빈 표현을 쓴다.
pub fn update_tray(app: &AppHandle, text: &str, phase: Phase, fraction: f64) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };

    // 툴팁 / macOS 타이틀은 매 tick 갱신 (기존 동작 유지).
    let _ = tray.set_tooltip(Some(format!("DiligentHours — {text}")));
    #[cfg(target_os = "macos")]
    {
        let _ = tray.set_title(Some(text));
    }

    // 파이 표현에 쓰는 값 정규화.
    let frac = if fraction.is_finite() {
        fraction.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let code = phase_code(phase);
    // FINISHED/IDLE 은 퍼센트가 의미 없으므로 0 으로 고정해 재렌더를 줄인다.
    let percent: u8 = match phase {
        Phase::Running => (frac * 100.0).round().clamp(0.0, 100.0) as u8,
        _ => 0,
    };

    // 스로틀: 정수 퍼센트 또는 phase 가 이전과 같으면 아이콘을 다시 그리지 않는다.
    let phase_changed = LAST_PHASE.swap(code, Ordering::Relaxed) != code;
    let percent_changed = LAST_PERCENT.swap(percent, Ordering::Relaxed) != percent;
    if !phase_changed && !percent_changed {
        return;
    }

    // 렌더는 실패해도 절대 panic 하지 않는다 (fallback: 기본 아이콘 유지/사용).
    let rgba = render_pie(phase, frac);
    let icon = Image::new_owned(rgba, ICON_SIZE, ICON_SIZE);
    let _ = tray.set_icon(Some(icon));
}

/// 남은 비율 파이 차트를 RGBA8 바이트로 래스터라이즈한다 (ICON_SIZE x ICON_SIZE).
///
/// 2x 슈퍼샘플 그리드에서 각 서브픽셀의 커버리지를 계산한 뒤 박스 필터로
/// 다운스케일해 원/섹터 가장자리를 안티에일리어싱한다. 항상 유효한 버퍼를
/// 반환하므로 호출부에서 별도 실패 처리가 필요 없다.
fn render_pie(phase: Phase, fraction: f64) -> Vec<u8> {
    let out_size = ICON_SIZE as usize;
    let hi = (ICON_SIZE * SS) as f64; // 고해상도 렌더 크기(px)
    let ss = SS as usize;

    let (fr, fg, fb) = match phase {
        Phase::Running => COLOR_RUNNING,
        Phase::Finished => COLOR_FINISHED,
        Phase::Idle => COLOR_IDLE,
    };

    // 채워진 섹터 각도. IDLE/FINISHED 는 phase 색의 "꽉 찬 원"으로 표현하고,
    // RUNNING 은 남은 비율만큼만 채운다. (FINISHED = 시간종료의 명확한 빨강 원반)
    let filled_frac = match phase {
        Phase::Running => fraction.clamp(0.0, 1.0),
        _ => 1.0,
    };
    // IDLE 은 은은한 반투명, RUNNING/FINISHED 는 불투명.
    let fill_alpha: f64 = if phase == Phase::Idle { 0.45 } else { 1.0 };

    let center = hi / 2.0;
    let outer_r = center - hi * 0.06; // 가장자리 여백
    let track_r = outer_r; // 빈 부분을 보여주는 얇은 트랙(외곽선) 반경
    let track_w = hi * 0.05; // 트랙 두께

    // 고해상도 커버리지 누적 버퍼: (r, g, b, a) 를 f64 로 모아 다운샘플.
    let mut acc = vec![0.0f64; out_size * out_size * 4];

    for py in 0..(ICON_SIZE * SS) as usize {
        for px in 0..(ICON_SIZE * SS) as usize {
            let x = px as f64 + 0.5;
            let y = py as f64 + 0.5;
            let dx = x - center;
            let dy = y - center;
            let dist = (dx * dx + dy * dy).sqrt();

            // 각도: 12시 방향 = 0, 시계방향 증가 (0..2π).
            // atan2(dx, -dy): 위쪽(-dy)이 0, 오른쪽(dx>0)이 +.
            let mut ang = dx.atan2(-dy);
            if ang < 0.0 {
                ang += std::f64::consts::TAU;
            }
            let in_sector = ang <= filled_frac * std::f64::consts::TAU;

            let (mut r, mut g, mut b, mut a) = (0.0, 0.0, 0.0, 0.0);

            // 1) 채워진 원반(섹터).
            if dist <= outer_r && in_sector {
                r = fr as f64;
                g = fg as f64;
                b = fb as f64;
                a = fill_alpha;
            }

            // 2) 얇은 트랙 링 (빈 부분도 은은한 외곽선으로 보이게).
            //    채워진 원반이 이미 있는 픽셀 위에서는 트랙을 덧그리지 않는다.
            if a == 0.0 {
                let ring_d = (dist - (track_r - track_w * 0.5)).abs();
                if dist <= track_r + 0.5 && ring_d <= track_w * 0.5 {
                    let (tr, tg, tb) = COLOR_IDLE;
                    r = tr as f64;
                    g = tg as f64;
                    b = tb as f64;
                    a = 0.35;
                }
            }

            // 서브픽셀 기여를 출력 픽셀에 누적 (박스 다운스케일).
            let ox = px / ss;
            let oy = py / ss;
            let idx = (oy * out_size + ox) * 4;
            acc[idx] += r * a;
            acc[idx + 1] += g * a;
            acc[idx + 2] += b * a;
            acc[idx + 3] += a;
        }
    }

    // 다운샘플 평균 → premultiplied 를 풀어서 straight-alpha RGBA8 로 변환.
    let samples = (ss * ss) as f64;
    let mut out = vec![0u8; out_size * out_size * 4];
    for i in 0..(out_size * out_size) {
        let idx = i * 4;
        let a_sum = acc[idx + 3];
        let (r, g, b, a) = if a_sum > 0.0 {
            (
                (acc[idx] / a_sum).round(),
                (acc[idx + 1] / a_sum).round(),
                (acc[idx + 2] / a_sum).round(),
                (a_sum / samples * 255.0).round(),
            )
        } else {
            (0.0, 0.0, 0.0, 0.0)
        };
        out[idx] = r.clamp(0.0, 255.0) as u8;
        out[idx + 1] = g.clamp(0.0, 255.0) as u8;
        out[idx + 2] = b.clamp(0.0, 255.0) as u8;
        out[idx + 3] = a.clamp(0.0, 255.0) as u8;
    }
    out
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

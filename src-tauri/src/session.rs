//! 세션 상태머신 + 설정/상태 영속화 (SessionManager + Persistence).
//!
//! SPEC 핵심 규칙 (docs/SPEC.md §2):
//! - **하루 1사이클 원칙**: 로컬 캘린더 날짜(YYYY-MM-DD)당 startTime은 단 한 번만 기록된다.
//! - **FINISHED 이후 당일 입력은 절대 사이클을 재시작하지 않는다** (수동 리셋 제외).
//!   날짜가 바뀐 뒤의 첫 입력에서만 IDLE → RUNNING 전이가 다시 발생한다.
//! - remaining 은 매 tick마다 벽시계(wall clock) 기준으로 재계산한다:
//!   `remaining = startTime + workDuration - now`.
//!   따라서 절전/최대절전 복귀나 근무 중 workDuration 설정 변경이 자동으로 반영된다.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use chrono::{DateTime, Duration as ChronoDuration, Local, TimeZone};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// 근무시간(초). 기본 9시간 = 32400초.
    pub work_duration_secs: u64,
    /// "hms" (시:분:초) | "seconds" (초 단위)
    pub display_format: String,
    /// 플로팅 창 표시 여부
    pub show_floating: bool,
    /// 플로팅 창 배경 불투명도 (0.15 ~ 1.0)
    pub floating_opacity: f64,
    /// 플로팅 창 글자 크기(px)
    pub font_size_px: u32,
    /// 마우스 "이동"도 시작 트리거로 인정할지 여부
    pub include_mouse_move: bool,
    /// FINISHED 시 OS 토스트 알림
    pub notify_toast: bool,
    /// FINISHED 시 짧은 사운드(프론트엔드 WebAudio)
    pub notify_sound: bool,
    /// 부팅 시 자동 실행
    pub autostart: bool,
    /// 플로팅 창 저장 위치 (물리 좌표)
    pub floating_pos: Option<(i32, i32)>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            work_duration_secs: 32_400, // 9시간
            display_format: "hms".to_string(),
            show_floating: true,
            floating_opacity: 0.85,
            font_size_px: 30,
            include_mouse_move: true,
            notify_toast: true,
            notify_sound: false,
            autostart: false,
            floating_pos: None,
        }
    }
}

impl Settings {
    /// 값 정규화 — 프론트 검증/손편집된 settings.json 과 무관하게 안전한 범위 보장.
    /// 특히 work_duration_secs 를 24h 로 제한해 chrono 시간 연산 overflow panic 을 막는다.
    pub fn normalize(&mut self) {
        if self.display_format != "seconds" {
            self.display_format = "hms".to_string();
        }
        self.floating_opacity = self.floating_opacity.clamp(0.15, 1.0);
        self.font_size_px = self.font_size_px.clamp(16, 64);
        self.work_duration_secs = self.work_duration_secs.min(24 * 3600);
    }
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Phase {
    Idle,
    Running,
    Finished,
}

impl Phase {
    /// tick 이벤트 payload 용 소문자 문자열.
    pub fn as_str(&self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Running => "running",
            Phase::Finished => "finished",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    /// 로컬 캘린더 날짜 "YYYY-MM-DD"
    pub date: String,
    /// 당일 첫 입력 시각 (RFC3339, chrono serde)
    pub start_time: Option<DateTime<Local>>,
    pub state: Phase,
    /// "종료 시각 지정" 오버라이드. Some 이면 이 시각을 종료 시각으로 사용한다
    /// (start_time + work_duration 대신). 구버전 state.json 호환을 위해 default=None.
    #[serde(default)]
    pub target_end: Option<DateTime<Local>>,
}

impl SessionState {
    pub fn idle_for(date: String) -> Self {
        Self {
            date,
            start_time: None,
            state: Phase::Idle,
            target_end: None,
        }
    }
}

/// Mutex 로 보호되는 앱 전체 상태 (managed state 내부).
pub struct AppData {
    pub settings: Settings,
    pub session: SessionState,
    pub config_dir: PathBuf,
}

/// Poison 이 발생해도 앱이 죽지 않도록 복구하며 잠근다.
pub fn lock_data(m: &Mutex<AppData>) -> MutexGuard<'_, AppData> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn today_string(now: &DateTime<Local>) -> String {
    now.format("%Y-%m-%d").to_string()
}

// ---------------------------------------------------------------------------
// Persistence (settings.json / state.json, atomic-ish write)
// ---------------------------------------------------------------------------

fn atomic_write(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // temp 파일에 쓰고 rename → 도중에 죽어도 기존 파일이 깨지지 않음.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn load_settings(dir: &Path) -> Settings {
    let path = dir.join("settings.json");
    let mut settings = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            eprintln!("[diligent-hours] settings.json 파싱 실패, 기본값 사용: {e}");
            Settings::default()
        }),
        // 파일 없음 등: 조용히 기본값.
        Err(_) => Settings::default(),
    };
    // 손편집/손상된 파일의 비정상 값 방어 (set_settings 와 동일 정규화)
    settings.normalize();
    settings
}

pub fn save_settings(dir: &Path, settings: &Settings) {
    match serde_json::to_string_pretty(settings) {
        Ok(json) => {
            if let Err(e) = atomic_write(&dir.join("settings.json"), &json) {
                eprintln!("[diligent-hours] settings.json 저장 실패: {e}");
            }
        }
        Err(e) => eprintln!("[diligent-hours] settings 직렬화 실패: {e}"),
    }
}

pub fn load_state(dir: &Path) -> Option<SessionState> {
    let path = dir.join("state.json");
    let text = std::fs::read_to_string(&path).ok()?;
    match serde_json::from_str(&text) {
        Ok(s) => Some(s),
        Err(e) => {
            eprintln!("[diligent-hours] state.json 파싱 실패, 무시: {e}");
            None
        }
    }
}

pub fn save_state(dir: &Path, session: &SessionState) {
    match serde_json::to_string_pretty(session) {
        Ok(json) => {
            if let Err(e) = atomic_write(&dir.join("state.json"), &json) {
                eprintln!("[diligent-hours] state.json 저장 실패: {e}");
            }
        }
        Err(e) => eprintln!("[diligent-hours] state 직렬화 실패: {e}"),
    }
}

// ---------------------------------------------------------------------------
// Status payload ("tick" 이벤트 / get_status 커맨드 공용)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusPayload {
    /// "idle" | "running" | "finished"
    pub state: String,
    /// RUNNING 일 때 남은 초(0 이상). 그 외 상태에서는 0.
    pub remaining_secs: i64,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub display_format: String,
    pub font_size_px: u32,
    pub floating_opacity: f64,
}

/// 유효 종료 시각. "종료 시각 지정"(target_end)이 있으면 그것을,
/// 없으면 start_time + work_duration 을 쓴다. start_time 이 없으면 None.
fn end_time_of(data: &AppData) -> Option<DateTime<Local>> {
    if let Some(target) = data.session.target_end {
        return Some(target);
    }
    data.session
        .start_time
        .map(|start| start + ChronoDuration::seconds(data.settings.work_duration_secs as i64))
}

/// 파이 차트 분모(총 카운트다운 초). target_end 가 있으면 (end - start),
/// 없으면 work_duration_secs. 0 이하이면 None(호출부에서 fraction 0 처리).
fn total_secs_of(data: &AppData) -> Option<i64> {
    if let (Some(target), Some(start)) = (data.session.target_end, data.session.start_time) {
        let total = (target - start).num_seconds();
        if total > 0 {
            Some(total)
        } else {
            None
        }
    } else {
        let total = data.settings.work_duration_secs as i64;
        if total > 0 {
            Some(total)
        } else {
            None
        }
    }
}

/// 정수를 3자리마다 콤마로 묶은 문자열 (예: 27939 → "27,939"). 크레이트 없이 직접 구성.
fn group_thousands(n: i64) -> String {
    let negative = n < 0;
    let digits = n.unsigned_abs().to_string();
    let bytes = digits.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(len + len / 3 + 1);
    if negative {
        out.push('-');
    }
    for (i, ch) in bytes.iter().enumerate() {
        if i > 0 && (len - i) % 3 == 0 {
            out.push(',');
        }
        out.push(*ch as char);
    }
    out
}

pub fn build_payload(data: &AppData, now: DateTime<Local>) -> StatusPayload {
    let end = end_time_of(data);
    let remaining_secs = match (data.session.state, end) {
        // 매 tick 벽시계 기준 재계산 (절전 복귀 / 설정 변경 자동 반영)
        (Phase::Running, Some(end)) => (end - now).num_seconds().max(0),
        _ => 0,
    };
    StatusPayload {
        state: data.session.state.as_str().to_string(),
        remaining_secs,
        start_time: data.session.start_time.map(|t| t.to_rfc3339()),
        end_time: end.map(|t| t.to_rfc3339()),
        display_format: data.settings.display_format.clone(),
        font_size_px: data.settings.font_size_px,
        floating_opacity: data.settings.floating_opacity,
    }
}

/// 트레이 툴팁 등에 쓰는 표시 문자열 (프론트엔드 포맷과 동일 규칙).
pub fn format_remaining(settings: &Settings, phase: Phase, remaining_secs: i64) -> String {
    match phase {
        Phase::Idle => "대기 중 — 첫 입력을 기다립니다".to_string(),
        Phase::Finished => "근무 시간 종료!".to_string(),
        Phase::Running => {
            let r = remaining_secs.max(0);
            if settings.display_format == "seconds" {
                // 콤마로 3자리씩 묶은 초 (예: "27,939") — "초"/"남음" 없음.
                group_thousands(r)
            } else {
                // "HH:MM:SS" (예: "07:45:39") — "남음" 없음.
                let h = r / 3600;
                let m = (r % 3600) / 60;
                let s = r % 60;
                format!("{h:02}:{m:02}:{s:02}")
            }
        }
    }
}

// ---------------------------------------------------------------------------
// State machine transitions
// ---------------------------------------------------------------------------

/// 전역 입력 신호 처리. IDLE 에서의 첫 입력만 RUNNING 전이를 일으킨다.
pub fn on_input(app: &AppHandle, now: DateTime<Local>) {
    let changed = {
        let state = app.state::<AppState>();
        let mut data = lock_data(&state.data);
        let today = today_string(&now);
        if data.session.date != today {
            // 날짜가 바뀐 뒤의 첫 입력 → 새 사이클 시작 (하루 1사이클 원칙)
            data.session = SessionState {
                date: today,
                start_time: Some(now),
                state: Phase::Running,
                target_end: None,
            };
            save_state(&data.config_dir, &data.session);
            true
        } else if data.session.start_time.is_none() {
            // 당일 첫 입력 → 근무 시작
            data.session.start_time = Some(now);
            data.session.state = Phase::Running;
            save_state(&data.config_dir, &data.session);
            true
        } else {
            // 이미 시작됨(RUNNING) 또는 종료됨(FINISHED).
            // SPEC: FINISHED 이후 입력은 당일 사이클을 절대 재시작하지 않는다.
            false
        }
    };
    if changed {
        tick(app, now);
    }
}

/// 트레이 "지금 시작": IDLE 일 때만 수동 시작.
pub fn manual_start(app: &AppHandle, now: DateTime<Local>) {
    let changed = {
        let state = app.state::<AppState>();
        let mut data = lock_data(&state.data);
        let today = today_string(&now);
        if data.session.date != today {
            data.session = SessionState::idle_for(today);
        }
        if data.session.state != Phase::Idle || data.session.start_time.is_some() {
            false // RUNNING/FINISHED 에서는 수동 시작 불가
        } else {
            data.session.start_time = Some(now);
            data.session.state = Phase::Running;
            save_state(&data.config_dir, &data.session);
            true
        }
    };
    if changed {
        tick(app, now);
    }
}

/// 트레이 "오늘 리셋": 오늘 세션을 IDLE 로 되돌린다 (다음 입력부터 재감지).
pub fn manual_reset(app: &AppHandle, now: DateTime<Local>) {
    {
        let state = app.state::<AppState>();
        let mut data = lock_data(&state.data);
        data.session = SessionState::idle_for(today_string(&now));
        save_state(&data.config_dir, &data.session);
    }
    tick(app, now);
}

/// "종료 시각 지정": 오늘 로컬 날짜의 hour:minute:00 을 종료 시각으로 설정한다.
/// start_time 이 없으면 now 를 기준 시작점으로 삼고, now >= target 이면 즉시 FINISHED.
pub fn set_target_time(app: &AppHandle, now: DateTime<Local>, hour: u32, minute: u32) {
    let (finished_now, notify_toast) = {
        let state = app.state::<AppState>();
        let mut data = lock_data(&state.data);
        let today = today_string(&now);

        // 날짜가 바뀌었으면 먼저 오늘 IDLE 로 정리.
        if data.session.date != today {
            data.session = SessionState::idle_for(today);
        }

        // 오늘 로컬 날짜의 hour:minute:00 을 target 으로. 실패/모호하면 now 로 폴백.
        let target = now
            .date_naive()
            .and_hms_opt(hour.min(23), minute.min(59), 0)
            .and_then(|naive| now.timezone().from_local_datetime(&naive).single())
            .unwrap_or(now);

        // 기준 시작점: 이미 시작됐으면 유지, 없으면 now.
        if data.session.start_time.is_none() {
            data.session.start_time = Some(now);
        }
        let was_finished = data.session.state == Phase::Finished;
        data.session.target_end = Some(target);
        data.session.state = if now >= target {
            Phase::Finished
        } else {
            Phase::Running
        };
        save_state(&data.config_dir, &data.session);
        // 즉시 FINISHED 로 진입한 경우(이전이 FINISHED 가 아니었을 때만) 부수효과를 낸다.
        // tick 은 RUNNING→FINISHED 전이만 감지하므로 이 경로는 tick 이 놓친다.
        let finished_now = !was_finished && data.session.state == Phase::Finished;
        (finished_now, data.settings.notify_toast)
    };
    // 즉시 FINISHED 진입 시 duration 기반 종료와 동일하게 finished 이벤트/토스트/사운드를 낸다.
    if finished_now {
        emit_finished(app, notify_toast);
    }
    // 다른 전이(manual_start/manual_reset)와 동일하게 즉시 tick 으로 UI/트레이 갱신.
    tick(app, now);
}

/// FINISHED 전이 부수효과: 프론트엔드 하이라이트/사운드용 "finished" 이벤트 + (옵션) OS 토스트.
/// tick 의 RUNNING→FINISHED 전이와 set_target_time 의 즉시 FINISHED 전이가 공용으로 호출한다.
fn emit_finished(app: &AppHandle, notify_toast: bool) {
    // 프론트엔드: 하이라이트 + (옵션) 사운드
    if let Err(e) = app.emit("finished", ()) {
        eprintln!("[diligent-hours] finished 이벤트 emit 실패: {e}");
    }
    if notify_toast {
        use tauri_plugin_notification::NotificationExt;
        if let Err(e) = app
            .notification()
            .builder()
            .title("DiligentHours")
            .body("오늘의 근무 시간이 끝났습니다. 수고하셨습니다!")
            .show()
        {
            eprintln!("[diligent-hours] 토스트 알림 실패: {e}");
        }
    }
}

/// 1초 주기 틱. 자정 롤오버 감지 → FINISHED 전이 → "tick" 이벤트 + 트레이 갱신.
pub fn tick(app: &AppHandle, now: DateTime<Local>) {
    let (payload, tray_text, phase, fraction, finished_now, notify_toast) = {
        let state = app.state::<AppState>();
        let mut data = lock_data(&state.data);
        let today = today_string(&now);

        // 자정(로컬 날짜 변경) 경과: FINISHED 여부와 무관하게 새 날짜의 IDLE 로 리셋.
        // 다음 첫 입력이 새 사이클을 시작한다.
        if data.session.date != today {
            data.session = SessionState::idle_for(today);
            save_state(&data.config_dir, &data.session);
        }

        // RUNNING 에서 remaining <= 0 → FINISHED 전이 (당일 재시작 없음)
        let mut finished_now = false;
        if data.session.state == Phase::Running {
            if let Some(end) = end_time_of(&data) {
                if (end - now).num_seconds() <= 0 {
                    data.session.state = Phase::Finished;
                    save_state(&data.config_dir, &data.session);
                    finished_now = true;
                }
            } else {
                // startTime 없는 RUNNING 은 비정상 상태: IDLE 로 복구.
                data.session.state = Phase::Idle;
                save_state(&data.config_dir, &data.session);
            }
        }

        let payload = build_payload(&data, now);
        let tray_text =
            format_remaining(&data.settings, data.session.state, payload.remaining_secs);
        // 트레이 파이 차트용 남은 비율 = remaining / total (0..=1).
        // total = target_end 지정 시 (end - start), 아니면 work_duration. total<=0 방어.
        let fraction = match total_secs_of(&data) {
            Some(total) => (payload.remaining_secs as f64 / total as f64).clamp(0.0, 1.0),
            None => 0.0,
        };
        (
            payload,
            tray_text,
            data.session.state,
            fraction,
            finished_now,
            data.settings.notify_toast,
        )
    };

    if finished_now {
        emit_finished(app, notify_toast);
    }

    if let Err(e) = app.emit("tick", &payload) {
        eprintln!("[diligent-hours] tick 이벤트 emit 실패: {e}");
    }

    crate::tray::update_tray(app, &tray_text, phase, fraction);
}

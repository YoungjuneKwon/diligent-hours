// DiligentHours 설정 창 (withGlobalTauri — 번들러 없음)
(function () {
  "use strict";

  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  function el(id) {
    return document.getElementById(id);
  }

  /** 백엔드에서 로드한 전체 설정 객체 — floatingPos 등 폼에 없는 필드 보존용 */
  let current = null;

  function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  /** "#rgb"/"#rrggbb" 를 <input type=color> 가 요구하는 "#rrggbb" 로 정규화. 잘못되면 기본값. */
  function normalizeHexColor(value, fallbackColor) {
    const fallback = fallbackColor || "#0f172a";
    if (typeof value !== "string") return fallback;
    let hex = value.trim();
    if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
      hex = "#" + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
    }
    return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : fallback;
  }

  function updateRangeLabels() {
    el("opacity-value").textContent = Number(el("opacity").value).toFixed(2);
    el("fontSize-value").textContent = el("fontSize").value + "px";
    el("padding-value").textContent = el("padding").value + "px";
  }

  /** "HH:MM" (settings.lastTarget) 을 {hour, minute} 로. 형식이 아니면 null. */
  function parseHhmm(value) {
    if (typeof value !== "string") return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!m) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour: hour, minute: minute };
  }

  /** 목표 시각 입력칸을 사용자가 손댔는지 — 손댔으면 재populate 로 되돌리지 않는다. */
  let targetDirty = false;

  /** 목표 시각 입력칸 프리필 — lastTarget 이 없으면 18:00. */
  function populateTarget(settings) {
    const last = parseHhmm(settings && settings.lastTarget) || { hour: 18, minute: 0 };
    el("target-hours").value = last.hour;
    el("target-minutes").value = last.minute;
    targetDirty = false;
    updateTargetHint();
  }

  /** 입력된 목표 시각까지 남는 시간을 안내한다 (지난 시각이면 경고). */
  function updateTargetHint() {
    const hour = clampInt(el("target-hours").value, 0, 23, 18);
    const minute = clampInt(el("target-minutes").value, 0, 59, 0);
    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    const hint = el("target-hint");
    const diffSecs = Math.floor((target - now) / 1000);
    const hhmm =
      String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
    if (diffSecs <= 0) {
      hint.textContent = hhmm + " 은 이미 지난 시각입니다 — 적용하면 바로 종료 상태가 됩니다.";
      return;
    }
    const h = Math.floor(diffSecs / 3600);
    const m = Math.floor((diffSecs % 3600) / 60);
    hint.textContent =
      "지금부터 " + hhmm + " 까지 " + (h > 0 ? h + "시간 " : "") + m + "분 남았습니다.";
  }

  function populate(settings) {
    const total = Math.max(0, Number(settings.workDurationSecs) || 0);
    el("hours").value = Math.floor(total / 3600);
    el("minutes").value = Math.floor((total % 3600) / 60);
    (settings.displayFormat === "seconds" ? el("fmt-seconds") : el("fmt-hms")).checked = true;
    el("showFloating").checked = !!settings.showFloating;
    el("bg-color").value = normalizeHexColor(settings.floatingBgColor);
    el("text-color").value = normalizeHexColor(settings.floatingTextColor, "#e2e8f0");
    el("opacity").value = settings.floatingOpacity;
    el("fontSize").value = settings.fontSizePx;
    el("padding").value = clampInt(settings.floatingPaddingPx, 0, 40, 0);
    el("win-width").value = clampInt(settings.floatingWidth, 160, 800, 300);
    el("win-height").value = clampInt(settings.floatingHeight, 70, 400, 110);
    el("includeMouseMove").checked = !!settings.includeMouseMove;
    el("notifyToast").checked = !!settings.notifyToast;
    el("notifySound").checked = !!settings.notifySound;
    el("autostart").checked = !!settings.autostart;
    updateRangeLabels();
    // 사용자가 입력해 둔(아직 적용 안 한) 목표 시각은 다른 설정 저장/브로드캐스트로 덮지 않는다.
    if (!targetDirty) {
      populateTarget(settings);
    }
  }

  function collect() {
    // current 를 복사해 폼 값을 덮어씀 → floatingPos 등 유지
    const s = Object.assign({}, current);
    const hours = clampInt(el("hours").value, 0, 24, 9);
    const minutes = clampInt(el("minutes").value, 0, 59, 0);
    s.workDurationSecs = hours * 3600 + minutes * 60;
    s.displayFormat = el("fmt-seconds").checked ? "seconds" : "hms";
    s.showFloating = el("showFloating").checked;
    s.floatingBgColor = normalizeHexColor(el("bg-color").value);
    s.floatingTextColor = normalizeHexColor(el("text-color").value, "#e2e8f0");
    s.floatingOpacity = Number(el("opacity").value);
    s.fontSizePx = clampInt(el("fontSize").value, 16, 64, 30);
    s.floatingPaddingPx = clampInt(el("padding").value, 0, 40, 0);
    s.floatingWidth = clampInt(el("win-width").value, 160, 800, 300);
    s.floatingHeight = clampInt(el("win-height").value, 70, 400, 110);
    s.includeMouseMove = el("includeMouseMove").checked;
    s.notifyToast = el("notifyToast").checked;
    s.notifySound = el("notifySound").checked;
    s.autostart = el("autostart").checked;
    return s;
  }

  let saveTimer = null;
  let saving = false;
  let pendingSettings = null;

  async function flushSaveQueue() {
    saveTimer = null;
    if (saving) return;
    saving = true;
    while (pendingSettings) {
      const s = pendingSettings;
      pendingSettings = null;
      try {
        await invoke("set_settings", { newSettings: s });
      } catch (e) {
        console.error("설정 저장 실패:", e);
      }
    }
    saving = false;

    // 백엔드 normalize 결과를 마지막 저장이 끝난 뒤 한 번만 반영한다.
    try {
      const saved = await invoke("get_settings");
      if (!pendingSettings && !saveTimer && !saving) {
        current = saved;
        populate(current);
      }
    } catch (e) {
      console.error("저장된 설정 다시 읽기 실패:", e);
    }
  }

  function scheduleSave() {
    updateRangeLabels();
    if (!current) return;
    pendingSettings = collect();
    current = pendingSettings;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSaveQueue, 60);
  }

  async function init() {
    try {
      current = await invoke("get_settings");
      populate(current);
      const version = await invoke("get_app_version");
      el("app-version").textContent = "v" + version;
    } catch (e) {
      console.error("설정 또는 버전 로드 실패:", e);
    }

    ["bg-color", "text-color", "opacity", "fontSize", "padding"].forEach(function (id) {
      el(id).addEventListener("input", scheduleSave);
    });
    [
      "hours", "minutes", "fmt-hms", "fmt-seconds", "showFloating",
      "win-width", "win-height", "includeMouseMove", "notifyToast",
      "notifySound", "autostart"
    ].forEach(function (id) {
      el(id).addEventListener("change", scheduleSave);
    });

    el("manual-start").addEventListener("click", function () {
      invoke("manual_start").catch(function (e) {
        console.error("manual_start 실패:", e);
      });
    });

    // window.confirm 은 일부 WebView(macOS WKWebView 등)에서 다이얼로그 없이
    // 항상 false 를 반환하므로 쓰지 않는다 — 버튼 2번 클릭 방식의 인페이지 확인.
    var resetBtn = el("manual-reset");
    var resetLabel = resetBtn.textContent;
    var resetConfirmTimer = null;
    resetBtn.addEventListener("click", function () {
      if (resetConfirmTimer === null) {
        // 1차 클릭: 확인 상태로 전환 (4초 내 재클릭 시 실행)
        resetBtn.textContent = "정말 리셋할까요? (다시 클릭)";
        resetConfirmTimer = setTimeout(function () {
          resetConfirmTimer = null;
          resetBtn.textContent = resetLabel;
        }, 4000);
        return;
      }
      clearTimeout(resetConfirmTimer);
      resetConfirmTimer = null;
      resetBtn.textContent = resetLabel;
      invoke("manual_reset").catch(function (e) {
        console.error("manual_reset 실패:", e);
      });
    });

    // 목표 시각: 지정한 시각까지 남은 시간으로 카운트다운을 맞춘다.
    // ("지금 시작"이 now + 근무시간을 종료 시각으로 삼는 것과 반대 방향)
    ["target-hours", "target-minutes"].forEach(function (id) {
      el(id).addEventListener("input", function () {
        targetDirty = true;
        updateTargetHint();
      });
    });
    // 입력칸을 비워둔 채 적용해도 안내와 실제 동작이 어긋나지 않게 확정값을 되쓴다.
    var targetBtn = el("target-apply");
    var targetLabel = targetBtn.textContent;
    var targetFeedbackTimer = null;
    targetBtn.addEventListener("click", function () {
      const hour = clampInt(el("target-hours").value, 0, 23, 18);
      const minute = clampInt(el("target-minutes").value, 0, 59, 0);
      el("target-hours").value = hour;
      el("target-minutes").value = minute;
      targetDirty = false;
      updateTargetHint();
      invoke("set_target_time", { hour: hour, minute: minute }).catch(function (e) {
        console.error("set_target_time 실패:", e);
      });
      // 백엔드도 lastTarget 을 저장하지만, 진행 중인 자동 저장이 낡은 스냅샷으로
      // 이 값을 덮지 않도록 로컬 캐시도 즉시 갱신한다.
      const hhmm =
        String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
      if (current) current.lastTarget = hhmm;
      targetBtn.textContent = "적용됨";
      if (targetFeedbackTimer) clearTimeout(targetFeedbackTimer);
      targetFeedbackTimer = setTimeout(function () {
        targetBtn.textContent = targetLabel;
      }, 1200);
    });

    // 창을 열어둔 채 시간이 흘러도 안내 문구가 낡지 않도록 주기 갱신.
    setInterval(updateTargetHint, 30000);

    // 트레이 토글 등 외부 변경 반영
    await listen("settings-changed", function (event) {
      // 자동 저장 도중의 이전 응답으로 사용자가 조절 중인 폼을 덮지 않는다.
      if (saving || pendingSettings || saveTimer) return;
      current = event.payload;
      populate(current);
    });
  }

  init();
})();

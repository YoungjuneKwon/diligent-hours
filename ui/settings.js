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

  let feedbackTimer = null;
  function showSavedFeedback() {
    const fb = el("save-feedback");
    fb.classList.add("visible");
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(function () {
      fb.classList.remove("visible");
    }, 1500);
  }

  async function save() {
    const s = collect();
    try {
      await invoke("set_settings", { newSettings: s });
      current = s;
      showSavedFeedback();
    } catch (e) {
      console.error("설정 저장 실패:", e);
    }
  }

  async function init() {
    try {
      current = await invoke("get_settings");
      populate(current);
    } catch (e) {
      console.error("설정 로드 실패:", e);
    }

    el("opacity").addEventListener("input", updateRangeLabels);
    el("fontSize").addEventListener("input", updateRangeLabels);
    el("padding").addEventListener("input", updateRangeLabels);
    el("save").addEventListener("click", save);

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

    // 트레이 토글 등 외부 변경 반영
    await listen("settings-changed", function (event) {
      current = event.payload;
      populate(current);
    });
  }

  init();
})();

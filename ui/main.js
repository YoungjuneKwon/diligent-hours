// DiligentHours 플로팅 창 (withGlobalTauri — 번들러 없음)
(function () {
  "use strict";

  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const tauriWindow = window.__TAURI__.window;
  const appWindow = tauriWindow.getCurrentWindow();

  const containerEl = document.getElementById("container");
  const timeEl = document.getElementById("time");

  /** 최신 상태(백엔드 "tick" payload 또는 get_status 결과) */
  let status = null;
  /** notifySound 등 판단용 설정 캐시 */
  let settings = null;

  // -------------------------------------------------------------------
  // 빠른 메뉴(팝오버) 상태 + 요소
  // -------------------------------------------------------------------
  const menuBtn = document.getElementById("menu-btn");
  const popoverEl = document.getElementById("popover");
  const popHours = document.getElementById("pop-hours");
  const popMinutes = document.getElementById("pop-minutes");
  const popFmtHms = document.getElementById("pop-fmt-hms");
  const popFmtSeconds = document.getElementById("pop-fmt-seconds");
  const popTargetHours = document.getElementById("pop-target-hours");
  const popTargetMinutes = document.getElementById("pop-target-minutes");
  const popTargetApplyBtn = document.getElementById("pop-target-apply");
  const popTrayBtn = document.getElementById("pop-tray");
  const popResetBtn = document.getElementById("pop-reset");
  const popQuitBtn = document.getElementById("pop-quit");

  /** set_settings 로 되돌려보낼 전체 설정 객체 (settings 와 동기) */
  let currentSettings = null;
  let popoverOpen = false;

  // 컴팩트/확장 창 크기 (tauri.conf.json 의 300x110 기준)
  const COMPACT_SIZE = { w: 300, h: 110 };
  const EXPANDED_SIZE = { w: 300, h: 420 };

  const LogicalSize = tauriWindow.LogicalSize;

  function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  // -------------------------------------------------------------------
  // 렌더링
  // -------------------------------------------------------------------
  function formatRemaining(secs, displayFormat) {
    const r = Math.max(0, Number(secs) || 0);
    if (displayFormat === "seconds") {
      // 3자리마다 콤마 (예: "27,939") — "초"/"남음" 없음.
      return r.toLocaleString("en-US");
    }
    // "HH:MM:SS" (예: "07:45:39") — "남음" 없음.
    const h = String(Math.floor(r / 3600)).padStart(2, "0");
    const m = String(Math.floor((r % 3600) / 60)).padStart(2, "0");
    const s = String(r % 60).padStart(2, "0");
    return h + ":" + m + ":" + s;
  }

  function applyStyle(fontSizePx, floatingOpacity) {
    if (typeof floatingOpacity === "number") {
      containerEl.style.setProperty("--opacity", String(floatingOpacity));
    }
    if (typeof fontSizePx === "number") {
      containerEl.style.setProperty("--font-size", fontSizePx + "px");
    }
  }

  function render() {
    if (!status) return;
    applyStyle(status.fontSizePx, status.floatingOpacity);
    containerEl.classList.remove("idle", "running", "finished");
    if (status.state === "running") {
      containerEl.classList.add("running");
      timeEl.textContent = formatRemaining(status.remainingSecs, status.displayFormat);
    } else if (status.state === "finished") {
      containerEl.classList.add("finished");
      timeEl.textContent = "근무 시간 종료!";
    } else {
      containerEl.classList.add("idle");
      timeEl.textContent = "대기 중";
    }
  }

  // -------------------------------------------------------------------
  // 종료 사운드 — WebAudio 오실레이터 두 톤 (오디오 에셋 없음)
  // -------------------------------------------------------------------
  function playFinishBeep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      if (ctx.state === "suspended") {
        ctx.resume().catch(function () {});
      }
      const gain = ctx.createGain();
      gain.gain.value = 0.08;
      gain.connect(ctx.destination);

      const t0 = ctx.currentTime;
      const o1 = ctx.createOscillator();
      o1.type = "sine";
      o1.frequency.value = 880; // A5
      o1.connect(gain);
      o1.start(t0);
      o1.stop(t0 + 0.18);

      const o2 = ctx.createOscillator();
      o2.type = "sine";
      o2.frequency.value = 1174.66; // D6
      o2.connect(gain);
      o2.start(t0 + 0.22);
      o2.stop(t0 + 0.5);

      setTimeout(function () {
        ctx.close().catch(function () {});
      }, 900);
    } catch (_e) {
      // 오디오 사용 불가 환경 — 무시 (토스트/하이라이트는 별도 동작)
    }
  }

  // -------------------------------------------------------------------
  // 창 이동 → 위치 저장 (debounce 800ms)
  // -------------------------------------------------------------------
  let moveTimer = null;
  function onMoved(position) {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(function () {
      invoke("save_floating_pos", { x: position.x, y: position.y }).catch(function (e) {
        console.error("save_floating_pos 실패:", e);
      });
    }, 800);
  }

  // -------------------------------------------------------------------
  // 빠른 메뉴(팝오버)
  // -------------------------------------------------------------------
  function setWindowSize(w, h) {
    try {
      if (!LogicalSize) return;
      appWindow.setSize(new LogicalSize(w, h)).catch(function (e) {
        console.error("setSize 실패:", e);
      });
    } catch (e) {
      console.error("setSize 예외:", e);
    }
  }

  /** 현재 설정값을 팝오버 컨트롤에 반영 (열 때마다 호출) */
  function syncPopoverFromSettings() {
    const src = currentSettings || settings;
    if (!src) return;
    const total = Math.max(0, Number(src.workDurationSecs) || 0);
    popHours.value = Math.floor(total / 3600);
    popMinutes.value = Math.floor((total % 3600) / 60);
    const isSeconds = src.displayFormat === "seconds";
    popFmtHms.setAttribute("aria-checked", isSeconds ? "false" : "true");
    popFmtSeconds.setAttribute("aria-checked", isSeconds ? "true" : "false");
  }

  /** 종료 시각 입력을 현재 유효 종료 시각(status.endTime)에서 채운다. 없으면 18:00. */
  function syncTargetFromStatus() {
    let hour = 18;
    let minute = 0;
    if (status && status.endTime) {
      const d = new Date(status.endTime);
      if (!Number.isNaN(d.getTime())) {
        hour = d.getHours();
        minute = d.getMinutes();
      }
    }
    popTargetHours.value = hour;
    popTargetMinutes.value = minute;
  }

  /** currentSettings 한 필드만 바꿔 전체 객체를 set_settings 로 저장 */
  async function applySettingField(mutate) {
    const base = currentSettings || settings;
    if (!base) return;
    const next = Object.assign({}, base);
    mutate(next);
    try {
      await invoke("set_settings", { newSettings: next });
      currentSettings = next;
      settings = next;
    } catch (e) {
      console.error("set_settings 실패:", e);
    }
  }

  function openPopover() {
    if (popoverOpen) return;
    popoverOpen = true;
    syncPopoverFromSettings();
    syncTargetFromStatus();
    setWindowSize(EXPANDED_SIZE.w, EXPANDED_SIZE.h);
    popoverEl.hidden = false;
    menuBtn.classList.add("open");
    menuBtn.setAttribute("aria-expanded", "true");
  }

  function closePopover() {
    if (!popoverOpen) return;
    popoverOpen = false;
    popoverEl.hidden = true;
    menuBtn.classList.remove("open");
    menuBtn.setAttribute("aria-expanded", "false");
    setWindowSize(COMPACT_SIZE.w, COMPACT_SIZE.h);
  }

  function togglePopover() {
    if (popoverOpen) closePopover();
    else openPopover();
  }

  function applyDuration() {
    const hours = clampInt(popHours.value, 0, 23, 0);
    const minutes = clampInt(popMinutes.value, 0, 59, 0);
    let total = hours * 3600 + minutes * 60;
    if (total < 60) {
      // 최소 1분 보장
      total = 60;
    }
    // 정규화된 값으로 입력 필드도 되돌려 표시
    popHours.value = Math.floor(total / 3600);
    popMinutes.value = Math.floor((total % 3600) / 60);
    applySettingField(function (s) {
      s.workDurationSecs = total;
    });
  }

  function setDisplayFormat(fmt) {
    popFmtHms.setAttribute("aria-checked", fmt === "hms" ? "true" : "false");
    popFmtSeconds.setAttribute("aria-checked", fmt === "seconds" ? "true" : "false");
    applySettingField(function (s) {
      s.displayFormat = fmt;
    });
  }

  let resetFeedbackTimer = null;
  function doReset() {
    invoke("manual_reset").catch(function (e) {
      console.error("manual_reset 실패:", e);
    });
    const original = popResetBtn.textContent;
    popResetBtn.textContent = "초기화됨";
    if (resetFeedbackTimer) clearTimeout(resetFeedbackTimer);
    resetFeedbackTimer = setTimeout(function () {
      popResetBtn.textContent = original;
    }, 1200);
  }

  let targetFeedbackTimer = null;
  function applyTargetTime() {
    const hour = clampInt(popTargetHours.value, 0, 23, 18);
    const minute = clampInt(popTargetMinutes.value, 0, 59, 0);
    popTargetHours.value = hour;
    popTargetMinutes.value = minute;
    // Tauri camelCase: Rust hour/minute → JS 키 hour/minute (단일 단어).
    invoke("set_target_time", { hour: hour, minute: minute }).catch(function (e) {
      console.error("set_target_time 실패:", e);
    });
    const original = popTargetApplyBtn.textContent;
    popTargetApplyBtn.textContent = "적용됨";
    if (targetFeedbackTimer) clearTimeout(targetFeedbackTimer);
    targetFeedbackTimer = setTimeout(function () {
      popTargetApplyBtn.textContent = original;
    }, 1200);
  }

  function doQuit() {
    try {
      invoke("quit_app").catch(function (e) {
        console.error("quit_app 실패:", e);
      });
    } catch (e) {
      console.error("quit_app 예외:", e);
    }
  }

  function setupPopover() {
    menuBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      togglePopover();
    });

    // 카운트다운 시간 — change 시 적용
    popHours.addEventListener("change", applyDuration);
    popMinutes.addEventListener("change", applyDuration);

    // 표시 방식 — 즉시 적용
    popFmtHms.addEventListener("click", function () {
      setDisplayFormat("hms");
    });
    popFmtSeconds.addEventListener("click", function () {
      setDisplayFormat("seconds");
    });

    // 트레이로 내리기 — 팝오버 닫고 showFloating=false
    popTrayBtn.addEventListener("click", function () {
      closePopover();
      applySettingField(function (s) {
        s.showFloating = false;
      });
    });

    // 종료 시각 지정 — 적용
    popTargetApplyBtn.addEventListener("click", applyTargetTime);

    // 초기화 (테스트용)
    popResetBtn.addEventListener("click", doReset);

    // 종료 — 앱 종료
    popQuitBtn.addEventListener("click", doQuit);

    // Escape 로 닫기
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && popoverOpen) {
        closePopover();
      }
    });
  }

  // -------------------------------------------------------------------
  // 초기화
  // -------------------------------------------------------------------
  async function init() {
    try {
      settings = await invoke("get_settings");
      currentSettings = settings;
      status = await invoke("get_status");
      render();
    } catch (e) {
      console.error("초기 상태 로드 실패:", e);
    }

    setupPopover();

    await listen("tick", function (event) {
      status = event.payload;
      render();
    });

    await listen("finished", function () {
      // 하이라이트는 tick(state=finished) 렌더가 담당; 여기서는 사운드만.
      if (settings && settings.notifySound) {
        playFinishBeep();
      }
    });

    await listen("settings-changed", function (event) {
      settings = event.payload;
      currentSettings = settings;
      applyStyle(settings.fontSizePx, settings.floatingOpacity);
      if (status) {
        status.displayFormat = settings.displayFormat;
        status.fontSizePx = settings.fontSizePx;
        status.floatingOpacity = settings.floatingOpacity;
      }
      // 팝오버가 열려 있으면 외부 변경(트레이 토글 등)을 컨트롤에 반영
      if (popoverOpen) {
        syncPopoverFromSettings();
      }
      render();
    });

    appWindow.onMoved(function (event) {
      onMoved(event.payload);
    });
  }

  init();
})();

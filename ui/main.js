// DiligentHours 플로팅 창 (withGlobalTauri — 번들러 없음)
(function () {
  "use strict";

  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const appWindow = window.__TAURI__.window.getCurrentWindow();

  const containerEl = document.getElementById("container");
  const timeEl = document.getElementById("time");

  /** 최신 상태(백엔드 "tick" payload 또는 get_status 결과) */
  let status = null;
  /** notifySound 등 판단용 설정 캐시 */
  let settings = null;

  // -------------------------------------------------------------------
  // 렌더링
  // -------------------------------------------------------------------
  function formatRemaining(secs, displayFormat) {
    const r = Math.max(0, Number(secs) || 0);
    if (displayFormat === "seconds") {
      return r + "초 남음";
    }
    const h = String(Math.floor(r / 3600)).padStart(2, "0");
    const m = String(Math.floor((r % 3600) / 60)).padStart(2, "0");
    const s = String(r % 60).padStart(2, "0");
    return h + ":" + m + ":" + s + " 남음";
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
  // 초기화
  // -------------------------------------------------------------------
  async function init() {
    try {
      settings = await invoke("get_settings");
      status = await invoke("get_status");
      render();
    } catch (e) {
      console.error("초기 상태 로드 실패:", e);
    }

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
      applyStyle(settings.fontSizePx, settings.floatingOpacity);
      if (status) {
        status.displayFormat = settings.displayFormat;
        status.fontSizePx = settings.fontSizePx;
        status.floatingOpacity = settings.floatingOpacity;
      }
      render();
    });

    appWindow.onMoved(function (event) {
      onMoved(event.payload);
    });
  }

  init();
})();

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

  // 팝오버 배치용 지오메트리 상수 (LOGICAL px). tauri.conf.json 의 300x110 카드 기준.
  const CARD_W = 300;
  const CARD_H = 110;
  const GAP = 6;
  const PANEL_W = 260; // #popover 폭(style.css)과 일치 — 측정 실패 시 폴백
  const PANEL_H = 320; // 패널 자연 높이 폴백 — 실제 측정값을 우선 사용

  const LogicalSize = tauriWindow.LogicalSize;
  const PhysicalPosition = tauriWindow.PhysicalPosition;
  const primaryMonitor = tauriWindow.primaryMonitor;

  // 프로그램적 창 이동/리사이즈 중에는 onMoved 저장을 건너뛴다(팝오버 확장/복원이
  // 플로팅 위치로 저장되지 않게). 실제 사용자 드래그(팝오버 닫힘)만 저장한다.
  let programmaticMove = false;
  // 팝오버가 창 top-left 를 바꾼 경우(UP) 닫을 때 복원할 원래 물리 좌표.
  let restoreCardOrigin = null;

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

  /** "#rgb"/"#rrggbb" → "r, g, b" 문자열. 잘못되면 기본 슬레이트(15,23,42). */
  function hexToRgbVar(hex) {
    const fallback = "15, 23, 42";
    if (typeof hex !== "string") return fallback;
    let h = hex.trim().replace(/^#/, "");
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return fallback;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return r + ", " + g + ", " + b;
  }

  function applyStyle(fontSizePx, floatingOpacity, floatingBgColor) {
    if (typeof floatingOpacity === "number") {
      containerEl.style.setProperty("--opacity", String(floatingOpacity));
      document.body.style.setProperty("--opacity", String(floatingOpacity));
    }
    if (typeof fontSizePx === "number") {
      containerEl.style.setProperty("--font-size", fontSizePx + "px");
    }
    if (typeof floatingBgColor === "string" && floatingBgColor) {
      document.body.style.setProperty("--dh-bg-rgb", hexToRgbVar(floatingBgColor));
    }
  }

  function render() {
    if (!status) return;
    applyStyle(status.fontSizePx, status.floatingOpacity, status.floatingBgColor);
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
    // 팝오버 확장/복원(프로그램적 이동)이나 팝오버가 열린 동안의 이동은 저장하지 않는다.
    if (programmaticMove || popoverOpen) return;
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
  /** #container(카드) 와 #popover(패널) 를 인라인으로 배치. 오프셋은 LOGICAL px. */
  function placeElements(cardLeft, cardTop, panelLeft, panelTop) {
    containerEl.style.left = cardLeft + "px";
    containerEl.style.top = cardTop + "px";
    popoverEl.style.left = panelLeft + "px";
    popoverEl.style.top = panelTop + "px";
  }

  /** 카드를 창 전체(컴팩트)로 되돌린다. */
  function resetCardToCompact() {
    containerEl.style.left = "0px";
    containerEl.style.top = "0px";
  }

  /** 팝오버가 열린 동안 카드 드래그를 비활성화(창이 커진 상태로 끌려가지 않게). */
  function setCardDraggable(enabled) {
    const dragEls = [containerEl, timeEl];
    dragEls.forEach(function (elm) {
      if (!elm) return;
      if (enabled) {
        elm.setAttribute("data-tauri-drag-region", "");
      } else {
        elm.removeAttribute("data-tauri-drag-region");
      }
    });
  }

  /**
   * #popover 의 실제 렌더 크기(LOGICAL css px)를 측정한다. 팝오버는 닫혀 있을 때
   * [hidden] 이므로, 잠시 화면 밖에서 visibility:hidden 으로 렌더시켜 offset 크기를
   * 읽는다. 측정 실패(0) 시 상수(PANEL_W/PANEL_H)로 폴백한다.
   * openPopover 는 이미 popoverEl.hidden=false 로 만든 뒤 호출하지만, 배치 전
   * 안정적인 크기를 얻기 위해 안전하게 강제 측정한다.
   */
  function measurePanel() {
    let w = 0;
    let h = 0;
    const el = popoverEl;
    // 현재 인라인 스타일을 저장했다가 복원.
    const saved = {
      hidden: el.hidden,
      visibility: el.style.visibility,
      left: el.style.left,
      top: el.style.top,
      maxHeight: el.style.maxHeight,
      overflowY: el.style.overflowY,
    };
    try {
      el.hidden = false;
      el.style.visibility = "hidden";
      el.style.left = "-10000px";
      el.style.top = "0px";
      // 뷰포트 상대 제약(max-height: calc(100vh-…))을 잠시 해제해 자연 높이를 읽는다.
      // 그렇지 않으면 측정 시점의 컴팩트 창(110px)에 맞춰 클램프되어 panelH 가 과소평가된다.
      el.style.maxHeight = "none";
      el.style.overflowY = "visible";
      // 강제 리플로우 후 측정.
      w = el.offsetWidth;
      h = el.offsetHeight;
    } catch (_e) {
      w = 0;
      h = 0;
    } finally {
      el.style.visibility = saved.visibility;
      el.style.left = saved.left;
      el.style.top = saved.top;
      el.style.maxHeight = saved.maxHeight;
      el.style.overflowY = saved.overflowY;
      el.hidden = saved.hidden;
    }
    return {
      panelW: w > 0 ? w : PANEL_W,
      panelH: h > 0 ? h : PANEL_H,
    };
  }

  /** 팝오버를 카드 옆(우/하/상)에 겹치지 않게 배치하고 창을 확장한다.
      우선순위: RIGHT → DOWN → UP. 어디에도 안 맞으면 세로 여유가 큰 쪽(DOWN/UP)을
      골라 카드를 화면 안에 유지하고 패널은 스크롤(max-height)로 처리한다. */
  async function expandForPopover() {
    // 실제 패널 크기(LOGICAL css px) 측정.
    const meas = measurePanel();
    const panelW = meas.panelW;
    const panelH = meas.panelH;

    // 블라인드 폴백(모니터/좌표 정보 전무): DOWN 배치.
    // 카드는 inner-left 0 에 두어 화면상의 x 를 유지하고, 패널은 카드 아래.
    // 창 폭은 max(CARD_W, panelW) 이므로 카드 왼쪽 정렬로 카드가 화면 밖으로 나가지 않는다.
    const blindDownFallback = function () {
      restoreCardOrigin = null;
      const winW = Math.max(CARD_W, panelW);
      const winH = CARD_H + GAP + panelH;
      if (LogicalSize) {
        appWindow.setSize(new LogicalSize(winW, winH)).catch(function (e) {
          console.error("setSize 실패:", e);
        });
      }
      placeElements(0, 0, 0, CARD_H + GAP);
    };

    let outer, monitor;
    try {
      outer = await appWindow.outerPosition();
    } catch (e) {
      console.error("outerPosition 조회 실패, DOWN 폴백:", e);
      programmaticMove = true;
      blindDownFallback();
      return;
    }

    // 모니터 획득: currentMonitor → primaryMonitor 폴백.
    try {
      monitor = await appWindow.currentMonitor();
    } catch (e) {
      console.error("currentMonitor 조회 실패:", e);
      monitor = null;
    }
    if (!monitor && typeof primaryMonitor === "function") {
      try {
        monitor = await primaryMonitor();
      } catch (e) {
        console.error("primaryMonitor 조회 실패:", e);
        monitor = null;
      }
    }

    const cardX = outer.x;
    const cardY = outer.y;

    if (!monitor) {
      // 두 모니터 조회 모두 실패 → 블라인드 DOWN(RIGHT 아님).
      programmaticMove = true;
      blindDownFallback();
      return;
    }

    const scale = monitor.scaleFactor || 1;
    const monTop = monitor.position.y;
    const monRight = monitor.position.x + monitor.size.width;
    const monBottom = monitor.position.y + monitor.size.height;

    const rightW = CARD_W + GAP + panelW;
    const rightH = Math.max(CARD_H, panelH);
    const stackW = Math.max(CARD_W, panelW);
    const downH = CARD_H + GAP + panelH;
    const upH = panelH + GAP + CARD_H;

    // 후보 배치: [RIGHT, DOWN, UP] 순. LEFT 는 제거됨.
    const candidates = [
      {
        name: "RIGHT",
        winX: cardX,
        winY: cardY,
        winW: rightW,
        winH: rightH,
        cardL: 0,
        cardT: 0,
        panelL: CARD_W + GAP,
        panelT: 0,
        fits: cardX + rightW * scale <= monRight && cardY + rightH * scale <= monBottom,
      },
      {
        name: "DOWN",
        winX: cardX,
        winY: cardY,
        winW: stackW,
        winH: downH,
        cardL: 0,
        cardT: 0,
        panelL: 0,
        panelT: CARD_H + GAP,
        fits: cardY + downH * scale <= monBottom && cardX + stackW * scale <= monRight,
      },
      {
        name: "UP",
        winX: cardX,
        winY: cardY - (panelH + GAP) * scale,
        winW: stackW,
        winH: upH,
        cardL: 0,
        cardT: panelH + GAP,
        panelL: 0,
        panelT: 0,
        fits: cardY - (panelH + GAP) * scale >= monTop && cardX + stackW * scale <= monRight,
      },
    ];

    let chosen = candidates.find(function (c) {
      return c.fits;
    });

    // 이번 오픈에서 패널에 강제로 건 인라인 max-height(px, LOGICAL). 폴백 스크롤용.
    let clampedPanelH = null;

    if (!chosen) {
      // 어디에도 완전히 맞지 않음(작은 화면) → 세로 여유가 큰 쪽 선택, 카드는 화면 유지.
      // 아래 여유: 카드 하단 ~ 모니터 하단(DOWN). 위 여유: 모니터 상단 ~ 카드 상단(UP).
      const roomBelow = monBottom - (cardY + CARD_H * scale);
      const roomAbove = cardY - monTop;
      const goDown = roomBelow >= roomAbove;
      // 선택 후보를 복제해서 창 높이를 화면 안 여유에 맞춰 줄이고, 패널 max-height 를
      // 그 여유(LOGICAL px)로 명시한다. 그래야 CSS overflow-y:auto 가 실제로 스크롤되고
      // 창이 모니터 밖으로 나가지 않는다.
      if (goDown) {
        // DOWN: 카드는 그대로, 패널은 카드 아래. 아래 여유(로지컬)만큼만 패널을 노출.
        const panelRoom = Math.max(0, Math.floor(roomBelow / scale) - GAP);
        clampedPanelH = panelRoom;
        chosen = Object.assign({}, candidates[1], {
          winH: CARD_H + GAP + panelRoom,
        });
      } else {
        // UP: 창 top-left 을 monTop 에 맞추고, 카드는 창 하단에 유지. 패널은 위 여유만큼.
        const panelRoom = Math.max(0, Math.floor(roomAbove / scale) - GAP);
        clampedPanelH = panelRoom;
        chosen = Object.assign({}, candidates[2], {
          winY: monTop,
          winH: panelRoom + GAP + CARD_H,
          cardT: panelRoom + GAP,
          panelT: 0,
        });
      }
    }

    programmaticMove = true;
    try {
      const movesWindow =
        Math.round(chosen.winX) !== Math.round(cardX) || Math.round(chosen.winY) !== Math.round(cardY);
      if (movesWindow && PhysicalPosition) {
        await appWindow.setPosition(new PhysicalPosition(Math.round(chosen.winX), Math.round(chosen.winY)));
        // 닫을 때 카드를 원래 자리로 되돌리기 위해 원점 저장(UP 등 창 top-left 이동 시).
        restoreCardOrigin = { x: cardX, y: cardY };
      } else {
        restoreCardOrigin = null;
      }
      if (LogicalSize) {
        await appWindow.setSize(new LogicalSize(chosen.winW, chosen.winH));
      }
      // 폴백(none-fits)일 때만 패널 높이를 화면 안 여유로 명시해 스크롤되게 한다.
      // 정상 배치는 CSS 기본 max-height(calc(100vh-12px)) 에 맡긴다.
      popoverEl.style.maxHeight = clampedPanelH != null ? clampedPanelH + "px" : "";
      placeElements(chosen.cardL, chosen.cardT, chosen.panelL, chosen.panelT);
    } catch (e) {
      console.error("팝오버 확장 실패, DOWN 폴백:", e);
      blindDownFallback();
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

  /** 종료 시각 입력을 채운다: lastTarget(영속) → status.endTime → 기본 18:00 순. */
  function syncTargetFromStatus() {
    let hour = 18;
    let minute = 0;
    let filled = false;

    // 1) 재시작 후에도 유지되는 마지막 지정값 ("HH:MM").
    const src = currentSettings || settings;
    if (src && typeof src.lastTarget === "string") {
      const m = /^(\d{1,2}):(\d{1,2})$/.exec(src.lastTarget.trim());
      if (m) {
        const h = parseInt(m[1], 10);
        const mi = parseInt(m[2], 10);
        if (!Number.isNaN(h) && !Number.isNaN(mi)) {
          hour = Math.min(23, Math.max(0, h));
          minute = Math.min(59, Math.max(0, mi));
          filled = true;
        }
      }
    }

    // 2) 없으면 현재 유효 종료 시각에서.
    if (!filled && status && status.endTime) {
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

  async function openPopover() {
    if (popoverOpen) return;
    popoverOpen = true;
    syncPopoverFromSettings();
    syncTargetFromStatus();
    // 패널을 먼저 보이게 해서 배치/스크롤이 자연스럽게 동작하도록.
    popoverEl.hidden = false;
    menuBtn.classList.add("open");
    menuBtn.setAttribute("aria-expanded", "true");
    setCardDraggable(false);
    try {
      await expandForPopover();
    } catch (e) {
      console.error("openPopover 예외:", e);
    }
    // 이동/리사이즈가 정착한 뒤 onMoved 저장을 다시 허용.
    setTimeout(function () {
      programmaticMove = false;
    }, 250);
  }

  async function closePopover() {
    if (!popoverOpen) return;
    popoverOpen = false;
    popoverEl.hidden = true;
    // 폴백에서 걸었을 수 있는 인라인 max-height 제거 → 다음 오픈은 CSS 기본값으로.
    popoverEl.style.maxHeight = "";
    menuBtn.classList.remove("open");
    menuBtn.setAttribute("aria-expanded", "false");

    programmaticMove = true;
    try {
      if (LogicalSize) {
        await appWindow.setSize(new LogicalSize(CARD_W, CARD_H));
      }
      // UP 배치로 창을 옮겼다면 카드를 원래 물리 좌표로 복원.
      if (restoreCardOrigin && PhysicalPosition) {
        await appWindow.setPosition(new PhysicalPosition(restoreCardOrigin.x, restoreCardOrigin.y));
      }
    } catch (e) {
      console.error("closePopover 복원 실패:", e);
    }
    restoreCardOrigin = null;
    resetCardToCompact();
    setCardDraggable(true);
    setTimeout(function () {
      programmaticMove = false;
    }, 250);
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
    // 백엔드도 lastTarget 을 영속화하지만, 같은 세션 내 재오픈 시 프리필이 즉시
    // 반영되도록 캐시도 낙관적으로 갱신한다 ("HH:MM", zero-pad).
    const hhmm =
      String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
    if (currentSettings) currentSettings.lastTarget = hhmm;
    if (settings) settings.lastTarget = hhmm;
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
      // 시작 시 워터마크 모드면 시각 큐 반영(클릭-스루 자체는 백엔드가 적용).
      document.body.classList.toggle("watermark", !!(settings && settings.watermarkMode));
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

    await listen("watermark-changed", function (event) {
      // 워터마크 모드가 켜지면 창이 클릭-스루가 되어 열린 팝오버가 갇힌다.
      // 트레이에서 켠 순간 팝오버를 닫아 컴팩트 크기로 복원한다.
      // (이벤트는 IPC라 클릭-스루 상태에서도 정상 수신된다.)
      const on = event && event.payload === true;
      if (on && popoverOpen) {
        closePopover();
      }
      // 활성화 여부를 body 클래스로 표시(선택적 시각 큐). 클릭-스루는 백엔드의
      // set_ignore_cursor_events 가 담당하므로 여기서 pointer-events 는 건드리지 않는다.
      document.body.classList.toggle("watermark", on);
    });

    await listen("settings-changed", function (event) {
      settings = event.payload;
      currentSettings = settings;
      applyStyle(settings.fontSizePx, settings.floatingOpacity, settings.floatingBgColor);
      if (status) {
        status.displayFormat = settings.displayFormat;
        status.fontSizePx = settings.fontSizePx;
        status.floatingOpacity = settings.floatingOpacity;
        status.floatingBgColor = settings.floatingBgColor;
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

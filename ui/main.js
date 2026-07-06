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
  const PANEL_W = 260; // #popover 폭(style.css)과 일치
  const PANEL_H = 320; // 여백 축소 후의 패널 자연 높이 근사; 초과 시 패널 스크롤 폴백

  const LogicalSize = tauriWindow.LogicalSize;
  const PhysicalPosition = tauriWindow.PhysicalPosition;

  // 프로그램적 창 이동/리사이즈 중에는 onMoved 저장을 건너뛴다(팝오버 확장/복원이
  // 플로팅 위치로 저장되지 않게). 실제 사용자 드래그(팝오버 닫힘)만 저장한다.
  let programmaticMove = false;
  // 팝오버가 창 top-left 를 바꾼 경우(LEFT/UP) 닫을 때 복원할 원래 물리 좌표.
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

  /** 팝오버를 카드 옆(우/좌/하/상)에 겹치지 않게 배치하고 창을 확장한다. */
  async function expandForPopover() {
    // 기본(폴백): 단순 RIGHT 배치 — 창 top-left 유지, 카드 (0,0), 패널 오른쪽.
    const fallback = function () {
      restoreCardOrigin = null;
      if (LogicalSize) {
        appWindow.setSize(new LogicalSize(CARD_W + GAP + PANEL_W, Math.max(CARD_H, PANEL_H)));
      }
      placeElements(0, 0, CARD_W + GAP, 0);
    };

    let outer, monitor;
    try {
      outer = await appWindow.outerPosition();
      monitor = await appWindow.currentMonitor();
    } catch (e) {
      console.error("팝오버 배치 정보 조회 실패, RIGHT 폴백:", e);
      fallback();
      return;
    }

    const cardX = outer.x;
    const cardY = outer.y;

    if (!monitor) {
      // 모니터 정보 없음 → fit 검사 없이 RIGHT.
      programmaticMove = true;
      try {
        if (LogicalSize) {
          await appWindow.setSize(new LogicalSize(CARD_W + GAP + PANEL_W, Math.max(CARD_H, PANEL_H)));
        }
      } catch (e) {
        console.error("setSize 실패:", e);
      }
      restoreCardOrigin = null;
      placeElements(0, 0, CARD_W + GAP, 0);
      return;
    }

    const scale = monitor.scaleFactor || 1;
    const monLeft = monitor.position.x;
    const monTop = monitor.position.y;
    const monRight = monitor.position.x + monitor.size.width;
    const monBottom = monitor.position.y + monitor.size.height;

    const rightW = CARD_W + GAP + PANEL_W;
    const rightH = Math.max(CARD_H, PANEL_H);
    const downW = Math.max(CARD_W, PANEL_W);
    const downH = CARD_H + GAP + PANEL_H;

    // 후보 배치: [RIGHT, LEFT, DOWN, UP] 순으로 첫 번째로 맞는 것을 선택.
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
        name: "LEFT",
        winX: cardX - (PANEL_W + GAP) * scale,
        winY: cardY,
        winW: rightW,
        winH: rightH,
        cardL: PANEL_W + GAP,
        cardT: 0,
        panelL: 0,
        panelT: 0,
        fits: cardX - (PANEL_W + GAP) * scale >= monLeft && cardY + rightH * scale <= monBottom,
      },
      {
        name: "DOWN",
        winX: cardX,
        winY: cardY,
        winW: downW,
        winH: downH,
        cardL: 0,
        cardT: 0,
        panelL: 0,
        panelT: CARD_H + GAP,
        fits: cardY + downH * scale <= monBottom && cardX + downW * scale <= monRight,
      },
      {
        name: "UP",
        winX: cardX,
        winY: cardY - (PANEL_H + GAP) * scale,
        winW: downW,
        winH: downH,
        cardL: 0,
        cardT: PANEL_H + GAP,
        panelL: 0,
        panelT: 0,
        fits: cardY - (PANEL_H + GAP) * scale >= monTop && cardX + downW * scale <= monRight,
      },
    ];

    let chosen = candidates.find(function (c) {
      return c.fits;
    });

    if (!chosen) {
      // 완전히 맞는 배치 없음 → RIGHT 로 두되 창을 모니터 안으로 클램프(카드 우선 보임).
      chosen = candidates[0];
      let wx = chosen.winX;
      let wy = chosen.winY;
      const wPhysW = chosen.winW * scale;
      const wPhysH = chosen.winH * scale;
      if (wx + wPhysW > monRight) wx = monRight - wPhysW;
      if (wy + wPhysH > monBottom) wy = monBottom - wPhysH;
      if (wx < monLeft) wx = monLeft;
      if (wy < monTop) wy = monTop;
      chosen = Object.assign({}, chosen, { winX: wx, winY: wy });
    }

    programmaticMove = true;
    try {
      const movesWindow = Math.round(chosen.winX) !== Math.round(cardX) || Math.round(chosen.winY) !== Math.round(cardY);
      if (movesWindow && PhysicalPosition) {
        await appWindow.setPosition(new PhysicalPosition(Math.round(chosen.winX), Math.round(chosen.winY)));
        // 닫을 때 카드를 원래 자리로 되돌리기 위해 원점 저장.
        restoreCardOrigin = { x: cardX, y: cardY };
      } else {
        restoreCardOrigin = null;
      }
      if (LogicalSize) {
        await appWindow.setSize(new LogicalSize(chosen.winW, chosen.winH));
      }
      placeElements(chosen.cardL, chosen.cardT, chosen.panelL, chosen.panelT);
    } catch (e) {
      console.error("팝오버 확장 실패, RIGHT 폴백:", e);
      fallback();
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
    menuBtn.classList.remove("open");
    menuBtn.setAttribute("aria-expanded", "false");

    programmaticMove = true;
    try {
      if (LogicalSize) {
        await appWindow.setSize(new LogicalSize(CARD_W, CARD_H));
      }
      // LEFT/UP 배치로 창을 옮겼다면 카드를 원래 물리 좌표로 복원.
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

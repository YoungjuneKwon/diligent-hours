# DiligentHours

> A desktop timer that treats your first keyboard/mouse input of the day as the start of work, then shows the time remaining until the agreed workday is over and alerts you when it ends. It helps you focus and work diligently for the agreed hours, and wrap up cleanly when the time is up.

## At a glance

- **Detect**: records the first global input (mouse/keyboard) event after midnight as the work start time
- **Countdown**: shows the time remaining until start time + the configured work duration (e.g. 9 hours)
- **Display**: tray icon or a semi-transparent floating window (seconds only / HH:MM:SS)
- **Alert**: highlights to notify you when the remaining time reaches zero
- **Daily reset**: once it hits zero, further input does not restart it for the same day. A new cycle begins on the first input after the date changes.

## Tech stack

- **[Tauri v2](https://tauri.app/)** — Rust backend + the OS's built-in WebView. Its small binary/memory footprint suits a tray-resident app.
- **Rust** — core logic: state machine, countdown, persistence
- **[rdev](https://crates.io/crates/rdev)** — global keyboard/mouse input detection (Windows: `SetWindowsHookEx`, macOS: `CGEventTap`)
- **vanilla HTML/CSS/JS** — static UI, no bundler/Node build (`withGlobalTauri`)
- Target platforms: **Windows (primary)**, **macOS (secondary)**

## Folder structure

```
diligent-hours/
├── src-tauri/   Rust backend (Tauri app, global hooks, state machine, tray)
├── ui/          Static web frontend (floating overlay, settings screen)
└── docs/        Design doc (SPEC.md), build guide (BUILD.md)
```

## Building

See [docs/BUILD.md](docs/BUILD.md) for the full procedure. In short:

```bash
# Run in development (no Node/bundler required)
cargo tauri dev

# Release build (native per OS)
cargo tauri build

# Cross-compile for Windows from Linux (cargo-xwin)
cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

## Download

- **GitHub Releases**: on a `v*` tag, the Windows NSIS installer (`.exe`) and the macOS `.dmg` are built automatically and attached to the release.
- Unsigned build notice: on Windows, if SmartScreen warns, choose "More info → Run anyway"; on macOS, right-click → Open.

## Privacy principles

- From global input, only **the fact that input occurred (a timestamp)** is used. **Key contents are never recorded, stored, or transmitted** (no keylogging).
- **No network communication** — it runs fully offline, and all data (start time / settings) is stored only in the local app config folder.

## Documentation

- [Design doc / requirements spec](docs/SPEC.md)
- [Build guide](docs/BUILD.md)

## Status

- **v0.3.0 released** — [GitHub Releases](https://github.com/YoungjuneKwon/diligent-hours/releases)
- Added in v0.2: floating-window `⋯` popover (countdown duration, display format, set end time, minimize to tray, reset, quit app), tray-icon pie chart of remaining time, cleaned-up display format (HH:MM:SS / comma-grouped seconds)
- Added in v0.2.1: show the popover in a position that does not cover the main window (right side by default), persist the set end time, background color / opacity controls in the settings window, reduced padding
- Fixed in v0.2.2: the popover being pushed off-screen when the window sits at the right edge (falls back to below → above when there isn't enough room on the right), plus measuring the actual panel size
- Added in v0.3.0: watermark (click-through) mode toggled from the tray — while on, the window passes mouse clicks/drags through to the apps behind it (like a non-interactive watermark), and cannot be dragged or clicked; turn it off from the tray to interact again

## License

[MIT](LICENSE)

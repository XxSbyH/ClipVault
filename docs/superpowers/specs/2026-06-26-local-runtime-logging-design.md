# ClipVault Local Runtime Logging Design

## Context

Some Windows 11 users report that recent ClipVault builds do not visibly crash, but also do not show any window or usable feedback. The current Tauri 2 application initializes `tracing_subscriber::fmt()` without a production file sink, and release builds use the Windows subsystem, so early startup errors can disappear from the user's perspective.

This design adds local runtime logging focused on startup diagnostics. It does not add cloud reporting, telemetry, clipboard content capture, or a settings UI for reading logs in the first phase.

## Goals

- Persist startup and runtime diagnostics locally even when the renderer never loads.
- Record startup checkpoints for the dependencies required to launch ClipVault correctly.
- Include actionable failure direction hints, so logs can distinguish likely WebView2, filesystem, database, Tauri plugin, Windows integration, permission, or configuration problems.
- Capture Rust panics and Tauri run/setup failures before the application exits.
- Avoid recording clipboard text, image bytes, file contents, secrets, or other sensitive user data.

## Non-Goals

- No remote log upload or telemetry.
- No in-app log viewer in this phase.
- No OCR, cloud sync, team workflow, or other product scope changes.
- No broad refactor of clipboard, hotkey, tray, or database modules.

## Log Location and Files

The logger uses a bootstrap log directory before Tauri `setup()` is available, then records the Tauri application data directory once path resolution is available.

The preferred final location is under the Tauri application data directory:

```text
<app_data_dir>/logs/
```

On Windows this should resolve to a per-user local application data path managed by Tauri for ClipVault. Before `app.path().app_data_dir()` can be called, the bootstrap writer should use a deterministic per-user local path derived from Windows environment variables and the product name, for example:

```text
%APPDATA%/ClipVault/logs/
```

If the bootstrap path and Tauri app data log path differ, startup logging should record both paths and keep writing to the bootstrap path for that process. This avoids losing early evidence. A later phase can add migration or UI affordances if the paths need consolidation.

The code should create the log directory before database initialization and continue startup even if non-critical log cleanup fails.

Files:

- `clipvault.log`: main runtime log written through `tracing`.
- `startup.log`: append-only startup checkpoint log optimized for "nothing appeared" reports.

`startup.log` is intentionally simple text with timestamps and stage names. It should be writable before the full tracing pipeline is available, so the earliest startup evidence is not lost if subscriber setup fails.

## Startup Dependency Checkpoints

Startup logging should record each dependency as a checkpoint with status and failure direction:

| Stage | Dependency | What To Record | Failure Direction |
| --- | --- | --- | --- |
| `process_start` | Executable and environment | app version, build profile, executable path if available, OS family | wrong binary, unsupported environment, path issue |
| `log_dir` | Local filesystem | log directory path creation result | directory permission, invalid path, locked profile |
| `panic_hook` | Rust panic hook | hook installation result | panic after this point should be captured |
| `tauri_builder` | Tauri core | plugin registration start/end | Tauri runtime or plugin initialization issue |
| `single_instance_plugin` | Tauri single-instance plugin | registration result | stale instance detection or plugin failure |
| `global_shortcut_plugin` | Tauri global shortcut plugin | registration result | shortcut subsystem initialization failure |
| `clipboard_plugin` | Tauri clipboard manager plugin | registration result | clipboard API/plugin initialization failure |
| `setup_start` | Tauri setup lifecycle | setup entry reached | failure before/inside setup |
| `app_data_dir` | Tauri path resolver and filesystem | resolved app data directory and creation result | profile path, permission, filesystem issue |
| `database_open` | SQLite database and migrations | database path and open/migration result | database lock, corruption, migration failure, antivirus/file lock |
| `settings_load` | SQLite settings row | settings load result, no sensitive values | corrupt settings JSON or database issue |
| `autostart_sync` | Windows registry/autostart integration | only when enabled, result | registry permission or Windows autostart failure |
| `clipboard_monitor` | Clipboard monitoring task | start result | clipboard access, background task issue |
| `window_config` | WebView/window setup | window labels configured and result | WebView2/runtime/window creation issue |
| `tray_create` | Windows tray/menu integration | tray creation result | shell/tray/icon resource issue |
| `hotkey_register` | Windows global shortcuts and hooks | result and non-sensitive conflict direction | hotkey conflict, Windows hook failure, permission issue |
| `main_window_show` | main window visibility | whether startup args/env requested showing main window and result | window focus/show failure, WebView2 issue |
| `tauri_run` | Tauri event loop | event loop entered or returned error | runtime startup failure |

When a checkpoint fails, the log entry should include:

- stage name
- error string
- likely area, such as `webview2`, `sqlite`, `filesystem`, `tauri_plugin`, `windows_api`, `hotkey`, `tray`, or `autostart`
- recommended next inspection point in short text

Example:

```text
2026-06-26T10:30:00.000+08:00 ERROR stage=database_open area=sqlite direction="check database lock/corruption or antivirus file lock" error="..."
```

## External Component Coverage

The first phase should explicitly identify these external components in startup logs:

- Microsoft Edge WebView2 Runtime: indirectly through window/WebView creation failures and a startup environment note that WebView2 is required.
- SQLite database file: database path, open result, migration result, and likely lock/corruption direction on failure.
- Windows clipboard API: clipboard plugin registration and monitor startup.
- Windows global shortcut and input hook APIs: global shortcut plugin registration, hotkey registration, wheel hook setup when applicable.
- Windows tray/shell APIs: tray creation and icon/menu setup.
- Windows registry/autostart integration: only when the user setting enables launch on startup.
- Tauri plugins: single instance, clipboard manager, and global shortcut registration.
- Local app data filesystem: app data directory and logs directory creation.
- Packaged resources: tray/icon resource failures should point to resource packaging or shell integration.

The log should not attempt invasive system probing. It should record the known dependency list and the result of the app's actual startup operations. This keeps the feature low-risk and avoids adding fragile platform checks.

## Architecture

`src-tauri/src/logger.rs` becomes the logging boundary:

- Initialize a bootstrap startup writer before building the Tauri application.
- Initialize or attach a file-backed tracing subscriber as early as the final log path is known.
- Provide a small startup checkpoint writer that can append to `startup.log` directly.
- Install a panic hook that records panic location and message to both `startup.log` and `tracing`.
- Record the Tauri app data directory during setup and note whether it matches the bootstrap directory.
- Provide helpers such as `startup_info`, `startup_ok`, and `startup_error` so `lib.rs` can record stages without duplicating formatting.

`src-tauri/src/lib.rs` records startup checkpoints around existing initialization:

- call logger initialization at the beginning of `run()`
- record plugin registration boundaries
- record `setup()` sub-steps in order
- replace final `.expect("error while running tauri application")` with explicit error logging

No renderer API is required in the first phase.

## Error Handling

Logging must never be the reason ClipVault fails to start unless a required startup dependency already failed.

- If `clipvault.log` cannot be created, continue with `startup.log` if possible.
- If `startup.log` cannot be created, continue with best-effort `tracing` initialization.
- If log rotation or cleanup fails, record the cleanup error if possible and continue.
- If a real startup dependency fails, record the stage and return the original error path.

## Retention

The first implementation should use bounded local files:

- Keep `clipvault.log` and `startup.log` small enough for support sharing.
- On startup, if a file exceeds the configured size threshold, rotate it to `.1` or truncate with a clear marker.
- Keep the policy simple and dependency-free.

Exact byte thresholds can be set in implementation, but should be covered by unit tests.

## Privacy

Logs may include:

- app version
- startup stage names
- non-sensitive settings state such as whether autostart is enabled
- paths to app-owned data/log files
- error messages from Rust/Tauri/Windows APIs

Logs must not include:

- clipboard text content
- image bytes or previews
- copied file contents
- sensitive filter matches
- token-like strings from clipboard payloads
- full history item content

If an error might contain sensitive data, callers should log a sanitized summary instead of raw payloads.

## Tests

Rust unit tests should cover:

- log directory creation in a temporary app-like directory
- startup checkpoint append format
- panic hook helper formatting where practical without causing a test panic leak
- rotation/truncation behavior for oversized log files
- failure resilience when log paths are unavailable, where practical

Manual verification remains required for real Windows startup cases:

- release build starts and creates logs
- killing startup during setup leaves `startup.log`
- WebView/window creation problems produce useful direction if reproducible
- tray, hotkey, clipboard monitor, and autostart failures are visible in logs

## Rollout

Phase 1 implements local startup/runtime logging only. After real user feedback confirms the log is useful, Phase 2 can add a settings-page action to open the log directory or copy a redacted diagnostic bundle.

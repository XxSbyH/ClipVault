# Local Runtime Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local startup/runtime logs that survive invisible Windows startup failures and point to likely external dependency problem areas.

**Architecture:** Keep logging contained in `src-tauri/src/logger.rs`, with testable pure helpers for path selection, rotation, and line formatting. Instrument `src-tauri/src/lib.rs` around the existing Tauri startup sequence so the app records dependency checkpoints before and during `setup()`, without adding renderer APIs or cloud telemetry.

**Tech Stack:** Rust 2021, Tauri 2, `tracing`, `tracing-subscriber`, `std::fs`, `std::panic`, `OnceLock`, existing `tempfile` dev dependency.

---

## File Structure

- Modify `src-tauri/src/logger.rs`: replace the current console-only subscriber with local file logging, startup checkpoint helpers, rotation helpers, panic hook installation, and unit tests.
- Modify `src-tauri/src/lib.rs`: record startup dependency checkpoints around Tauri builder, plugin registration, setup sub-steps, window/tray/hotkey setup, and `run()` errors.
- No changes to `src-tauri/src/commands.rs`, `src/renderer/src/lib/tauriApi.ts`, `src/renderer/src/components/SettingsPanel.tsx`, or Tauri permissions in this phase.
- No new crates. Use only existing dependencies and the Rust standard library.

## Logging Contract

`startup.log` line format:

```text
epoch_ms=1782450000000 level=INFO stage=process_start area=process direction="ClipVault startup started" message="version=2.1.5 profile=release"
```

Required helper signatures in `logger.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoggerInit {
    pub log_dir: std::path::PathBuf,
    pub startup_log_path: std::path::PathBuf,
    pub runtime_log_path: std::path::PathBuf,
}

pub fn init() -> LoggerInit;
pub fn startup_info(stage: &str, area: &str, direction: &str, message: impl AsRef<str>);
pub fn startup_ok(stage: &str, area: &str, direction: &str, message: impl AsRef<str>);
pub fn startup_error(stage: &str, area: &str, direction: &str, error: impl std::fmt::Display);
pub fn note_tauri_app_data_dir(path: &std::path::Path);
```

Areas should use these stable string values where possible:

- `process`
- `filesystem`
- `panic`
- `tauri`
- `tauri_plugin`
- `webview2`
- `sqlite`
- `windows_api`
- `clipboard`
- `hotkey`
- `tray`
- `autostart`

---

### Task 1: Logger Pure Helpers

**Files:**
- Modify: `src-tauri/src/logger.rs`

- [ ] **Step 1: Replace `logger.rs` with pure helper tests first**

Add tests at the bottom of `src-tauri/src/logger.rs` before implementing the helpers. The file will temporarily fail to compile until Step 3.

```rust
#[cfg(test)]
mod tests {
    use std::{env, fs};

    use tempfile::tempdir;

    use super::{
        bootstrap_log_dir_from_env, escape_field, format_startup_line, rotate_if_oversized,
        MAX_LOG_BYTES,
    };

    #[test]
    fn bootstrap_log_dir_prefers_appdata_and_product_name() {
        let base = tempdir().unwrap();
        let path = bootstrap_log_dir_from_env(Some(base.path()), None);

        assert_eq!(path, base.path().join("ClipVault").join("logs"));
    }

    #[test]
    fn bootstrap_log_dir_falls_back_to_localappdata() {
        let base = tempdir().unwrap();
        let path = bootstrap_log_dir_from_env(None, Some(base.path()));

        assert_eq!(path, base.path().join("ClipVault").join("logs"));
    }

    #[test]
    fn startup_line_escapes_spaces_quotes_and_newlines() {
        let line = format_startup_line(
            123,
            "ERROR",
            "database_open",
            "sqlite",
            "check database lock",
            "bad \"db\"\nline",
        );

        assert_eq!(
            line,
            "epoch_ms=123 level=ERROR stage=database_open area=sqlite direction=\"check database lock\" message=\"bad \\\"db\\\" line\"\n"
        );
    }

    #[test]
    fn escape_field_preserves_simple_values_without_quotes() {
        assert_eq!(escape_field("sqlite"), "sqlite");
        assert_eq!(escape_field("database_open"), "database_open");
    }

    #[test]
    fn rotate_if_oversized_moves_large_file_to_dot_one() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("clipvault.log");
        fs::write(&path, vec![b'a'; MAX_LOG_BYTES + 1]).unwrap();

        rotate_if_oversized(&path).unwrap();

        assert!(!path.exists());
        assert_eq!(
            fs::read(dir.path().join("clipvault.log.1")).unwrap().len(),
            MAX_LOG_BYTES + 1
        );
    }

    #[test]
    fn rotate_if_oversized_keeps_small_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("startup.log");
        fs::write(&path, b"small").unwrap();

        rotate_if_oversized(&path).unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"small");
        assert!(!dir.path().join("startup.log.1").exists());
    }

    #[test]
    fn bootstrap_log_dir_uses_current_dir_when_env_missing() {
        let current = env::current_dir().unwrap();
        let path = bootstrap_log_dir_from_env(None, None);

        assert!(path.ends_with("ClipVault/logs") || path.ends_with("ClipVault\\logs"));
        assert!(path.starts_with(current));
    }
}
```

- [ ] **Step 2: Run logger tests and verify they fail**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo test --manifest-path src-tauri\Cargo.toml logger::tests
```

Expected: FAIL because helper functions and constants are not defined yet.

- [ ] **Step 3: Implement pure helpers**

At the top of `src-tauri/src/logger.rs`, replace the existing contents with this helper foundation. Keep the tests from Step 1 below this code.

```rust
use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const PRODUCT_NAME: &str = "ClipVault";
pub(crate) const MAX_LOG_BYTES: u64 = 1024 * 1024;

fn now_epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn bootstrap_log_dir() -> PathBuf {
    let appdata = env::var_os("APPDATA").map(PathBuf::from);
    let localappdata = env::var_os("LOCALAPPDATA").map(PathBuf::from);
    bootstrap_log_dir_from_env(appdata.as_deref(), localappdata.as_deref())
}

pub(crate) fn bootstrap_log_dir_from_env(appdata: Option<&Path>, localappdata: Option<&Path>) -> PathBuf {
    let base = appdata
        .or(localappdata)
        .map(Path::to_path_buf)
        .or_else(|| env::current_dir().ok())
        .unwrap_or_else(env::temp_dir);

    base.join(PRODUCT_NAME).join("logs")
}

pub(crate) fn rotate_if_oversized(path: &Path) -> std::io::Result<()> {
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(());
    };

    if metadata.len() <= MAX_LOG_BYTES {
        return Ok(());
    }

    let rotated = PathBuf::from(format!("{}.1", path.display()));
    if rotated.exists() {
        fs::remove_file(&rotated)?;
    }
    fs::rename(path, rotated)
}

pub(crate) fn escape_field(value: &str) -> String {
    let normalized = value.replace(['\r', '\n'], " ");
    if normalized
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | '/' | '\\' | ':'))
    {
        return normalized;
    }

    format!("\"{}\"", normalized.replace('"', "\\\""))
}

pub(crate) fn format_startup_line(
    epoch_ms: u128,
    level: &str,
    stage: &str,
    area: &str,
    direction: &str,
    message: &str,
) -> String {
    format!(
        "epoch_ms={} level={} stage={} area={} direction={} message={}\n",
        epoch_ms,
        escape_field(level),
        escape_field(stage),
        escape_field(area),
        escape_field(direction),
        escape_field(message)
    )
}
```

- [ ] **Step 4: Run logger helper tests and verify they pass**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo test --manifest-path src-tauri\Cargo.toml logger::tests
```

Expected: PASS for the helper tests.

- [ ] **Step 5: Commit helper foundation**

```powershell
git add src-tauri/src/logger.rs
git commit -m "feat: add runtime log helpers"
```

---

### Task 2: File Logger Runtime and Panic Hook

**Files:**
- Modify: `src-tauri/src/logger.rs`

- [ ] **Step 1: Add tests for startup append and initialization**

Extend the `tests` module in `src-tauri/src/logger.rs` with:

```rust
use super::{append_startup_line, init_in_dir};

#[test]
fn append_startup_line_creates_parent_and_appends() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("logs").join("startup.log");

    append_startup_line(&path, "INFO", "process_start", "process", "startup", "version=2.1.5")
        .unwrap();
    append_startup_line(&path, "OK", "log_dir", "filesystem", "log directory ready", "path=test")
        .unwrap();

    let content = fs::read_to_string(path).unwrap();
    assert!(content.contains("level=INFO stage=process_start area=process"));
    assert!(content.contains("level=OK stage=log_dir area=filesystem"));
}

#[test]
fn init_in_dir_creates_log_files_and_records_process_start() {
    let dir = tempdir().unwrap();
    let init = init_in_dir(dir.path().join("logs"));

    assert!(init.log_dir.exists());
    assert_eq!(init.startup_log_path, init.log_dir.join("startup.log"));
    assert_eq!(init.runtime_log_path, init.log_dir.join("clipvault.log"));

    let content = fs::read_to_string(init.startup_log_path).unwrap();
    assert!(content.contains("stage=process_start"));
    assert!(content.contains("WebView2 runtime required"));
}
```

- [ ] **Step 2: Run logger tests and verify they fail**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo test --manifest-path src-tauri\Cargo.toml logger::tests
```

Expected: FAIL because `append_startup_line` and `init_in_dir` are not implemented.

- [ ] **Step 3: Implement runtime logger state**

Add these imports to the existing import block in `src-tauri/src/logger.rs`:

```rust
use std::{
    fs::OpenOptions,
    io::Write,
    panic,
    sync::{Mutex, OnceLock},
};
```

Add this code after the helper functions:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoggerInit {
    pub log_dir: PathBuf,
    pub startup_log_path: PathBuf,
    pub runtime_log_path: PathBuf,
}

#[derive(Debug, Clone)]
struct LoggerState {
    startup_log_path: PathBuf,
    log_dir: PathBuf,
}

static LOGGER_STATE: OnceLock<LoggerState> = OnceLock::new();

pub fn init() -> LoggerInit {
    init_in_dir(bootstrap_log_dir())
}

pub(crate) fn init_in_dir(log_dir: PathBuf) -> LoggerInit {
    let startup_log_path = log_dir.join("startup.log");
    let runtime_log_path = log_dir.join("clipvault.log");

    if let Err(error) = fs::create_dir_all(&log_dir) {
        eprintln!("failed to create ClipVault log directory {}: {error}", log_dir.display());
    }
    if let Err(error) = rotate_if_oversized(&startup_log_path) {
        eprintln!("failed to rotate startup log {}: {error}", startup_log_path.display());
    }
    if let Err(error) = rotate_if_oversized(&runtime_log_path) {
        let _ = append_startup_line(
            &startup_log_path,
            "ERROR",
            "log_rotate",
            "filesystem",
            "check log file permissions or file locks",
            &error.to_string(),
        );
    }

    let init = LoggerInit {
        log_dir: log_dir.clone(),
        startup_log_path: startup_log_path.clone(),
        runtime_log_path: runtime_log_path.clone(),
    };

    let _ = LOGGER_STATE.set(LoggerState {
        startup_log_path: startup_log_path.clone(),
        log_dir,
    });

    install_panic_hook();
    init_tracing(&runtime_log_path, &startup_log_path);

    startup_info(
        "process_start",
        "process",
        "ClipVault startup started; WebView2 runtime required on Windows",
        format!(
            "version={} profile={}",
            env!("CARGO_PKG_VERSION"),
            if cfg!(debug_assertions) { "debug" } else { "release" }
        ),
    );
    startup_ok(
        "log_dir",
        "filesystem",
        "local log directory ready",
        init.log_dir.display().to_string(),
    );
    startup_ok(
        "panic_hook",
        "panic",
        "panic after this point should be captured",
        "installed",
    );

    init
}

fn init_tracing(runtime_log_path: &Path, startup_log_path: &Path) {
    match OpenOptions::new()
        .create(true)
        .append(true)
        .open(runtime_log_path)
    {
        Ok(file) => {
            let writer = Mutex::new(file);
            if let Err(error) = tracing_subscriber::fmt()
                .with_ansi(false)
                .with_writer(writer)
                .try_init()
            {
                let _ = append_startup_line(
                    startup_log_path,
                    "ERROR",
                    "tracing_init",
                    "filesystem",
                    "runtime tracing subscriber already initialized or unavailable",
                    &error.to_string(),
                );
            }
        }
        Err(error) => {
            let _ = append_startup_line(
                startup_log_path,
                "ERROR",
                "runtime_log",
                "filesystem",
                "check log file permissions or file locks",
                &error.to_string(),
            );
            let _ = tracing_subscriber::fmt().try_init();
        }
    }
}

fn install_panic_hook() {
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |panic_info| {
        let location = panic_info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_else(|| "unknown".to_string());
        let message = panic_info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| panic_info.payload().downcast_ref::<String>().map(String::as_str))
            .unwrap_or("panic payload is not a string");
        let combined = format!("{location} {message}");

        startup_error(
            "panic",
            "panic",
            "inspect the logged stage immediately before this panic",
            combined,
        );
        tracing::error!(target: "panic", location = %location, "panic captured: {message}");
        default_hook(panic_info);
    }));
}

pub(crate) fn append_startup_line(
    startup_log_path: &Path,
    level: &str,
    stage: &str,
    area: &str,
    direction: &str,
    message: &str,
) -> std::io::Result<()> {
    if let Some(parent) = startup_log_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(startup_log_path)?;
    file.write_all(format_startup_line(now_epoch_ms(), level, stage, area, direction, message).as_bytes())
}

fn write_startup(level: &str, stage: &str, area: &str, direction: &str, message: &str) {
    if let Some(state) = LOGGER_STATE.get() {
        if let Err(error) = append_startup_line(
            &state.startup_log_path,
            level,
            stage,
            area,
            direction,
            message,
        ) {
            eprintln!(
                "failed to write ClipVault startup log {}: {error}",
                state.startup_log_path.display()
            );
        }
    }
}

pub fn startup_info(stage: &str, area: &str, direction: &str, message: impl AsRef<str>) {
    let message = message.as_ref();
    write_startup("INFO", stage, area, direction, message);
    tracing::info!(target: "startup", stage, area, direction, "{message}");
}

pub fn startup_ok(stage: &str, area: &str, direction: &str, message: impl AsRef<str>) {
    let message = message.as_ref();
    write_startup("OK", stage, area, direction, message);
    tracing::info!(target: "startup", stage, area, direction, "{message}");
}

pub fn startup_error(stage: &str, area: &str, direction: &str, error: impl std::fmt::Display) {
    let message = error.to_string();
    write_startup("ERROR", stage, area, direction, &message);
    tracing::error!(target: "startup", stage, area, direction, "{message}");
}

pub fn note_tauri_app_data_dir(path: &Path) {
    let Some(state) = LOGGER_STATE.get() else {
        return;
    };

    let message = if path.join("logs") == state.log_dir {
        format!("tauri_app_data_dir={} matches_bootstrap_log_dir=true", path.display())
    } else {
        format!(
            "tauri_app_data_dir={} bootstrap_log_dir={} matches_bootstrap_log_dir=false",
            path.display(),
            state.log_dir.display()
        )
    };

    startup_info(
        "app_data_dir_compare",
        "filesystem",
        "compare Tauri app data directory with bootstrap log directory",
        message,
    );
}
```

- [ ] **Step 4: Run logger tests and fix formatting issues**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo test --manifest-path src-tauri\Cargo.toml logger::tests
```

Expected: PASS. If Rust reports unused imports, remove only the unused imports produced by this exact implementation.

- [ ] **Step 5: Run formatter check**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo fmt --manifest-path src-tauri\Cargo.toml --check
```

Expected: PASS.

- [ ] **Step 6: Commit runtime logger**

```powershell
git add src-tauri/src/logger.rs
git commit -m "feat: write local runtime logs"
```

---

### Task 3: Instrument Tauri Startup Dependencies

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add startup checkpoint calls around plugin registration**

In `src-tauri/src/lib.rs`, replace the start of `run()`:

```rust
pub fn run() {
    logger::init();

    tauri::Builder::default()
```

with:

```rust
pub fn run() {
    let init = logger::init();
    logger::startup_ok(
        "logger_init",
        "filesystem",
        "startup and runtime log files initialized",
        format!(
            "startup_log={} runtime_log={}",
            init.startup_log_path.display(),
            init.runtime_log_path.display()
        ),
    );
    logger::startup_info(
        "tauri_builder",
        "tauri",
        "building Tauri application and registering plugins",
        "builder_start",
    );
    logger::startup_info(
        "single_instance_plugin",
        "tauri_plugin",
        "register single-instance plugin; stale instance detection can affect startup",
        "register_start",
    );

    let builder = tauri::Builder::default()
```

Then replace the chained builder plugin section:

```rust
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if autostart::should_show_main_window_for_args(args) {
                let _ = windows::show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
```

with:

```rust
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            logger::startup_info(
                "single_instance_callback",
                "tauri_plugin",
                "second instance callback reached; existing window should be focused when requested",
                format!("args_count={}", args.len()),
            );
            if autostart::should_show_main_window_for_args(args) {
                match windows::show_main_window(app) {
                    Ok(()) => logger::startup_ok(
                        "single_instance_focus",
                        "tauri_plugin",
                        "existing main window focused for second instance",
                        "show_main_window_ok",
                    ),
                    Err(error) => logger::startup_error(
                        "single_instance_focus",
                        "tauri_plugin",
                        "check existing window state or WebView2 window focus handling",
                        error,
                    ),
                }
            }
        }))
        .plugin({
            logger::startup_ok(
                "single_instance_plugin",
                "tauri_plugin",
                "single-instance plugin registered",
                "register_ok",
            );
            logger::startup_info(
                "global_shortcut_plugin",
                "tauri_plugin",
                "register global shortcut plugin; Windows shortcut subsystem required",
                "register_start",
            );
            tauri_plugin_global_shortcut::Builder::new().build()
        })
        .plugin({
            logger::startup_ok(
                "global_shortcut_plugin",
                "tauri_plugin",
                "global shortcut plugin registered",
                "register_ok",
            );
            logger::startup_info(
                "clipboard_plugin",
                "tauri_plugin",
                "register clipboard manager plugin; Windows clipboard API required",
                "register_start",
            );
            tauri_plugin_clipboard_manager::init()
        })
```

After this plugin block and before `.setup`, add:

```rust
        .setup(|app| -> Result<(), Box<dyn std::error::Error>> {
            logger::startup_ok(
                "clipboard_plugin",
                "tauri_plugin",
                "clipboard manager plugin registered",
                "register_ok",
            );
            logger::startup_ok(
                "setup_start",
                "tauri",
                "Tauri setup lifecycle reached",
                "setup_entered",
            );
```

This keeps the chain valid while recording the plugin registration boundaries that can be logged before `setup()`.

- [ ] **Step 2: Instrument setup sub-steps**

Inside the existing `.setup(|app| { ... })` closure, replace:

```rust
            let app_data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_dir)?;
            let repository = Repository::open(app_data_dir.join("clipboard.db"))?;
            let state = commands::AppState::new(repository);
            let settings = state.repository().get_settings()?;
            if settings.launch_on_startup {
                autostart::sync_launch_on_startup(true)?;
            }
            clipboard::start_monitoring(app.handle().clone(), state.clone());
            app.manage(state);
            windows::configure_windows(app.handle())?;
            tray::create_tray(app.handle())?;
            hotkeys::register_global_shortcuts(app.handle())?;
            if autostart::should_show_main_window_for_env_args() {
                windows::show_main_window(app.handle())?;
            }
            Ok(())
```

with:

```rust
            let app_data_dir = match app.path().app_data_dir() {
                Ok(path) => {
                    logger::startup_ok(
                        "app_data_dir",
                        "filesystem",
                        "Tauri app data directory resolved",
                        path.display().to_string(),
                    );
                    logger::note_tauri_app_data_dir(&path);
                    path
                }
                Err(error) => {
                    logger::startup_error(
                        "app_data_dir",
                        "filesystem",
                        "check Windows user profile path and app data permissions",
                        &error,
                    );
                    return Err(Box::new(error));
                }
            };

            if let Err(error) = fs::create_dir_all(&app_data_dir) {
                logger::startup_error(
                    "app_data_dir_create",
                    "filesystem",
                    "check app data directory permissions or locked profile state",
                    &error,
                );
                return Err(Box::new(error));
            }
            logger::startup_ok(
                "app_data_dir_create",
                "filesystem",
                "app data directory exists",
                app_data_dir.display().to_string(),
            );

            let database_path = app_data_dir.join("clipboard.db");
            logger::startup_info(
                "database_open",
                "sqlite",
                "open SQLite database; failures point to lock, corruption, migration, or antivirus file lock",
                database_path.display().to_string(),
            );
            let repository = match Repository::open(&database_path) {
                Ok(repository) => {
                    logger::startup_ok(
                        "database_open",
                        "sqlite",
                        "SQLite database opened and migrations completed",
                        database_path.display().to_string(),
                    );
                    repository
                }
                Err(error) => {
                    logger::startup_error(
                        "database_open",
                        "sqlite",
                        "check database lock/corruption, migration failure, or antivirus file lock",
                        &error,
                    );
                    return Err(Box::new(error));
                }
            };

            let state = commands::AppState::new(repository);
            let settings = match state.repository().get_settings() {
                Ok(settings) => {
                    logger::startup_ok(
                        "settings_load",
                        "sqlite",
                        "settings loaded without logging sensitive values",
                        format!("launch_on_startup={}", settings.launch_on_startup),
                    );
                    settings
                }
                Err(error) => {
                    logger::startup_error(
                        "settings_load",
                        "sqlite",
                        "check settings JSON row or database integrity",
                        &error,
                    );
                    return Err(Box::new(error));
                }
            };

            if settings.launch_on_startup {
                logger::startup_info(
                    "autostart_sync",
                    "autostart",
                    "sync Windows autostart registry entry because setting is enabled",
                    "enabled=true",
                );
                if let Err(error) = autostart::sync_launch_on_startup(true) {
                    logger::startup_error(
                        "autostart_sync",
                        "autostart",
                        "check Windows registry permission or startup entry path",
                        &error,
                    );
                    return Err(Box::new(error));
                }
                logger::startup_ok(
                    "autostart_sync",
                    "autostart",
                    "Windows autostart entry synchronized",
                    "enabled=true",
                );
            } else {
                logger::startup_info(
                    "autostart_sync",
                    "autostart",
                    "autostart setting disabled; registry sync skipped",
                    "enabled=false",
                );
            }

            clipboard::start_monitoring(app.handle().clone(), state.clone());
            logger::startup_ok(
                "clipboard_monitor",
                "clipboard",
                "clipboard monitor task started; Windows clipboard API required",
                "started",
            );

            app.manage(state);
            logger::startup_ok(
                "app_state",
                "tauri",
                "application state registered",
                "managed",
            );

            if let Err(error) = windows::configure_windows(app.handle()) {
                logger::startup_error(
                    "window_config",
                    "webview2",
                    "check Microsoft Edge WebView2 Runtime, window labels, or packaged frontend files",
                    &error,
                );
                return Err(Box::new(error));
            }
            logger::startup_ok(
                "window_config",
                "webview2",
                "Tauri windows configured; WebView2 runtime dependency reached",
                "labels=main,hud,search",
            );

            if let Err(error) = tray::create_tray(app.handle()) {
                logger::startup_error(
                    "tray_create",
                    "tray",
                    "check Windows shell tray availability and packaged icon resources",
                    &error,
                );
                return Err(Box::new(error));
            }
            logger::startup_ok(
                "tray_create",
                "tray",
                "Windows tray menu created",
                "created",
            );

            if let Err(error) = hotkeys::register_global_shortcuts(app.handle()) {
                logger::startup_error(
                    "hotkey_register",
                    "hotkey",
                    "check global hotkey conflicts, Windows hook permissions, or input subsystem",
                    &error,
                );
                return Err(Box::new(error));
            }
            logger::startup_ok(
                "hotkey_register",
                "hotkey",
                "global shortcuts registered",
                "registered",
            );

            if autostart::should_show_main_window_for_env_args() {
                logger::startup_info(
                    "main_window_show",
                    "webview2",
                    "startup arguments request showing the main window",
                    "show_requested=true",
                );
                if let Err(error) = windows::show_main_window(app.handle()) {
                    logger::startup_error(
                        "main_window_show",
                        "webview2",
                        "check window visibility/focus handling or WebView2 runtime",
                        &error,
                    );
                    return Err(Box::new(error));
                }
                logger::startup_ok(
                    "main_window_show",
                    "webview2",
                    "main window show request completed",
                    "shown",
                );
            } else {
                logger::startup_info(
                    "main_window_show",
                    "webview2",
                    "startup arguments do not request showing the main window",
                    "show_requested=false",
                );
            }

            logger::startup_ok(
                "setup_complete",
                "tauri",
                "Tauri setup completed",
                "setup_ok",
            );
            Ok(())
```

- [ ] **Step 3: Replace final `run().expect(...)` with explicit logging**

At the end of `run()`, replace:

```rust
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

with:

```rust
        .run(tauri::generate_context!());

    match result {
        Ok(()) => logger::startup_ok(
            "tauri_run",
            "tauri",
            "Tauri event loop exited normally",
            "run_ok",
        ),
        Err(error) => {
            logger::startup_error(
                "tauri_run",
                "tauri",
                "check Tauri runtime, WebView2 runtime, plugin setup, or packaged frontend files",
                &error,
            );
            panic!("error while running tauri application: {error}");
        }
    }
}
```

Also ensure the builder chain is assigned to `let result = builder...run(...)` after Step 1 introduced `let builder =`.

- [ ] **Step 4: Run Rust formatter**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo fmt --manifest-path src-tauri\Cargo.toml
```

Expected: command exits successfully and formats `lib.rs`.

- [ ] **Step 5: Run focused Rust tests**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo test --manifest-path src-tauri\Cargo.toml logger::tests
```

Expected: PASS.

- [ ] **Step 6: Compile-check Rust package**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo test --manifest-path src-tauri\Cargo.toml --no-run
```

Expected: PASS. The `setup` closure should compile with the explicit `Result<(), Box<dyn std::error::Error>>` return type and `return Err(Box::new(error));` for `tauri::Error`, `std::io::Error`, and project `AppError` values.

- [ ] **Step 7: Commit startup instrumentation**

```powershell
git add src-tauri/src/lib.rs src-tauri/src/logger.rs
git commit -m "feat: log startup dependency checkpoints"
```

---

### Task 4: Runtime Warning Coverage for Existing Failure Paths

**Files:**
- Modify: `src-tauri/src/hotkeys.rs`
- Modify: `src-tauri/src/clipboard/mod.rs`
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Inspect existing `tracing::warn!` and `tracing::error!` calls**

Run:

```powershell
rg -n "tracing::(warn|error)!" src-tauri\src\hotkeys.rs src-tauri\src\clipboard\mod.rs src-tauri\src\commands.rs
```

Expected: output includes existing clipboard tick failures, hotkey failures, wheel hook failures, and restore wheel hook errors.

- [ ] **Step 2: Add startup-style direction to high-signal runtime warnings**

For each existing warning/error in these files, add structured fields where the error is already sanitized and does not include clipboard content. Use this pattern:

```rust
tracing::warn!(
    target: "hotkeys",
    area = "hotkey",
    direction = "check global hotkey conflicts, Windows hook permissions, or input subsystem",
    "fixed content paste failed: {error}"
);
```

Apply equivalent directions:

- Clipboard monitor tick failure: `area = "clipboard"`, direction `check Windows clipboard access or foreground app interaction`.
- Fixed content paste, quick copy, wheel quick copy, wheel hook restore: `area = "hotkey"`, direction `check global hotkey conflicts, Windows hook permissions, or input subsystem`.
- Cut clipboard capture failure: `area = "clipboard"`, direction `check clipboard access after cut operation or foreground app focus`.

Do not log clipboard item content, previews, image data, or file contents.

- [ ] **Step 3: Run Rust formatter and compile check**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo fmt --manifest-path src-tauri\Cargo.toml
cargo test --manifest-path src-tauri\Cargo.toml --no-run
```

Expected: both commands exit successfully.

- [ ] **Step 4: Commit runtime warning fields**

```powershell
git add src-tauri/src/hotkeys.rs src-tauri/src/clipboard/mod.rs src-tauri/src/commands.rs
git commit -m "feat: add diagnostic fields to runtime warnings"
```

---

### Task 5: Verification and Manual Startup Evidence

**Files:**
- Modify only if earlier verification exposes a compile or test issue in files already touched by Tasks 1-4.

- [ ] **Step 1: Run Rust formatter check**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo fmt --manifest-path src-tauri\Cargo.toml --check
```

Expected: PASS.

- [ ] **Step 2: Run Rust test suite**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo test --manifest-path src-tauri\Cargo.toml
```

Expected: PASS.

- [ ] **Step 3: Run Rust clippy**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo clippy --manifest-path src-tauri\Cargo.toml -- -D warnings
```

Expected: PASS.

- [ ] **Step 4: Run frontend checks for unchanged renderer boundary**

Run:

```powershell
pnpm typecheck
pnpm test
```

Expected: PASS. Renderer code should be unchanged, but these commands guard against accidental type or workspace drift.

- [ ] **Step 5: Build production app**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
pnpm build
```

Expected: PASS and produces the configured Tauri build artifacts.

- [ ] **Step 6: Manually verify log files on Windows**

Run the built or dev app once. Then inspect:

```powershell
Get-ChildItem "$env:APPDATA\ClipVault\logs"
Get-Content "$env:APPDATA\ClipVault\logs\startup.log" -Tail 80
Get-Content "$env:APPDATA\ClipVault\logs\clipvault.log" -Tail 80
```

Expected startup evidence:

- `process_start`
- `log_dir`
- `panic_hook`
- `tauri_builder`
- `single_instance_plugin`
- `global_shortcut_plugin`
- `clipboard_plugin`
- `setup_start`
- `app_data_dir`
- `database_open`
- `settings_load`
- `clipboard_monitor`
- `window_config`
- `tray_create`
- `hotkey_register`
- `main_window_show`

If the path differs because Tauri resolves a different app data directory, use the `app_data_dir_compare` line in `startup.log` to locate the active bootstrap log path for that run.

- [ ] **Step 7: Commit any verification fixes**

If verification required code changes:

```powershell
git add src-tauri/src/logger.rs src-tauri/src/lib.rs src-tauri/src/hotkeys.rs src-tauri/src/clipboard/mod.rs src-tauri/src/commands.rs
git commit -m "fix: stabilize runtime logging verification"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review Notes

- Spec coverage: startup/runtime local logs, dependency checkpoints, failure directions, panic hook, Tauri run/setup error logging, privacy boundaries, rotation, and tests are each mapped to Tasks 1-5.
- Scope: no renderer API, settings page, telemetry, or new dependency is included.
- Type consistency: all planned public logger helper names match the logging contract section.
- Privacy: runtime warning updates only add area/direction fields to existing sanitized error logs.

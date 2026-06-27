use std::{
    env, fs,
    fs::OpenOptions,
    io::Write,
    panic,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
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

pub(crate) fn bootstrap_log_dir_from_env(
    appdata: Option<&Path>,
    localappdata: Option<&Path>,
) -> PathBuf {
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
    if normalized.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | '/' | '\\' | ':')
    }) {
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
static PANIC_HOOK_INSTALLED: OnceLock<()> = OnceLock::new();

pub fn init() -> LoggerInit {
    init_in_dir(bootstrap_log_dir())
}

pub(crate) fn init_in_dir(log_dir: PathBuf) -> LoggerInit {
    let startup_log_path = log_dir.join("startup.log");
    let runtime_log_path = log_dir.join("clipvault.log");

    if let Err(error) = fs::create_dir_all(&log_dir) {
        eprintln!(
            "failed to create ClipVault log directory {}: {error}",
            log_dir.display()
        );
    }
    if let Err(error) = rotate_if_oversized(&startup_log_path) {
        eprintln!(
            "failed to rotate startup log {}: {error}",
            startup_log_path.display()
        );
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
            if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            }
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
    let _ = PANIC_HOOK_INSTALLED.get_or_init(|| {
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
                .or_else(|| {
                    panic_info
                        .payload()
                        .downcast_ref::<String>()
                        .map(String::as_str)
                })
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
    });
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
    file.write_all(
        format_startup_line(now_epoch_ms(), level, stage, area, direction, message).as_bytes(),
    )
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
        format!(
            "tauri_app_data_dir={} matches_bootstrap_log_dir=true",
            path.display()
        )
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

#[cfg(test)]
mod tests {
    use std::{env, fs};

    use tempfile::tempdir;

    use super::{
        append_startup_line, bootstrap_log_dir_from_env, escape_field, format_startup_line,
        init_in_dir, rotate_if_oversized, MAX_LOG_BYTES,
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
        fs::write(&path, vec![b'a'; MAX_LOG_BYTES as usize + 1]).unwrap();

        rotate_if_oversized(&path).unwrap();

        assert!(!path.exists());
        assert_eq!(
            fs::read(dir.path().join("clipvault.log.1")).unwrap().len(),
            MAX_LOG_BYTES as usize + 1
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

    #[test]
    fn append_startup_line_creates_parent_and_appends() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("logs").join("startup.log");

        append_startup_line(
            &path,
            "INFO",
            "process_start",
            "process",
            "startup",
            "version=2.1.7",
        )
        .unwrap();
        append_startup_line(
            &path,
            "OK",
            "log_dir",
            "filesystem",
            "log directory ready",
            "path=test",
        )
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
}

pub mod image;

use std::{fs, path::Path, time::Duration};

use serde_json::json;
use tauri::{AppHandle, Emitter};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::{
    commands::{self, AppState, HistoryRevisionPayload},
    detector::{create_preview, detect_content_type, parse_single_file_path},
    errors::{AppError, AppResult},
    events,
    models::{ClipboardContentType, ClipboardInsertInput, ClipboardItem, ClipboardMetadata},
    privacy::{filter::is_sensitive_content, foreground::is_blacklisted_foreground_app},
};

const MONITOR_INTERVAL_MS: u64 = 800;
const IMAGE_SCAN_INTERVAL_MS: i64 = 1200;
const BLACKLIST_CHECK_INTERVAL_MS: i64 = 3000;

#[derive(Debug, Clone, PartialEq)]
pub enum CaptureDecision {
    Insert {
        input: Box<ClipboardInsertInput>,
        hash: String,
    },
    Skip(CaptureSkipReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureSkipReason {
    Empty,
    Sensitive,
    TooLarge,
    Duplicate,
}

#[derive(Debug, Default)]
pub struct ClipboardMonitor {
    last_hash: String,
    next_image_scan_at: i64,
    next_blacklist_check_at: i64,
    last_blacklist_result: bool,
}

impl ClipboardMonitor {
    pub fn last_hash(&self) -> &str {
        &self.last_hash
    }

    fn remember_hash(&mut self, hash: String) {
        self.last_hash = hash;
    }
}

pub fn start_monitoring(app: AppHandle, state: AppState) {
    state.set_monitoring_service_started(true);
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(MONITOR_INTERVAL_MS)).await;
            if !state.monitoring_enabled() {
                continue;
            }

            state.set_monitoring_running(true);
            if let Err(error) = tick_with_shared_monitor(&app, &state) {
                tracing::warn!(
                    target: "clipboard",
                    area = "clipboard",
                    direction = "check Windows clipboard access or foreground app interaction",
                    "clipboard monitor tick failed: {error}"
                );
            }
            state.set_monitoring_running(false);
        }
    });
}

pub fn capture_clipboard_now(app: &AppHandle, state: &AppState) -> AppResult<()> {
    if !state.monitoring_enabled() {
        return Ok(());
    }

    state.set_monitoring_running(true);
    let result = tick_with_shared_monitor(app, state);
    state.set_monitoring_running(false);
    result
}

pub fn remember_internal_clipboard_write(state: &AppState, item: &ClipboardItem) {
    remember_internal_clipboard_hash(state, &item.content_hash);
}

pub fn remember_internal_text_clipboard_write(state: &AppState, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }

    let content_type = detect_content_type(text);
    let hash = hash_text(content_type, text);
    remember_internal_clipboard_hash(state, &hash);
}

pub fn remember_internal_clipboard_hash(state: &AppState, hash: &str) {
    state.clipboard_monitor_mut(|monitor| {
        monitor.remember_hash(hash.to_string());
    });
    state.set_monitoring_last_hash(hash);
}

fn tick_with_shared_monitor(app: &AppHandle, state: &AppState) -> AppResult<()> {
    state.clipboard_monitor_mut(|monitor| tick(app, state, monitor))
}

pub fn build_text_insert_input(
    raw_text: &str,
    text_limit_kb: u32,
    sensitive_filter_enabled: bool,
    last_hash: &str,
) -> CaptureDecision {
    let text = raw_text.trim();
    if text.is_empty() {
        return CaptureDecision::Skip(CaptureSkipReason::Empty);
    }

    if sensitive_filter_enabled && is_sensitive_content(text) {
        return CaptureDecision::Skip(CaptureSkipReason::Sensitive);
    }

    if text.len() > text_limit_kb as usize * 1024 {
        return CaptureDecision::Skip(CaptureSkipReason::TooLarge);
    }

    let content_type = detect_content_type(text);
    let hash = hash_text(content_type, text);
    if hash == last_hash {
        return CaptureDecision::Skip(CaptureSkipReason::Duplicate);
    }

    let mut metadata = ClipboardMetadata::default();
    let mut file_path = None;
    if let Some(path) = parse_single_file_path(text) {
        file_path = Some(path.to_string_lossy().to_string());
        metadata = file_metadata(&path);
    }

    CaptureDecision::Insert {
        input: Box::new(ClipboardInsertInput {
            content: Some(text.to_string()),
            content_type,
            content_hash: hash.clone(),
            preview: create_preview(text, 200),
            metadata: Some(metadata),
            file_path,
            image_data: None,
        }),
        hash,
    }
}

fn tick(app: &AppHandle, state: &AppState, monitor: &mut ClipboardMonitor) -> AppResult<()> {
    let settings = state.repository().get_settings()?;

    if settings.enable_blacklist && is_blacklisted(app, state, monitor)? {
        return Ok(());
    }

    if let Ok(text) = app.clipboard().read_text() {
        if let CaptureDecision::Insert { input, hash } = build_text_insert_input(
            &text,
            settings.text_limit_kb,
            settings.enable_sensitive_filter,
            monitor.last_hash(),
        ) {
            insert_and_emit(app, state, *input, hash, monitor)?;
            return Ok(());
        }
    }

    let now = now_millis();
    if now < monitor.next_image_scan_at {
        return Ok(());
    }

    let Ok(image) = app.clipboard().read_image() else {
        monitor.next_image_scan_at = now + IMAGE_SCAN_INTERVAL_MS;
        return Ok(());
    };
    let png = image::encode_rgba_png(image.rgba(), image.width(), image.height())?;
    let hash = hash_bytes(&png);
    if hash == monitor.last_hash() {
        return Ok(());
    }

    let processed = image::process_image_bytes(&png, settings.image_compression)?;
    let filename = image_filename(now);
    let mut metadata = ClipboardMetadata {
        file_name: Some(filename.clone()),
        file_ext: Some(".jpg".to_string()),
        file_size: Some(processed.compressed_size),
        original_size: Some(processed.original_size),
        compressed_size: Some(processed.compressed_size),
        image_width: Some(processed.width),
        image_height: Some(processed.height),
        ..Default::default()
    };
    metadata
        .extra
        .insert("mimeType".to_string(), json!(processed.mime_type));

    insert_and_emit(
        app,
        state,
        ClipboardInsertInput {
            content: Some(filename.clone()),
            content_type: crate::models::ClipboardContentType::Image,
            content_hash: hash.clone(),
            preview: filename,
            metadata: Some(metadata),
            file_path: None,
            image_data: Some(processed.bytes),
        },
        hash,
        monitor,
    )?;
    monitor.next_image_scan_at = 0;
    Ok(())
}

fn is_blacklisted(
    _app: &AppHandle,
    state: &AppState,
    monitor: &mut ClipboardMonitor,
) -> AppResult<bool> {
    let now = now_millis();
    if now >= monitor.next_blacklist_check_at {
        let apps = state.repository().list_blacklist_apps()?;
        monitor.last_blacklist_result = is_blacklisted_foreground_app(&apps);
        monitor.next_blacklist_check_at = now + BLACKLIST_CHECK_INTERVAL_MS;
    }
    Ok(monitor.last_blacklist_result)
}

fn insert_and_emit(
    app: &AppHandle,
    state: &AppState,
    input: ClipboardInsertInput,
    hash: String,
    monitor: &mut ClipboardMonitor,
) -> AppResult<()> {
    let item = state.repository().insert_clipboard_item(input)?;
    monitor.remember_hash(hash);
    state.set_monitoring_last_hash(monitor.last_hash());
    let cursor = commands::set_quick_paste_cursor_impl(state, item.id)?;
    let revision = state.bump_history_revision();
    commands::emit_quick_paste_cursor(app, &cursor);
    app.emit(events::CLIPBOARD_NEW_ITEM, &item)
        .map_err(|err| AppError::from(format!("failed to emit clipboard item: {err}")))?;
    let _ = app.emit(
        events::HISTORY_REVISION,
        HistoryRevisionPayload { revision },
    );
    Ok(())
}

fn file_metadata(path: &Path) -> ClipboardMetadata {
    let file_size = fs::metadata(path).ok().map(|stat| stat.len());
    ClipboardMetadata {
        exists: Some(path.exists()),
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string),
        file_ext: path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| format!(".{ext}")),
        file_size,
        ..Default::default()
    }
}

fn image_filename(timestamp_ms: i64) -> String {
    format!("screenshot_{timestamp_ms}.jpg")
}

fn hash_text(content_type: ClipboardContentType, text: &str) -> String {
    hash_bytes(format!("{}:{text}", content_type_hash_prefix(content_type)).as_bytes())
}

fn content_type_hash_prefix(content_type: ClipboardContentType) -> &'static str {
    match content_type {
        ClipboardContentType::Text => "text",
        ClipboardContentType::Image => "image",
        ClipboardContentType::File => "file",
        ClipboardContentType::Url => "url",
        ClipboardContentType::Code => "code",
        ClipboardContentType::Color => "color",
        ClipboardContentType::Email => "email",
    }
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", md5::compute(bytes))
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ClipboardContentType;

    #[test]
    fn text_capture_skips_empty_sensitive_too_large_and_duplicates() {
        assert_eq!(
            build_text_insert_input("", 100, true, ""),
            CaptureDecision::Skip(CaptureSkipReason::Empty)
        );
        assert_eq!(
            build_text_insert_input("password=secret123", 100, true, ""),
            CaptureDecision::Skip(CaptureSkipReason::Sensitive)
        );
        assert_eq!(
            build_text_insert_input("abcdef", 0, false, ""),
            CaptureDecision::Skip(CaptureSkipReason::TooLarge)
        );

        let first = build_text_insert_input("hello", 100, true, "");
        let CaptureDecision::Insert { hash, .. } = first else {
            panic!("expected insert decision");
        };
        assert_eq!(
            build_text_insert_input("hello", 100, true, &hash),
            CaptureDecision::Skip(CaptureSkipReason::Duplicate)
        );
    }

    #[test]
    fn text_capture_builds_typed_insert_input() {
        let decision = build_text_insert_input("https://example.com", 100, true, "");
        let CaptureDecision::Insert { input, hash } = decision else {
            panic!("expected insert decision");
        };

        assert_eq!(input.content_type, ClipboardContentType::Url);
        assert_eq!(input.content.as_deref(), Some("https://example.com"));
        assert_eq!(input.preview, "https://example.com");
        assert_eq!(input.content_hash, hash);
        assert_eq!(hash, "7142bd89ab7f64ee15a5c70be84827a8");
    }

    #[test]
    fn hash_bytes_matches_legacy_electron_md5_buffer_hash() {
        assert_eq!(hash_bytes(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn text_hash_uses_lowercase_database_type_prefix() {
        assert_eq!(
            hash_text(ClipboardContentType::Text, "hello"),
            "98381d9d9f80490f7c3dd0b69cb8a14e"
        );
    }
}

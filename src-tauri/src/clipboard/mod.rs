pub mod formats;
pub mod image;

use std::{fs, path::Path, time::Duration};

use serde_json::json;
use tauri::{AppHandle, Emitter};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::{
    commands::{self, AppState, HistoryRevisionPayload},
    database::repository::Repository,
    detector::{create_preview, detect_content_type, parse_single_file_path},
    errors::{AppError, AppResult},
    events,
    models::{
        BlacklistApp, ClipboardContentType, ClipboardFormatInput, ClipboardInsertInput,
        ClipboardItem, ClipboardMetadata,
    },
    privacy::{filter::is_sensitive_content, foreground::is_blacklisted_foreground_app},
};

const MONITOR_INTERVAL_MS: u64 = 800;
const IMAGE_SCAN_INTERVAL_MS: i64 = 1200;
const BLACKLIST_CHECK_INTERVAL_MS: i64 = 3000;
const IGNORED_CLIPBOARD_RETENTION_MS: i64 = 120_000;
const IGNORED_CLIPBOARD_MAX_ENTRIES: usize = 128;

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
    last_sequence: Option<u32>,
    next_image_scan_at: i64,
    next_blacklist_check_at: i64,
    blacklist_apps: Vec<BlacklistApp>,
    ignored_clipboard_sequences: Vec<IgnoredClipboardSequence>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct IgnoredClipboardSequence {
    sequence: u32,
    ignored_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClipboardSequenceDecision {
    New,
    AlreadySeen,
}

impl ClipboardMonitor {
    pub fn last_hash(&self) -> &str {
        &self.last_hash
    }

    fn remember_hash(&mut self, hash: String) {
        self.last_hash = hash;
    }

    fn begin_clipboard_sequence(
        &mut self,
        sequence: Option<u32>,
        now: i64,
    ) -> ClipboardSequenceDecision {
        let Some(sequence) = sequence else {
            return ClipboardSequenceDecision::New;
        };
        self.prune_ignored_clipboard_sequences(now);
        if self.last_sequence == Some(sequence)
            || self
                .ignored_clipboard_sequences
                .iter()
                .any(|entry| entry.sequence == sequence)
        {
            self.last_sequence = Some(sequence);
            return ClipboardSequenceDecision::AlreadySeen;
        }
        ClipboardSequenceDecision::New
    }

    fn remember_clipboard_sequence(&mut self, sequence: Option<u32>) {
        if let Some(sequence) = sequence {
            self.last_sequence = Some(sequence);
        }
    }

    fn remember_ignored_clipboard_sequence(&mut self, sequence: u32, now: i64) {
        self.prune_ignored_clipboard_sequences(now);
        self.ignored_clipboard_sequences
            .retain(|entry| entry.sequence != sequence);
        self.ignored_clipboard_sequences
            .push(IgnoredClipboardSequence {
                sequence,
                ignored_at: now,
            });
        if self.ignored_clipboard_sequences.len() > IGNORED_CLIPBOARD_MAX_ENTRIES {
            let overflow = self.ignored_clipboard_sequences.len() - IGNORED_CLIPBOARD_MAX_ENTRIES;
            self.ignored_clipboard_sequences.drain(0..overflow);
        }
        self.last_sequence = Some(sequence);
    }

    fn prune_ignored_clipboard_sequences(&mut self, now: i64) {
        self.ignored_clipboard_sequences
            .retain(|entry| now - entry.ignored_at <= IGNORED_CLIPBOARD_RETENTION_MS);
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
    let sequence = clipboard_sequence_number();
    let now = now_millis();
    if matches!(
        monitor.begin_clipboard_sequence(sequence, now),
        ClipboardSequenceDecision::AlreadySeen
    ) {
        return Ok(());
    }

    let settings = state.repository().get_settings()?;

    if settings.enable_blacklist && is_blacklisted(app, state, monitor)? {
        if let Some(sequence) = sequence {
            monitor.remember_ignored_clipboard_sequence(sequence, now);
        }
        return Ok(());
    }

    if let Ok(text) = app.clipboard().read_text() {
        match build_text_insert_input(
            &text,
            settings.text_limit_kb,
            settings.enable_sensitive_filter,
            monitor.last_hash(),
        ) {
            CaptureDecision::Insert { input, hash } => {
                let formats = read_supported_formats_for_capture();
                insert_and_emit_with_formats(app, state, *input, hash, monitor, formats)?;
                monitor.remember_clipboard_sequence(sequence);
                return Ok(());
            }
            CaptureDecision::Skip(CaptureSkipReason::Duplicate) => {
                let formats = read_supported_formats_for_capture();
                if !formats.is_empty() {
                    let text = text.trim();
                    let hash = hash_text(detect_content_type(text), text);
                    if persist_rich_formats_for_existing_hash(state.repository(), &hash, &formats)?
                    {
                        emit_history_revision(app, state);
                    }
                    monitor.remember_clipboard_sequence(sequence);
                    return Ok(());
                }
                monitor.remember_clipboard_sequence(sequence);
            }
            CaptureDecision::Skip(_) => {
                monitor.remember_clipboard_sequence(sequence);
            }
        }
    }

    if now < monitor.next_image_scan_at {
        return Ok(());
    }

    let Ok(image) = app.clipboard().read_image() else {
        monitor.next_image_scan_at = now + IMAGE_SCAN_INTERVAL_MS;
        monitor.remember_clipboard_sequence(sequence);
        return Ok(());
    };
    let png = image::encode_rgba_png(image.rgba(), image.width(), image.height())?;
    let hash = hash_bytes(&png);
    if hash == monitor.last_hash() {
        monitor.remember_clipboard_sequence(sequence);
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

    let formats = read_supported_formats_for_capture();
    insert_and_emit_with_formats(
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
        formats,
    )?;
    monitor.remember_clipboard_sequence(sequence);
    monitor.next_image_scan_at = 0;
    Ok(())
}

fn is_blacklisted(
    _app: &AppHandle,
    state: &AppState,
    monitor: &mut ClipboardMonitor,
) -> AppResult<bool> {
    is_blacklisted_with_cache(
        monitor,
        now_millis(),
        || state.repository().list_blacklist_apps(),
        is_blacklisted_foreground_app,
    )
}

fn is_blacklisted_with_cache<L, M>(
    monitor: &mut ClipboardMonitor,
    now: i64,
    mut load_blacklist: L,
    mut matches_foreground: M,
) -> AppResult<bool>
where
    L: FnMut() -> AppResult<Vec<BlacklistApp>>,
    M: FnMut(&[BlacklistApp]) -> bool,
{
    if now >= monitor.next_blacklist_check_at {
        monitor.blacklist_apps = load_blacklist()?;
        monitor.next_blacklist_check_at = now + BLACKLIST_CHECK_INTERVAL_MS;
    }
    Ok(matches_foreground(&monitor.blacklist_apps))
}

fn insert_and_emit_with_formats(
    app: &AppHandle,
    state: &AppState,
    mut input: ClipboardInsertInput,
    hash: String,
    monitor: &mut ClipboardMonitor,
    formats: Vec<ClipboardFormatInput>,
) -> AppResult<()> {
    if let Some(existing) = state
        .repository()
        .find_by_content_hash(&input.content_hash)?
    {
        if persist_rich_formats_for_item(state.repository(), existing.id, &formats)? {
            emit_history_revision(app, state);
        }
        monitor.remember_hash(hash);
        state.set_monitoring_last_hash(monitor.last_hash());
        return Ok(());
    }

    let format_names = formats
        .iter()
        .map(|format| format.format_name.clone())
        .collect::<Vec<_>>();
    apply_rich_format_metadata(&mut input, &format_names);
    let item = state.repository().insert_clipboard_item(input)?;
    persist_rich_formats_for_item(state.repository(), item.id, &formats)?;
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

fn persist_rich_formats_for_existing_hash(
    repo: &Repository,
    content_hash: &str,
    formats: &[ClipboardFormatInput],
) -> AppResult<bool> {
    let Some(item) = repo.find_by_content_hash(content_hash)? else {
        return Ok(false);
    };

    persist_rich_formats_for_item(repo, item.id, formats)
}

fn persist_rich_formats_for_item(
    repo: &Repository,
    item_id: i64,
    formats: &[ClipboardFormatInput],
) -> AppResult<bool> {
    if formats.is_empty() {
        return Ok(false);
    }

    let before = repo.list_clipboard_formats(item_id)?.len();
    for format in formats {
        if let Err(error) = repo.insert_clipboard_format(item_id, format) {
            tracing::warn!(
                target: "clipboard",
                area = "clipboard",
                direction = "persist rich clipboard format payload",
                format_name = format.format_name,
                "failed to store rich clipboard format: {error}"
            );
        }
    }

    Ok(repo.list_clipboard_formats(item_id)?.len() > before)
}

fn emit_history_revision(app: &AppHandle, state: &AppState) {
    let revision = state.bump_history_revision();
    let _ = app.emit(
        events::HISTORY_REVISION,
        HistoryRevisionPayload { revision },
    );
}

fn apply_rich_format_metadata(input: &mut ClipboardInsertInput, format_names: &[String]) {
    if format_names.is_empty() {
        return;
    }

    let mut names = Vec::new();
    for name in format_names {
        if !names.contains(name) {
            names.push(name.clone());
        }
    }
    let format_count = names.len();
    let metadata = input
        .metadata
        .get_or_insert_with(ClipboardMetadata::default);
    metadata
        .extra
        .insert("hasRichFormats".to_string(), json!(true));
    metadata
        .extra
        .insert("formatNames".to_string(), json!(names));
    metadata
        .extra
        .insert("formatCount".to_string(), json!(format_count));
}

fn read_supported_formats_for_capture() -> Vec<ClipboardFormatInput> {
    match formats::read_supported_formats() {
        Ok(formats) => formats,
        Err(error) => {
            tracing::warn!(
                target: "clipboard",
                area = "clipboard",
                direction = "read supported rich clipboard formats",
                "rich clipboard format capture skipped: {error}"
            );
            Vec::new()
        }
    }
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

#[cfg(target_os = "windows")]
fn clipboard_sequence_number() -> Option<u32> {
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;

    let sequence = unsafe { GetClipboardSequenceNumber() };
    if sequence == 0 {
        None
    } else {
        Some(sequence)
    }
}

#[cfg(not(target_os = "windows"))]
fn clipboard_sequence_number() -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    use crate::{
        database::repository::Repository,
        models::{ClipboardContentType, ClipboardFormatEncoding},
    };

    fn repo() -> Repository {
        let dir = tempdir().unwrap();
        Repository::open(dir.path().join("clipboard.db")).unwrap()
    }

    fn text_input(content: &str, hash: &str) -> ClipboardInsertInput {
        ClipboardInsertInput {
            content: Some(content.to_string()),
            content_type: ClipboardContentType::Text,
            content_hash: hash.to_string(),
            preview: content.to_string(),
            metadata: None,
            file_path: None,
            image_data: None,
        }
    }

    fn html_format(data: &[u8]) -> ClipboardFormatInput {
        ClipboardFormatInput {
            format_name: "HTML Format".to_string(),
            format_id: Some(49323),
            mime_type: Some("text/html".to_string()),
            encoding: ClipboardFormatEncoding::Binary,
            data: data.to_vec(),
            data_hash: hash_bytes(data),
        }
    }

    fn blacklist_entry(app_name: &str) -> crate::models::BlacklistApp {
        crate::models::BlacklistApp {
            id: 1,
            app_name: app_name.to_string(),
            app_path: None,
            is_builtin: false,
            created_at: 0,
        }
    }

    #[test]
    fn blacklist_decision_is_recomputed_even_when_app_list_cache_is_fresh() {
        let mut monitor = ClipboardMonitor::default();
        let mut loads = 0;

        let first = is_blacklisted_with_cache(
            &mut monitor,
            100,
            || {
                loads += 1;
                Ok(vec![blacklist_entry("chrome.exe")])
            },
            |_| false,
        )
        .unwrap();
        let second = is_blacklisted_with_cache(
            &mut monitor,
            101,
            || {
                loads += 1;
                Ok(vec![blacklist_entry("chrome.exe")])
            },
            |_| true,
        )
        .unwrap();

        assert!(!first);
        assert!(second);
        assert_eq!(loads, 1);
    }

    #[test]
    fn blacklisted_clipboard_sequence_is_ignored_after_foreground_changes() {
        let mut monitor = ClipboardMonitor::default();
        let sequence = 42;

        monitor.remember_ignored_clipboard_sequence(sequence, 100);

        assert_eq!(
            monitor.begin_clipboard_sequence(Some(sequence), 101),
            ClipboardSequenceDecision::AlreadySeen
        );
    }

    #[test]
    fn ignored_clipboard_sequence_expires_after_retention_window() {
        let mut monitor = ClipboardMonitor::default();
        let sequence = 42;

        monitor.remember_ignored_clipboard_sequence(sequence, 100);
        monitor.last_sequence = None;

        assert_eq!(
            monitor.begin_clipboard_sequence(Some(sequence), 120_101),
            ClipboardSequenceDecision::New
        );
    }

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
    fn rich_format_metadata_marks_item_without_polluting_preview() {
        let mut input = match build_text_insert_input("hello", 100, true, "") {
            CaptureDecision::Insert { input, .. } => *input,
            _ => panic!("expected insert"),
        };

        apply_rich_format_metadata(
            &mut input,
            &["HTML Format".to_string(), "Rich Text Format".to_string()],
        );

        assert_eq!(input.preview, "hello");
        let metadata = input.metadata.unwrap();
        assert_eq!(metadata.extra["hasRichFormats"], json!(true));
        assert_eq!(
            metadata.extra["formatNames"],
            json!(["HTML Format", "Rich Text Format"])
        );
    }

    #[test]
    fn duplicate_text_capture_can_backfill_late_rich_formats() {
        let repo = repo();
        let hash = hash_text(ClipboardContentType::Text, "#### title");
        let item = repo
            .insert_clipboard_item(text_input("#### title", &hash))
            .unwrap();

        let added =
            persist_rich_formats_for_existing_hash(&repo, &hash, &[html_format(b"<h4>title</h4>")])
                .unwrap();
        let repeated =
            persist_rich_formats_for_existing_hash(&repo, &hash, &[html_format(b"<h4>title</h4>")])
                .unwrap();
        let stored = repo.get_item_by_id(item.id).unwrap().unwrap();
        let formats = repo.list_clipboard_formats(item.id).unwrap();

        assert!(added);
        assert!(!repeated);
        assert_eq!(formats.len(), 1);
        assert_eq!(stored.metadata.extra["hasRichFormats"], json!(true));
        assert_eq!(stored.metadata.extra["formatNames"], json!(["HTML Format"]));
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

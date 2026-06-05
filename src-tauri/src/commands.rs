use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::{
    database::repository::Repository,
    errors::{AppError, AppResult},
    events,
    models::{
        AppSettings, BlacklistApp, ClipboardContentType, ClipboardItem, HotkeySettings,
        HotkeySettingsPatch, HudDirection, HudPayload, MonitoringStatus,
    },
    settings,
};

const DEFAULT_HISTORY_LIMIT: i64 = 1000;

#[derive(Debug, Clone, Default)]
pub struct QuickPasteCursorState {
    pub offset: Option<i64>,
    pub last_item_id: Option<i64>,
}

#[derive(Debug)]
struct MonitoringRuntimeState {
    monitor_enabled: bool,
    monitor_started: bool,
    has_timer: bool,
    last_hash_prefix: String,
}

impl Default for MonitoringRuntimeState {
    fn default() -> Self {
        Self {
            monitor_enabled: false,
            monitor_started: false,
            has_timer: false,
            last_hash_prefix: String::new(),
        }
    }
}

pub struct AppState {
    repository: Arc<Repository>,
    monitoring: Arc<Mutex<MonitoringRuntimeState>>,
    history_revision: Arc<AtomicU64>,
    quick_paste_cursor: Arc<Mutex<QuickPasteCursorState>>,
}

impl AppState {
    pub fn new(repository: Repository) -> Self {
        Self {
            repository: Arc::new(repository),
            monitoring: Arc::new(Mutex::new(MonitoringRuntimeState::default())),
            history_revision: Arc::new(AtomicU64::new(0)),
            quick_paste_cursor: Arc::new(Mutex::new(QuickPasteCursorState::default())),
        }
    }

    pub fn repository(&self) -> &Repository {
        &self.repository
    }

    pub fn history_revision(&self) -> u64 {
        self.history_revision.load(Ordering::SeqCst)
    }

    pub fn quick_paste_cursor(&self) -> QuickPasteCursorState {
        self.quick_paste_cursor
            .lock()
            .expect("quick paste cursor lock poisoned")
            .clone()
    }

    fn bump_history_revision(&self) -> u64 {
        self.history_revision.fetch_add(1, Ordering::SeqCst) + 1
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRevisionPayload {
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteResult {
    pub success: bool,
    pub item: Option<ClipboardItem>,
    pub revision: u64,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyConflict {
    pub hotkey: String,
    pub commands: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyConflictReport {
    pub has_conflicts: bool,
    pub conflicts: Vec<HotkeyConflict>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyAvailability {
    pub hotkey: String,
    pub available: bool,
    pub reason: Option<String>,
}

pub fn get_history_impl(state: &AppState, limit: Option<i64>) -> AppResult<Vec<ClipboardItem>> {
    state
        .repository()
        .get_history(normalize_limit(limit.unwrap_or(DEFAULT_HISTORY_LIMIT)))
}

pub fn get_history_revision_impl(state: &AppState) -> u64 {
    state.history_revision()
}

pub fn search_items_impl(
    state: &AppState,
    query: String,
    limit: Option<i64>,
) -> AppResult<Vec<ClipboardItem>> {
    let limit = normalize_limit(limit.unwrap_or(DEFAULT_HISTORY_LIMIT));
    if query.trim().is_empty() {
        state.repository().get_history(limit)
    } else {
        state.repository().search_items(query.trim(), limit)
    }
}

pub fn paste_item_impl(state: &AppState, id: i64) -> AppResult<PasteResult> {
    let Some(_) = state.repository().get_item_by_id(id)? else {
        return Ok(PasteResult {
            success: false,
            item: None,
            revision: state.history_revision(),
            message: "item not found".to_string(),
        });
    };

    let item = state.repository().increment_use_stats(id)?;
    {
        let mut cursor = state
            .quick_paste_cursor
            .lock()
            .expect("quick paste cursor lock poisoned");
        cursor.offset = None;
        cursor.last_item_id = Some(id);
    }
    let revision = state.bump_history_revision();
    Ok(PasteResult {
        success: true,
        item: Some(item),
        revision,
        message: "paste stub completed".to_string(),
    })
}

pub fn delete_item_impl(state: &AppState, id: i64) -> AppResult<u64> {
    state.repository().delete_item(id)?;
    Ok(state.bump_history_revision())
}

pub fn toggle_pin_impl(state: &AppState, id: i64) -> AppResult<ClipboardItem> {
    let item = state.repository().toggle_pin(id)?;
    state.bump_history_revision();
    Ok(item)
}

pub fn toggle_favorite_impl(state: &AppState, id: i64) -> AppResult<ClipboardItem> {
    let item = state.repository().toggle_favorite(id)?;
    state.bump_history_revision();
    Ok(item)
}

pub fn get_image_data_url_impl(state: &AppState, id: i64) -> AppResult<Option<String>> {
    let Some(item) = state.repository().get_item_by_id(id)? else {
        return Ok(None);
    };
    let Some(image_data) = item.image_data else {
        return Ok(None);
    };

    Ok(Some(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(image_data)
    )))
}

pub fn update_setting_impl(state: &AppState, key: String, value: Value) -> AppResult<AppSettings> {
    let settings = settings::update_setting_with_side_effects(state.repository(), &key, value)?;
    state.bump_history_revision();
    Ok(settings)
}

pub fn add_blacklist_impl(
    state: &AppState,
    app_name: String,
    app_path: Option<String>,
) -> AppResult<Vec<BlacklistApp>> {
    let trimmed = app_name.trim();
    if trimmed.is_empty() {
        return Err(AppError::from("blacklist app name cannot be empty"));
    }

    state
        .repository()
        .add_blacklist_app(trimmed, app_path.as_deref())?;
    state.repository().list_blacklist_apps()
}

pub fn remove_blacklist_impl(state: &AppState, id: i64) -> AppResult<Vec<BlacklistApp>> {
    state.repository().remove_blacklist_app(id)?;
    state.repository().list_blacklist_apps()
}

pub fn update_hotkeys_impl(
    state: &AppState,
    patch: HotkeySettingsPatch,
) -> AppResult<HotkeySettings> {
    state.repository().update_hotkey_settings(&patch)
}

pub fn clear_history_impl(state: &AppState, include_favorites: bool) -> AppResult<u64> {
    state.repository().clear_history(include_favorites)?;
    Ok(state.bump_history_revision())
}

pub fn toggle_monitoring_impl(state: &AppState) -> MonitoringStatus {
    let mut monitoring = state
        .monitoring
        .lock()
        .expect("monitoring state lock poisoned");
    monitoring.monitor_enabled = !monitoring.monitor_enabled;
    monitoring.monitor_started = monitoring.monitor_enabled;
    monitoring.has_timer = monitoring.monitor_enabled;
    monitoring_status(&monitoring)
}

pub fn test_monitoring_impl(state: &AppState) -> MonitoringStatus {
    let monitoring = state
        .monitoring
        .lock()
        .expect("monitoring state lock poisoned");
    monitoring_status(&monitoring)
}

pub fn check_hotkey_conflicts_impl(patch: &HotkeySettingsPatch) -> HotkeyConflictReport {
    let mut by_hotkey: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (command, value) in hotkey_patch_entries(patch) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            by_hotkey
                .entry(trimmed.to_string())
                .or_default()
                .push(command.to_string());
        }
    }

    let conflicts: Vec<HotkeyConflict> = by_hotkey
        .into_iter()
        .filter_map(|(hotkey, commands)| {
            (commands.len() > 1).then_some(HotkeyConflict { hotkey, commands })
        })
        .collect();

    HotkeyConflictReport {
        has_conflicts: !conflicts.is_empty(),
        conflicts,
    }
}

pub fn check_hotkey_available_impl(hotkey: String) -> HotkeyAvailability {
    let hotkey = hotkey.trim().to_string();
    if hotkey.is_empty() {
        HotkeyAvailability {
            hotkey,
            available: false,
            reason: Some("hotkey is empty".to_string()),
        }
    } else {
        HotkeyAvailability {
            hotkey,
            available: true,
            reason: None,
        }
    }
}

pub fn test_hud_impl() -> HudPayload {
    HudPayload {
        direction: HudDirection::Next,
        content_type: ClipboardContentType::Text,
        text: "HUD stub".to_string(),
    }
}

#[tauri::command]
pub fn get_history(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> AppResult<Vec<ClipboardItem>> {
    get_history_impl(state.inner(), limit)
}

#[tauri::command]
pub fn get_history_revision(state: State<'_, AppState>) -> u64 {
    get_history_revision_impl(state.inner())
}

#[tauri::command]
pub fn search_items(
    state: State<'_, AppState>,
    query: String,
    limit: Option<i64>,
) -> AppResult<Vec<ClipboardItem>> {
    search_items_impl(state.inner(), query, limit)
}

#[tauri::command]
pub fn paste_item(app: AppHandle, state: State<'_, AppState>, id: i64) -> AppResult<PasteResult> {
    let result = paste_item_impl(state.inner(), id)?;
    if result.success {
        emit_history_revision(&app, result.revision);
    }
    Ok(result)
}

#[tauri::command]
pub fn delete_item(app: AppHandle, state: State<'_, AppState>, id: i64) -> AppResult<u64> {
    let revision = delete_item_impl(state.inner(), id)?;
    emit_history_revision(&app, revision);
    Ok(revision)
}

#[tauri::command]
pub fn toggle_pin(app: AppHandle, state: State<'_, AppState>, id: i64) -> AppResult<ClipboardItem> {
    let item = toggle_pin_impl(state.inner(), id)?;
    emit_history_revision(&app, state.history_revision());
    Ok(item)
}

#[tauri::command]
pub fn toggle_favorite(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> AppResult<ClipboardItem> {
    let item = toggle_favorite_impl(state.inner(), id)?;
    emit_history_revision(&app, state.history_revision());
    Ok(item)
}

#[tauri::command]
pub fn get_image_data_url(state: State<'_, AppState>, id: i64) -> AppResult<Option<String>> {
    get_image_data_url_impl(state.inner(), id)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppResult<AppSettings> {
    state.repository().get_settings()
}

#[tauri::command]
pub fn update_setting(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    value: Value,
) -> AppResult<AppSettings> {
    let settings = update_setting_impl(state.inner(), key, value)?;
    emit_history_revision(&app, state.history_revision());
    Ok(settings)
}

#[tauri::command]
pub fn list_blacklist(state: State<'_, AppState>) -> AppResult<Vec<BlacklistApp>> {
    state.repository().list_blacklist_apps()
}

#[tauri::command]
pub fn add_blacklist(
    state: State<'_, AppState>,
    app_name: String,
    app_path: Option<String>,
) -> AppResult<Vec<BlacklistApp>> {
    add_blacklist_impl(state.inner(), app_name, app_path)
}

#[tauri::command]
pub fn remove_blacklist(state: State<'_, AppState>, id: i64) -> AppResult<Vec<BlacklistApp>> {
    remove_blacklist_impl(state.inner(), id)
}

#[tauri::command]
pub fn get_hotkeys(state: State<'_, AppState>) -> AppResult<HotkeySettings> {
    state.repository().get_hotkey_settings()
}

#[tauri::command]
pub fn check_hotkey_conflicts(patch: HotkeySettingsPatch) -> HotkeyConflictReport {
    check_hotkey_conflicts_impl(&patch)
}

#[tauri::command]
pub fn check_hotkey_available(hotkey: String) -> HotkeyAvailability {
    check_hotkey_available_impl(hotkey)
}

#[tauri::command]
pub fn update_hotkeys(
    state: State<'_, AppState>,
    patch: HotkeySettingsPatch,
) -> AppResult<HotkeySettings> {
    update_hotkeys_impl(state.inner(), patch)
}

#[tauri::command]
pub fn clear_history(
    app: AppHandle,
    state: State<'_, AppState>,
    include_favorites: bool,
) -> AppResult<u64> {
    let revision = clear_history_impl(state.inner(), include_favorites)?;
    emit_history_revision(&app, revision);
    Ok(revision)
}

#[tauri::command]
pub fn toggle_monitoring(app: AppHandle, state: State<'_, AppState>) -> MonitoringStatus {
    let status = toggle_monitoring_impl(state.inner());
    let _ = app.emit(events::MONITORING_CHANGED, &status);
    status
}

#[tauri::command]
pub fn minimize_window() -> bool {
    true
}

#[tauri::command]
pub fn hide_window() -> bool {
    true
}

#[tauri::command]
pub fn test_monitoring(state: State<'_, AppState>) -> MonitoringStatus {
    test_monitoring_impl(state.inner())
}

#[tauri::command]
pub fn test_hud(app: AppHandle) -> HudPayload {
    let payload = test_hud_impl();
    let _ = app.emit(events::HUD_SHOW, &payload);
    payload
}

fn emit_history_revision(app: &AppHandle, revision: u64) {
    let _ = app.emit(
        events::HISTORY_REVISION,
        HistoryRevisionPayload { revision },
    );
}

fn monitoring_status(monitoring: &MonitoringRuntimeState) -> MonitoringStatus {
    MonitoringStatus {
        monitor_enabled: monitoring.monitor_enabled,
        monitor_started: monitoring.monitor_started,
        has_timer: monitoring.has_timer,
        is_running: monitoring.monitor_enabled && monitoring.monitor_started,
        last_hash_prefix: monitoring.last_hash_prefix.clone(),
    }
}

fn normalize_limit(limit: i64) -> i64 {
    limit.clamp(1, DEFAULT_HISTORY_LIMIT)
}

fn hotkey_patch_entries(patch: &HotkeySettingsPatch) -> Vec<(&'static str, &str)> {
    let mut entries = Vec::new();
    if let Some(value) = patch.open_panel.as_deref() {
        entries.push(("openPanel", value));
    }
    if let Some(value) = patch.search.as_deref() {
        entries.push(("search", value));
    }
    if let Some(value) = patch.pause.as_deref() {
        entries.push(("pause", value));
    }
    if let Some(value) = patch.clear.as_deref() {
        entries.push(("clear", value));
    }
    if let Some(value) = patch.quick_paste_prev.as_deref() {
        entries.push(("quickPastePrev", value));
    }
    if let Some(value) = patch.quick_paste_next.as_deref() {
        entries.push(("quickPasteNext", value));
    }
    entries
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use crate::{
        database::repository::Repository,
        models::{ClipboardContentType, ClipboardInsertInput, HotkeySettingsPatch},
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

    #[test]
    fn commands_search_blank_query_returns_history() {
        let state = super::AppState::new(repo());
        state
            .repository()
            .insert_clipboard_item(text_input("alpha", "hash-alpha"))
            .unwrap();

        let items = super::search_items_impl(&state, "   ".to_string(), Some(10)).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].preview, "alpha");
    }

    #[test]
    fn commands_delete_and_clear_bump_history_revision() {
        let state = super::AppState::new(repo());
        let item = state
            .repository()
            .insert_clipboard_item(text_input("alpha", "hash-alpha"))
            .unwrap();
        assert_eq!(state.history_revision(), 0);

        let after_delete = super::delete_item_impl(&state, item.id).unwrap();
        let after_clear = super::clear_history_impl(&state, true).unwrap();

        assert_eq!(after_delete, 1);
        assert_eq!(after_clear, 2);
    }

    #[test]
    fn commands_hotkey_conflicts_detect_duplicate_non_empty_strings() {
        let report = super::check_hotkey_conflicts_impl(&HotkeySettingsPatch {
            open_panel: Some("Ctrl+Shift+V".to_string()),
            search: Some(" Ctrl+Shift+V ".to_string()),
            clear: Some("".to_string()),
            ..HotkeySettingsPatch::default()
        });

        assert!(report.has_conflicts);
        assert_eq!(report.conflicts.len(), 1);
        assert_eq!(report.conflicts[0].hotkey, "Ctrl+Shift+V");
    }

    #[test]
    fn commands_monitoring_toggle_returns_status() {
        let state = super::AppState::new(repo());

        let enabled = super::toggle_monitoring_impl(&state);
        let disabled = super::toggle_monitoring_impl(&state);

        assert!(enabled.monitor_enabled);
        assert!(enabled.is_running);
        assert!(!disabled.monitor_enabled);
        assert!(!disabled.is_running);
    }
}

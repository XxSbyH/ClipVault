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
use tauri::{AppHandle, Emitter, State, Window};
use tauri_plugin_autostart::ManagerExt as _;

use crate::{
    database::repository::Repository,
    errors::{AppError, AppResult},
    events,
    hotkeys::{self, QuickPasteCursor, QuickPasteCursorSnapshot},
    models::{
        AppSettings, BlacklistApp, ClipboardContentType, ClipboardItem, FixedContent,
        FixedContentInput, HotkeySettings, HotkeySettingsPatch, HudDirection, HudPayload,
        MonitoringStatus, WheelShortcutModifier, WheelShortcutScope,
    },
    paste, settings, windows,
};

const DEFAULT_HISTORY_LIMIT: i64 = 1000;

#[derive(Debug)]
struct MonitoringRuntimeState {
    monitor_enabled: bool,
    monitor_started: bool,
    has_timer: bool,
    is_running: bool,
    last_hash_prefix: String,
}

impl Default for MonitoringRuntimeState {
    fn default() -> Self {
        Self {
            monitor_enabled: true,
            monitor_started: false,
            has_timer: false,
            is_running: false,
            last_hash_prefix: String::new(),
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    repository: Arc<Repository>,
    monitoring: Arc<Mutex<MonitoringRuntimeState>>,
    history_revision: Arc<AtomicU64>,
    quick_paste_cursor: Arc<Mutex<QuickPasteCursor>>,
}

impl AppState {
    pub fn new(repository: Repository) -> Self {
        Self {
            repository: Arc::new(repository),
            monitoring: Arc::new(Mutex::new(MonitoringRuntimeState::default())),
            history_revision: Arc::new(AtomicU64::new(0)),
            quick_paste_cursor: Arc::new(Mutex::new(QuickPasteCursor::default())),
        }
    }

    pub fn repository(&self) -> &Repository {
        &self.repository
    }

    pub fn history_revision(&self) -> u64 {
        self.history_revision.load(Ordering::SeqCst)
    }

    pub fn quick_paste_cursor(&self) -> QuickPasteCursorSnapshot {
        self.quick_paste_cursor
            .lock()
            .expect("quick paste cursor lock poisoned")
            .snapshot()
    }

    pub fn quick_paste_cursor_mut<T>(&self, f: impl FnOnce(&mut QuickPasteCursor) -> T) -> T {
        let mut cursor = self
            .quick_paste_cursor
            .lock()
            .expect("quick paste cursor lock poisoned");
        f(&mut cursor)
    }

    pub fn monitoring_enabled(&self) -> bool {
        self.monitoring
            .lock()
            .expect("monitoring state lock poisoned")
            .monitor_enabled
    }

    pub fn set_monitoring_service_started(&self, started: bool) -> MonitoringStatus {
        let mut monitoring = self
            .monitoring
            .lock()
            .expect("monitoring state lock poisoned");
        monitoring.monitor_started = started;
        monitoring.has_timer = started;
        if !started {
            monitoring.is_running = false;
        }
        monitoring_status(&monitoring)
    }

    pub fn set_monitoring_running(&self, running: bool) -> MonitoringStatus {
        let mut monitoring = self
            .monitoring
            .lock()
            .expect("monitoring state lock poisoned");
        monitoring.is_running = running;
        monitoring_status(&monitoring)
    }

    pub fn set_monitoring_last_hash(&self, hash: &str) -> MonitoringStatus {
        let mut monitoring = self
            .monitoring
            .lock()
            .expect("monitoring state lock poisoned");
        monitoring.last_hash_prefix = hash.chars().take(12).collect();
        monitoring_status(&monitoring)
    }

    pub fn bump_history_revision(&self) -> u64 {
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
pub struct ClearHistoryResult {
    pub revision: u64,
    pub deleted: usize,
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

pub fn paste_item_impl<F>(state: &AppState, id: i64, paste: F) -> AppResult<PasteResult>
where
    F: FnOnce(&ClipboardItem) -> AppResult<()>,
{
    let Some(item) = state.repository().get_item_by_id(id)? else {
        return Ok(PasteResult {
            success: false,
            item: None,
            revision: state.history_revision(),
            message: "item not found".to_string(),
        });
    };

    if let Err(error) = paste(&item) {
        return Ok(PasteResult {
            success: false,
            item: Some(item),
            revision: state.history_revision(),
            message: error.to_string(),
        });
    }

    let item = state.repository().increment_use_stats(id)?;
    let revision = state.bump_history_revision();
    Ok(PasteResult {
        success: true,
        item: Some(item),
        revision,
        message: "pasted".to_string(),
    })
}

pub fn copy_item_impl<F>(state: &AppState, id: i64, copy: F) -> AppResult<PasteResult>
where
    F: FnOnce(&ClipboardItem) -> AppResult<()>,
{
    let Some(item) = state.repository().get_item_by_id(id)? else {
        return Ok(PasteResult {
            success: false,
            item: None,
            revision: state.history_revision(),
            message: "item not found".to_string(),
        });
    };

    if let Err(error) = copy(&item) {
        return Ok(PasteResult {
            success: false,
            item: Some(item),
            revision: state.history_revision(),
            message: error.to_string(),
        });
    }

    let item = state.repository().increment_use_stats(id)?;
    let revision = state.bump_history_revision();
    Ok(PasteResult {
        success: true,
        item: Some(item),
        revision,
        message: "copied".to_string(),
    })
}

pub fn delete_item_impl(state: &AppState, id: i64) -> AppResult<u64> {
    if state.repository().get_item_by_id(id)?.is_none() {
        return Err(AppError::from(format!("clipboard item {id} not found")));
    }

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
    let Some(image_data) = item.image_data.as_deref() else {
        return Ok(None);
    };
    let mime_type = detect_image_mime_type(&item, image_data);

    Ok(Some(format!(
        "{mime_type};base64,{}",
        STANDARD.encode(image_data)
    )))
}

pub fn update_setting_impl(state: &AppState, key: String, value: Value) -> AppResult<AppSettings> {
    let before_count = state.repository().count_items()?;
    let settings = settings::update_setting_with_side_effects(state.repository(), &key, value)?;
    let after_count = state.repository().count_items()?;
    if before_count != after_count {
        state.bump_history_revision();
    }
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

pub fn validate_fixed_content_input(input: &FixedContentInput) -> AppResult<FixedContentInput> {
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::from("fixed content title cannot be empty"));
    }

    let content = input.content.trim().to_string();
    if content.is_empty() {
        return Err(AppError::from("fixed content content cannot be empty"));
    }

    let hotkey = input.hotkey.trim().to_string();
    if hotkey.is_empty() {
        return Err(AppError::from("fixed content hotkey cannot be empty"));
    }
    parse_hotkey_id("fixed content", &hotkey)?;

    Ok(FixedContentInput {
        title,
        content,
        hotkey,
        enabled: input.enabled,
    })
}

pub fn validate_fixed_content_hotkey_conflicts(
    state: &AppState,
    current_id: Option<i64>,
    input: &FixedContentInput,
) -> AppResult<()> {
    if !input.enabled {
        return Ok(());
    }

    let settings = state.repository().get_hotkey_settings()?;
    let mut assignments = BTreeMap::new();
    add_hotkey_settings_assignments(&mut assignments, &settings)?;

    for content in state.repository().list_fixed_contents()? {
        if !content.enabled || Some(content.id) == current_id {
            continue;
        }
        add_hotkey_assignment(
            &mut assignments,
            &format!("fixed content {}", content.id),
            &content.hotkey,
        )?;
    }

    add_hotkey_assignment(&mut assignments, "fixed content candidate", &input.hotkey)
}

pub fn validate_hotkey_settings_conflicts_with_fixed_contents(
    state: &AppState,
    settings: &HotkeySettings,
) -> AppResult<()> {
    let mut assignments = BTreeMap::new();
    add_hotkey_settings_assignments(&mut assignments, settings)?;

    for content in state.repository().list_fixed_contents()? {
        if content.enabled {
            add_hotkey_assignment(
                &mut assignments,
                &format!("fixed content {}", content.id),
                &content.hotkey,
            )?;
        }
    }
    Ok(())
}

pub fn list_fixed_contents_impl(state: &AppState) -> AppResult<Vec<FixedContent>> {
    state.repository().list_fixed_contents()
}

pub fn create_fixed_content_impl(
    state: &AppState,
    input: FixedContentInput,
) -> AppResult<FixedContent> {
    let input = validate_fixed_content_input(&input)?;
    validate_fixed_content_hotkey_conflicts(state, None, &input)?;
    state.repository().create_fixed_content(&input)
}

pub fn update_fixed_content_impl(
    state: &AppState,
    id: i64,
    input: FixedContentInput,
) -> AppResult<FixedContent> {
    let input = validate_fixed_content_input(&input)?;
    validate_fixed_content_hotkey_conflicts(state, Some(id), &input)?;
    state
        .repository()
        .update_fixed_content(id, &input)?
        .ok_or_else(|| AppError::from(format!("fixed content {id} not found")))
}

pub fn delete_fixed_content_impl(state: &AppState, id: i64) -> AppResult<()> {
    if state.repository().delete_fixed_content(id)? {
        Ok(())
    } else {
        Err(AppError::from(format!("fixed content {id} not found")))
    }
}

pub fn trigger_fixed_content_impl<F>(
    state: &AppState,
    id: i64,
    paste: F,
) -> AppResult<Option<FixedContent>>
where
    F: FnOnce(&FixedContent) -> AppResult<()>,
{
    let Some(content) = state.repository().get_fixed_content_by_id(id)? else {
        return Ok(None);
    };
    if !content.enabled {
        return Ok(None);
    }

    paste(&content)?;
    state.repository().increment_fixed_content_use_stats(id)
}

pub fn update_hotkeys_impl(
    state: &AppState,
    patch: HotkeySettingsPatch,
) -> AppResult<HotkeySettings> {
    let current = state.repository().get_hotkey_settings()?;
    let candidate = build_hotkey_settings_candidate(&current, &patch)?;
    validate_hotkey_settings_conflicts_with_fixed_contents(state, &candidate)?;
    state
        .repository()
        .update_hotkey_settings(&HotkeySettingsPatch::from(&candidate))
}

pub fn clear_history_impl(
    state: &AppState,
    include_favorites: bool,
) -> AppResult<ClearHistoryResult> {
    let deleted = state.repository().clear_history(include_favorites)?;
    let revision = if deleted > 0 {
        state.bump_history_revision()
    } else {
        state.history_revision()
    };
    Ok(ClearHistoryResult { revision, deleted })
}

pub fn toggle_monitoring_impl(state: &AppState) -> MonitoringStatus {
    let mut monitoring = state
        .monitoring
        .lock()
        .expect("monitoring state lock poisoned");
    monitoring.monitor_enabled = !monitoring.monitor_enabled;
    if !monitoring.monitor_enabled {
        monitoring.is_running = false;
    }
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

pub fn check_hotkey_available_with_system_impl(
    app: &AppHandle,
    hotkey: String,
) -> HotkeyAvailability {
    let probe = hotkeys::check_system_hotkey_available(app, &hotkey);
    HotkeyAvailability {
        hotkey: probe.hotkey,
        available: probe.available,
        reason: probe.reason,
    }
}

pub fn build_hotkey_settings_candidate(
    current: &HotkeySettings,
    patch: &HotkeySettingsPatch,
) -> AppResult<HotkeySettings> {
    let mut candidate = current.clone();
    if let Some(value) = patch.open_panel.as_deref() {
        candidate.open_panel = normalize_hotkey_patch_value("openPanel", value)?;
    }
    if let Some(value) = patch.search.as_deref() {
        candidate.search = normalize_hotkey_patch_value("search", value)?;
    }
    if let Some(value) = patch.pause.as_deref() {
        candidate.pause = normalize_hotkey_patch_value("pause", value)?;
    }
    if let Some(value) = patch.clear.as_deref() {
        candidate.clear = normalize_hotkey_patch_value("clear", value)?;
    }
    if let Some(value) = patch.quick_paste_prev.as_deref() {
        candidate.quick_paste_prev = normalize_hotkey_patch_value("quickPastePrev", value)?;
    }
    if let Some(value) = patch.quick_paste_next.as_deref() {
        candidate.quick_paste_next = normalize_hotkey_patch_value("quickPasteNext", value)?;
    }
    hotkeys::validate_hotkey_settings(&candidate)?;
    Ok(candidate)
}

pub fn test_hud_impl() -> HudPayload {
    HudPayload::quick_paste(
        HudDirection::Next,
        ClipboardContentType::Text,
        "HUD stub".to_string(),
    )
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
    let result = paste_item_impl(state.inner(), id, |item| {
        paste::write_clipboard_and_paste(&app, item)
    })?;
    if result.success {
        emit_history_revision(&app, result.revision);
    }
    Ok(result)
}

#[tauri::command]
pub fn copy_item(app: AppHandle, state: State<'_, AppState>, id: i64) -> AppResult<PasteResult> {
    let result = copy_item_impl(state.inner(), id, |item| {
        paste::write_item_to_clipboard(&app, item)
    })?;
    if result.success {
        emit_history_revision(&app, result.revision);
        if let Some(item) = result.item.as_ref() {
            emit_hud_notification(
                &app,
                HudPayload::copy_success(item.content_type, item.preview.clone()),
            );
        }
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
    if is_wheel_shortcut_setting_key(&key) {
        return update_wheel_shortcut_setting(&app, state.inner(), key, value);
    }

    let before_revision = state.history_revision();
    let should_apply_autostart = key == "launchOnStartup";
    let settings = update_setting_impl(state.inner(), key, value)?;
    if should_apply_autostart {
        apply_setting_side_effect(&app, &settings)?;
    }
    let after_revision = state.history_revision();
    if after_revision != before_revision {
        emit_history_revision(&app, after_revision);
    }
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
pub fn list_fixed_contents(state: State<'_, AppState>) -> AppResult<Vec<FixedContent>> {
    list_fixed_contents_impl(state.inner())
}

#[tauri::command]
pub fn create_fixed_content(
    app: AppHandle,
    state: State<'_, AppState>,
    input: FixedContentInput,
) -> AppResult<FixedContent> {
    let created = create_fixed_content_impl(state.inner(), input)?;

    if let Err(error) = hotkeys::replace_all_keyboard_shortcuts(&app, state.inner()) {
        if let Err(rollback_error) = state.repository().delete_fixed_content(created.id) {
            return Err(AppError::from(format!(
                "{error}; failed to rollback fixed content create: {rollback_error}"
            )));
        }
        if let Err(restore_error) = restore_all_keyboard_shortcuts(&app, state.inner()) {
            return Err(with_restore_error(error, restore_error));
        }
        return Err(error);
    }

    Ok(created)
}

#[tauri::command]
pub fn update_fixed_content(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    input: FixedContentInput,
) -> AppResult<FixedContent> {
    let candidate_input = validate_fixed_content_input(&input)?;
    validate_fixed_content_hotkey_conflicts(state.inner(), Some(id), &candidate_input)?;

    let settings = state.repository().get_hotkey_settings()?;
    let mut fixed_contents = state.repository().list_fixed_contents()?;
    let mut found = false;
    for content in &mut fixed_contents {
        if content.id == id {
            content.title = candidate_input.title.clone();
            content.content = candidate_input.content.clone();
            content.hotkey = candidate_input.hotkey.clone();
            content.enabled = candidate_input.enabled;
            found = true;
            break;
        }
    }
    if !found {
        return Err(AppError::from(format!("fixed content {id} not found")));
    }

    if let Err(error) =
        hotkeys::replace_keyboard_shortcuts_with_fixed_contents(&app, &settings, &fixed_contents)
    {
        if let Err(restore_error) = restore_all_keyboard_shortcuts(&app, state.inner()) {
            return Err(with_restore_error(error, restore_error));
        }
        return Err(error);
    }

    match update_fixed_content_impl(state.inner(), id, input) {
        Ok(content) => Ok(content),
        Err(error) => {
            if let Err(restore_error) = restore_all_keyboard_shortcuts(&app, state.inner()) {
                return Err(with_restore_error(error, restore_error));
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub fn delete_fixed_content(app: AppHandle, state: State<'_, AppState>, id: i64) -> AppResult<()> {
    let settings = state.repository().get_hotkey_settings()?;
    let fixed_contents = state.repository().list_fixed_contents()?;
    if !fixed_contents.iter().any(|content| content.id == id) {
        return Err(AppError::from(format!("fixed content {id} not found")));
    }
    let candidate_contents: Vec<FixedContent> = fixed_contents
        .into_iter()
        .filter(|content| content.id != id)
        .collect();

    if let Err(error) = hotkeys::replace_keyboard_shortcuts_with_fixed_contents(
        &app,
        &settings,
        &candidate_contents,
    ) {
        if let Err(restore_error) = restore_all_keyboard_shortcuts(&app, state.inner()) {
            return Err(with_restore_error(error, restore_error));
        }
        return Err(error);
    }

    match delete_fixed_content_impl(state.inner(), id) {
        Ok(()) => Ok(()),
        Err(error) => {
            if let Err(restore_error) = restore_all_keyboard_shortcuts(&app, state.inner()) {
                return Err(with_restore_error(error, restore_error));
            }
            Err(error)
        }
    }
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
pub fn check_hotkey_available(app: AppHandle, hotkey: String) -> HotkeyAvailability {
    check_hotkey_available_with_system_impl(&app, hotkey)
}

#[tauri::command]
pub fn update_hotkeys(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: HotkeySettingsPatch,
) -> AppResult<HotkeySettings> {
    let current = state.repository().get_hotkey_settings()?;
    let candidate = build_hotkey_settings_candidate(&current, &patch)?;
    validate_hotkey_settings_conflicts_with_fixed_contents(state.inner(), &candidate)?;
    let fixed_contents = state.repository().list_fixed_contents()?;

    if let Err(error) =
        hotkeys::replace_keyboard_shortcuts_with_fixed_contents(&app, &candidate, &fixed_contents)
    {
        if let Err(restore_error) = restore_all_keyboard_shortcuts(&app, state.inner()) {
            return Err(with_restore_error(error, restore_error));
        }
        return Err(error);
    }

    match state
        .repository()
        .update_hotkey_settings(&HotkeySettingsPatch::from(&candidate))
    {
        Ok(hotkeys) => Ok(hotkeys),
        Err(error) => {
            if let Err(restore_error) = restore_all_keyboard_shortcuts(&app, state.inner()) {
                return Err(with_restore_error(error, restore_error));
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub fn clear_history(
    app: AppHandle,
    state: State<'_, AppState>,
    include_favorites: bool,
) -> AppResult<ClearHistoryResult> {
    let result = clear_history_impl(state.inner(), include_favorites)?;
    if result.deleted > 0 {
        emit_history_revision(&app, result.revision);
    }
    Ok(result)
}

#[tauri::command]
pub fn toggle_monitoring(app: AppHandle, state: State<'_, AppState>) -> MonitoringStatus {
    let status = toggle_monitoring_impl(state.inner());
    let _ = app.emit(events::MONITORING_CHANGED, &status);
    status
}

#[tauri::command]
pub fn minimize_window(window: Window) -> AppResult<()> {
    window
        .minimize()
        .map_err(|err| AppError::from(format!("failed to minimize window: {err}")))
}

#[tauri::command]
pub fn hide_window(app: AppHandle, window: Window) -> AppResult<()> {
    let label = window.label().to_string();
    window
        .hide()
        .map_err(|err| AppError::from(format!("failed to hide window: {err}")))?;
    if label == "main" {
        emit_hud_notification(
            &app,
            HudPayload::panel("控制面板", "已隐藏，Ctrl+Shift+V 可再次唤起"),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn test_monitoring(state: State<'_, AppState>) -> MonitoringStatus {
    test_monitoring_impl(state.inner())
}

#[tauri::command]
pub fn test_hud(app: AppHandle) -> HudPayload {
    let payload = test_hud_impl();
    emit_hud_notification(&app, payload.clone());
    payload
}

pub fn emit_hud_notification(app: &AppHandle, payload: HudPayload) {
    let _ = windows::show_hud_window(app);
    let _ = app.emit(events::HUD_SHOW, &payload);
}

fn emit_history_revision(app: &AppHandle, revision: u64) {
    let _ = app.emit(
        events::HISTORY_REVISION,
        HistoryRevisionPayload { revision },
    );
}

fn apply_setting_side_effect(app: &AppHandle, settings: &AppSettings) -> AppResult<()> {
    if settings.launch_on_startup {
        app.autolaunch()
            .enable()
            .map_err(|err| AppError::from(format!("failed to enable autostart: {err}")))?;
    } else {
        app.autolaunch()
            .disable()
            .map_err(|err| AppError::from(format!("failed to disable autostart: {err}")))?;
    }
    Ok(())
}

fn update_wheel_shortcut_setting(
    app: &AppHandle,
    state: &AppState,
    key: String,
    value: Value,
) -> AppResult<AppSettings> {
    let current = state.repository().get_settings()?;
    let candidate = build_wheel_shortcut_settings_candidate(&current, &key, value.clone())?;

    if let Err(error) = hotkeys::start_wheel_hook_with_options(
        app,
        hotkeys::WheelHookOptions::from_settings(&candidate),
    ) {
        restore_wheel_hook(app, &current);
        return Err(error);
    }

    match update_setting_impl(state, key, value) {
        Ok(settings) => Ok(settings),
        Err(error) => {
            restore_wheel_hook(app, &current);
            Err(error)
        }
    }
}

pub fn build_wheel_shortcut_settings_candidate(
    current: &AppSettings,
    key: &str,
    value: Value,
) -> AppResult<AppSettings> {
    let mut candidate = current.clone();
    match key {
        "wheelShortcutEnabled" => {
            candidate.wheel_shortcut_enabled =
                serde_json::from_value::<bool>(value).map_err(|error| {
                    AppError::from(format!("invalid wheelShortcutEnabled: {error}"))
                })?;
        }
        "wheelShortcutModifier" => {
            candidate.wheel_shortcut_modifier =
                serde_json::from_value::<WheelShortcutModifier>(value).map_err(|error| {
                    AppError::from(format!("invalid wheelShortcutModifier: {error}"))
                })?;
        }
        "wheelShortcutScope" => {
            candidate.wheel_shortcut_scope = serde_json::from_value::<WheelShortcutScope>(value)
                .map_err(|error| AppError::from(format!("invalid wheelShortcutScope: {error}")))?;
        }
        _ => return Err(AppError::from(format!("unsupported wheel setting: {key}"))),
    }
    Ok(candidate)
}

fn restore_wheel_hook(app: &AppHandle, settings: &AppSettings) {
    if let Err(error) = hotkeys::start_wheel_hook_with_options(
        app,
        hotkeys::WheelHookOptions::from_settings(settings),
    ) {
        tracing::error!(target: "hotkeys", "failed to restore previous wheel hook: {error}");
    }
}

fn restore_all_keyboard_shortcuts(app: &AppHandle, state: &AppState) -> AppResult<()> {
    hotkeys::replace_all_keyboard_shortcuts(app, state)
}

fn with_restore_error(error: AppError, restore_error: AppError) -> AppError {
    AppError::from(format!(
        "{error}; failed to restore previous hotkeys: {restore_error}"
    ))
}

fn monitoring_status(monitoring: &MonitoringRuntimeState) -> MonitoringStatus {
    MonitoringStatus {
        monitor_enabled: monitoring.monitor_enabled,
        monitor_started: monitoring.monitor_started,
        has_timer: monitoring.has_timer,
        is_running: monitoring.is_running,
        last_hash_prefix: monitoring.last_hash_prefix.clone(),
    }
}

fn normalize_limit(limit: i64) -> i64 {
    limit.clamp(1, DEFAULT_HISTORY_LIMIT)
}

fn normalize_hotkey_patch_value(key: &str, value: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::from(format!("invalid hotkey_{key}: empty value")));
    }
    Ok(trimmed.to_string())
}

fn is_wheel_shortcut_setting_key(key: &str) -> bool {
    matches!(
        key,
        "wheelShortcutEnabled" | "wheelShortcutModifier" | "wheelShortcutScope"
    )
}

fn detect_image_mime_type(item: &ClipboardItem, image_data: &[u8]) -> &'static str {
    if let Some(value) = metadata_mime_type(item) {
        return value;
    }

    match image_data {
        [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, ..] => "data:image/png",
        [0xFF, 0xD8, 0xFF, ..] => "data:image/jpeg",
        [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => "data:image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "data:image/webp",
        _ => "data:application/octet-stream",
    }
}

fn metadata_mime_type(item: &ClipboardItem) -> Option<&'static str> {
    for key in ["mimeType", "mime_type", "contentType", "content_type"] {
        let Some(value) = item.metadata.extra.get(key).and_then(Value::as_str) else {
            continue;
        };

        match value.trim().to_ascii_lowercase().as_str() {
            "image/png" | "data:image/png" => return Some("data:image/png"),
            "image/jpeg" | "image/jpg" | "data:image/jpeg" | "data:image/jpg" => {
                return Some("data:image/jpeg");
            }
            "image/gif" | "data:image/gif" => return Some("data:image/gif"),
            "image/webp" | "data:image/webp" => return Some("data:image/webp"),
            _ => {}
        }
    }

    None
}

fn parse_hotkey_id(command: &str, accelerator: &str) -> AppResult<u32> {
    accelerator
        .trim()
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map(|shortcut| shortcut.id())
        .map_err(|error| {
            AppError::from(format!(
                "invalid hotkey {command}={}: {error}",
                accelerator.trim()
            ))
        })
}

fn add_hotkey_settings_assignments(
    assignments: &mut BTreeMap<u32, String>,
    settings: &HotkeySettings,
) -> AppResult<()> {
    for (command, accelerator) in hotkey_settings_entries(settings) {
        add_hotkey_assignment(assignments, command, accelerator)?;
    }
    Ok(())
}

fn add_hotkey_assignment(
    assignments: &mut BTreeMap<u32, String>,
    command: &str,
    accelerator: &str,
) -> AppResult<()> {
    let id = parse_hotkey_id(command, accelerator)?;
    if let Some(existing) = assignments.insert(id, command.to_string()) {
        return Err(AppError::from(format!(
            "hotkey {} is assigned to both {existing} and {command}",
            accelerator.trim()
        )));
    }
    Ok(())
}

fn hotkey_settings_entries(settings: &HotkeySettings) -> Vec<(&'static str, &str)> {
    vec![
        ("openPanel", &settings.open_panel),
        ("search", &settings.search),
        ("pause", &settings.pause),
        ("clear", &settings.clear),
        ("quickPastePrev", &settings.quick_paste_prev),
        ("quickPasteNext", &settings.quick_paste_next),
    ]
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
        errors::AppError,
        models::{
            ClipboardContentType, ClipboardInsertInput, ClipboardMetadata, FixedContentInput,
            HotkeySettingsPatch,
        },
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

    fn image_input(hash: &str, image_data: Vec<u8>) -> ClipboardInsertInput {
        ClipboardInsertInput {
            content: None,
            content_type: ClipboardContentType::Image,
            content_hash: hash.to_string(),
            preview: "[image]".to_string(),
            metadata: Some(ClipboardMetadata::default()),
            file_path: None,
            image_data: Some(image_data),
        }
    }

    fn fixed_content_input(
        title: &str,
        content: &str,
        hotkey: &str,
        enabled: bool,
    ) -> FixedContentInput {
        FixedContentInput {
            title: title.to_string(),
            content: content.to_string(),
            hotkey: hotkey.to_string(),
            enabled,
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
        assert_eq!(after_clear.revision, 1);
        assert_eq!(after_clear.deleted, 0);
    }

    #[test]
    fn commands_clear_history_returns_real_deleted_count() {
        let state = super::AppState::new(repo());
        let normal = state
            .repository()
            .insert_clipboard_item(text_input("normal", "hash-normal"))
            .unwrap();
        let favorite = state
            .repository()
            .insert_clipboard_item(text_input("favorite", "hash-favorite"))
            .unwrap();
        state.repository().toggle_favorite(favorite.id).unwrap();

        let result = super::clear_history_impl(&state, false).unwrap();
        let remaining_ids: Vec<i64> = state
            .repository()
            .get_history(10)
            .unwrap()
            .into_iter()
            .map(|item| item.id)
            .collect();

        assert_eq!(result.deleted, 1);
        assert_eq!(result.revision, 1);
        assert!(!remaining_ids.contains(&normal.id));
        assert_eq!(remaining_ids, vec![favorite.id]);
    }

    #[test]
    fn commands_delete_missing_item_returns_error_without_bumping_revision() {
        let state = super::AppState::new(repo());

        let result = super::delete_item_impl(&state, 404);

        assert!(result.unwrap_err().to_string().contains("not found"));
        assert_eq!(state.history_revision(), 0);
    }

    #[test]
    fn commands_paste_item_updates_use_stats_after_successful_paste() {
        let state = super::AppState::new(repo());
        let item = state
            .repository()
            .insert_clipboard_item(text_input("alpha", "hash-alpha"))
            .unwrap();

        let result = super::paste_item_impl(&state, item.id, |_| Ok(())).unwrap();
        let stored = state.repository().get_item_by_id(item.id).unwrap().unwrap();

        assert!(result.success);
        assert_eq!(result.item.as_ref().map(|item| item.use_count), Some(1));
        assert_eq!(result.revision, 1);
        assert_eq!(stored.use_count, 1);
        assert!(stored.last_used_at.is_some());
        assert_eq!(state.history_revision(), 1);
    }

    #[test]
    fn commands_paste_item_failure_does_not_update_use_stats() {
        let state = super::AppState::new(repo());
        let item = state
            .repository()
            .insert_clipboard_item(text_input("alpha", "hash-alpha"))
            .unwrap();

        let result =
            super::paste_item_impl(&state, item.id, |_| Err(AppError::from("paste failed")))
                .unwrap();
        let stored = state.repository().get_item_by_id(item.id).unwrap().unwrap();

        assert!(!result.success);
        assert!(result.message.contains("paste failed"));
        assert_eq!(result.revision, 0);
        assert_eq!(stored.use_count, 0);
        assert_eq!(state.history_revision(), 0);
    }

    #[test]
    fn commands_copy_item_updates_use_stats_after_successful_copy() {
        let state = super::AppState::new(repo());
        let item = state
            .repository()
            .insert_clipboard_item(text_input("alpha", "hash-alpha"))
            .unwrap();

        let result = super::copy_item_impl(&state, item.id, |_| Ok(())).unwrap();
        let stored = state.repository().get_item_by_id(item.id).unwrap().unwrap();

        assert!(result.success);
        assert_eq!(result.message, "copied");
        assert_eq!(result.item.as_ref().map(|item| item.use_count), Some(1));
        assert_eq!(result.revision, 1);
        assert_eq!(stored.use_count, 1);
        assert!(stored.last_used_at.is_some());
        assert_eq!(state.history_revision(), 1);
    }

    #[test]
    fn commands_copy_item_failure_does_not_update_use_stats() {
        let state = super::AppState::new(repo());
        let item = state
            .repository()
            .insert_clipboard_item(text_input("alpha", "hash-alpha"))
            .unwrap();

        let result =
            super::copy_item_impl(&state, item.id, |_| Err(AppError::from("copy failed"))).unwrap();
        let stored = state.repository().get_item_by_id(item.id).unwrap().unwrap();

        assert!(!result.success);
        assert!(result.message.contains("copy failed"));
        assert_eq!(result.revision, 0);
        assert_eq!(stored.use_count, 0);
        assert_eq!(state.history_revision(), 0);
    }

    #[test]
    fn commands_image_data_url_detects_jpeg_magic_bytes() {
        let state = super::AppState::new(repo());
        let item = state
            .repository()
            .insert_clipboard_item(image_input(
                "hash-jpeg",
                vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10],
            ))
            .unwrap();

        let data_url = super::get_image_data_url_impl(&state, item.id)
            .unwrap()
            .unwrap();

        assert!(data_url.starts_with("data:image/jpeg;base64,"));
    }

    #[test]
    fn commands_setting_update_does_not_bump_revision_when_history_is_unchanged() {
        let state = super::AppState::new(repo());

        let settings =
            super::update_setting_impl(&state, "textLimitKb".to_string(), serde_json::json!(64))
                .unwrap();

        assert_eq!(settings.text_limit_kb, 64);
        assert_eq!(state.history_revision(), 0);
    }

    #[test]
    fn fixed_content_candidate_rejects_blank_and_invalid_values() {
        let blank_title = super::validate_fixed_content_input(&fixed_content_input(
            "  ", "content", "Ctrl+1", true,
        ))
        .unwrap_err();
        assert!(blank_title.to_string().contains("title"));

        let blank_content = super::validate_fixed_content_input(&fixed_content_input(
            "Title", "  ", "Ctrl+1", true,
        ))
        .unwrap_err();
        assert!(blank_content.to_string().contains("content"));

        let blank_hotkey = super::validate_fixed_content_input(&fixed_content_input(
            "Title", "content", "  ", true,
        ))
        .unwrap_err();
        assert!(blank_hotkey.to_string().contains("hotkey"));

        let invalid = super::validate_fixed_content_input(&fixed_content_input(
            "Title", "content", "nope", true,
        ))
        .unwrap_err();
        assert!(invalid.to_string().contains("invalid hotkey"));

        let trimmed = super::validate_fixed_content_input(&fixed_content_input(
            " Title ",
            " content ",
            " Ctrl+1 ",
            true,
        ))
        .unwrap();
        assert_eq!(trimmed.title, "Title");
        assert_eq!(trimmed.content, "content");
        assert_eq!(trimmed.hotkey, "Ctrl+1");
    }

    #[test]
    fn fixed_content_conflicts_with_existing_enabled_hotkeys() {
        let state = super::AppState::new(repo());
        state
            .repository()
            .create_fixed_content(&fixed_content_input("Disabled", "A", "Ctrl+1", false))
            .unwrap();
        let enabled = state
            .repository()
            .create_fixed_content(&fixed_content_input("Enabled", "B", "Ctrl+2", true))
            .unwrap();

        let disabled_duplicate = fixed_content_input("New", "C", "Ctrl+1", true);
        assert!(
            super::validate_fixed_content_hotkey_conflicts(&state, None, &disabled_duplicate)
                .is_ok()
        );

        let normal_duplicate = fixed_content_input("New", "C", "CommandOrControl+Shift+V", true);
        assert!(
            super::validate_fixed_content_hotkey_conflicts(&state, None, &normal_duplicate)
                .unwrap_err()
                .to_string()
                .contains("openPanel")
        );

        let fixed_duplicate = fixed_content_input("New", "C", "Ctrl+2", true);
        assert!(
            super::validate_fixed_content_hotkey_conflicts(&state, None, &fixed_duplicate)
                .unwrap_err()
                .to_string()
                .contains("fixed content")
        );

        let self_update = fixed_content_input("Enabled", "B", "Ctrl+2", true);
        assert!(super::validate_fixed_content_hotkey_conflicts(
            &state,
            Some(enabled.id),
            &self_update
        )
        .is_ok());

        let disabled_input = fixed_content_input("Disabled Duplicate", "C", "Ctrl+2", false);
        assert!(
            super::validate_fixed_content_hotkey_conflicts(&state, None, &disabled_input).is_ok()
        );
    }

    #[test]
    fn fixed_content_trigger_updates_usage_after_successful_paste() {
        let state = super::AppState::new(repo());
        let fixed = state
            .repository()
            .create_fixed_content(&fixed_content_input("Greeting", "Hello", "Ctrl+1", true))
            .unwrap();
        let mut pasted = None;

        let result = super::trigger_fixed_content_impl(&state, fixed.id, |content| {
            pasted = Some(content.content.clone());
            Ok(())
        })
        .unwrap();
        let stored = state
            .repository()
            .get_fixed_content_by_id(fixed.id)
            .unwrap()
            .unwrap();

        assert_eq!(pasted.as_deref(), Some("Hello"));
        assert_eq!(result.as_ref().map(|content| content.use_count), Some(1));
        assert_eq!(stored.use_count, 1);
        assert!(stored.last_used_at.is_some());
    }

    #[test]
    fn fixed_content_trigger_skips_disabled_content() {
        let state = super::AppState::new(repo());
        let fixed = state
            .repository()
            .create_fixed_content(&fixed_content_input("Greeting", "Hello", "Ctrl+1", false))
            .unwrap();
        let mut pasted = false;

        let result = super::trigger_fixed_content_impl(&state, fixed.id, |_| {
            pasted = true;
            Ok(())
        })
        .unwrap();
        let stored = state
            .repository()
            .get_fixed_content_by_id(fixed.id)
            .unwrap()
            .unwrap();

        assert!(result.is_none());
        assert!(!pasted);
        assert_eq!(stored.use_count, 0);
        assert_eq!(stored.last_used_at, None);
    }

    #[test]
    fn fixed_content_trigger_failure_does_not_update_usage() {
        let state = super::AppState::new(repo());
        let fixed = state
            .repository()
            .create_fixed_content(&fixed_content_input("Greeting", "Hello", "Ctrl+1", true))
            .unwrap();

        let result = super::trigger_fixed_content_impl(&state, fixed.id, |_| {
            Err(AppError::from("paste failed"))
        });
        let stored = state
            .repository()
            .get_fixed_content_by_id(fixed.id)
            .unwrap()
            .unwrap();

        assert!(result.unwrap_err().to_string().contains("paste failed"));
        assert_eq!(stored.use_count, 0);
        assert_eq!(stored.last_used_at, None);
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
    fn commands_hotkey_candidate_trims_and_validates_before_persistence() {
        let current = crate::models::HotkeySettings::default();

        let candidate = super::build_hotkey_settings_candidate(
            &current,
            &HotkeySettingsPatch {
                open_panel: Some(" Ctrl+Alt+K ".to_string()),
                ..HotkeySettingsPatch::default()
            },
        )
        .unwrap();

        assert_eq!(candidate.open_panel, "Ctrl+Alt+K");

        let duplicate = super::build_hotkey_settings_candidate(
            &current,
            &HotkeySettingsPatch {
                search: Some(current.open_panel.clone()),
                ..HotkeySettingsPatch::default()
            },
        )
        .unwrap_err();
        assert!(duplicate.to_string().contains("assigned to both"));

        let invalid = super::build_hotkey_settings_candidate(
            &current,
            &HotkeySettingsPatch {
                open_panel: Some("not-a-hotkey".to_string()),
                ..HotkeySettingsPatch::default()
            },
        )
        .unwrap_err();
        assert!(invalid.to_string().contains("invalid hotkey"));
    }

    #[test]
    fn commands_hotkey_update_rejects_invalid_values_without_database_write() {
        let state = super::AppState::new(repo());

        let result = super::update_hotkeys_impl(
            &state,
            HotkeySettingsPatch {
                open_panel: Some("Ctrl+Alt+K".to_string()),
                pause: Some("not-a-hotkey".to_string()),
                ..HotkeySettingsPatch::default()
            },
        );

        assert!(result.unwrap_err().to_string().contains("invalid hotkey"));
        assert_eq!(
            state.repository().get_hotkey_settings().unwrap().open_panel,
            "CommandOrControl+Shift+V"
        );
    }

    #[test]
    fn commands_identify_wheel_shortcut_setting_keys() {
        assert!(super::is_wheel_shortcut_setting_key("wheelShortcutEnabled"));
        assert!(super::is_wheel_shortcut_setting_key(
            "wheelShortcutModifier"
        ));
        assert!(super::is_wheel_shortcut_setting_key("wheelShortcutScope"));
        assert!(!super::is_wheel_shortcut_setting_key("launchOnStartup"));
    }

    #[test]
    fn commands_build_wheel_shortcut_candidate_validates_values_before_persistence() {
        let current = crate::models::AppSettings::default();

        let disabled = super::build_wheel_shortcut_settings_candidate(
            &current,
            "wheelShortcutEnabled",
            serde_json::json!(false),
        )
        .unwrap();
        assert!(!disabled.wheel_shortcut_enabled);

        let scoped = super::build_wheel_shortcut_settings_candidate(
            &current,
            "wheelShortcutScope",
            serde_json::json!("panel-only"),
        )
        .unwrap();
        assert_eq!(
            scoped.wheel_shortcut_scope,
            crate::models::WheelShortcutScope::PanelOnly
        );

        let invalid = super::build_wheel_shortcut_settings_candidate(
            &current,
            "wheelShortcutModifier",
            serde_json::json!("ctrl+shift"),
        )
        .unwrap_err();
        assert!(invalid.to_string().contains("wheelShortcutModifier"));
    }

    #[test]
    fn commands_monitoring_toggle_returns_status() {
        let state = super::AppState::new(repo());

        let initial = super::test_monitoring_impl(&state);
        let disabled = super::toggle_monitoring_impl(&state);
        let enabled = super::toggle_monitoring_impl(&state);

        assert!(initial.monitor_enabled);
        assert!(!initial.monitor_started);
        assert!(!initial.has_timer);
        assert!(!initial.is_running);
        assert!(!disabled.monitor_enabled);
        assert!(!disabled.is_running);
        assert!(enabled.monitor_enabled);
        assert!(!enabled.is_running);
    }

    #[test]
    fn commands_monitoring_runtime_state_tracks_service_and_tick_status() {
        let state = super::AppState::new(repo());

        let started = state.set_monitoring_service_started(true);
        let running = state.set_monitoring_running(true);
        let hashed = state.set_monitoring_last_hash("0123456789abcdef");
        let stopped = state.set_monitoring_service_started(false);

        assert!(started.monitor_started);
        assert!(started.has_timer);
        assert!(running.is_running);
        assert_eq!(hashed.last_hash_prefix, "0123456789ab");
        assert!(!stopped.monitor_started);
        assert!(!stopped.has_timer);
        assert!(!stopped.is_running);
    }
}

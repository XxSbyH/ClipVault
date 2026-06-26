use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::{
    commands::{self, AppState},
    errors::{AppError, AppResult},
    events,
    models::{
        AppSettings, ClipboardItem, FixedContent, HotkeySettings, HudDirection, HudPayload,
        QuickPasteBoundary, QuickPasteCursorPayload, WheelShortcutModifier, WheelShortcutScope,
    },
    paste, windows,
};

const WHEEL_DEBOUNCE_MS: u128 = 180;
const QUICK_PASTE_CURSOR_IDLE_RESET: Duration = Duration::from_secs(5 * 60);
const CUT_CAPTURE_DELAY_MS: u64 = 160;
const WIN_MSG_KEYDOWN: u32 = 0x0100;
const WIN_MSG_SYSKEYDOWN: u32 = 0x0104;
const VK_X_CODE: u32 = b'X' as u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuickPasteDirection {
    Older,
    Newer,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QuickPasteCursor {
    offset: Option<usize>,
    head_id: Option<i64>,
    order: Vec<i64>,
    last_used_at: Option<Instant>,
}

impl QuickPasteCursor {
    pub fn resolve(
        &mut self,
        direction: QuickPasteDirection,
        history_ids: &[i64],
    ) -> QuickPasteCursorResolution {
        self.resolve_at(direction, history_ids, Instant::now())
    }

    pub fn select(
        &mut self,
        item_id: i64,
        history_ids: &[i64],
    ) -> Option<QuickPasteCursorSnapshot> {
        self.select_at(item_id, history_ids, Instant::now())
    }

    fn resolve_at(
        &mut self,
        direction: QuickPasteDirection,
        history_ids: &[i64],
        now: Instant,
    ) -> QuickPasteCursorResolution {
        if history_ids.is_empty() {
            *self = Self::default();
            return QuickPasteCursorResolution::Empty;
        }

        let selected_item_id = self.selected_item_id();
        self.retain_existing_ids(history_ids);
        if self.should_start_new_session(now) {
            self.start_session(history_ids);
        } else {
            self.merge_new_ids(history_ids, selected_item_id);
        }

        let current = self.offset.unwrap_or(0).min(self.order.len() - 1);
        let next = match direction {
            QuickPasteDirection::Older if current + 1 >= self.order.len() => {
                self.last_used_at = Some(now);
                return QuickPasteCursorResolution::Boundary(QuickPasteBoundary::Oldest);
            }
            QuickPasteDirection::Older => current + 1,
            QuickPasteDirection::Newer if current == 0 => {
                self.last_used_at = Some(now);
                return QuickPasteCursorResolution::Boundary(QuickPasteBoundary::Newest);
            }
            QuickPasteDirection::Newer => current - 1,
        };

        self.offset = Some(next);
        self.last_used_at = Some(now);
        self.order
            .get(next)
            .copied()
            .map(QuickPasteCursorResolution::Item)
            .unwrap_or(QuickPasteCursorResolution::Empty)
    }

    fn select_at(
        &mut self,
        item_id: i64,
        history_ids: &[i64],
        now: Instant,
    ) -> Option<QuickPasteCursorSnapshot> {
        let offset = history_ids.iter().position(|current| *current == item_id)?;
        self.order = history_ids.to_vec();
        self.offset = Some(offset);
        self.head_id = history_ids.first().copied();
        self.last_used_at = Some(now);
        Some(self.snapshot())
    }

    fn should_start_new_session(&self, now: Instant) -> bool {
        self.order.is_empty()
            || self.offset.is_none()
            || self
                .last_used_at
                .and_then(|last| now.checked_duration_since(last))
                .is_some_and(|elapsed| elapsed >= QUICK_PASTE_CURSOR_IDLE_RESET)
    }

    fn start_session(&mut self, history_ids: &[i64]) {
        self.order = history_ids.to_vec();
        self.offset = Some(0);
        self.head_id = history_ids.first().copied();
    }

    fn retain_existing_ids(&mut self, history_ids: &[i64]) {
        if self.order.is_empty() {
            return;
        }

        self.order.retain(|id| history_ids.contains(id));
        if self.order.is_empty() {
            self.offset = None;
            self.head_id = None;
            return;
        }

        if self.offset.is_some_and(|offset| offset >= self.order.len()) {
            self.offset = Some(self.order.len() - 1);
        }
    }

    fn merge_new_ids(&mut self, history_ids: &[i64], selected_item_id: Option<i64>) {
        for (index, id) in history_ids.iter().enumerate() {
            if self.order.contains(id) {
                continue;
            }
            let insert_at = history_ids[index + 1..]
                .iter()
                .find_map(|next_id| self.order.iter().position(|current| current == next_id))
                .unwrap_or(self.order.len());
            self.order.insert(insert_at, *id);
        }

        if let Some(selected_index) =
            selected_item_id.and_then(|id| self.order.iter().position(|current| *current == id))
        {
            self.offset = Some(selected_index);
        } else if self.offset.is_some_and(|offset| offset >= self.order.len()) {
            self.offset = Some(self.order.len() - 1);
        }
        self.head_id = history_ids.first().copied();
    }

    fn selected_item_id(&self) -> Option<i64> {
        self.offset
            .and_then(|offset| self.order.get(offset))
            .copied()
    }

    pub fn snapshot(&self) -> QuickPasteCursorSnapshot {
        QuickPasteCursorSnapshot {
            offset: self.offset.map(|offset| offset as i64),
            head_id: self.head_id,
            selected_item_id: self.selected_item_id(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuickPasteCursorResolution {
    Item(i64),
    Boundary(QuickPasteBoundary),
    Empty,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QuickPasteCursorSnapshot {
    pub offset: Option<i64>,
    pub head_id: Option<i64>,
    pub selected_item_id: Option<i64>,
}

enum QuickHistoryCopyResult {
    Copied(Box<commands::PasteResult>),
    Boundary(QuickPasteBoundary),
    Empty,
}

enum QuickHistoryResolveResult {
    Item(Box<ClipboardItem>),
    Boundary(QuickPasteBoundary),
    Empty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchHotkeyInstruction {
    ShowQuickSearchWindow,
    HideQuickSearchWindow,
    EmitQuickSearchOpened,
}

fn search_hotkey_instructions(search_window_visible: bool) -> Vec<SearchHotkeyInstruction> {
    if search_window_visible {
        return vec![SearchHotkeyInstruction::HideQuickSearchWindow];
    }

    vec![
        SearchHotkeyInstruction::ShowQuickSearchWindow,
        SearchHotkeyInstruction::EmitQuickSearchOpened,
    ]
}

pub fn head_id(items: &[ClipboardItem]) -> Option<i64> {
    items.first().map(|item| item.id)
}

pub fn register_global_shortcuts(app: &AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    replace_all_keyboard_shortcuts(app, state.inner())?;
    if let Err(error) = start_wheel_hook(app) {
        tracing::warn!(
            target: "hotkeys",
            area = "hotkey",
            direction = "check global hotkey conflicts, Windows hook permissions, or input subsystem",
            "wheel shortcut hook failed to start; keyboard quick paste remains available: {error}"
        );
    }
    if let Err(error) = start_cut_capture_hook(app) {
        tracing::warn!(
            target: "hotkeys",
            area = "clipboard",
            direction = "check clipboard access after cut operation or foreground app focus",
            "cut capture hook failed to start; clipboard polling remains available: {error}"
        );
    }
    Ok(())
}

pub fn replace_all_keyboard_shortcuts(app: &AppHandle, state: &AppState) -> AppResult<()> {
    let settings = state.repository().get_hotkey_settings()?;
    let fixed_contents = state.repository().list_fixed_contents()?;
    replace_keyboard_shortcuts_with_fixed_contents(app, &settings, &fixed_contents)
}

pub fn replace_keyboard_shortcuts(app: &AppHandle, settings: &HotkeySettings) -> AppResult<()> {
    replace_keyboard_shortcuts_with_fixed_contents(app, settings, &[])
}

pub fn replace_keyboard_shortcuts_with_fixed_contents(
    app: &AppHandle,
    settings: &HotkeySettings,
    fixed_contents: &[FixedContent],
) -> AppResult<()> {
    validate_keyboard_shortcuts(settings, fixed_contents)?;
    app.global_shortcut()
        .unregister_all()
        .map_err(|err| AppError::from(format!("failed to unregister hotkeys: {err}")))?;
    if let Err(error) =
        register_keyboard_shortcuts_with_fixed_contents(app, settings, fixed_contents)
    {
        let _ = app.global_shortcut().unregister_all();
        return Err(error);
    }
    Ok(())
}

pub fn validate_hotkey_settings(settings: &HotkeySettings) -> AppResult<()> {
    validate_keyboard_shortcuts(settings, &[])
}

fn validate_keyboard_shortcuts(
    settings: &HotkeySettings,
    fixed_contents: &[FixedContent],
) -> AppResult<()> {
    let mut by_hotkey: BTreeMap<u32, String> = BTreeMap::new();
    for (command, accelerator, _) in keyboard_shortcut_entries(settings) {
        add_shortcut_assignment(&mut by_hotkey, command, accelerator)?;
    }
    for content in fixed_contents.iter().filter(|content| content.enabled) {
        add_shortcut_assignment(
            &mut by_hotkey,
            &format!("fixed content {}", content.id),
            &content.hotkey,
        )?;
    }
    Ok(())
}

fn add_shortcut_assignment(
    by_hotkey: &mut BTreeMap<u32, String>,
    command: &str,
    accelerator: &str,
) -> AppResult<()> {
    let accelerator = accelerator.trim();
    if accelerator.is_empty() {
        return Err(AppError::from(format!("hotkey {command} cannot be empty")));
    }
    let shortcut = accelerator
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|error| {
            AppError::from(format!("invalid hotkey {command}={accelerator}: {error}"))
        })?;

    if let Some(existing) = by_hotkey.insert(shortcut.id(), command.to_string()) {
        return Err(AppError::from(format!(
            "hotkey {accelerator} is assigned to both {existing} and {command}"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WheelHookOptions {
    pub enabled: bool,
    pub modifier: WheelShortcutModifier,
    pub scope: WheelShortcutScope,
}

impl WheelHookOptions {
    pub fn from_settings(settings: &AppSettings) -> Self {
        Self {
            enabled: settings.wheel_shortcut_enabled,
            modifier: settings.wheel_shortcut_modifier,
            scope: settings.wheel_shortcut_scope,
        }
    }
}

pub fn start_wheel_hook(app: &AppHandle) -> AppResult<()> {
    let settings = app.state::<AppState>().repository().get_settings()?;
    start_wheel_hook_with_options(app, WheelHookOptions::from_settings(&settings))
}

pub fn start_wheel_hook_with_options(app: &AppHandle, options: WheelHookOptions) -> AppResult<()> {
    wheel::start(app, options)
}

pub fn stop_wheel_hook() -> AppResult<()> {
    wheel::stop()
}

pub fn start_cut_capture_hook(app: &AppHandle) -> AppResult<()> {
    keyboard_capture::start(app)
}

pub fn check_system_hotkey_available(app: &AppHandle, hotkey: &str) -> HotkeyAvailabilityProbe {
    let trimmed = hotkey.trim();
    if trimmed.is_empty() {
        return HotkeyAvailabilityProbe::unavailable(trimmed, "hotkey is empty");
    }

    let shortcut = match trimmed.parse::<tauri_plugin_global_shortcut::Shortcut>() {
        Ok(shortcut) => shortcut,
        Err(error) => return HotkeyAvailabilityProbe::unavailable(trimmed, &error.to_string()),
    };

    if app.global_shortcut().is_registered(shortcut) {
        return HotkeyAvailabilityProbe::available(trimmed);
    }

    match app.global_shortcut().register(shortcut) {
        Ok(()) => {
            let _ = app.global_shortcut().unregister(shortcut);
            HotkeyAvailabilityProbe::available(trimmed)
        }
        Err(error) => HotkeyAvailabilityProbe::unavailable(trimmed, &error.to_string()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HotkeyAvailabilityProbe {
    pub hotkey: String,
    pub available: bool,
    pub reason: Option<String>,
}

impl HotkeyAvailabilityProbe {
    fn available(hotkey: &str) -> Self {
        Self {
            hotkey: hotkey.to_string(),
            available: true,
            reason: None,
        }
    }

    fn unavailable(hotkey: &str, reason: &str) -> Self {
        Self {
            hotkey: hotkey.to_string(),
            available: false,
            reason: Some(reason.to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum HotkeyAction {
    OpenPanel,
    Search,
    Pause,
    Clear,
    QuickPaste(QuickPasteDirection),
    FixedContent(i64),
}

fn keyboard_shortcut_entries(settings: &HotkeySettings) -> Vec<(&'static str, &str, HotkeyAction)> {
    vec![
        ("openPanel", &settings.open_panel, HotkeyAction::OpenPanel),
        ("search", &settings.search, HotkeyAction::Search),
        ("pause", &settings.pause, HotkeyAction::Pause),
        ("clear", &settings.clear, HotkeyAction::Clear),
        (
            "quickPastePrev",
            &settings.quick_paste_prev,
            HotkeyAction::QuickPaste(QuickPasteDirection::Older),
        ),
        (
            "quickPasteNext",
            &settings.quick_paste_next,
            HotkeyAction::QuickPaste(QuickPasteDirection::Newer),
        ),
    ]
}

fn register_keyboard_shortcuts_with_fixed_contents(
    app: &AppHandle,
    settings: &HotkeySettings,
    fixed_contents: &[FixedContent],
) -> AppResult<()> {
    for (_, accelerator, action) in keyboard_shortcut_entries(settings) {
        register_shortcut(app, accelerator, action)?;
    }
    for content in fixed_contents.iter().filter(|content| content.enabled) {
        register_shortcut(app, &content.hotkey, HotkeyAction::FixedContent(content.id))?;
    }
    Ok(())
}

fn register_shortcut(app: &AppHandle, accelerator: &str, action: HotkeyAction) -> AppResult<()> {
    let accelerator = accelerator.trim();
    if accelerator.is_empty() {
        return Ok(());
    }

    app.global_shortcut()
        .on_shortcut(accelerator, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                handle_hotkey_action(app, action);
            }
        })
        .map_err(|error| {
            AppError::from(format!("failed to register hotkey {accelerator}: {error}"))
        })
}

fn handle_hotkey_action(app: &AppHandle, action: HotkeyAction) {
    match action {
        HotkeyAction::OpenPanel => {
            if windows::is_main_window_visible(app) {
                let _ = windows::hide_main_window(app);
                commands::emit_hud_notification(
                    app,
                    HudPayload::panel("控制面板", "已隐藏，Ctrl+Shift+V 可再次唤起"),
                );
            } else {
                if windows::show_main_window(app).is_ok() {
                    commands::emit_hud_notification(
                        app,
                        HudPayload::panel("控制面板", "已唤起，Enter 复制当前选择"),
                    );
                    let _ = windows::focus_main_window(app);
                }
            }
        }
        HotkeyAction::Search => {
            handle_search_hotkey(app);
        }
        HotkeyAction::Pause => {
            if let Some(state) = app.try_state::<AppState>() {
                let status = commands::toggle_monitoring_impl(state.inner());
                let _ = app.emit(events::MONITORING_CHANGED, &status);
            }
        }
        HotkeyAction::Clear => {
            if let Some(state) = app.try_state::<AppState>() {
                if let Ok(result) = commands::clear_history_impl(state.inner(), false) {
                    if result.deleted > 0 {
                        let _ = app.emit(
                            events::HISTORY_REVISION,
                            commands::HistoryRevisionPayload {
                                revision: result.revision,
                            },
                        );
                    }
                }
            }
        }
        HotkeyAction::QuickPaste(direction) => {
            let _ = quick_copy(app, direction);
        }
        HotkeyAction::FixedContent(id) => {
            if let Err(error) = paste_fixed_content(app, id) {
                tracing::warn!(
                    target: "hotkeys",
                    area = "hotkey",
                    direction = "check global hotkey conflicts, Windows hook permissions, or input subsystem",
                    "fixed content paste failed: {error}"
                );
            }
        }
    }
}

fn handle_search_hotkey(app: &AppHandle) {
    for instruction in search_hotkey_instructions(windows::is_search_window_visible(app)) {
        match instruction {
            SearchHotkeyInstruction::ShowQuickSearchWindow => {
                let _ = windows::show_search_window(app);
            }
            SearchHotkeyInstruction::HideQuickSearchWindow => {
                let _ = windows::hide_search_window(app);
            }
            SearchHotkeyInstruction::EmitQuickSearchOpened => {
                let _ = app.emit(events::QUICK_SEARCH_OPENED, ());
            }
        }
    }
}

fn paste_fixed_content(app: &AppHandle, id: i64) -> AppResult<()> {
    let state = app.state::<AppState>();
    let Some(content) = commands::trigger_fixed_content_impl(state.inner(), id, |content| {
        paste::write_text_and_paste(app, &content.content)
    })?
    else {
        return Ok(());
    };

    commands::emit_hud_notification(app, HudPayload::panel("固定内容", &content.title));
    Ok(())
}

fn resolve_quick_history_item(
    state: &AppState,
    direction: QuickPasteDirection,
) -> AppResult<QuickHistoryResolveResult> {
    let total = state.repository().count_items()?;
    let history = state.repository().get_history(total)?;
    let history_ids = history.iter().map(|item| item.id).collect::<Vec<_>>();
    let item_id =
        match state.quick_paste_cursor_mut(|cursor| cursor.resolve(direction, &history_ids)) {
            QuickPasteCursorResolution::Item(item_id) => item_id,
            QuickPasteCursorResolution::Boundary(boundary) => {
                return Ok(QuickHistoryResolveResult::Boundary(boundary));
            }
            QuickPasteCursorResolution::Empty => return Ok(QuickHistoryResolveResult::Empty),
        };

    Ok(history
        .into_iter()
        .find(|item| item.id == item_id)
        .map(|item| QuickHistoryResolveResult::Item(Box::new(item)))
        .unwrap_or(QuickHistoryResolveResult::Empty))
}

fn copy_quick_history_item<F>(
    state: &AppState,
    direction: QuickPasteDirection,
    copy: F,
) -> AppResult<QuickHistoryCopyResult>
where
    F: FnOnce(&ClipboardItem) -> AppResult<()>,
{
    let item = match resolve_quick_history_item(state, direction)? {
        QuickHistoryResolveResult::Item(item) => item,
        QuickHistoryResolveResult::Boundary(boundary) => {
            return Ok(QuickHistoryCopyResult::Boundary(boundary));
        }
        QuickHistoryResolveResult::Empty => return Ok(QuickHistoryCopyResult::Empty),
    };

    commands::copy_item_impl(state, item.id, copy)
        .map(|result| QuickHistoryCopyResult::Copied(Box::new(result)))
}

fn wheel_quick_history_item<F>(
    state: &AppState,
    direction: QuickPasteDirection,
    copy: F,
) -> AppResult<QuickHistoryCopyResult>
where
    F: FnOnce(&ClipboardItem) -> AppResult<()>,
{
    copy_quick_history_item(state, direction, copy)
}

fn quick_copy_success_payload(
    direction: QuickPasteDirection,
    result: &commands::PasteResult,
) -> Option<HudPayload> {
    if !result.success {
        return None;
    }

    let hud_direction = match direction {
        QuickPasteDirection::Older => HudDirection::Prev,
        QuickPasteDirection::Newer => HudDirection::Next,
    };
    result
        .item
        .as_ref()
        .map(|item| HudPayload::quick_paste(hud_direction, item.content_type, item.preview.clone()))
}

fn quick_copy(app: &AppHandle, direction: QuickPasteDirection) -> AppResult<()> {
    let state = app.state::<AppState>();
    let outcome = wheel_quick_history_item(state.inner(), direction, |item| {
        paste::write_item_to_clipboard(app, item)
    })?;

    match outcome {
        QuickHistoryCopyResult::Copied(result) => {
            if let Some(payload) = quick_copy_success_payload(direction, &result) {
                commands::emit_hud_notification(app, payload);
                emit_quick_paste_cursor(app, result.item.as_ref().map(|item| item.id), None);
            } else if !result.success {
                tracing::warn!(
                    target: "hotkeys",
                    area = "hotkey",
                    direction = "check global hotkey conflicts, Windows hook permissions, or input subsystem",
                    "quick copy failed: {}",
                    result.message
                );
            }

            if result.success {
                let _ = app.emit(
                    events::HISTORY_REVISION,
                    commands::HistoryRevisionPayload {
                        revision: result.revision,
                    },
                );
            }
        }
        QuickHistoryCopyResult::Boundary(boundary) => {
            commands::emit_hud_notification(app, quick_copy_boundary_payload(boundary));
            emit_quick_paste_cursor(
                app,
                state.quick_paste_cursor().selected_item_id,
                Some(boundary),
            );
        }
        QuickHistoryCopyResult::Empty => {}
    }
    Ok(())
}

fn quick_copy_boundary_payload(boundary: QuickPasteBoundary) -> HudPayload {
    let text = match boundary {
        QuickPasteBoundary::Newest => "游标已到开始",
        QuickPasteBoundary::Oldest => "游标已到末尾",
    };
    HudPayload::panel("快速复制", text)
}

fn emit_quick_paste_cursor(
    app: &AppHandle,
    selected_item_id: Option<i64>,
    boundary: Option<QuickPasteBoundary>,
) {
    let _ = app.emit(
        events::QUICK_PASTE_CURSOR_CHANGED,
        QuickPasteCursorPayload {
            selected_item_id,
            boundary,
        },
    );
}

fn wheel_direction_from_mouse_data(mouse_data: u32) -> Option<QuickPasteDirection> {
    let delta = ((mouse_data >> 16) as u16) as i16;
    match delta.cmp(&0) {
        std::cmp::Ordering::Greater => Some(QuickPasteDirection::Older),
        std::cmp::Ordering::Less => Some(QuickPasteDirection::Newer),
        std::cmp::Ordering::Equal => None,
    }
}

fn modifier_matches_state(
    modifier: WheelShortcutModifier,
    ctrl: bool,
    alt: bool,
    shift: bool,
) -> bool {
    match modifier {
        WheelShortcutModifier::Ctrl => ctrl,
        WheelShortcutModifier::Alt => alt,
        WheelShortcutModifier::Shift => shift,
        WheelShortcutModifier::CtrlAlt => ctrl && alt,
    }
}

fn should_capture_cut_shortcut(message: u32, vk_code: u32, ctrl_down: bool) -> bool {
    ctrl_down && vk_code == VK_X_CODE && matches!(message, WIN_MSG_KEYDOWN | WIN_MSG_SYSKEYDOWN)
}

#[cfg(target_os = "windows")]
mod wheel {
    use std::{
        sync::{mpsc, Mutex, OnceLock},
        thread,
        time::{Duration, Instant},
    };

    use ::windows::Win32::{
        Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM},
        System::Threading::GetCurrentThreadId,
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_MENU, VK_SHIFT},
            WindowsAndMessaging::{
                CallNextHookEx, DispatchMessageW, GetMessageW, PeekMessageW, PostThreadMessageW,
                SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, HC_ACTION, HHOOK, MSG,
                MSLLHOOKSTRUCT, PM_NOREMOVE, WH_MOUSE_LL, WM_MOUSEWHEEL, WM_QUIT,
            },
        },
    };
    use tauri::AppHandle;

    use super::{
        modifier_matches_state, quick_copy, wheel_direction_from_mouse_data, QuickPasteDirection,
        WheelHookOptions, WHEEL_DEBOUNCE_MS,
    };
    use crate::{errors::AppResult, models::WheelShortcutScope, windows as app_windows};

    static RUNTIME: OnceLock<Mutex<Option<WheelHookRuntime>>> = OnceLock::new();

    struct WheelHookRuntime {
        hook: isize,
        thread_id: u32,
        app: AppHandle,
        options: WheelHookOptions,
        last_triggered_at: Instant,
    }

    pub fn start(app: &AppHandle, options: WheelHookOptions) -> AppResult<()> {
        stop()?;
        if !options.enabled {
            return Ok(());
        }

        let app = app.clone();
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        thread::Builder::new()
            .name("clipvault-wheel-hook".to_string())
            .spawn(move || {
                let thread_id = unsafe { GetCurrentThreadId() };
                let mut bootstrap_message = MSG::default();
                let _ = unsafe {
                    PeekMessageW(&mut bootstrap_message, HWND::default(), 0, 0, PM_NOREMOVE)
                };

                let hook = unsafe {
                    SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), HINSTANCE::default(), 0)
                };

                let hook = match hook {
                    Ok(hook) => hook,
                    Err(error) => {
                        let _ = tx.send(Err(format!("failed to install wheel hook: {error}")));
                        return;
                    }
                };

                {
                    let mut runtime = runtime().lock().expect("wheel hook lock poisoned");
                    *runtime = Some(WheelHookRuntime {
                        hook: hook.0 as isize,
                        thread_id,
                        app,
                        options,
                        last_triggered_at: Instant::now()
                            .checked_sub(Duration::from_millis(WHEEL_DEBOUNCE_MS as u64))
                            .unwrap_or_else(Instant::now),
                    });
                }
                let _ = tx.send(Ok(()));
                message_loop();
                clear_runtime_for_thread(thread_id, hook.0 as isize);
            })
            .map_err(|error| format!("failed to spawn wheel hook thread: {error}"))?;

        rx.recv_timeout(Duration::from_secs(2))
            .map_err(|error| format!("wheel hook startup timed out: {error}"))?
            .map_err(Into::into)
    }

    pub fn stop() -> AppResult<()> {
        let runtime = runtime().lock().expect("wheel hook lock poisoned").take();
        let Some(runtime) = runtime else {
            return Ok(());
        };

        let hook = HHOOK(runtime.hook as *mut _);
        let _ = unsafe { UnhookWindowsHookEx(hook) };
        let _ = unsafe { PostThreadMessageW(runtime.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
        Ok(())
    }

    fn runtime() -> &'static Mutex<Option<WheelHookRuntime>> {
        RUNTIME.get_or_init(|| Mutex::new(None))
    }

    fn clear_runtime_for_thread(thread_id: u32, hook: isize) {
        let mut runtime = runtime().lock().expect("wheel hook lock poisoned");
        if runtime
            .as_ref()
            .is_some_and(|current| current.thread_id == thread_id && current.hook == hook)
        {
            *runtime = None;
        }
    }

    fn message_loop() {
        let mut message = MSG::default();
        loop {
            let result = unsafe { GetMessageW(&mut message, HWND::default(), 0, 0) };
            if result.0 <= 0 {
                break;
            }
            unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }

    unsafe extern "system" fn mouse_hook_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code == HC_ACTION as i32
            && wparam.0 as u32 == WM_MOUSEWHEEL
            && handle_mouse_wheel(lparam)
        {
            return LRESULT(1);
        }
        CallNextHookEx(HHOOK::default(), code, wparam, lparam)
    }

    fn handle_mouse_wheel(lparam: LPARAM) -> bool {
        let Some(direction) = read_wheel_direction(lparam) else {
            return false;
        };

        let (app, scope, modifier) = {
            let runtime = runtime().lock().expect("wheel hook lock poisoned");
            let Some(runtime) = runtime.as_ref() else {
                return false;
            };
            (
                runtime.app.clone(),
                runtime.options.scope,
                runtime.options.modifier,
            )
        };

        if !modifier_matches_state(
            modifier,
            key_is_down(VK_CONTROL.0),
            key_is_down(VK_MENU.0),
            key_is_down(VK_SHIFT.0),
        ) {
            return false;
        }

        if scope == WheelShortcutScope::PanelOnly && !app_windows::is_main_window_visible(&app) {
            return false;
        }

        let should_trigger = {
            let mut runtime = runtime().lock().expect("wheel hook lock poisoned");
            let Some(runtime) = runtime.as_mut() else {
                return false;
            };
            if runtime.last_triggered_at.elapsed().as_millis() < WHEEL_DEBOUNCE_MS {
                false
            } else {
                runtime.last_triggered_at = Instant::now();
                true
            }
        };

        if should_trigger {
            thread::spawn(move || {
                if let Err(error) = quick_copy(&app, direction) {
                    tracing::warn!(
                        target: "hotkeys",
                        area = "hotkey",
                        direction = "check global hotkey conflicts, Windows hook permissions, or input subsystem",
                        "wheel quick copy failed: {error}"
                    );
                }
            });
        }

        true
    }

    fn read_wheel_direction(lparam: LPARAM) -> Option<QuickPasteDirection> {
        if lparam.0 == 0 {
            return None;
        }
        let hook = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        wheel_direction_from_mouse_data(hook.mouseData)
    }

    fn key_is_down(vkey: u16) -> bool {
        unsafe { GetAsyncKeyState(i32::from(vkey)) & 0x8000u16 as i16 != 0 }
    }
}

#[cfg(not(target_os = "windows"))]
mod wheel {
    use tauri::AppHandle;

    use super::WheelHookOptions;
    use crate::{errors::AppResult, models::WheelShortcutScope};

    pub fn start(_app: &AppHandle, options: WheelHookOptions) -> AppResult<()> {
        if options.enabled {
            tracing::warn!(
                target: "hotkeys",
                area = "hotkey",
                direction = "wheel shortcuts require Windows low-level mouse hook support",
                "wheel shortcuts are only supported on Windows; keyboard quick paste remains available"
            );
        }
        let _ = WheelShortcutScope::Global;
        Ok(())
    }

    pub fn stop() -> AppResult<()> {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod keyboard_capture {
    use std::{
        sync::{mpsc, Mutex, OnceLock},
        thread,
        time::{Duration, Instant},
    };

    use ::windows::Win32::{
        Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM},
        System::Threading::GetCurrentThreadId,
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL},
            WindowsAndMessaging::{
                CallNextHookEx, DispatchMessageW, GetMessageW, PeekMessageW, PostThreadMessageW,
                SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, HC_ACTION, HHOOK,
                KBDLLHOOKSTRUCT, MSG, PM_NOREMOVE, WH_KEYBOARD_LL, WM_QUIT,
            },
        },
    };
    use tauri::{AppHandle, Manager};

    use super::{should_capture_cut_shortcut, CUT_CAPTURE_DELAY_MS, WHEEL_DEBOUNCE_MS};
    use crate::{commands::AppState, errors::AppResult};

    static RUNTIME: OnceLock<Mutex<Option<CutCaptureRuntime>>> = OnceLock::new();

    struct CutCaptureRuntime {
        hook: isize,
        thread_id: u32,
        app: AppHandle,
        last_triggered_at: Instant,
    }

    pub fn start(app: &AppHandle) -> AppResult<()> {
        stop()?;

        let app = app.clone();
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        thread::Builder::new()
            .name("clipvault-cut-capture-hook".to_string())
            .spawn(move || {
                let thread_id = unsafe { GetCurrentThreadId() };
                let mut bootstrap_message = MSG::default();
                let _ = unsafe {
                    PeekMessageW(&mut bootstrap_message, HWND::default(), 0, 0, PM_NOREMOVE)
                };

                let hook = unsafe {
                    SetWindowsHookExW(
                        WH_KEYBOARD_LL,
                        Some(keyboard_hook_proc),
                        HINSTANCE::default(),
                        0,
                    )
                };

                let hook = match hook {
                    Ok(hook) => hook,
                    Err(error) => {
                        let _ =
                            tx.send(Err(format!("failed to install cut capture hook: {error}")));
                        return;
                    }
                };

                {
                    let mut runtime = runtime().lock().expect("cut capture hook lock poisoned");
                    *runtime = Some(CutCaptureRuntime {
                        hook: hook.0 as isize,
                        thread_id,
                        app,
                        last_triggered_at: Instant::now()
                            .checked_sub(Duration::from_millis(WHEEL_DEBOUNCE_MS as u64))
                            .unwrap_or_else(Instant::now),
                    });
                }
                let _ = tx.send(Ok(()));
                message_loop();
                clear_runtime_for_thread(thread_id, hook.0 as isize);
            })
            .map_err(|error| format!("failed to spawn cut capture hook thread: {error}"))?;

        rx.recv_timeout(Duration::from_secs(2))
            .map_err(|error| format!("cut capture hook startup timed out: {error}"))?
            .map_err(Into::into)
    }

    pub fn stop() -> AppResult<()> {
        let runtime = runtime()
            .lock()
            .expect("cut capture hook lock poisoned")
            .take();
        let Some(runtime) = runtime else {
            return Ok(());
        };

        let hook = HHOOK(runtime.hook as *mut _);
        let _ = unsafe { UnhookWindowsHookEx(hook) };
        let _ = unsafe { PostThreadMessageW(runtime.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
        Ok(())
    }

    fn runtime() -> &'static Mutex<Option<CutCaptureRuntime>> {
        RUNTIME.get_or_init(|| Mutex::new(None))
    }

    fn clear_runtime_for_thread(thread_id: u32, hook: isize) {
        let mut runtime = runtime().lock().expect("cut capture hook lock poisoned");
        if runtime
            .as_ref()
            .is_some_and(|current| current.thread_id == thread_id && current.hook == hook)
        {
            *runtime = None;
        }
    }

    fn message_loop() {
        let mut message = MSG::default();
        loop {
            let result = unsafe { GetMessageW(&mut message, HWND::default(), 0, 0) };
            if result.0 <= 0 {
                break;
            }
            unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }

    unsafe extern "system" fn keyboard_hook_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code == HC_ACTION as i32 {
            handle_keyboard_event(wparam, lparam);
        }
        CallNextHookEx(HHOOK::default(), code, wparam, lparam)
    }

    fn handle_keyboard_event(wparam: WPARAM, lparam: LPARAM) {
        let Some(vk_code) = read_vk_code(lparam) else {
            return;
        };
        if !should_capture_cut_shortcut(wparam.0 as u32, vk_code, key_is_down(VK_CONTROL.0)) {
            return;
        }

        let app = {
            let mut runtime = runtime().lock().expect("cut capture hook lock poisoned");
            let Some(runtime) = runtime.as_mut() else {
                return;
            };
            if runtime.last_triggered_at.elapsed().as_millis() < WHEEL_DEBOUNCE_MS {
                return;
            }
            runtime.last_triggered_at = Instant::now();
            runtime.app.clone()
        };

        trigger_cut_capture(app);
    }

    fn read_vk_code(lparam: LPARAM) -> Option<u32> {
        if lparam.0 == 0 {
            return None;
        }
        let hook = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        Some(hook.vkCode)
    }

    fn key_is_down(vkey: u16) -> bool {
        unsafe { GetAsyncKeyState(i32::from(vkey)) & 0x8000u16 as i16 != 0 }
    }

    fn trigger_cut_capture(app: AppHandle) {
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(CUT_CAPTURE_DELAY_MS));
            let Some(state) = app.try_state::<AppState>() else {
                return;
            };
            let state = state.inner().clone();
            if let Err(error) = crate::clipboard::capture_clipboard_now(&app, &state) {
                tracing::warn!(
                    target: "clipboard",
                    area = "clipboard",
                    direction = "check clipboard access after cut operation or foreground app focus",
                    "cut clipboard capture failed: {error}"
                );
            }
        });
    }
}

#[cfg(not(target_os = "windows"))]
mod keyboard_capture {
    use tauri::AppHandle;

    use crate::errors::AppResult;

    pub fn start(_app: &AppHandle) -> AppResult<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use tempfile::tempdir;

    use crate::{
        database::repository::Repository,
        models::{ClipboardContentType, ClipboardInsertInput},
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

    fn copied_result(outcome: QuickHistoryCopyResult) -> commands::PasteResult {
        match outcome {
            QuickHistoryCopyResult::Copied(result) => *result,
            QuickHistoryCopyResult::Boundary(boundary) => {
                panic!("expected copied result, got boundary {boundary:?}")
            }
            QuickHistoryCopyResult::Empty => panic!("expected copied result, got empty history"),
        }
    }

    #[test]
    fn search_hotkey_targets_quick_search_overlay_when_hidden() {
        assert_eq!(
            search_hotkey_instructions(false),
            vec![
                SearchHotkeyInstruction::ShowQuickSearchWindow,
                SearchHotkeyInstruction::EmitQuickSearchOpened,
            ]
        );
    }

    #[test]
    fn search_hotkey_hides_quick_search_overlay_when_visible() {
        assert_eq!(
            search_hotkey_instructions(true),
            vec![SearchHotkeyInstruction::HideQuickSearchWindow]
        );
    }

    #[test]
    fn quick_history_action_uses_copy_result_and_updates_cursor() {
        let state = AppState::new(repo());
        let older = state
            .repository()
            .insert_clipboard_item(text_input("older", "hash-older"))
            .unwrap();
        let newest = state
            .repository()
            .insert_clipboard_item(text_input("newest", "hash-newest"))
            .unwrap();
        let mut copied_id = None;

        let result = copy_quick_history_item(&state, QuickPasteDirection::Older, |item| {
            copied_id = Some(item.id);
            Ok(())
        })
        .map(copied_result)
        .unwrap();

        assert_eq!(copied_id, Some(older.id));
        assert!(result.success);
        assert_eq!(result.message, "copied");
        assert_eq!(result.item.as_ref().map(|item| item.id), Some(older.id));
        assert_eq!(
            state.quick_paste_cursor(),
            QuickPasteCursorSnapshot {
                offset: Some(1),
                head_id: Some(newest.id),
                selected_item_id: Some(older.id),
            }
        );
    }

    #[test]
    fn quick_history_action_does_not_update_use_stats_when_copy_fails() {
        let state = AppState::new(repo());
        let older = state
            .repository()
            .insert_clipboard_item(text_input("older", "hash-older"))
            .unwrap();
        state
            .repository()
            .insert_clipboard_item(text_input("newest", "hash-newest"))
            .unwrap();

        let result = copy_quick_history_item(&state, QuickPasteDirection::Older, |_| {
            Err(AppError::from("copy failed"))
        })
        .map(copied_result)
        .unwrap();
        let stored = state
            .repository()
            .get_item_by_id(older.id)
            .unwrap()
            .unwrap();

        assert!(!result.success);
        assert_eq!(result.message, "copy failed");
        assert_eq!(stored.use_count, 0);
        assert_eq!(stored.last_used_at, None);
    }

    #[test]
    fn quick_history_action_hud_keeps_previous_next_direction_only_on_success() {
        let state = AppState::new(repo());
        state
            .repository()
            .insert_clipboard_item(text_input("older", "hash-copy-hud-older"))
            .unwrap();
        state
            .repository()
            .insert_clipboard_item(text_input("newest", "hash-copy-hud-newest"))
            .unwrap();

        let result = copy_quick_history_item(&state, QuickPasteDirection::Older, |_| Ok(()))
            .map(copied_result)
            .unwrap();
        let payload = quick_copy_success_payload(QuickPasteDirection::Older, &result).unwrap();

        assert_eq!(
            payload,
            HudPayload::quick_paste(
                crate::models::HudDirection::Prev,
                ClipboardContentType::Text,
                "older".to_string()
            )
        );

        let failed_state = AppState::new(repo());
        failed_state
            .repository()
            .insert_clipboard_item(text_input("older", "hash-copy-hud-fail-older"))
            .unwrap();
        failed_state
            .repository()
            .insert_clipboard_item(text_input("newest", "hash-copy-hud-fail-newest"))
            .unwrap();

        let failed = copy_quick_history_item(&failed_state, QuickPasteDirection::Older, |_| {
            Err(AppError::from("copy failed"))
        })
        .map(copied_result)
        .unwrap();

        assert!(failed.item.is_some());
        assert_eq!(
            quick_copy_success_payload(QuickPasteDirection::Older, &failed),
            None
        );
    }

    #[test]
    fn wheel_quick_history_action_uses_copy_not_paste() {
        let state = AppState::new(repo());
        let older = state
            .repository()
            .insert_clipboard_item(text_input("older", "hash-wheel-copy-older"))
            .unwrap();
        state
            .repository()
            .insert_clipboard_item(text_input("newest", "hash-wheel-copy-newest"))
            .unwrap();
        let mut copied_id = None;

        let result = wheel_quick_history_item(&state, QuickPasteDirection::Older, |item| {
            copied_id = Some(item.id);
            Ok(())
        })
        .map(copied_result)
        .unwrap();
        let stored = state
            .repository()
            .get_item_by_id(older.id)
            .unwrap()
            .unwrap();

        assert_eq!(copied_id, Some(older.id));
        assert_eq!(result.message, "copied");
        assert_eq!(stored.use_count, 1);
        assert!(stored.last_used_at.is_some());
    }

    #[test]
    fn quick_history_action_keeps_sequence_when_copied_item_moves_to_head() {
        let state = AppState::new(repo());
        let oldest = state
            .repository()
            .insert_clipboard_item(text_input("oldest", "hash-sequence-oldest"))
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let middle = state
            .repository()
            .insert_clipboard_item(text_input("middle", "hash-sequence-middle"))
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        state
            .repository()
            .insert_clipboard_item(text_input("newest", "hash-sequence-newest"))
            .unwrap();
        let mut copied_ids = Vec::new();

        copy_quick_history_item(&state, QuickPasteDirection::Older, |item| {
            copied_ids.push(item.id);
            Ok(())
        })
        .map(copied_result)
        .unwrap();

        std::thread::sleep(std::time::Duration::from_millis(2));
        state
            .repository()
            .insert_clipboard_item(text_input("middle", "hash-sequence-middle"))
            .unwrap();

        copy_quick_history_item(&state, QuickPasteDirection::Older, |item| {
            copied_ids.push(item.id);
            Ok(())
        })
        .map(copied_result)
        .unwrap();

        assert_eq!(copied_ids, vec![middle.id, oldest.id]);
    }

    #[test]
    fn first_older_move_selects_offset_one_when_history_has_at_least_two_items() {
        let mut cursor = QuickPasteCursor::default();

        assert_eq!(
            cursor.resolve(QuickPasteDirection::Older, &[10, 9, 8]),
            QuickPasteCursorResolution::Item(9)
        );
        assert_eq!(
            cursor.snapshot(),
            QuickPasteCursorSnapshot {
                offset: Some(1),
                head_id: Some(10),
                selected_item_id: Some(9),
            }
        );
    }

    #[test]
    fn newer_move_reports_boundary_at_offset_zero() {
        let mut cursor = QuickPasteCursor::default();

        assert_eq!(
            cursor.resolve(QuickPasteDirection::Newer, &[10, 9, 8]),
            QuickPasteCursorResolution::Boundary(QuickPasteBoundary::Newest)
        );
        assert_eq!(
            cursor.resolve(QuickPasteDirection::Newer, &[10, 9, 8]),
            QuickPasteCursorResolution::Boundary(QuickPasteBoundary::Newest)
        );
    }

    #[test]
    fn older_move_reports_boundary_at_tail() {
        let mut cursor = QuickPasteCursor::default();

        assert_eq!(
            cursor.resolve(QuickPasteDirection::Older, &[10, 9]),
            QuickPasteCursorResolution::Item(9)
        );
        assert_eq!(
            cursor.resolve(QuickPasteDirection::Older, &[10, 9]),
            QuickPasteCursorResolution::Boundary(QuickPasteBoundary::Oldest)
        );
    }

    #[test]
    fn active_session_keeps_order_until_idle_timeout() {
        let mut cursor = QuickPasteCursor::default();
        let now = Instant::now();
        assert_eq!(
            cursor.resolve_at(QuickPasteDirection::Older, &[10, 9, 8, 7], now),
            QuickPasteCursorResolution::Item(9)
        );

        assert_eq!(
            cursor.resolve_at(
                QuickPasteDirection::Older,
                &[9, 10, 8, 7],
                now + Duration::from_secs(1)
            ),
            QuickPasteCursorResolution::Item(8)
        );
        assert_eq!(
            cursor.resolve_at(
                QuickPasteDirection::Older,
                &[9, 10, 8, 7],
                now + QUICK_PASTE_CURSOR_IDLE_RESET + Duration::from_secs(1)
            ),
            QuickPasteCursorResolution::Item(10)
        );
        assert_eq!(
            cursor.snapshot(),
            QuickPasteCursorSnapshot {
                offset: Some(1),
                head_id: Some(9),
                selected_item_id: Some(10),
            }
        );
    }

    #[test]
    fn empty_history_clears_cursor() {
        let mut cursor = QuickPasteCursor::default();
        assert_eq!(
            cursor.resolve(QuickPasteDirection::Older, &[10, 9, 8]),
            QuickPasteCursorResolution::Item(9)
        );

        assert_eq!(
            cursor.resolve(QuickPasteDirection::Older, &[]),
            QuickPasteCursorResolution::Empty
        );
        assert_eq!(cursor.snapshot(), QuickPasteCursorSnapshot::default());
    }

    #[test]
    fn active_session_includes_new_items_inserted_before_head() {
        let mut cursor = QuickPasteCursor::default();
        let now = Instant::now();

        assert_eq!(
            cursor.resolve_at(QuickPasteDirection::Older, &[10, 9, 8], now),
            QuickPasteCursorResolution::Item(9)
        );
        assert_eq!(
            cursor.resolve_at(
                QuickPasteDirection::Older,
                &[10, 9, 8],
                now + Duration::from_secs(1)
            ),
            QuickPasteCursorResolution::Item(8)
        );
        assert_eq!(
            cursor.resolve_at(
                QuickPasteDirection::Newer,
                &[11, 10, 9, 8],
                now + Duration::from_secs(2)
            ),
            QuickPasteCursorResolution::Item(9)
        );
        assert_eq!(
            cursor.resolve_at(
                QuickPasteDirection::Newer,
                &[11, 10, 9, 8],
                now + Duration::from_secs(3)
            ),
            QuickPasteCursorResolution::Item(10)
        );
        assert_eq!(
            cursor.resolve_at(
                QuickPasteDirection::Newer,
                &[11, 10, 9, 8],
                now + Duration::from_secs(4)
            ),
            QuickPasteCursorResolution::Item(11)
        );
    }

    #[test]
    fn cursor_reports_boundary_instead_of_reselecting_current_item() {
        let mut cursor = QuickPasteCursor::default();
        let now = Instant::now();

        assert_eq!(
            cursor.resolve_at(QuickPasteDirection::Newer, &[10, 9], now),
            QuickPasteCursorResolution::Boundary(QuickPasteBoundary::Newest)
        );
        assert_eq!(
            cursor.resolve_at(
                QuickPasteDirection::Older,
                &[10, 9],
                now + Duration::from_secs(1)
            ),
            QuickPasteCursorResolution::Item(9)
        );
        assert_eq!(
            cursor.resolve_at(
                QuickPasteDirection::Older,
                &[10, 9],
                now + Duration::from_secs(2)
            ),
            QuickPasteCursorResolution::Boundary(QuickPasteBoundary::Oldest)
        );
    }

    #[test]
    fn cursor_can_be_anchored_to_a_clicked_history_item() {
        let mut cursor = QuickPasteCursor::default();
        let now = Instant::now();

        let snapshot = cursor.select_at(8, &[10, 9, 8, 7], now).unwrap();

        assert_eq!(
            snapshot,
            QuickPasteCursorSnapshot {
                offset: Some(2),
                head_id: Some(10),
                selected_item_id: Some(8),
            }
        );
        assert_eq!(
            cursor.resolve_at(
                QuickPasteDirection::Newer,
                &[10, 9, 8, 7],
                now + Duration::from_secs(1)
            ),
            QuickPasteCursorResolution::Item(9)
        );
    }

    #[test]
    fn system_hotkey_probe_rejects_empty_and_invalid_strings_without_runtime() {
        let empty = HotkeyAvailabilityProbe::unavailable("", "hotkey is empty");
        assert!(!empty.available);
        assert_eq!(empty.reason.as_deref(), Some("hotkey is empty"));

        assert!("CommandOrControl+Shift+V"
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .is_ok());
        assert!("Ctrl+Alt+Left"
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .is_ok());
        assert!("not-a-hotkey"
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .is_err());
    }

    #[test]
    fn validates_hotkey_settings_before_registration() {
        let mut settings = crate::models::HotkeySettings::default();
        assert!(validate_hotkey_settings(&settings).is_ok());

        settings.search = settings.open_panel.clone();
        assert!(validate_hotkey_settings(&settings)
            .unwrap_err()
            .to_string()
            .contains("assigned to both"));

        settings.search = "not-a-hotkey".to_string();
        assert!(validate_hotkey_settings(&settings)
            .unwrap_err()
            .to_string()
            .contains("invalid hotkey"));
    }

    #[test]
    fn wheel_hook_options_match_default_settings_shape() {
        let options = WheelHookOptions {
            enabled: true,
            modifier: WheelShortcutModifier::Ctrl,
            scope: WheelShortcutScope::Global,
        };

        assert!(options.enabled);
        assert_eq!(options.modifier, WheelShortcutModifier::Ctrl);
        assert_eq!(options.scope, WheelShortcutScope::Global);
    }

    #[test]
    fn wheel_direction_maps_positive_delta_to_older_and_negative_to_newer() {
        assert_eq!(
            wheel_direction_from_mouse_data((120u16 as u32) << 16),
            Some(QuickPasteDirection::Older)
        );
        assert_eq!(
            wheel_direction_from_mouse_data(((-120i16) as u16 as u32) << 16),
            Some(QuickPasteDirection::Newer)
        );
        assert_eq!(wheel_direction_from_mouse_data(0), None);
    }

    #[test]
    fn wheel_modifier_matching_respects_configured_modifier() {
        assert!(modifier_matches_state(
            WheelShortcutModifier::Ctrl,
            true,
            false,
            false
        ));
        assert!(modifier_matches_state(
            WheelShortcutModifier::CtrlAlt,
            true,
            true,
            false
        ));
        assert!(!modifier_matches_state(
            WheelShortcutModifier::CtrlAlt,
            true,
            false,
            false
        ));
        assert!(modifier_matches_state(
            WheelShortcutModifier::Shift,
            false,
            false,
            true
        ));
    }

    #[test]
    fn keyboard_capture_detects_ctrl_x_cut_shortcut() {
        assert!(super::should_capture_cut_shortcut(
            0x0100,
            b'X' as u32,
            true
        ));
        assert!(super::should_capture_cut_shortcut(
            0x0104,
            b'X' as u32,
            true
        ));
        assert!(!super::should_capture_cut_shortcut(
            0x0100,
            b'C' as u32,
            true
        ));
        assert!(!super::should_capture_cut_shortcut(
            0x0100,
            b'X' as u32,
            false
        ));
        assert!(!super::should_capture_cut_shortcut(
            0x0101,
            b'X' as u32,
            true
        ));
    }
}

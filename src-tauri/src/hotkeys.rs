use std::collections::BTreeMap;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::{
    commands::{self, AppState},
    errors::{AppError, AppResult},
    events,
    models::{
        AppSettings, ClipboardItem, HotkeySettings, HudDirection, HudPayload,
        WheelShortcutModifier, WheelShortcutScope,
    },
    paste, windows,
};

const WHEEL_DEBOUNCE_MS: u128 = 180;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuickPasteDirection {
    Older,
    Newer,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QuickPasteCursor {
    offset: Option<i64>,
    head_id: Option<i64>,
}

impl QuickPasteCursor {
    pub fn resolve(
        &mut self,
        direction: QuickPasteDirection,
        total: i64,
        head_id: Option<i64>,
    ) -> Option<i64> {
        if total <= 0 {
            self.offset = None;
            self.head_id = head_id;
            return None;
        }

        if self.head_id != head_id {
            self.offset = None;
            self.head_id = head_id;
        }

        let current = self.offset.unwrap_or(0);
        let next = match direction {
            QuickPasteDirection::Older => (current + 1).min(total - 1),
            QuickPasteDirection::Newer => (current - 1).max(0),
        };

        self.offset = Some(next);
        Some(next)
    }

    pub fn snapshot(&self) -> QuickPasteCursorSnapshot {
        QuickPasteCursorSnapshot {
            offset: self.offset,
            head_id: self.head_id,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QuickPasteCursorSnapshot {
    pub offset: Option<i64>,
    pub head_id: Option<i64>,
}

pub fn head_id(items: &[ClipboardItem]) -> Option<i64> {
    items.first().map(|item| item.id)
}

pub fn register_global_shortcuts(app: &AppHandle) -> AppResult<()> {
    let settings = app.state::<AppState>().repository().get_hotkey_settings()?;

    replace_keyboard_shortcuts(app, &settings)?;
    if let Err(error) = start_wheel_hook(app) {
        tracing::warn!(
            target: "hotkeys",
            "wheel shortcut hook failed to start; keyboard quick paste remains available: {error}"
        );
    }
    Ok(())
}

pub fn replace_keyboard_shortcuts(app: &AppHandle, settings: &HotkeySettings) -> AppResult<()> {
    validate_hotkey_settings(settings)?;
    app.global_shortcut()
        .unregister_all()
        .map_err(|err| AppError::from(format!("failed to unregister hotkeys: {err}")))?;
    if let Err(error) = register_keyboard_shortcuts(app, settings) {
        let _ = app.global_shortcut().unregister_all();
        return Err(error);
    }
    Ok(())
}

pub fn validate_hotkey_settings(settings: &HotkeySettings) -> AppResult<()> {
    let mut by_hotkey: BTreeMap<String, &'static str> = BTreeMap::new();
    for (command, accelerator, _) in keyboard_shortcut_entries(settings) {
        let accelerator = accelerator.trim();
        if accelerator.is_empty() {
            return Err(AppError::from(format!("hotkey {command} cannot be empty")));
        }
        accelerator
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .map_err(|error| {
                AppError::from(format!("invalid hotkey {command}={accelerator}: {error}"))
            })?;

        if let Some(existing) = by_hotkey.insert(accelerator.to_string(), command) {
            return Err(AppError::from(format!(
                "hotkey {accelerator} is assigned to both {existing} and {command}"
            )));
        }
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

fn register_keyboard_shortcuts(app: &AppHandle, settings: &HotkeySettings) -> AppResult<()> {
    for (_, accelerator, action) in keyboard_shortcut_entries(settings) {
        register_shortcut(app, accelerator, action)?;
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
            let _ = windows::show_main_window(app);
        }
        HotkeyAction::Search => {
            let _ = windows::show_main_window(app);
            let _ = app.emit(events::CLIPBOARD_FOCUS_SEARCH, ());
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
            let _ = quick_paste(app, direction);
        }
    }
}

fn quick_paste(app: &AppHandle, direction: QuickPasteDirection) -> AppResult<()> {
    let state = app.state::<AppState>();
    let total = state.repository().count_items()?;
    let history = state.repository().get_history(1)?;
    let head_id = history.first().map(|item| item.id);
    let Some(offset) =
        state.quick_paste_cursor_mut(|cursor| cursor.resolve(direction, total, head_id))
    else {
        return Ok(());
    };

    let Some(item) = state.repository().get_history_by_offset(offset)? else {
        return Ok(());
    };

    let hud_direction = match direction {
        QuickPasteDirection::Older => HudDirection::Prev,
        QuickPasteDirection::Newer => HudDirection::Next,
    };
    let payload = HudPayload {
        direction: hud_direction,
        content_type: item.content_type,
        text: item.preview.clone(),
    };
    let _ = windows::show_hud_window(app);
    let _ = app.emit(events::HUD_SHOW, &payload);

    let result = commands::paste_item_impl(state.inner(), item.id, |item| {
        paste::write_clipboard_and_paste(app, item)
    })?;
    if result.success {
        let _ = app.emit(
            events::HISTORY_REVISION,
            commands::HistoryRevisionPayload {
                revision: result.revision,
            },
        );
    }
    Ok(())
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
        modifier_matches_state, quick_paste, wheel_direction_from_mouse_data, QuickPasteDirection,
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
        if code == HC_ACTION as i32 && wparam.0 as u32 == WM_MOUSEWHEEL {
            if handle_mouse_wheel(lparam) {
                return LRESULT(1);
            }
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
                if let Err(error) = quick_paste(&app, direction) {
                    tracing::warn!(target: "hotkeys", "wheel quick paste failed: {error}");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_older_move_selects_offset_one_when_history_has_at_least_two_items() {
        let mut cursor = QuickPasteCursor::default();

        assert_eq!(
            cursor.resolve(QuickPasteDirection::Older, 3, Some(10)),
            Some(1)
        );
        assert_eq!(
            cursor.snapshot(),
            QuickPasteCursorSnapshot {
                offset: Some(1),
                head_id: Some(10),
            }
        );
    }

    #[test]
    fn newer_move_clamps_at_offset_zero() {
        let mut cursor = QuickPasteCursor::default();

        assert_eq!(
            cursor.resolve(QuickPasteDirection::Newer, 3, Some(10)),
            Some(0)
        );
        assert_eq!(
            cursor.resolve(QuickPasteDirection::Newer, 3, Some(10)),
            Some(0)
        );
    }

    #[test]
    fn older_move_clamps_at_tail() {
        let mut cursor = QuickPasteCursor::default();

        assert_eq!(
            cursor.resolve(QuickPasteDirection::Older, 2, Some(10)),
            Some(1)
        );
        assert_eq!(
            cursor.resolve(QuickPasteDirection::Older, 2, Some(10)),
            Some(1)
        );
    }

    #[test]
    fn head_id_change_resets_cursor_before_resolving() {
        let mut cursor = QuickPasteCursor::default();
        assert_eq!(
            cursor.resolve(QuickPasteDirection::Older, 4, Some(10)),
            Some(1)
        );

        assert_eq!(
            cursor.resolve(QuickPasteDirection::Older, 4, Some(11)),
            Some(1)
        );
        assert_eq!(
            cursor.snapshot(),
            QuickPasteCursorSnapshot {
                offset: Some(1),
                head_id: Some(11),
            }
        );
    }

    #[test]
    fn empty_history_clears_cursor() {
        let mut cursor = QuickPasteCursor::default();
        assert_eq!(
            cursor.resolve(QuickPasteDirection::Older, 3, Some(10)),
            Some(1)
        );

        assert_eq!(cursor.resolve(QuickPasteDirection::Older, 0, None), None);
        assert_eq!(cursor.snapshot(), QuickPasteCursorSnapshot::default());
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
}

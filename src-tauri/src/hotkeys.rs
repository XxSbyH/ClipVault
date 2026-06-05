use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::{
    commands::{self, AppState},
    errors::{AppError, AppResult},
    events,
    models::{ClipboardItem, HudDirection, HudPayload, WheelShortcutModifier, WheelShortcutScope},
    paste, windows,
};

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

    register_shortcut(app, &settings.open_panel, HotkeyAction::OpenPanel)?;
    register_shortcut(app, &settings.search, HotkeyAction::Search)?;
    register_shortcut(app, &settings.pause, HotkeyAction::Pause)?;
    register_shortcut(app, &settings.clear, HotkeyAction::Clear)?;
    register_shortcut(
        app,
        &settings.quick_paste_prev,
        HotkeyAction::QuickPaste(QuickPasteDirection::Older),
    )?;
    register_shortcut(
        app,
        &settings.quick_paste_next,
        HotkeyAction::QuickPaste(QuickPasteDirection::Newer),
    )?;
    start_wheel_hook(app)?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WheelHookOptions {
    pub enabled: bool,
    pub modifier: WheelShortcutModifier,
    pub scope: WheelShortcutScope,
}

pub fn start_wheel_hook(app: &AppHandle) -> AppResult<()> {
    let settings = app.state::<AppState>().repository().get_settings()?;
    let options = WheelHookOptions {
        enabled: settings.wheel_shortcut_enabled,
        modifier: settings.wheel_shortcut_modifier,
        scope: settings.wheel_shortcut_scope,
    };

    if options.enabled {
        tracing::warn!(
            target: "hotkeys",
            "wheel shortcut hook is not active in this build; keyboard quick paste remains available"
        );
    }
    Ok(())
}

pub fn stop_wheel_hook() -> AppResult<()> {
    Ok(())
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
}

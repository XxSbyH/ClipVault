use std::time::Duration;

use tauri::{image::Image, AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
    VK_CONTROL, VK_V,
};

use crate::{
    errors::{AppError, AppResult},
    models::{ClipboardContentType, ClipboardItem},
};

pub fn write_clipboard_and_paste(app: &AppHandle, item: &ClipboardItem) -> AppResult<()> {
    write_item_to_clipboard(app, item)?;
    hide_main_window(app);
    simulate_ctrl_v_after_delay(Duration::from_millis(120))
}

pub fn write_text_and_paste(app: &AppHandle, text: &str) -> AppResult<()> {
    write_text_to_clipboard(app, text)?;
    hide_main_window(app);
    simulate_ctrl_v_after_delay(Duration::from_millis(120))
}

pub fn write_item_to_clipboard(app: &AppHandle, item: &ClipboardItem) -> AppResult<()> {
    if should_try_rich_formats(item) {
        if let Some(state) = app.try_state::<crate::commands::AppState>() {
            match state
                .repository()
                .list_clipboard_formats(item.id)
                .and_then(|formats| {
                    crate::clipboard::formats::write_supported_formats(
                        &formats,
                        item.content.as_deref(),
                    )
                }) {
                Ok(true) => return Ok(()),
                Ok(false) => {
                    tracing::warn!(
                        target: "clipboard",
                        area = "clipboard",
                        direction = "write rich clipboard formats",
                        "rich clipboard paste had no supported payloads; falling back"
                    );
                }
                Err(error) => {
                    tracing::warn!(
                        target: "clipboard",
                        area = "clipboard",
                        direction = "write rich clipboard formats",
                        "rich clipboard paste failed; falling back: {error}"
                    );
                }
            }
        }
    }

    match item.content_type {
        ClipboardContentType::Text
        | ClipboardContentType::Url
        | ClipboardContentType::Code
        | ClipboardContentType::Color
        | ClipboardContentType::Email => {
            let Some(content) = item.content.as_deref() else {
                return Err(AppError::from("clipboard item has no text content"));
            };
            write_text_to_clipboard(app, content)
        }
        ClipboardContentType::File => {
            let Some(path) = item.file_path.as_deref().or(item.content.as_deref()) else {
                return Err(AppError::from("clipboard file item has no path"));
            };
            app.clipboard().write_text(path).map_err(|err| {
                AppError::from(format!("failed to write clipboard file path: {err}"))
            })
        }
        ClipboardContentType::Image => {
            let Some(image_data) = item.image_data.as_deref() else {
                return Err(AppError::from("clipboard image item has no image data"));
            };
            let image = Image::from_bytes(image_data).map_err(|err| {
                AppError::from(format!("failed to decode clipboard image: {err}"))
            })?;
            app.clipboard()
                .write_image(&image)
                .map_err(|err| AppError::from(format!("failed to write clipboard image: {err}")))
        }
    }
}

fn should_try_rich_formats(item: &ClipboardItem) -> bool {
    item.metadata
        .extra
        .get("hasRichFormats")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn write_text_to_clipboard(app: &AppHandle, text: &str) -> AppResult<()> {
    app.clipboard()
        .write_text(text)
        .map_err(|err| AppError::from(format!("failed to write clipboard text: {err}")))
}

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    if let Some(window) = app.get_webview_window("search") {
        let _ = window.hide();
    }
}

#[cfg(target_os = "windows")]
fn simulate_ctrl_v_after_delay(delay: Duration) -> AppResult<()> {
    std::thread::sleep(delay);
    send_ctrl_v()
}

#[cfg(not(target_os = "windows"))]
fn simulate_ctrl_v_after_delay(_delay: Duration) -> AppResult<()> {
    Err(AppError::from(
        "paste simulation is only supported on Windows",
    ))
}

#[cfg(target_os = "windows")]
fn send_ctrl_v() -> AppResult<()> {
    let inputs = [
        keyboard_input(VK_CONTROL, false),
        keyboard_input(VK_V, false),
        keyboard_input(VK_V, true),
        keyboard_input(VK_CONTROL, true),
    ];

    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent == inputs.len() as u32 {
        Ok(())
    } else {
        Err(AppError::from(format!(
            "failed to simulate Ctrl+V: SendInput sent {sent} events"
        )))
    }
}

#[cfg(target_os = "windows")]
fn keyboard_input(key: VIRTUAL_KEY, key_up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                wScan: 0,
                dwFlags: if key_up {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::models::{ClipboardContentType, ClipboardItem, ClipboardMetadata};

    fn text_item(content: &str) -> ClipboardItem {
        ClipboardItem {
            id: 1,
            content: Some(content.to_string()),
            content_type: ClipboardContentType::Text,
            content_hash: "hash".to_string(),
            preview: content.to_string(),
            metadata: ClipboardMetadata::default(),
            file_path: None,
            image_data: None,
            created_at: 1,
            last_used_at: None,
            use_count: 0,
            is_pinned: false,
            is_favorite: false,
        }
    }

    #[test]
    fn should_try_rich_formats_only_when_metadata_says_available() {
        let mut item = text_item("hello");
        assert!(!super::should_try_rich_formats(&item));

        item.metadata
            .extra
            .insert("hasRichFormats".to_string(), json!(true));
        assert!(super::should_try_rich_formats(&item));
    }
}

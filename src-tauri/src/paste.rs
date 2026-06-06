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

pub fn write_item_to_clipboard(app: &AppHandle, item: &ClipboardItem) -> AppResult<()> {
    match item.content_type {
        ClipboardContentType::Text
        | ClipboardContentType::Url
        | ClipboardContentType::Code
        | ClipboardContentType::Color
        | ClipboardContentType::Email => {
            let Some(content) = item.content.as_deref() else {
                return Err(AppError::from("clipboard item has no text content"));
            };
            app.clipboard()
                .write_text(content)
                .map_err(|err| AppError::from(format!("failed to write clipboard text: {err}")))
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

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
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

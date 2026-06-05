use tauri::{AppHandle, Manager, WindowEvent};

use crate::errors::{AppError, AppResult};

pub fn configure_windows(app: &AppHandle) -> AppResult<()> {
    configure_main_window(app)?;
    configure_hud_window(app)?;
    Ok(())
}

pub fn show_main_window(app: &AppHandle) -> AppResult<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Err(AppError::from("main window not found"));
    };
    window
        .show()
        .map_err(|err| AppError::from(format!("failed to show main window: {err}")))?;
    window
        .set_focus()
        .map_err(|err| AppError::from(format!("failed to focus main window: {err}")))?;
    Ok(())
}

pub fn hide_main_window(app: &AppHandle) -> AppResult<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Err(AppError::from("main window not found"));
    };
    window
        .hide()
        .map_err(|err| AppError::from(format!("failed to hide main window: {err}")))
}

pub fn is_main_window_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

pub fn show_hud_window(app: &AppHandle) -> AppResult<()> {
    let Some(window) = app.get_webview_window("hud") else {
        return Err(AppError::from("hud window not found"));
    };
    window
        .show()
        .map_err(|err| AppError::from(format!("failed to show HUD window: {err}")))?;
    Ok(())
}

fn configure_main_window(app: &AppHandle) -> AppResult<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    window
        .set_decorations(false)
        .map_err(|err| AppError::from(format!("failed to configure main decorations: {err}")))?;
    let close_window = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = close_window.hide();
        }
    });
    Ok(())
}

fn configure_hud_window(app: &AppHandle) -> AppResult<()> {
    let Some(window) = app.get_webview_window("hud") else {
        return Ok(());
    };
    window
        .set_decorations(false)
        .map_err(|err| AppError::from(format!("failed to configure HUD decorations: {err}")))?;
    let _ = window.set_always_on_top(true);
    let _ = window.set_skip_taskbar(true);
    Ok(())
}

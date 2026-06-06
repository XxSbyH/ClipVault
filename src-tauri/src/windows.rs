use tauri::{AppHandle, Manager, PhysicalPosition, WebviewWindow, WindowEvent};

use crate::errors::{AppError, AppResult};

const HUD_TOP_OFFSET: i32 = 18;

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

pub fn focus_main_window(app: &AppHandle) -> AppResult<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Err(AppError::from("main window not found"));
    };
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
    position_hud_window(&window)?;
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
    let _ = window.set_resizable(false);
    let _ = window.set_focusable(false);
    let _ = window.set_shadow(false);
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.set_always_on_top(true);
    let _ = window.set_skip_taskbar(true);
    Ok(())
}

fn position_hud_window(window: &WebviewWindow) -> AppResult<()> {
    let Some(monitor) = window
        .primary_monitor()
        .map_err(|err| AppError::from(format!("failed to read primary monitor: {err}")))?
    else {
        return Ok(());
    };

    let work_area = monitor.work_area();
    let window_size = window
        .outer_size()
        .map_err(|err| AppError::from(format!("failed to read HUD window size: {err}")))?;
    let available_width = work_area.size.width as i32;
    let window_width = window_size.width as i32;
    let x = work_area.position.x + ((available_width - window_width) / 2).max(0);
    let y = work_area.position.y + HUD_TOP_OFFSET;

    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|err| AppError::from(format!("failed to position HUD window: {err}")))?;
    Ok(())
}

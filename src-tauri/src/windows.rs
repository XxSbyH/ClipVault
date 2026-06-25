use tauri::{AppHandle, Manager, PhysicalPosition, WebviewWindow, WindowEvent};

use crate::errors::{AppError, AppResult};

const HUD_TOP_OFFSET: i32 = 18;
const MIN_VISIBLE_WINDOW_AREA_DENOMINATOR: i128 = 4;
const SEARCH_RIGHT_OFFSET: i32 = 180;
const SEARCH_UP_OFFSET: i32 = 120;

pub fn configure_windows(app: &AppHandle) -> AppResult<()> {
    configure_main_window(app)?;
    configure_hud_window(app)?;
    configure_search_window(app)?;
    Ok(())
}

pub fn show_main_window(app: &AppHandle) -> AppResult<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Err(AppError::from("main window not found"));
    };
    window
        .unminimize()
        .map_err(|err| AppError::from(format!("failed to unminimize main window: {err}")))?;
    recover_main_window_if_offscreen(&window)?;
    window
        .show()
        .map_err(|err| AppError::from(format!("failed to show main window: {err}")))?;
    window
        .set_focus()
        .map_err(|err| AppError::from(format!("failed to focus main window: {err}")))?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WorkArea {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowSize {
    width: i32,
    height: i32,
}

fn recover_main_window_if_offscreen(window: &WebviewWindow) -> AppResult<()> {
    let current_position = window
        .outer_position()
        .map_err(|err| AppError::from(format!("failed to read main window position: {err}")))?;
    let current_size = window
        .outer_size()
        .map_err(|err| AppError::from(format!("failed to read main window size: {err}")))?;
    let work_areas = window
        .available_monitors()
        .map_err(|err| AppError::from(format!("failed to read monitors: {err}")))?
        .into_iter()
        .map(|monitor| {
            let area = monitor.work_area();
            WorkArea {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width.min(i32::MAX as u32) as i32,
                height: area.size.height.min(i32::MAX as u32) as i32,
            }
        })
        .collect::<Vec<_>>();

    if let Some(position) = recover_main_window_position(
        current_position,
        WindowSize {
            width: current_size.width.min(i32::MAX as u32) as i32,
            height: current_size.height.min(i32::MAX as u32) as i32,
        },
        &work_areas,
    ) {
        window.set_position(position).map_err(|err| {
            AppError::from(format!("failed to recover main window position: {err}"))
        })?;
    }

    Ok(())
}

fn recover_main_window_position(
    position: PhysicalPosition<i32>,
    size: WindowSize,
    work_areas: &[WorkArea],
) -> Option<PhysicalPosition<i32>> {
    let primary_area = work_areas.first()?;
    if work_areas
        .iter()
        .any(|area| window_is_meaningfully_visible_in_work_area(position, size, *area))
    {
        return None;
    }

    let x = primary_area.x + ((primary_area.width - size.width) / 2).max(0);
    let y = primary_area.y + ((primary_area.height - size.height) / 2).max(0);
    Some(PhysicalPosition::new(x, y))
}

fn window_is_meaningfully_visible_in_work_area(
    position: PhysicalPosition<i32>,
    size: WindowSize,
    area: WorkArea,
) -> bool {
    let window_area = i128::from(size.width.max(0)) * i128::from(size.height.max(0));
    if window_area <= 0 {
        return false;
    }

    let visible_area = visible_window_area(position, size, area);
    visible_area * MIN_VISIBLE_WINDOW_AREA_DENOMINATOR >= window_area
}

fn visible_window_area(position: PhysicalPosition<i32>, size: WindowSize, area: WorkArea) -> i128 {
    let window_right = position.x.saturating_add(size.width.max(0));
    let window_bottom = position.y.saturating_add(size.height.max(0));
    let area_right = area.x.saturating_add(area.width.max(0));
    let area_bottom = area.y.saturating_add(area.height.max(0));

    let left = position.x.max(area.x);
    let top = position.y.max(area.y);
    let right = window_right.min(area_right);
    let bottom = window_bottom.min(area_bottom);
    let width = i128::from(right.saturating_sub(left).max(0));
    let height = i128::from(bottom.saturating_sub(top).max(0));
    width * height
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

pub fn show_search_window(app: &AppHandle) -> AppResult<()> {
    let Some(window) = app.get_webview_window("search") else {
        return Err(AppError::from("search window not found"));
    };
    window
        .unminimize()
        .map_err(|err| AppError::from(format!("failed to unminimize search window: {err}")))?;
    position_search_window(&window)?;
    window
        .show()
        .map_err(|err| AppError::from(format!("failed to show search window: {err}")))?;
    window
        .set_focus()
        .map_err(|err| AppError::from(format!("failed to focus search window: {err}")))?;
    Ok(())
}

pub fn hide_search_window(app: &AppHandle) -> AppResult<()> {
    let Some(window) = app.get_webview_window("search") else {
        return Err(AppError::from("search window not found"));
    };
    window
        .hide()
        .map_err(|err| AppError::from(format!("failed to hide search window: {err}")))
}

pub fn is_search_window_visible(app: &AppHandle) -> bool {
    let Some(window) = app.get_webview_window("search") else {
        return false;
    };
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(true);
    visible && !minimized
}

pub fn is_main_window_visible(app: &AppHandle) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(true);
    main_window_is_presented(visible, minimized)
}

fn main_window_is_presented(visible: bool, minimized: bool) -> bool {
    visible && !minimized
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

fn configure_search_window(app: &AppHandle) -> AppResult<()> {
    let Some(window) = app.get_webview_window("search") else {
        return Ok(());
    };
    window
        .set_decorations(false)
        .map_err(|err| AppError::from(format!("failed to configure search decorations: {err}")))?;
    let _ = window.set_resizable(false);
    let _ = window.set_always_on_top(true);
    let _ = window.set_shadow(false);
    let _ = window.set_skip_taskbar(true);
    let close_window = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = close_window.hide();
        }
        WindowEvent::Focused(false) => {
            let _ = close_window.hide();
        }
        _ => {}
    });
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

fn position_search_window(window: &WebviewWindow) -> AppResult<()> {
    let Some(monitor) = window
        .primary_monitor()
        .map_err(|err| AppError::from(format!("failed to read primary monitor: {err}")))?
    else {
        return Ok(());
    };

    let work_area = monitor.work_area();
    let window_size = window
        .outer_size()
        .map_err(|err| AppError::from(format!("failed to read search window size: {err}")))?;
    let position = search_window_position(
        WorkArea {
            x: work_area.position.x,
            y: work_area.position.y,
            width: work_area.size.width.min(i32::MAX as u32) as i32,
            height: work_area.size.height.min(i32::MAX as u32) as i32,
        },
        WindowSize {
            width: window_size.width.min(i32::MAX as u32) as i32,
            height: window_size.height.min(i32::MAX as u32) as i32,
        },
    );

    window
        .set_position(position)
        .map_err(|err| AppError::from(format!("failed to position search window: {err}")))?;
    Ok(())
}

fn search_window_position(area: WorkArea, size: WindowSize) -> PhysicalPosition<i32> {
    let available_x = (area.width - size.width).max(0);
    let available_y = (area.height - size.height).max(0);
    let center_x = area.x + available_x / 2;
    let center_y = area.y + available_y / 2;
    let x = (center_x + SEARCH_RIGHT_OFFSET).min(area.x + available_x);
    let y = (center_y - SEARCH_UP_OFFSET).max(area.y);
    PhysicalPosition::new(x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_window_position_is_recovered_when_fully_outside_work_areas() {
        let work_area = WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };

        let recovered = recover_main_window_position(
            PhysicalPosition::new(-4000, 120),
            WindowSize {
                width: 820,
                height: 600,
            },
            &[work_area],
        );

        assert_eq!(recovered, Some(PhysicalPosition::new(550, 220)));
    }

    #[test]
    fn main_window_position_is_recovered_when_only_a_tiny_part_intersects_work_area() {
        let work_area = WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };

        let recovered = recover_main_window_position(
            PhysicalPosition::new(1800, 900),
            WindowSize {
                width: 820,
                height: 600,
            },
            &[work_area],
        );

        assert_eq!(recovered, Some(PhysicalPosition::new(550, 220)));
    }

    #[test]
    fn main_window_position_is_kept_when_meaningfully_visible() {
        let work_area = WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };

        let recovered = recover_main_window_position(
            PhysicalPosition::new(1300, 500),
            WindowSize {
                width: 820,
                height: 600,
            },
            &[work_area],
        );

        assert_eq!(recovered, None);
    }

    #[test]
    fn minimized_main_window_is_not_considered_visible_for_toggle() {
        assert!(main_window_is_presented(true, false));
        assert!(!main_window_is_presented(true, true));
        assert!(!main_window_is_presented(false, false));
    }

    #[test]
    fn search_window_position_is_shifted_up_and_right_in_primary_work_area() {
        let position = search_window_position(
            WorkArea {
                x: 40,
                y: 20,
                width: 1600,
                height: 900,
            },
            WindowSize {
                width: 520,
                height: 300,
            },
        );

        assert_eq!(position, PhysicalPosition::new(760, 200));
    }
}

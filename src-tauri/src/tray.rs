use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

use crate::{commands::AppState, errors::AppResult, events, windows};

const TRAY_ID: &str = "clipvault-main-tray";
const MENU_OPEN: &str = "open";
const MENU_TOGGLE: &str = "toggle-monitoring";
const MENU_CLEAR: &str = "clear-history";
const MENU_SETTINGS: &str = "settings";
const MENU_QUIT: &str = "quit";

pub fn create_tray(app: &AppHandle) -> AppResult<()> {
    let open = MenuItemBuilder::with_id(MENU_OPEN, "打开 ClipVault").build(app)?;
    let toggle = MenuItemBuilder::with_id(MENU_TOGGLE, "暂停/恢复监听").build(app)?;
    let clear = MenuItemBuilder::with_id(MENU_CLEAR, "清空历史").build(app)?;
    let settings = MenuItemBuilder::with_id(MENU_SETTINGS, "设置").build(app)?;
    let quit = MenuItemBuilder::with_id(MENU_QUIT, "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&open, &toggle, &clear, &settings, &quit])
        .build()?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("ClipVault")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(handle_tray_menu_event);

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn handle_tray_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        MENU_OPEN => {
            let _ = windows::show_main_window(app);
        }
        MENU_TOGGLE => {
            if let Some(state) = app.try_state::<AppState>() {
                let status = crate::commands::toggle_monitoring_impl(state.inner());
                let _ = app.emit(events::MONITORING_CHANGED, &status);
            }
        }
        MENU_CLEAR => {
            if let Some(state) = app.try_state::<AppState>() {
                if let Ok(result) = crate::commands::clear_history_impl(state.inner(), false) {
                    if result.deleted > 0 {
                        let _ = app.emit(
                            events::HISTORY_REVISION,
                            crate::commands::HistoryRevisionPayload {
                                revision: result.revision,
                            },
                        );
                    }
                }
            }
        }
        MENU_SETTINGS => {
            let _ = windows::show_main_window(app);
            let _ = app.emit(events::CLIPBOARD_OPEN_SETTINGS, ());
        }
        MENU_QUIT => {
            app.exit(0);
        }
        _ => {}
    }
}

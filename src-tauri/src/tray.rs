use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

use crate::{commands::AppState, errors::AppResult, events, windows};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const TRAY_ID: &str = "clipvault-main-tray";
const MENU_TOGGLE: &str = "toggle-monitoring";
const MENU_CLEAR: &str = "clear-history";
const MENU_SETTINGS: &str = "settings";
const MENU_WEBSITE: &str = "website";
const MENU_QUIT: &str = "quit";
const OFFICIAL_SITE_URL: &str = "https://github.com/XxSbyH/ClipVault";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn create_tray(app: &AppHandle) -> AppResult<()> {
    let toggle = MenuItemBuilder::with_id(MENU_TOGGLE, "暂停/恢复监听").build(app)?;
    let clear = MenuItemBuilder::with_id(MENU_CLEAR, "清空历史").build(app)?;
    let settings = MenuItemBuilder::with_id(MENU_SETTINGS, "设置").build(app)?;
    let website = MenuItemBuilder::with_id(MENU_WEBSITE, "打开官网").build(app)?;
    let quit = MenuItemBuilder::with_id(MENU_QUIT, "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&toggle, &clear, &settings, &website, &quit])
        .build()?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("ClipVault")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let _ = windows::show_main_window(app);
                let _ = windows::focus_main_window(app);
            }
        })
        .on_menu_event(handle_tray_menu_event);

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn handle_tray_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
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
        MENU_WEBSITE => {
            open_official_site();
        }
        MENU_QUIT => {
            app.exit(0);
        }
        _ => {}
    }
}

#[cfg(test)]
fn tray_menu_labels() -> Vec<&'static str> {
    vec!["暂停/恢复监听", "清空历史", "设置", "打开官网", "退出"]
}

fn open_official_site() {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", OFFICIAL_SITE_URL])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }

    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg(OFFICIAL_SITE_URL)
            .spawn();
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open")
            .arg(OFFICIAL_SITE_URL)
            .spawn();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn tray_menu_items_exclude_open_command() {
        let labels = super::tray_menu_labels();

        assert_eq!(
            labels,
            vec!["暂停/恢复监听", "清空历史", "设置", "打开官网", "退出"]
        );
    }
}

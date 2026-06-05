pub mod cleanup;
pub mod commands;
pub mod database;
pub mod detector;
pub mod errors;
pub mod events;
pub mod logger;
pub mod models;
pub mod privacy;
pub mod settings;

use std::fs;

use database::repository::Repository;
use tauri::Manager;

#[tauri::command]
fn health_check() -> &'static str {
    "ok"
}

pub fn run() {
    logger::init();

    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_dir)?;
            let repository = Repository::open(app_data_dir.join("clipboard.db"))?;
            app.manage(commands::AppState::new(repository));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health_check,
            commands::get_history,
            commands::get_history_revision,
            commands::search_items,
            commands::paste_item,
            commands::delete_item,
            commands::toggle_pin,
            commands::toggle_favorite,
            commands::get_image_data_url,
            commands::get_settings,
            commands::update_setting,
            commands::list_blacklist,
            commands::add_blacklist,
            commands::remove_blacklist,
            commands::get_hotkeys,
            commands::check_hotkey_conflicts,
            commands::check_hotkey_available,
            commands::update_hotkeys,
            commands::clear_history,
            commands::toggle_monitoring,
            commands::minimize_window,
            commands::hide_window,
            commands::test_monitoring,
            commands::test_hud
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

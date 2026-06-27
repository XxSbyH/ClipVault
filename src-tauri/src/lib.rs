pub mod autostart;
pub mod cleanup;
pub mod clipboard;
pub mod commands;
pub mod database;
pub mod detector;
pub mod errors;
pub mod events;
pub mod history_export;
pub mod hotkeys;
pub mod logger;
pub mod models;
pub mod paste;
pub mod privacy;
pub mod settings;
pub mod text_transform;
pub mod tray;
pub mod windows;

use std::fs;

use database::repository::Repository;
use tauri::Manager;

#[tauri::command]
fn health_check() -> &'static str {
    "ok"
}

pub fn run() {
    let init = logger::init();
    logger::startup_ok(
        "logger_init",
        "filesystem",
        "startup and runtime log files initialized",
        format!(
            "startup_log={} runtime_log={}",
            init.startup_log_path.display(),
            init.runtime_log_path.display()
        ),
    );
    logger::startup_info(
        "tauri_builder",
        "tauri",
        "building Tauri application and registering plugins",
        "builder_start",
    );

    let builder = tauri::Builder::default();
    logger::startup_info(
        "single_instance_plugin",
        "tauri_plugin",
        "register single-instance plugin; stale instance detection can affect startup",
        "register_start",
    );
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        logger::startup_info(
            "single_instance_callback",
            "tauri_plugin",
            "second instance callback reached; existing window should be focused when requested",
            format!("args_count={}", args.len()),
        );
        if autostart::should_show_main_window_for_args(args) {
            match windows::show_main_window(app) {
                Ok(()) => logger::startup_ok(
                    "single_instance_focus",
                    "tauri_plugin",
                    "existing main window focused for second instance",
                    "show_main_window_ok",
                ),
                Err(error) => logger::startup_error(
                    "single_instance_focus",
                    "tauri_plugin",
                    "check existing window state or WebView2 window focus handling",
                    error,
                ),
            }
        }
    }));
    logger::startup_ok(
        "single_instance_plugin",
        "tauri_plugin",
        "single-instance plugin registered",
        "register_ok",
    );
    logger::startup_info(
        "global_shortcut_plugin",
        "tauri_plugin",
        "register global shortcut plugin; Windows shortcut subsystem required",
        "register_start",
    );
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    logger::startup_ok(
        "global_shortcut_plugin",
        "tauri_plugin",
        "global shortcut plugin registered",
        "register_ok",
    );
    logger::startup_info(
        "clipboard_plugin",
        "tauri_plugin",
        "register clipboard manager plugin; Windows clipboard API required",
        "register_start",
    );
    let builder = builder.plugin(tauri_plugin_clipboard_manager::init());
    logger::startup_ok(
        "clipboard_plugin",
        "tauri_plugin",
        "clipboard manager plugin registered",
        "register_ok",
    );
    logger::startup_info(
        "dialog_plugin",
        "tauri_plugin",
        "register dialog plugin for history import and export file selection",
        "register_start",
    );
    let builder = builder.plugin(tauri_plugin_dialog::init());
    logger::startup_ok(
        "dialog_plugin",
        "tauri_plugin",
        "dialog plugin registered",
        "register_ok",
    );

    let result = builder
        .setup(|app| -> Result<(), Box<dyn std::error::Error>> {
            logger::startup_ok(
                "setup_start",
                "tauri",
                "Tauri setup lifecycle reached",
                "setup_entered",
            );

            let app_data_dir = match app.path().app_data_dir() {
                Ok(path) => {
                    logger::startup_ok(
                        "app_data_dir",
                        "filesystem",
                        "Tauri app data directory resolved",
                        path.display().to_string(),
                    );
                    logger::note_tauri_app_data_dir(&path);
                    path
                }
                Err(error) => {
                    logger::startup_error(
                        "app_data_dir",
                        "filesystem",
                        "check Windows user profile path and app data permissions",
                        &error,
                    );
                    return Err(Box::new(error));
                }
            };

            if let Err(error) = fs::create_dir_all(&app_data_dir) {
                logger::startup_error(
                    "app_data_dir_create",
                    "filesystem",
                    "check app data directory permissions or locked profile state",
                    &error,
                );
                return Err(Box::new(error));
            }
            logger::startup_ok(
                "app_data_dir_create",
                "filesystem",
                "app data directory exists",
                app_data_dir.display().to_string(),
            );

            let database_path = app_data_dir.join("clipboard.db");
            logger::startup_info(
                "database_open",
                "sqlite",
                "open SQLite database; failures point to lock, corruption, migration, or antivirus file lock",
                database_path.display().to_string(),
            );
            let repository = match Repository::open(&database_path) {
                Ok(repository) => {
                    logger::startup_ok(
                        "database_open",
                        "sqlite",
                        "SQLite database opened and migrations completed",
                        database_path.display().to_string(),
                    );
                    repository
                }
                Err(error) => {
                    logger::startup_error(
                        "database_open",
                        "sqlite",
                        "check database lock/corruption, migration failure, or antivirus file lock",
                        &error,
                    );
                    return Err(Box::new(error));
                }
            };

            let state = commands::AppState::new(repository);
            let settings = match state.repository().get_settings() {
                Ok(settings) => {
                    logger::startup_ok(
                        "settings_load",
                        "sqlite",
                        "settings loaded without logging sensitive values",
                        format!("launch_on_startup={}", settings.launch_on_startup),
                    );
                    settings
                }
                Err(error) => {
                    logger::startup_error(
                        "settings_load",
                        "sqlite",
                        "check settings JSON row or database integrity",
                        &error,
                    );
                    return Err(Box::new(error));
                }
            };

            if settings.launch_on_startup {
                logger::startup_info(
                    "autostart_sync",
                    "autostart",
                    "sync Windows autostart registry entry because setting is enabled",
                    "enabled=true",
                );
                if let Err(error) = autostart::sync_launch_on_startup(true) {
                    logger::startup_error(
                        "autostart_sync",
                        "autostart",
                        "check Windows registry permission or startup entry path",
                        &error,
                    );
                    return Err(Box::new(errors::AppError::from(error)));
                }
                logger::startup_ok(
                    "autostart_sync",
                    "autostart",
                    "Windows autostart entry synchronized",
                    "enabled=true",
                );
            } else {
                logger::startup_info(
                    "autostart_sync",
                    "autostart",
                    "autostart setting disabled; registry sync skipped",
                    "enabled=false",
                );
            }

            clipboard::start_monitoring(app.handle().clone(), state.clone());
            logger::startup_ok(
                "clipboard_monitor",
                "clipboard",
                "clipboard monitor task started; Windows clipboard API required",
                "started",
            );

            app.manage(state);
            logger::startup_ok(
                "app_state",
                "tauri",
                "application state registered",
                "managed",
            );

            if let Err(error) = windows::configure_windows(app.handle()) {
                logger::startup_error(
                    "window_config",
                    "webview2",
                    "check Microsoft Edge WebView2 Runtime, window labels, or packaged frontend files",
                    &error,
                );
                return Err(Box::new(error));
            }
            logger::startup_ok(
                "window_config",
                "webview2",
                "Tauri windows configured; WebView2 runtime dependency reached",
                "labels=main,hud,search",
            );

            if let Err(error) = tray::create_tray(app.handle()) {
                logger::startup_error(
                    "tray_create",
                    "tray",
                    "check Windows shell tray availability and packaged icon resources",
                    &error,
                );
                return Err(Box::new(error));
            }
            logger::startup_ok(
                "tray_create",
                "tray",
                "Windows tray menu created",
                "created",
            );

            match hotkeys::register_global_shortcuts(app.handle()) {
                hotkeys::StartupHotkeyRegistrationStatus::Registered => {
                    logger::startup_ok(
                        "hotkey_register",
                        "hotkey",
                        "global shortcuts registered",
                        "registered",
                    );
                }
                hotkeys::StartupHotkeyRegistrationStatus::Degraded { error } => {
                    logger::startup_error(
                        "hotkey_register",
                        "hotkey",
                        "global shortcuts unavailable; startup continues so hotkeys can be changed in settings",
                        &error,
                    );
                    logger::startup_info(
                        "hotkey_register",
                        "hotkey",
                        "startup continued without global keyboard shortcuts",
                        "degraded",
                    );
                }
            }

            if autostart::should_show_main_window_for_env_args() {
                logger::startup_info(
                    "main_window_show",
                    "webview2",
                    "startup arguments request showing the main window",
                    "show_requested=true",
                );
                if let Err(error) = windows::show_main_window(app.handle()) {
                    logger::startup_error(
                        "main_window_show",
                        "webview2",
                        "check window visibility/focus handling or WebView2 runtime",
                        &error,
                    );
                    return Err(Box::new(error));
                }
                logger::startup_ok(
                    "main_window_show",
                    "webview2",
                    "main window show request completed",
                    "shown",
                );
            } else {
                logger::startup_info(
                    "main_window_show",
                    "webview2",
                    "startup arguments do not request showing the main window",
                    "show_requested=false",
                );
            }

            logger::startup_ok(
                "setup_complete",
                "tauri",
                "Tauri setup completed",
                "setup_ok",
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health_check,
            commands::get_history,
            commands::get_history_revision,
            commands::search_items,
            commands::set_quick_paste_cursor,
            commands::paste_item,
            commands::copy_item,
            commands::special_paste_item,
            commands::update_text_item,
            commands::create_text_item,
            commands::delete_item,
            commands::toggle_pin,
            commands::toggle_favorite,
            commands::get_image_data_url,
            commands::get_settings,
            commands::update_setting,
            commands::list_blacklist,
            commands::add_blacklist,
            commands::remove_blacklist,
            commands::list_fixed_contents,
            commands::create_fixed_content,
            commands::update_fixed_content,
            commands::delete_fixed_content,
            commands::get_hotkeys,
            commands::check_hotkey_conflicts,
            commands::check_hotkey_available,
            commands::update_hotkeys,
            commands::clear_history,
            commands::export_history,
            commands::import_history,
            commands::toggle_monitoring,
            commands::minimize_window,
            commands::hide_window,
            commands::hide_search_window,
            commands::test_monitoring,
            commands::test_hud
        ])
        .run(tauri::generate_context!());

    match result {
        Ok(()) => logger::startup_ok(
            "tauri_run",
            "tauri",
            "Tauri event loop exited normally",
            "run_ok",
        ),
        Err(error) => {
            logger::startup_error(
                "tauri_run",
                "tauri",
                "check Tauri runtime, WebView2 runtime, plugin setup, or packaged frontend files",
                &error,
            );
            panic!("error while running tauri application: {error}");
        }
    }
}

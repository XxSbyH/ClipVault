pub mod detector;
pub mod errors;
pub mod models;
pub mod privacy;

#[tauri::command]
fn health_check() -> &'static str {
    "ok"
}

pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![health_check])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

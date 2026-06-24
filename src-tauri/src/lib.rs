mod commands;
mod engine;
mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::media::import_media,
            commands::media::get_media_thumbnails,
            commands::project::get_project,
            commands::project::update_project,
            commands::project::save_project,
            commands::project::load_project,
            commands::export::start_export,
            commands::export::start_clip_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

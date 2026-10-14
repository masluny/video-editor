mod analysis;
mod commands;
mod export;
mod ffmpeg;
mod graph;
mod job;
mod model;
mod probe;
mod proxy;
mod state;
mod thumbs;
mod util;
mod waveform;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::ffmpeg_status,
            commands::probe_media,
            commands::media_thumbnails,
            commands::media_waveform,
            commands::media_proxy,
            commands::detect_silence,
            commands::export_start,
            commands::export_cancel,
            commands::read_text_file,
            commands::write_text_file,
            commands::paths_exist,
            commands::autosave_write,
            commands::autosave_read,
            commands::autosave_clear,
            commands::log_frontend,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Revind");
}

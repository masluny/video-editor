use crate::engine::export;
use crate::state::AppState;
use std::collections::HashMap;
use tauri::AppHandle;

#[tauri::command]
pub async fn start_export(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    output_path: String,
    range_in: Option<f64>,
    range_out: Option<f64>,
) -> Result<String, String> {
    let project = state.project.lock().await;
    let media_map: HashMap<String, String> = project
        .media
        .iter()
        .map(|m| (m.id.clone(), m.path.clone()))
        .collect();

    export::start_export(&app, &project, media_map, &output_path, range_in, range_out)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_clip_export(
    app: AppHandle,
    media_path: String,
    output_path: String,
    source_in: f64,
    source_out: f64,
) -> Result<String, String> {
    export::start_clip_export(&app, &media_path, &output_path, source_in, source_out)
        .await
        .map_err(|e| e.to_string())
}

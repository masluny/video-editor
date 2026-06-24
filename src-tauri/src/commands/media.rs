use crate::engine::probe;
use crate::engine::thumbnails;
use crate::state::AppState;
use anyhow::Result;
use tauri::AppHandle;

#[tauri::command]
pub async fn import_media(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<serde_json::Value>, String> {
    if paths.is_empty() {
        return Ok(vec![]);
    }

    let mut results = vec![];

    for path in paths {
        // Always try to probe, but NEVER drop the file from the UI.
        // If probe fails (bad file, unsupported codec, permission, etc.), we still add a stub
        // so the user sees the file in the bin and gets feedback.
        let info = match probe::probe_media(&app, &path).await {
            Ok(i) => i,
            Err(e) => {
                eprintln!("[import_media] probe failed for {:?}: {}. Adding stub entry so user sees it.", path, e);
                // Create a minimal stub so it appears in the media bin.
                let fname = std::path::Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.clone());
                crate::engine::probe::MediaInfo {
                    path: path.clone(),
                    file_name: fname,
                    duration_sec: 0.0,
                    width: 0,
                    height: 0,
                    fps: 0.0,
                    has_video: false,
                    has_audio: false,
                    video_codec: None,
                    audio_codec: None,
                    sample_rate: None,
                    channels: None,
                    bit_rate: None,
                    size_bytes: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
                }
            }
        };

        let id = uuid::Uuid::new_v4().to_string();

        let asset_json = serde_json::json!({
            "id": id,
            "path": info.path,
            "name": info.file_name,
            "durationSec": info.duration_sec,
            "width": info.width,
            "height": info.height,
            "fps": info.fps,
            "hasVideo": info.has_video,
            "hasAudio": info.has_audio,
            "thumbnail": null,
        });

        {
            let mut project = state.project.lock().await;
            if !project.media.iter().any(|m| m.path == info.path) {
                project.media.push(crate::engine::timeline::MediaAsset {
                    id: id.clone(),
                    path: info.path,
                    name: info.file_name,
                    duration_sec: info.duration_sec,
                    width: info.width,
                    height: info.height,
                    fps: info.fps,
                    has_video: info.has_video,
                    has_audio: info.has_audio,
                    thumbnail: None,
                });
            }
        }

        results.push(asset_json);

        // Best-effort filmstrip thumbnails in the background (won't block the import).
        let app_clone = app.clone();
        let path_for_thumb = path.clone();
        let dur = if info.duration_sec > 0.0 { Some(info.duration_sec) } else { None };
        tokio::spawn(async move {
            let _ = thumbnails::generate_thumbnails(&app_clone, &path_for_thumb, 10, dur).await;
        });
    }

    Ok(results)
}

#[tauri::command]
pub async fn get_media_thumbnails(
    app: AppHandle,
    path: String,
    count: u32,
    duration: Option<f64>,
) -> Result<Vec<String>, String> {
    thumbnails::generate_thumbnails(&app, &path, count, duration)
        .await
        .map_err(|e| e.to_string())
}

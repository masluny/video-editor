//! Tauri commands. The backend is stateless with respect to the project: the
//! frontend owns the document and passes it in when it needs work done.

use crate::state::AppState;
use crate::{analysis, export, ffmpeg, probe, proxy, thumbs, util, waveform};
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, State};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    ok: bool,
    ffmpeg: Option<String>,
    ffprobe: Option<String>,
    encoders: Vec<String>,
    error: Option<String>,
}

#[tauri::command]
pub async fn ffmpeg_status() -> FfmpegStatus {
    let a = ffmpeg::resolve(ffmpeg::Tool::Ffmpeg).await;
    let b = ffmpeg::resolve(ffmpeg::Tool::Ffprobe).await;
    let encoders = if a.is_ok() { ffmpeg::encoders().await.unwrap_or_default() } else { vec![] };
    let error = a.as_ref().err().or(b.as_ref().err()).map(|e| e.to_string());
    FfmpegStatus {
        ok: a.is_ok() && b.is_ok(),
        ffmpeg: a.ok().map(|p| p.to_string_lossy().into_owned()),
        ffprobe: b.ok().map(|p| p.to_string_lossy().into_owned()),
        encoders,
        error,
    }
}

#[tauri::command]
pub async fn probe_media(paths: Vec<String>) -> Vec<probe::ProbeOutcome> {
    let paths = probe::expand_paths(&paths);
    let sem = Arc::new(tokio::sync::Semaphore::new(6));
    let mut handles = vec![];
    for path in paths {
        let sem = sem.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await;
            match probe::probe(&path).await {
                Ok(info) => probe::ProbeOutcome { path, info: Some(info), error: None },
                Err(e) => probe::ProbeOutcome { path, info: None, error: Some(e.to_string()) },
            }
        }));
    }
    let mut out = vec![];
    for h in handles {
        if let Ok(r) = h.await {
            out.push(r);
        }
    }
    out
}

#[tauri::command]
pub async fn media_thumbnails(app: AppHandle, path: String, duration: f64, count: u32, height: u32) -> CmdResult<Vec<String>> {
    thumbs::thumbnails(&app, &path, duration, count, height).await.map_err(err)
}

#[tauri::command]
pub async fn media_waveform(app: AppHandle, path: String, duration: f64) -> CmdResult<waveform::Waveform> {
    waveform::waveform(&app, &path, duration).await.map_err(err)
}

#[tauri::command]
pub async fn media_proxy(app: AppHandle, state: State<'_, AppState>, path: String, duration: f64, has_video: bool) -> CmdResult<String> {
    let lock = state.proxy_lock(&path);
    let _guard = lock.lock().await;
    proxy::make_proxy(&app, &path, duration, has_video).await.map_err(err)
}

#[tauri::command]
pub async fn detect_silence(path: String, from: f64, to: f64, noise_db: f64, min_silence: f64) -> CmdResult<Vec<[f64; 2]>> {
    analysis::detect_silence(&path, from, to, noise_db, min_silence).await.map_err(err)
}

#[tauri::command]
pub async fn detect_scenes(path: String, from: f64, to: f64, threshold: f64) -> CmdResult<Vec<f64>> {
    analysis::detect_scenes(&path, from, to, threshold).await.map_err(err)
}

#[tauri::command]
pub async fn picture_stats(path: String, from: f64, to: f64) -> CmdResult<analysis::PictureStats> {
    analysis::picture_stats(&path, from, to).await.map_err(err)
}

/// "Clean up voice": a processed copy of `[from, to]` of a file's sound, kept with the app's
/// data (not the cache, which the system may clear) and reused when asked again.
#[tauri::command]
pub async fn clean_voice(app: AppHandle, path: String, from: f64, to: f64) -> CmdResult<String> {
    let run = async {
        let dir = util::data_dir(&app)?.join("processed");
        std::fs::create_dir_all(&dir)?;
        let out = dir.join(format!("{}.m4a", util::media_key(&path, &format!("clean-voice-v1 {from} {to}"))));
        if out.is_file() {
            return Ok(out.to_string_lossy().into_owned());
        }
        let tmp = out.with_extension("part.m4a");
        let bin = ffmpeg::resolve(ffmpeg::Tool::Ffmpeg).await?;
        let args = analysis::clean_voice_args(&path, from, (to - from).max(0.05), &tmp.to_string_lossy());
        if let Err(e) = ffmpeg::run(&bin, &args).await {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
        std::fs::rename(&tmp, &out)?;
        anyhow::Ok(out.to_string_lossy().into_owned())
    };
    run.await.map_err(err)
}

#[tauri::command]
pub async fn export_start(app: AppHandle, request: export::ExportRequest) -> CmdResult<String> {
    export::start(&app, request).await.map_err(err)
}

#[tauri::command]
pub fn export_cancel(app: AppHandle, job_id: String) {
    export::cancel(&app, &job_id);
}

#[tauri::command]
pub async fn read_text_file(path: String) -> CmdResult<String> {
    tokio::fs::read_to_string(&path).await.map_err(|e| format!("Could not read {path}: {e}"))
}

#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> CmdResult<()> {
    util::write_atomic(std::path::Path::new(&path), contents.as_bytes()).map_err(err)
}

#[tauri::command]
pub fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| std::path::Path::new(p).is_file()).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Autosave {
    contents: String,
    /// Milliseconds since the Unix epoch.
    modified: u64,
}

fn autosave_path(app: &AppHandle) -> anyhow::Result<std::path::PathBuf> {
    Ok(util::data_dir(app)?.join("autosave.vproj"))
}

#[tauri::command]
pub fn autosave_write(app: AppHandle, contents: String) -> CmdResult<()> {
    let path = autosave_path(&app).map_err(err)?;
    util::write_atomic(&path, contents.as_bytes()).map_err(err)
}

#[tauri::command]
pub fn autosave_read(app: AppHandle) -> Option<Autosave> {
    let path = autosave_path(&app).ok()?;
    let contents = std::fs::read_to_string(&path).ok()?;
    let modified = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(Autosave { contents, modified })
}

#[tauri::command]
pub fn autosave_clear(app: AppHandle) {
    if let Ok(p) = autosave_path(&app) {
        let _ = std::fs::remove_file(p);
    }
}

/// Lets the webview surface errors in the terminal during development.
#[tauri::command]
pub fn log_frontend(level: String, message: String) {
    eprintln!("[webview:{level}] {message}");
}

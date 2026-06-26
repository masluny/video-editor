//! Export jobs: build the plan, render to a temp file, rename into place.

use crate::ffmpeg::{self, Tool};
use crate::graph::{self, ExportSettings};
use crate::job;
use crate::model::Project;
use crate::state::AppState;
use crate::util;
use anyhow::{anyhow, Context, Result};
use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::watch;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub project: Project,
    pub output: String,
    #[serde(default)]
    pub settings: ExportSettings,
    #[serde(default)]
    pub range: Option<[f64; 2]>,
    /// Pre-rendered title layers: clip id -> PNG (data URL or bare base64).
    #[serde(default)]
    pub titles: HashMap<String, String>,
}

pub async fn start(app: &AppHandle, req: ExportRequest) -> Result<String> {
    let job_id = uuid::Uuid::new_v4().to_string();
    let title_dir = util::cache_dir(app, "export-titles")?.join(&job_id);
    let titles = write_titles(&title_dir, &req.titles)?;

    let output = PathBuf::from(&req.output);
    let ext = output.extension().and_then(|e| e.to_str()).unwrap_or("mp4").to_string();
    let stem = output.file_stem().and_then(|s| s.to_str()).unwrap_or("export").to_string();
    let dir = output.parent().map(Path::to_path_buf).unwrap_or_default();
    if !dir.as_os_str().is_empty() && !dir.is_dir() {
        return Err(anyhow!("The folder {} does not exist.", dir.display()));
    }
    // Render next to the destination, then rename, so a failed or cancelled
    // export never clobbers an existing file.
    let partial = dir.join(format!(".{stem}.revind-part.{ext}"));

    let range = req.range.map(|[a, b]| (a, b));
    let plan = graph::build(&req.project, &req.settings, range, &titles, &partial.to_string_lossy())?;
    let bin = ffmpeg::resolve(Tool::Ffmpeg).await?;

    let (tx, rx) = watch::channel(false);
    app.state::<AppState>().exports.lock().unwrap().insert(job_id.clone(), tx);

    let app = app.clone();
    let id = job_id.clone();
    tokio::spawn(async move {
        let started = Instant::now();
        let total = plan.duration;
        let emit = |payload: serde_json::Value| {
            let _ = app.emit("export-progress", payload);
        };
        emit(json!({ "jobId": id, "status": "running", "progress": 0.0 }));

        let result = job::run_ffmpeg(&bin, &plan.args, rx, |p| {
            let progress = if total > 0.0 { (p.out_time / total * 100.0).clamp(0.0, 99.5) } else { 0.0 };
            let eta = if p.speed > 0.01 { ((total - p.out_time).max(0.0) / p.speed).round() } else { -1.0 };
            emit(json!({
                "jobId": id, "status": "running", "progress": progress,
                "speed": p.speed, "fps": p.fps, "eta": eta,
            }));
        })
        .await;

        let finished = result.and_then(|_| {
            if output.exists() {
                let _ = std::fs::remove_file(&output);
            }
            std::fs::rename(&partial, &output).context("could not move the rendered file into place")
        });
        match finished {
            Ok(()) => emit(json!({
                "jobId": id, "status": "completed", "progress": 100.0, "output": output.to_string_lossy(),
                "elapsed": started.elapsed().as_secs_f64(),
            })),
            Err(e) => {
                let _ = std::fs::remove_file(&partial);
                let cancelled = e.to_string() == "cancelled";
                emit(json!({
                    "jobId": id,
                    "status": if cancelled { "cancelled" } else { "failed" },
                    "error": if cancelled { String::new() } else { e.to_string() },
                }));
            }
        }
        let _ = std::fs::remove_dir_all(&title_dir);
        app.state::<AppState>().exports.lock().unwrap().remove(&id);
    });

    Ok(job_id)
}

pub fn cancel(app: &AppHandle, job_id: &str) {
    if let Some(tx) = app.state::<AppState>().exports.lock().unwrap().get(job_id) {
        let _ = tx.send(true);
    }
}

fn write_titles(dir: &Path, titles: &HashMap<String, String>) -> Result<HashMap<String, PathBuf>> {
    let mut out = HashMap::new();
    if titles.is_empty() {
        return Ok(out);
    }
    std::fs::create_dir_all(dir)?;
    for (i, (clip_id, data)) in titles.iter().enumerate() {
        let b64 = data.split_once("base64,").map(|(_, b)| b).unwrap_or(data);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .with_context(|| format!("title {clip_id} is not valid base64"))?;
        let path = dir.join(format!("title{i}.png"));
        std::fs::write(&path, bytes)?;
        out.insert(clip_id.clone(), path);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Renders an export request captured from the frontend (set REVIND_REQUEST to a
    /// JSON file). Guards the TS <-> Rust contract end to end; skipped when unset.
    #[test]
    fn renders_captured_frontend_request() {
        let Ok(path) = std::env::var("REVIND_REQUEST") else { return };
        let req: ExportRequest = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).expect("request deserializes");
        let dir = std::env::temp_dir().join(format!("revind_req_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let titles = write_titles(&dir.join("titles"), &req.titles).unwrap();
        let out = dir.join(format!("out.{}", Path::new(&req.output).extension().and_then(|e| e.to_str()).unwrap_or("mp4")));
        let plan = graph::build(&req.project, &req.settings, req.range.map(|[a, b]| (a, b)), &titles, out.to_str().unwrap()).unwrap();
        let status = std::process::Command::new("ffmpeg").args(&plan.args).status().unwrap();
        assert!(status.success(), "ffmpeg failed for {:?}", plan.args);
        println!("rendered {} ({:.2}s)", out.display(), plan.duration);
    }
}

use crate::engine::ffmpeg;
use crate::engine::filtergraph;
use crate::engine::timeline::Project;
use anyhow::{Context, Result};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};

pub struct ExportJob {
    pub id: String,
    pub output_path: String,
    pub status: ExportStatus,
    pub progress: f32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

pub async fn start_export(
    app: &AppHandle,
    project: &Project,
    media_map: HashMap<String, String>,
    output_path: &str,
    range_in: Option<f64>,
    range_out: Option<f64>,
) -> Result<String> {
    let ffmpeg_bin = ffmpeg::resolve_ffmpeg(app)?;
    let args = filtergraph::build_export_args(project, &media_map, output_path, range_in, range_out);

    if args.is_empty() {
        return Err(anyhow::anyhow!("nothing to export — project has no clips"));
    }

    // When a range is set, use the range duration for progress tracking
    let total_duration = match (range_in, range_out) {
        (Some(ri), Some(ro)) => (ro - ri).max(0.0),
        (Some(ri), None) => (project.duration() - ri).max(0.0),
        (None, Some(ro)) => ro,
        (None, None) => project.duration(),
    };
    let job_id = uuid::Uuid::new_v4().to_string();

    let app_handle = app.clone();
    let job_id_clone = job_id.clone();

    tokio::spawn(async move {
        let result = run_ffmpeg_export(&app_handle, &ffmpeg_bin, &args, total_duration).await;
        match result {
            Ok(()) => {
                let _ = app_handle.emit("export-progress", serde_json::json!({
                    "jobId": job_id_clone,
                    "status": "completed",
                    "progress": 100,
                }));
            }
            Err(e) => {
                let _ = app_handle.emit("export-progress", serde_json::json!({
                    "jobId": job_id_clone,
                    "status": "failed",
                    "error": e.to_string(),
                }));
            }
        }
    });

    Ok(job_id)
}

pub async fn start_clip_export(
    app: &AppHandle,
    media_path: &str,
    output_path: &str,
    source_in: f64,
    source_out: f64,
) -> Result<String> {
    let ffmpeg_bin = ffmpeg::resolve_ffmpeg(app)?;
    let duration = (source_out - source_in).max(0.0);
    if duration <= 0.0 {
        return Err(anyhow::anyhow!("clip selection is empty"));
    }

    let args = vec![
        "-ss".into(),
        format!("{source_in:.6}"),
        "-t".into(),
        format!("{duration:.6}"),
        "-i".into(),
        media_path.into(),
        "-map".into(),
        "0:v?".into(),
        "-map".into(),
        "0:a?".into(),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-crf".into(),
        "20".into(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-y".into(),
        output_path.into(),
    ];

    let job_id = uuid::Uuid::new_v4().to_string();
    let app_handle = app.clone();
    let job_id_clone = job_id.clone();

    tokio::spawn(async move {
        let result = run_ffmpeg_export(&app_handle, &ffmpeg_bin, &args, duration).await;
        match result {
            Ok(()) => {
                let _ = app_handle.emit("export-progress", serde_json::json!({
                    "jobId": job_id_clone,
                    "status": "completed",
                    "progress": 100,
                }));
            }
            Err(e) => {
                let _ = app_handle.emit("export-progress", serde_json::json!({
                    "jobId": job_id_clone,
                    "status": "failed",
                    "error": e.to_string(),
                }));
            }
        }
    });

    Ok(job_id)
}

async fn run_ffmpeg_export(
    app: &AppHandle,
    ffmpeg_bin: &std::path::Path,
    args: &[String],
    total_duration: f64,
) -> Result<()> {
    let mut child = tokio::process::Command::new(ffmpeg_bin)
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-nostats")
        .arg("-progress")
        .arg("pipe:1")
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("failed to start ffmpeg")?;

    use tokio::io::{AsyncBufReadExt, BufReader};
    let stdout = child.stdout.take().context("no stdout")?;
    let stderr = child.stderr.take().context("no stderr")?;

    let stderr_task = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        let mut out = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if out.len() < 12_000 {
                out.push_str(&line);
                out.push('\n');
            }
        }
        out
    });

    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();
    let mut last_progress = 0.0_f32;

    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(secs) = parse_progress(&line) {
            let secs_f = secs as f64;
            let pct = if total_duration > 0.0 {
                ((secs_f / total_duration) * 100.0).clamp(0.0, 99.0) as f32
            } else {
                secs.min(100.0)
            };
            if pct + 0.25 < last_progress {
                continue;
            }
            last_progress = pct.max(last_progress);
            let _ = app.emit("export-progress", serde_json::json!({
                "status": "running",
                "progress": last_progress,
            }));
        } else if line.trim() == "progress=end" {
            let _ = app.emit("export-progress", serde_json::json!({
                "status": "running",
                "progress": 99,
            }));
        }
    }

    let status = child.wait().await?;
    let stderr_output = stderr_task.await.unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        let detail = stderr_output
            .lines()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        Err(anyhow::anyhow!(
            "ffmpeg exited with code {:?}{}{}",
            status.code(),
            if detail.is_empty() { "" } else { ":\n" },
            detail
        ))
    }
}

fn parse_progress(line: &str) -> Option<f32> {
    if let Some(v) = line.strip_prefix("out_time_ms=") {
        let micros: f32 = v.trim().parse().ok()?;
        return Some(micros / 1_000_000.0);
    }
    if let Some(v) = line.strip_prefix("out_time_us=") {
        let micros: f32 = v.trim().parse().ok()?;
        return Some(micros / 1_000_000.0);
    }
    if let Some(v) = line.strip_prefix("out_time=") {
        return parse_timecode(v.trim());
    }
    if line.starts_with("frame=") || line.starts_with("size=") {
        if let Some(idx) = line.find("time=") {
            let rest = &line[idx + 5..];
            let time_str = rest.split_whitespace().next()?;
            let secs = parse_timecode(time_str)?;
            return Some(secs);
        }
    }
    None
}

fn parse_timecode(tc: &str) -> Option<f32> {
    let parts: Vec<&str> = tc.split(':').collect();
    if parts.len() == 3 {
        let h: f32 = parts[0].parse().ok()?;
        let m: f32 = parts[1].parse().ok()?;
        let s: f32 = parts[2].parse().ok()?;
        Some(h * 3600.0 + m * 60.0 + s)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::parse_progress;

    #[test]
    fn parses_ffmpeg_progress_protocol() {
        assert_eq!(parse_progress("out_time_ms=2500000"), Some(2.5));
        assert_eq!(parse_progress("out_time_us=1250000"), Some(1.25));
        assert_eq!(parse_progress("out_time=00:00:03.50"), Some(3.5));
    }
}

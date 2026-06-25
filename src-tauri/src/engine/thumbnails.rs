use anyhow::{Context, Result};
use tauri::AppHandle;
use tauri::Manager;

use crate::engine::ffmpeg;

/// Generate `count` thumbnails for a media file, evenly spaced across `duration`
/// (when known). Results are cached on disk keyed by the source path, so repeat
/// calls are cheap. Returns absolute paths to the PNG frames.
pub async fn generate_thumbnails(
    app: &AppHandle,
    media_path: &str,
    count: u32,
    duration: Option<f64>,
) -> Result<Vec<String>> {
    let count = count.max(1);
    let cache_dir = app
        .path()
        .app_local_data_dir()
        .context("no app data dir")?
        .join("thumbnails");
    let out_dir = cache_dir.join(hash_path(media_path));
    std::fs::create_dir_all(&out_dir)?;

    // Cache hit: reuse existing frames rather than re-running ffmpeg.
    let existing = collect(&out_dir, count);
    if !existing.is_empty() {
        return Ok(existing);
    }

    let ffmpeg_bin = ffmpeg::resolve_ffmpeg(app)?;
    let pattern_str = out_dir.join("thumb_%04d.png").to_string_lossy().into_owned();

    // One frame every `interval` seconds so the frames span the whole clip.
    let interval = match duration {
        Some(d) if d > 0.5 => (d / count as f64).max(0.1),
        _ => 1.0,
    };
    let vf_filter = format!("fps=1/{interval:.4},scale=160:-1");
    let frames_arg = count.to_string();

    let args: Vec<&str> = vec![
        "-i", media_path,
        "-vf", &vf_filter,
        "-frames:v", &frames_arg,
        "-y",
        &pattern_str,
    ];

    let _ = tokio::process::Command::new(&ffmpeg_bin)
        .args(&args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;

    Ok(collect(&out_dir, count))
}

fn collect(out_dir: &std::path::Path, count: u32) -> Vec<String> {
    let mut thumbs = vec![];
    for i in 1..=count {
        let p = out_dir.join(format!("thumb_{i:04}.png"));
        if p.exists() {
            thumbs.push(p.to_string_lossy().into_owned());
        } else {
            break;
        }
    }
    thumbs
}

fn hash_path(p: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    p.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    fn ffmpeg_available() -> bool {
        Command::new("ffmpeg").arg("-version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    // Validates the ffmpeg thumbnail command (even spacing) against real media,
    // mirroring how generate_thumbnails invokes ffmpeg.
    #[test]
    fn thumbnail_command_extracts_frames() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not available; skipping thumbnail test");
            return;
        }
        let dir = std::env::temp_dir().join(format!("revind_thumb_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("in.mp4");
        let gen = Command::new("ffmpeg")
            .args(["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=8", "-pix_fmt", "yuv420p", input.to_str().unwrap()])
            .output()
            .expect("gen input");
        assert!(gen.status.success());

        let count = 6u32;
        let interval = 8.0 / count as f64;
        let pattern = dir.join("thumb_%04d.png");
        let out = Command::new("ffmpeg")
            .args([
                "-i", input.to_str().unwrap(),
                "-vf", &format!("fps=1/{interval:.4},scale=160:-1"),
                "-frames:v", &count.to_string(),
                "-y", pattern.to_str().unwrap(),
            ])
            .output()
            .expect("thumbs");
        assert!(out.status.success(), "ffmpeg thumbs failed: {}", String::from_utf8_lossy(&out.stderr));

        let made = (1..=count).filter(|i| dir.join(format!("thumb_{i:04}.png")).exists()).count();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(made >= 4, "expected several thumbnails, got {made}");
    }
}

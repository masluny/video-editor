//! Filmstrip / poster thumbnails. Each frame is grabbed with a fast input seek
//! (`-ss` before `-i`), so long files cost the same as short ones. Results are
//! cached on disk keyed by the file's path, size and mtime.

use crate::ffmpeg::{self, Tool};
use crate::util;
use anyhow::Result;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Semaphore;

/// Returns `count` JPEG paths; frame `i` shows source time `(i + 0.5) * duration / count`.
/// Frames that fail to decode are returned as empty strings so indices stay aligned.
pub async fn thumbnails(app: &AppHandle, path: &str, duration: f64, count: u32, height: u32) -> Result<Vec<String>> {
    let count = count.clamp(1, 240);
    let height = height.clamp(32, 720);
    let dir = util::cache_dir(app, "thumbs")?.join(util::media_key(path, &format!("{count}x{height}")));
    let file = |i: u32| dir.join(format!("t{i:03}.jpg"));

    let done_marker = dir.join("done");
    if done_marker.exists() {
        return Ok((0..count).map(|i| existing(file(i))).collect());
    }
    std::fs::create_dir_all(&dir)?;

    let ffmpeg_bin = Arc::new(ffmpeg::resolve(Tool::Ffmpeg).await?);
    let sem = Arc::new(Semaphore::new(4));
    let mut tasks = tokio::task::JoinSet::new();
    for i in 0..count {
        let t = if duration > 0.0 { (i as f64 + 0.5) * duration / count as f64 } else { 0.0 };
        let out = file(i);
        let bin = ffmpeg_bin.clone();
        let sem = sem.clone();
        let src = path.to_string();
        tasks.spawn(async move {
            let _permit = sem.acquire().await;
            let mut args: Vec<String> = vec!["-hide_banner".into(), "-v".into(), "error".into()];
            if t > 0.0 {
                args.extend(["-ss".into(), util::f(t)]);
            }
            args.extend([
                "-i".into(),
                src,
                "-frames:v".into(),
                "1".into(),
                "-an".into(),
                "-vf".into(),
                format!("scale=-2:{height}:flags=bilinear"),
                "-q:v".into(),
                "5".into(),
                "-y".into(),
                out.to_string_lossy().into_owned(),
            ]);
            let _ = ffmpeg::run(&bin, &args).await;
        });
    }
    while tasks.join_next().await.is_some() {}
    let _ = std::fs::write(&done_marker, b"1");
    Ok((0..count).map(|i| existing(file(i))).collect())
}

fn existing(p: PathBuf) -> String {
    if p.is_file() { p.to_string_lossy().into_owned() } else { String::new() }
}

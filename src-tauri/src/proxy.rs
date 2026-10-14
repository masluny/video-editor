//! Preview proxies: lightweight H.264/AAC MP4 copies of media the webview
//! can't decode (MKV, AVI, some HEVC/ProRes variants…). Proxies are used for
//! playback only — export always reads the original file.

use crate::ffmpeg::{self, Tool};
use crate::job;
use crate::util;
use anyhow::Result;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

pub async fn make_proxy(app: &AppHandle, path: &str, duration: f64, has_video: bool) -> Result<String> {
    let out = util::cache_dir(app, "proxies")?.join(format!("{}.mp4", util::media_key(path, "proxy-v1")));
    if out.is_file() {
        return Ok(out.to_string_lossy().into_owned());
    }
    let tmp = out.with_extension("part.mp4");
    let bin = ffmpeg::resolve(Tool::Ffmpeg).await?;

    let mut args: Vec<String> = vec!["-i".into(), path.into(), "-map".into(), "0:a:0?".into()];
    if has_video {
        args.extend([
            "-map".into(),
            "0:v:0".into(),
            "-vf".into(),
            // ≤720p, even dimensions; frequent keyframes so scrubbing is snappy.
            "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p".into(),
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            "24".into(),
            "-g".into(),
            "15".into(),
        ]);
    } else {
        args.extend(["-vn".into()]);
    }
    args.extend([
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "160k".into(),
        "-ac".into(),
        "2".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-f".into(),
        "mp4".into(),
        tmp.to_string_lossy().into_owned(),
    ]);

    let (_tx, rx) = watch::channel(false);
    let app2 = app.clone();
    let src = path.to_string();
    let mut last = -1.0;
    let result = job::run_ffmpeg(&bin, &args, rx, |p| {
        if duration > 0.0 {
            let pct = (p.out_time / duration * 100.0).clamp(0.0, 99.0).floor();
            if pct > last {
                last = pct;
                let _ = app2.emit("proxy-progress", json!({ "path": src, "progress": pct }));
            }
        }
    })
    .await;

    match result {
        Ok(()) => {
            std::fs::rename(&tmp, &out)?;
            let _ = app.emit("proxy-progress", json!({ "path": path, "progress": 100 }));
            Ok(out.to_string_lossy().into_owned())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

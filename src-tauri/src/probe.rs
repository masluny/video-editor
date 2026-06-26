//! Media probing via ffprobe.

use crate::ffmpeg::{self, Tool};
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub name: String,
    /// "video" | "audio" | "image"
    pub kind: &'static str,
    pub duration: f64,
    /// Display size (rotation metadata already applied).
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_video: bool,
    pub has_audio: bool,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub container: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeOutcome {
    pub path: String,
    pub info: Option<MediaInfo>,
    pub error: Option<String>,
}

const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "m4v", "mkv", "webm", "avi", "mts", "m2ts", "ts", "mpg", "mpeg", "wmv", "flv", "3gp",
    "ogv", "mxf", "mp3", "wav", "aac", "m4a", "flac", "ogg", "opus", "aif", "aiff", "wma", "png", "jpg",
    "jpeg", "webp", "bmp", "gif", "tif", "tiff", "heic",
];

/// Expand dropped folders into the media files they contain (two levels deep).
pub fn expand_paths(paths: &[String]) -> Vec<String> {
    fn walk(dir: &Path, depth: u32, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = entries.flatten().map(|e| e.path()).collect();
        entries.sort();
        for p in entries {
            let hidden = p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with('.')).unwrap_or(true);
            if hidden {
                continue;
            }
            if p.is_dir() {
                if depth > 0 {
                    walk(&p, depth - 1, out);
                }
            } else if is_media_file(&p) {
                out.push(p.to_string_lossy().into_owned());
            }
        }
    }
    let mut out = vec![];
    for p in paths {
        let path = Path::new(p);
        if path.is_dir() {
            walk(path, 2, &mut out);
        } else {
            out.push(p.clone());
        }
    }
    out
}

fn is_media_file(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| MEDIA_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

pub async fn probe(path: &str) -> Result<MediaInfo> {
    let meta = std::fs::metadata(path).with_context(|| format!("cannot open {path}"))?;
    if meta.is_dir() {
        return Err(anyhow!("{path} is a folder"));
    }
    let ffprobe = ffmpeg::resolve(Tool::Ffprobe).await?;
    let args: Vec<String> = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let (stdout, _) = ffmpeg::run(&ffprobe, &args)
        .await
        .map_err(|e| anyhow!("not a readable media file ({})", e.to_string().lines().last().unwrap_or("")))?;
    let json: Value = serde_json::from_slice(&stdout).context("unexpected ffprobe output")?;
    parse(path, &json, meta.len())
}

pub fn parse(path: &str, json: &Value, size: u64) -> Result<MediaInfo> {
    let name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.into());
    let format = &json["format"];
    let container = format["format_name"].as_str().unwrap_or("").to_string();
    let empty = vec![];
    let streams = json["streams"].as_array().unwrap_or(&empty);

    let mut video: Option<&Value> = None;
    let mut audio: Option<&Value> = None;
    for s in streams {
        let attached = s["disposition"]["attached_pic"].as_i64().unwrap_or(0) == 1;
        match s["codec_type"].as_str() {
            // Cover art inside an MP3/M4A is a "video" stream — ignore it.
            Some("video") if video.is_none() && !attached => video = Some(s),
            Some("audio") if audio.is_none() => audio = Some(s),
            _ => {}
        }
    }
    if video.is_none() && audio.is_none() {
        return Err(anyhow!("no audio or video streams found"));
    }

    let num = |v: &Value| v.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| v.as_f64());
    let mut duration = num(&format["duration"]).unwrap_or(0.0);
    if duration <= 0.0 {
        duration = [video, audio].iter().flatten().filter_map(|s| num(&s["duration"])).fold(0.0, f64::max);
    }

    let video_codec = video.and_then(|v| v["codec_name"].as_str()).map(String::from);
    let still_codec = matches!(
        video_codec.as_deref(),
        Some("png" | "mjpeg" | "bmp" | "webp" | "tiff" | "jpegxl" | "hevc" | "gif")
    );
    let image_container = container.contains("image2") || container.ends_with("_pipe") || container == "gif";
    let frames = video.and_then(|v| v["nb_frames"].as_str()).and_then(|s| s.parse::<u64>().ok());
    let is_image = video.is_some()
        && audio.is_none()
        && image_container
        && still_codec
        && (frames.map(|n| n <= 1).unwrap_or(true) || duration <= 0.1);

    let (mut width, mut height, mut fps) = (0u32, 0u32, 0.0);
    if let Some(v) = video {
        width = v["width"].as_u64().unwrap_or(0) as u32;
        height = v["height"].as_u64().unwrap_or(0) as u32;
        let rot = rotation(v);
        if (rot.abs() - 90.0).abs() < 1.0 || (rot.abs() - 270.0).abs() < 1.0 {
            std::mem::swap(&mut width, &mut height);
        }
        fps = [v["avg_frame_rate"].as_str(), v["r_frame_rate"].as_str()]
            .into_iter()
            .flatten()
            .map(parse_rate)
            .find(|r| *r >= 1.0 && *r <= 240.0)
            .unwrap_or(0.0);
    }

    let kind = if is_image {
        "image"
    } else if video.is_some() {
        "video"
    } else {
        "audio"
    };
    if kind == "image" {
        duration = 0.0;
    }

    Ok(MediaInfo {
        path: path.to_string(),
        name,
        kind,
        duration,
        width,
        height,
        fps,
        has_video: video.is_some(),
        has_audio: audio.is_some(),
        video_codec,
        audio_codec: audio.and_then(|a| a["codec_name"].as_str()).map(String::from),
        container,
        size,
    })
}

fn rotation(stream: &Value) -> f64 {
    if let Some(list) = stream["side_data_list"].as_array() {
        for sd in list {
            if let Some(r) = sd["rotation"].as_f64().or_else(|| sd["rotation"].as_i64().map(|i| i as f64)) {
                return r;
            }
        }
    }
    stream["tags"]["rotate"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0)
}

fn parse_rate(s: &str) -> f64 {
    match s.split_once('/') {
        Some((n, d)) => {
            let (n, d) = (n.parse::<f64>().unwrap_or(0.0), d.parse::<f64>().unwrap_or(0.0));
            if d > 0.0 { n / d } else { 0.0 }
        }
        None => s.parse().unwrap_or(0.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mp3_with_cover_art_is_audio() {
        let j = json!({
            "format": {"format_name": "mp3", "duration": "12.5"},
            "streams": [
                {"codec_type": "audio", "codec_name": "mp3"},
                {"codec_type": "video", "codec_name": "mjpeg", "width": 500, "height": 500, "disposition": {"attached_pic": 1}}
            ]
        });
        let m = parse("/a/song.mp3", &j, 1).unwrap();
        assert_eq!(m.kind, "audio");
        assert!(!m.has_video && m.has_audio);
        assert_eq!(m.duration, 12.5);
    }

    #[test]
    fn rotated_phone_video_reports_display_size() {
        let j = json!({
            "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "3.0"},
            "streams": [{"codec_type": "video", "codec_name": "hevc", "width": 1920, "height": 1080,
                "avg_frame_rate": "30000/1001", "r_frame_rate": "90000/1",
                "side_data_list": [{"rotation": -90}]}]
        });
        let m = parse("/a/IMG_1.MOV", &j, 1).unwrap();
        assert_eq!((m.width, m.height), (1080, 1920));
        assert!((m.fps - 29.97).abs() < 0.01);
        assert_eq!(m.kind, "video");
    }

    #[test]
    fn png_is_image() {
        let j = json!({
            "format": {"format_name": "png_pipe"},
            "streams": [{"codec_type": "video", "codec_name": "png", "width": 800, "height": 600, "r_frame_rate": "25/1"}]
        });
        let m = parse("/a/b.png", &j, 1).unwrap();
        assert_eq!(m.kind, "image");
        assert_eq!(m.duration, 0.0);
    }
}

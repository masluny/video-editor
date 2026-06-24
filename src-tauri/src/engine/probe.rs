use crate::engine::ffmpeg;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaInfo {
    pub path: String,
    pub file_name: String,
    pub duration_sec: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_video: bool,
    pub has_audio: bool,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    pub bit_rate: Option<u64>,
    pub size_bytes: u64,
}

pub async fn probe_media(app: &AppHandle, path: &str) -> Result<MediaInfo> {
    eprintln!("[probe] probing path: {:?}", path);
    let ffprobe = ffmpeg::resolve_ffprobe(app)?;
    eprintln!("[probe] using ffprobe: {}", ffprobe.display());
    let file_path = Path::new(path);
    let file_name = file_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    let size_bytes = std::fs::metadata(path)
        .map(|m| m.len())
        .unwrap_or(0);

    let args = vec![
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        path,
    ];

    eprintln!("[probe] running: {} {}", ffprobe.display(), args.join(" "));
    let output = ffmpeg::run_capture(&ffprobe, &args).await?;
    eprintln!("[probe] ffprobe stdout len: {}", output.len());
    let val: serde_json::Value = serde_json::from_str(&output)
        .with_context(|| "failed to parse ffprobe output")?;

    let format = &val["format"];
    let duration_sec = format["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .or_else(|| format["duration"].as_f64())
        .unwrap_or(0.0);

    let bit_rate = format["bit_rate"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok());

    static EMPTY_STREAMS: Vec<serde_json::Value> = vec![];
    let streams = val["streams"].as_array().unwrap_or(&EMPTY_STREAMS);

    let mut has_video = false;
    let mut has_audio = false;
    let mut video_codec: Option<String> = None;
    let mut audio_codec: Option<String> = None;
    let mut width: u32 = 0;
    let mut height: u32 = 0;
    let mut fps: f64 = 0.0;
    let mut sample_rate: Option<u32> = None;
    let mut channels: Option<u32> = None;

    for s in streams {
        let codec_type = s["codec_type"].as_str().unwrap_or("");
        match codec_type {
            "video" if !has_video => {
                has_video = true;
                video_codec = s["codec_name"].as_str().map(String::from);
                width = s["width"].as_u64().unwrap_or(0) as u32;
                height = s["height"].as_u64().unwrap_or(0) as u32;

                let r_frame = s["r_frame_rate"].as_str().unwrap_or("0/1");
                fps = parse_fraction(r_frame);
            }
            "audio" if !has_audio => {
                has_audio = true;
                audio_codec = s["codec_name"].as_str().map(String::from);
                sample_rate = s["sample_rate"].as_str().and_then(|v| v.parse::<u32>().ok());
                channels = s["channels"].as_u64().map(|c| c as u32);
            }
            _ => {}
        }
    }

    Ok(MediaInfo {
        path: path.to_string(),
        file_name,
        duration_sec,
        width,
        height,
        fps,
        has_video,
        has_audio,
        video_codec,
        audio_codec,
        sample_rate,
        channels,
        bit_rate,
        size_bytes,
    })
}

fn parse_fraction(s: &str) -> f64 {
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() == 2 {
        let num: f64 = parts[0].parse().unwrap_or(0.0);
        let den: f64 = parts[1].parse().unwrap_or(1.0);
        if den > 0.0 { num / den } else { 0.0 }
    } else {
        s.parse().unwrap_or(0.0)
    }
}

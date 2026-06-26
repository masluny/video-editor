//! Audio waveform peaks for the timeline.

use crate::ffmpeg::{self, Tool};
use crate::util;
use anyhow::{Context, Result};
use serde::Serialize;
use std::process::Stdio;
use tauri::AppHandle;
use tokio::io::AsyncReadExt;

const SAMPLE_RATE: u32 = 8000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Waveform {
    /// Peaks per second of source media.
    pub rate: f64,
    /// Peak amplitude per bucket, 0..=255.
    pub peaks: Vec<u8>,
}

pub async fn waveform(app: &AppHandle, path: &str, duration: f64) -> Result<Waveform> {
    // ~100 peaks/s for normal clips, fewer for very long files (cap ~120k values).
    let rate: f64 = if duration > 0.0 { (120_000.0 / duration).clamp(5.0, 100.0).floor() } else { 50.0 };
    let cache = util::cache_dir(app, "waveforms")?.join(format!("{}.bin", util::media_key(path, &format!("r{rate}"))));
    if let Ok(peaks) = std::fs::read(&cache) {
        return Ok(Waveform { rate, peaks });
    }

    let bin = ffmpeg::resolve(Tool::Ffmpeg).await?;
    let mut child = ffmpeg::command(&bin)
        .args(["-hide_banner", "-v", "error", "-i", path, "-vn", "-sn", "-dn", "-ac", "1", "-ar"])
        .arg(SAMPLE_RATE.to_string())
        .args(["-f", "s16le", "-acodec", "pcm_s16le", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("failed to start ffmpeg")?;
    let mut stdout = child.stdout.take().context("no stdout")?;

    let bucket = (SAMPLE_RATE as f64 / rate).round().max(1.0) as usize;
    let mut peaks: Vec<u8> = Vec::with_capacity((duration * rate) as usize + 16);
    let mut buf = vec![0u8; 64 * 1024];
    let mut carry: Option<u8> = None;
    let (mut n, mut peak) = (0usize, 0i32);
    loop {
        let read = stdout.read(&mut buf).await?;
        if read == 0 {
            break;
        }
        let mut bytes: &[u8] = &buf[..read];
        // A sample may straddle two reads.
        if let Some(lo) = carry.take() {
            push_sample(i16::from_le_bytes([lo, bytes[0]]) as i32, bucket, &mut n, &mut peak, &mut peaks);
            bytes = &bytes[1..];
        }
        let pairs = bytes.chunks_exact(2);
        if let [rem] = pairs.remainder() {
            carry = Some(*rem);
        }
        for p in pairs {
            push_sample(i16::from_le_bytes([p[0], p[1]]) as i32, bucket, &mut n, &mut peak, &mut peaks);
        }
    }
    if n > 0 {
        peaks.push(to_u8(peak));
    }
    let _ = child.wait().await;
    let _ = util::write_atomic(&cache, &peaks);
    Ok(Waveform { rate, peaks })
}

fn push_sample(s: i32, bucket: usize, n: &mut usize, peak: &mut i32, peaks: &mut Vec<u8>) {
    *peak = (*peak).max(s.abs());
    *n += 1;
    if *n >= bucket {
        peaks.push(to_u8(*peak));
        *n = 0;
        *peak = 0;
    }
}

fn to_u8(peak: i32) -> u8 {
    // Gentle curve so quiet material is still visible.
    let v = (peak as f64 / 32768.0).clamp(0.0, 1.0).sqrt();
    (v * 255.0).round() as u8
}

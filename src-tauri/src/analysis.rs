//! Media analysis: silences (for "Remove silences"), shot changes (for "Split at shot
//! changes") and picture statistics (for "Auto colour" and "Match colour").

use crate::ffmpeg::{self, Tool};
use crate::util::f;
use anyhow::{anyhow, Result};
use serde::Serialize;

/// Silent intervals `[start, end]` (source seconds) inside `[from, to]` of a media file.
pub async fn detect_silence(path: &str, from: f64, to: f64, noise_db: f64, min_silence: f64) -> Result<Vec<[f64; 2]>> {
    let bin = ffmpeg::resolve(Tool::Ffmpeg).await?;
    let len = (to - from).max(0.0);
    let args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostats".into(),
        "-ss".into(),
        f(from),
        "-t".into(),
        f(len),
        "-i".into(),
        path.into(),
        "-vn".into(),
        "-af".into(),
        format!("silencedetect=noise={}dB:d={}", f(noise_db.clamp(-90.0, 0.0)), f(min_silence.max(0.05))),
        "-f".into(),
        "null".into(),
        "-".into(),
    ];
    let (_, stderr) = ffmpeg::run(&bin, &args).await?;
    Ok(parse_silences(&stderr, from, len))
}

fn parse_silences(log: &str, offset: f64, len: f64) -> Vec<[f64; 2]> {
    let value_after = |line: &str, key: &str| -> Option<f64> {
        let rest = &line[line.find(key)? + key.len()..];
        rest.split_whitespace().next()?.trim_end_matches('|').parse().ok()
    };
    let mut out = vec![];
    let mut open: Option<f64> = None;
    for line in log.lines() {
        if let Some(s) = value_after(line, "silence_start:") {
            open = Some(s.max(0.0));
        } else if let Some(e) = value_after(line, "silence_end:") {
            let s = open.take().unwrap_or(0.0);
            out.push([offset + s, offset + e.min(len)]);
        }
    }
    if let Some(s) = open {
        out.push([offset + s, offset + len]); // silent until the end
    }
    out.retain(|[s, e]| e > s);
    out
}

/// Shot changes (source seconds, strictly inside `(from, to)`) of a video file. `threshold`
/// is ffmpeg's scdet score (0..100, ~10 for ordinary cuts); lower finds softer changes.
pub async fn detect_scenes(path: &str, from: f64, to: f64, threshold: f64) -> Result<Vec<f64>> {
    let bin = ffmpeg::resolve(Tool::Ffmpeg).await?;
    let len = (to - from).max(0.0);
    let (_, stderr) = ffmpeg::run(&bin, &scene_args(path, from, len, threshold)).await?;
    Ok(parse_scenes(&stderr, from, len))
}

pub fn scene_args(path: &str, from: f64, len: f64, threshold: f64) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-nostats".into(),
        "-ss".into(),
        f(from),
        "-t".into(),
        f(len),
        "-i".into(),
        path.into(),
        "-an".into(),
        "-sn".into(),
        "-dn".into(),
        // Scores barely depend on resolution, and a small picture is far cheaper to compare.
        "-vf".into(),
        format!("scale=192:-2,scdet=threshold={}:sc_pass=1", f(threshold.clamp(1.0, 100.0))),
        "-f".into(),
        "null".into(),
        "-".into(),
    ]
}

fn parse_scenes(log: &str, offset: f64, len: f64) -> Vec<f64> {
    let mut out: Vec<f64> = vec![];
    for line in log.lines() {
        let Some(at) = line.find("lavfi.scd.time:") else { continue };
        let Some(t) = line[at + 15..].split(|c: char| c == ',' || c.is_whitespace()).find(|s| !s.is_empty()).and_then(|s| s.parse::<f64>().ok()) else {
            continue;
        };
        // Ignore a "change" on the very first frames (scdet compares against nothing there).
        if t > 0.05 && t < len - 0.01 && out.last().is_none_or(|&last| offset + t - last > 0.1) {
            out.push(offset + t);
        }
    }
    out
}

/// Tonal range and colourfulness of a stretch of picture: luma at the 10th and 90th
/// percentiles and on average (0..1, video range), and mean chroma (0..1 of full scale).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct PictureStats {
    pub low: f64,
    pub high: f64,
    pub avg: f64,
    pub sat: f64,
}

/// Picture statistics of `[from, to]` of a video (or an image), from a dozen sampled frames.
pub async fn picture_stats(path: &str, from: f64, to: f64) -> Result<PictureStats> {
    let bin = ffmpeg::resolve(Tool::Ffmpeg).await?;
    let (_, stderr) = ffmpeg::run(&bin, &stats_args(path, from, (to - from).max(0.0))).await?;
    parse_stats(&stderr).ok_or_else(|| anyhow!("no frames to measure"))
}

pub fn stats_args(path: &str, from: f64, len: f64) -> Vec<String> {
    // About twelve frames whatever the length (at least one for a still).
    let rate = (12.0 / len.max(0.1)).clamp(0.05, 4.0);
    vec![
        "-hide_banner".into(),
        "-nostats".into(),
        "-ss".into(),
        f(from),
        "-t".into(),
        f(len.max(0.1)),
        "-i".into(),
        path.into(),
        "-an".into(),
        "-sn".into(),
        "-dn".into(),
        "-vf".into(),
        format!("fps={},scale=320:-2,format=yuv420p,signalstats,metadata=mode=print", f(rate)),
        "-f".into(),
        "null".into(),
        "-".into(),
    ]
}

pub(crate) fn parse_stats(log: &str) -> Option<PictureStats> {
    let mut sums = [0.0f64; 4];
    let mut counts = [0usize; 4];
    for line in log.lines() {
        let Some(at) = line.find("lavfi.signalstats.") else { continue };
        let Some((key, value)) = line[at + 18..].split_once('=') else { continue };
        let i = match key {
            "YLOW" => 0,
            "YHIGH" => 1,
            "YAVG" => 2,
            "SATAVG" => 3,
            _ => continue,
        };
        if let Ok(v) = value.trim().parse::<f64>() {
            sums[i] += v;
            counts[i] += 1;
        }
    }
    if counts.contains(&0) {
        return None;
    }
    let mean = |i: usize| sums[i] / counts[i] as f64;
    let luma = |y: f64| ((y - 16.0) / 219.0).clamp(0.0, 1.0);
    Some(PictureStats { low: luma(mean(0)), high: luma(mean(1)), avg: luma(mean(2)), sat: (mean(3) / 128.0).clamp(0.0, 2.0) })
}

#[cfg(test)]
mod tests {
    use super::{parse_scenes, parse_silences, parse_stats};

    #[test]
    fn parses_signalstats_log() {
        let log = "[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YLOW=41\n[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YHIGH=210\n\
                   lavfi.signalstats.YAVG=125\nlavfi.signalstats.SATAVG=64\nlavfi.signalstats.YLOW=43\nlavfi.signalstats.YHIGH=208\n\
                   lavfi.signalstats.YAVG=127\nlavfi.signalstats.SATAVG=64\n";
        let s = parse_stats(log).unwrap();
        assert!((s.low - 26.0 / 219.0).abs() < 1e-9 && (s.high - 193.0 / 219.0).abs() < 1e-9);
        assert!((s.avg - 110.0 / 219.0).abs() < 1e-9 && (s.sat - 0.5).abs() < 1e-9);
        assert!(parse_stats("nothing here").is_none());
    }

    #[test]
    fn parses_scdet_log() {
        let log = "[scdet @ 0x1] lavfi.scd.score: 17.844, lavfi.scd.time: 1.5\n[scdet @ 0x1] lavfi.scd.score: 25.6, lavfi.scd.time: 1.52\nframe=  1\n[scdet @ 0x1] lavfi.scd.score: 30.4, lavfi.scd.time: 5.02\n";
        assert_eq!(parse_scenes(log, 10.0, 8.0), vec![11.5, 15.02]);
        assert!(parse_scenes(log, 0.0, 5.0).iter().all(|&t| t < 5.0));
    }

    #[test]
    fn parses_silencedetect_log() {
        let log = "[silencedetect @ 0x1] silence_start: 1.5\n[silencedetect @ 0x1] silence_end: 2.75 | silence_duration: 1.25\n[silencedetect @ 0x1] silence_start: 9.1\n";
        let s = parse_silences(log, 10.0, 10.0);
        assert_eq!(s, vec![[11.5, 12.75], [19.1, 20.0]]);
    }
}

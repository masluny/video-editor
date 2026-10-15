//! Media analysis: silences (for "Remove silences") and shot changes (for "Split at shot
//! changes").

use crate::ffmpeg::{self, Tool};
use crate::util::f;
use anyhow::Result;

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
        if t > 0.05 && t < len - 0.01 && out.last().map_or(true, |&last| offset + t - last > 0.1) {
            out.push(offset + t);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{parse_scenes, parse_silences};

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

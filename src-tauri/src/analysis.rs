//! Audio analysis used by "Remove silences".

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

#[cfg(test)]
mod tests {
    use super::parse_silences;

    #[test]
    fn parses_silencedetect_log() {
        let log = "[silencedetect @ 0x1] silence_start: 1.5\n[silencedetect @ 0x1] silence_end: 2.75 | silence_duration: 1.25\n[silencedetect @ 0x1] silence_start: 9.1\n";
        let s = parse_silences(log, 10.0, 10.0);
        assert_eq!(s, vec![[11.5, 12.75], [19.1, 20.0]]);
    }
}

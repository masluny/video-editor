//! Long-running ffmpeg jobs (export, proxy) with progress and cancellation.

use crate::ffmpeg;
use anyhow::{anyhow, Context, Result};
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::watch;

#[derive(Debug, Clone, Copy, Default)]
pub struct Progress {
    /// Seconds of output written so far.
    pub out_time: f64,
    /// Encoding speed relative to realtime (e.g. 2.5 = 2.5x).
    pub speed: f64,
    pub fps: f64,
}

/// Runs ffmpeg with `-progress pipe:1`, reporting progress through `on_progress`.
/// Flipping `cancel` to `true` kills the process and returns `Err("cancelled")`.
pub async fn run_ffmpeg<F: FnMut(Progress)>(
    bin: &Path,
    args: &[String],
    mut cancel: watch::Receiver<bool>,
    mut on_progress: F,
) -> Result<()> {
    let mut child = ffmpeg::command(bin)
        .args(["-hide_banner", "-nostdin", "-nostats", "-progress", "pipe:1", "-y"])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("failed to start ffmpeg")?;

    let stdout = child.stdout.take().context("no stdout")?;
    let mut stderr = child.stderr.take().context("no stderr")?;
    // Keep only the tail of stderr; ffmpeg can be very chatty on long renders.
    let stderr_task = tokio::spawn(async move {
        let mut tail: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        while let Ok(n) = stderr.read(&mut buf).await {
            if n == 0 {
                break;
            }
            tail.extend_from_slice(&buf[..n]);
            if tail.len() > 64 * 1024 {
                tail.drain(..tail.len() - 32 * 1024);
            }
        }
        String::from_utf8_lossy(&tail).into_owned()
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut p = Progress::default();
    let mut cancel_open = true;
    loop {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        let line = line.trim();
                        if let Some(v) = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms=")) {
                            if let Ok(us) = v.parse::<f64>() { p.out_time = (us / 1e6).max(0.0); }
                        } else if let Some(v) = line.strip_prefix("speed=") {
                            p.speed = v.trim_end_matches('x').trim().parse().unwrap_or(p.speed);
                        } else if let Some(v) = line.strip_prefix("fps=") {
                            p.fps = v.parse().unwrap_or(p.fps);
                        } else if line.starts_with("progress=") {
                            on_progress(p);
                        }
                    }
                    _ => break,
                }
            }
            changed = cancel.changed(), if cancel_open => {
                match changed {
                    Ok(()) if *cancel.borrow() => {
                        let _ = child.kill().await;
                        return Err(anyhow!("cancelled"));
                    }
                    Ok(()) => {}
                    Err(_) => cancel_open = false, // sender gone: can no longer be cancelled
                }
            }
        }
    }

    let status = child.wait().await?;
    let stderr_text = stderr_task.await.unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        let detail = ffmpeg::last_lines(&stderr_text, 8);
        Err(anyhow!(
            "ffmpeg failed (exit {}){}",
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into()),
            if detail.is_empty() { String::new() } else { format!(":\n{detail}") }
        ))
    }
}

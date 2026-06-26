//! Locating and running ffmpeg / ffprobe.
//!
//! Every candidate binary is *validated* (`-version` must succeed) before it is
//! used. This matters: a sidecar copied from a package manager can be
//! dynamically linked against libraries that later disappear, and blindly
//! picking it makes every probe/export fail.

use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Tool {
    Ffmpeg,
    Ffprobe,
}

impl Tool {
    fn name(self) -> &'static str {
        match self {
            Tool::Ffmpeg => "ffmpeg",
            Tool::Ffprobe => "ffprobe",
        }
    }
    fn env_vars(self) -> [&'static str; 2] {
        match self {
            Tool::Ffmpeg => ["REVIND_FFMPEG", "VEDIT_FFMPEG_PATH"],
            Tool::Ffprobe => ["REVIND_FFPROBE", "VEDIT_FFPROBE_PATH"],
        }
    }
}

static CACHE: Mutex<Vec<(Tool, PathBuf)>> = Mutex::new(Vec::new());

const EXE: &str = if cfg!(windows) { ".exe" } else { "" };

fn target_triple() -> &'static str {
    match (std::env::consts::ARCH, std::env::consts::OS) {
        ("aarch64", "macos") => "aarch64-apple-darwin",
        ("x86_64", "macos") => "x86_64-apple-darwin",
        ("x86_64", "windows") => "x86_64-pc-windows-msvc",
        ("aarch64", "windows") => "aarch64-pc-windows-msvc",
        ("x86_64", "linux") => "x86_64-unknown-linux-gnu",
        ("aarch64", "linux") => "aarch64-unknown-linux-gnu",
        _ => "unknown",
    }
}

fn candidates(tool: Tool) -> Vec<PathBuf> {
    let name = tool.name();
    let mut out: Vec<PathBuf> = vec![];

    for var in tool.env_vars() {
        if let Ok(p) = std::env::var(var) {
            if !p.is_empty() {
                out.push(PathBuf::from(p));
            }
        }
    }

    // Bundled sidecar: Tauri places externalBin next to the main executable
    // (suffix stripped in bundles, triple-suffixed in some dev layouts).
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        out.push(dir.join(format!("{name}{EXE}")));
        out.push(dir.join(format!("{name}-{}{EXE}", target_triple())));
        // macOS bundle: Contents/MacOS/<exe> -> Contents/Resources
        out.push(dir.join("..").join("Resources").join(format!("{name}{EXE}")));
    }

    // PATH (GUI apps on macOS get a minimal PATH, hence the fixed list below).
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            out.push(dir.join(format!("{name}{EXE}")));
        }
    }

    let fixed: &[&str] = if cfg!(windows) {
        &["C:\\ffmpeg\\bin", "C:\\Program Files\\ffmpeg\\bin", "C:\\ProgramData\\chocolatey\\bin"]
    } else {
        &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/snap/bin", "/opt/local/bin"]
    };
    for dir in fixed {
        out.push(PathBuf::from(dir).join(format!("{name}{EXE}")));
    }

    let mut seen = std::collections::HashSet::new();
    out.retain(|p| seen.insert(p.clone()));
    out
}

async fn validate(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let mut cmd = command(path);
    cmd.arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).stdin(Stdio::null());
    match tokio::time::timeout(Duration::from_secs(8), cmd.status()).await {
        Ok(Ok(status)) => status.success(),
        _ => false,
    }
}

/// Resolve a working binary. Successful lookups are cached for the session;
/// failures are not, so installing ffmpeg while the app runs just works.
pub async fn resolve(tool: Tool) -> Result<PathBuf> {
    if let Some((_, p)) = CACHE.lock().unwrap().iter().find(|(t, _)| *t == tool) {
        return Ok(p.clone());
    }
    for candidate in candidates(tool) {
        if validate(&candidate).await {
            eprintln!("[revind] using {} at {}", tool.name(), candidate.display());
            CACHE.lock().unwrap().push((tool, candidate.clone()));
            return Ok(candidate);
        }
    }
    Err(anyhow!(
        "{} was not found. Install FFmpeg (macOS: `brew install ffmpeg`, Windows: `winget install ffmpeg`, Linux: your package manager) and try again.",
        tool.name()
    ))
}

/// A tokio command that never flashes a console window on Windows.
pub fn command(bin: &Path) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut cmd = tokio::process::Command::new(bin);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.kill_on_drop(true);
    cmd
}

/// Run a binary to completion, returning (stdout, stderr). Errors on non-zero exit.
pub async fn run(bin: &Path, args: &[String]) -> Result<(Vec<u8>, String)> {
    let output = command(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .with_context(|| format!("failed to start {}", bin.display()))?;
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        return Err(anyhow!("{}", last_lines(&stderr, 6)));
    }
    Ok((output.stdout, stderr))
}

pub fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// Which optional encoders this ffmpeg build offers (drives the export dialog).
pub async fn encoders() -> Result<Vec<String>> {
    let bin = resolve(Tool::Ffmpeg).await?;
    let (out, _) = run(&bin, &["-hide_banner".into(), "-encoders".into()]).await?;
    let text = String::from_utf8_lossy(&out);
    let wanted = [
        "libx264", "libx265", "h264_videotoolbox", "hevc_videotoolbox", "h264_nvenc", "hevc_nvenc",
        "h264_qsv", "h264_amf", "prores_ks", "libvpx-vp9", "libopus", "libmp3lame", "aac", "gif",
    ];
    Ok(wanted
        .iter()
        .filter(|w| text.lines().any(|l| l.split_whitespace().nth(1) == Some(**w)))
        .map(|s| s.to_string())
        .collect())
}

use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri::Manager;

/// Resolve the ffmpeg binary path.
/// Order: env override -> bundled sidecar -> system PATH.
pub fn resolve_ffmpeg(app: &AppHandle) -> Result<PathBuf> {
    resolve_bin(app, "VEDIT_FFMPEG_PATH", "ffmpeg")
}

/// Resolve the ffprobe binary path.
pub fn resolve_ffprobe(app: &AppHandle) -> Result<PathBuf> {
    resolve_bin(app, "VEDIT_FFPROBE_PATH", "ffprobe")
}

fn resolve_bin(app: &AppHandle, env_var: &str, name: &str) -> Result<PathBuf> {
    if let Ok(p) = std::env::var(env_var) {
        let path = PathBuf::from(p);
        if path.exists() {
            eprintln!("[ffmpeg-resolve] using env {} = {}", env_var, path.display());
            return Ok(path);
        }
    }

    // 0. DEV: exact symlinks user created + common places (must work in tauri dev)
    if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").unwrap_or_default();
        let triple = "aarch64-apple-darwin";
        let candidates: Vec<PathBuf> = vec![
            // exact dev symlinks in the layout the user set up
            PathBuf::from(format!("{}/video-editor/src-tauri/binaries/{}-{}", home, name, triple)),
            PathBuf::from("src-tauri/binaries").join(format!("{}-{}", name, triple)),
            PathBuf::from("binaries").join(format!("{}-{}", name, triple)),
            // from exe parent (tauri dev often runs from target/debug)
            std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(format!("{}-{}", name, triple)))).unwrap_or_default(),
            std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("..").join("..").join("src-tauri").join("binaries").join(format!("{}-{}", name, triple)))).unwrap_or_default(),
            // absolute homebrew
            PathBuf::from(format!("/opt/homebrew/bin/{}", name)),
            PathBuf::from(format!("/opt/homebrew/opt/ffmpeg/bin/{}", name)),
        ];
        for c in candidates {
            if !c.as_os_str().is_empty() && c.exists() {
                eprintln!("[ffmpeg-resolve] using dev symlink/candidate {}", c.display());
                return Ok(c);
            }
        }
    }

    // 1. Try sidecar (dev + bundled)
    if let Some(side) = sidecar_path(app, name) {
        if side.exists() {
            eprintln!("[ffmpeg-resolve] using sidecar {}", side.display());
            return Ok(side);
        }
    }

    // 2. Search well known locations
    if let Some(found) = search_common_locations(name) {
        eprintln!("[ffmpeg-resolve] using common location {}", found.display());
        return Ok(found);
    }

    // 3. PATH
    if let Some(found) = find_in_path(name) {
        eprintln!("[ffmpeg-resolve] using PATH {}", found.display());
        return Ok(found);
    }

    // 4. Last resort macOS
    if cfg!(target_os = "macos") {
        for c in [
            PathBuf::from(format!("/opt/homebrew/bin/{}", name)),
            PathBuf::from(format!("/usr/local/bin/{}", name)),
        ] {
            if c.exists() {
                eprintln!("[ffmpeg-resolve] LAST RESORT {}", c.display());
                return Ok(c);
            }
        }
    }

    let msg = format!(
        "{name} not found. Please run: brew install ffmpeg  (or put the binary in src-tauri/binaries/{name}-aarch64-apple-darwin)"
    );
    eprintln!("[ffmpeg-resolve] FATAL: {}", msg);
    Err(anyhow!(msg))
}

/// Bundled sidecar path. Tauri stores externalBin next to the main executable
/// with a target-triple suffix, e.g. `ffmpeg-aarch64-apple-darwin`.
fn sidecar_path(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let triple = target_triple();
    let candidates = [
        app.path().app_local_data_dir().ok(),
        app.path().resource_dir().ok(),
        std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)),
    ];
    for dir in candidates.into_iter().flatten() {
        let p = dir.join(format!("{name}-{triple}"));
        if p.exists() {
            return Some(p);
        }
        // Also accept unsuffixed name (dev convenience).
        let p2 = dir.join(name);
        if p2.exists() {
            return Some(p2);
        }
    }
    None
}

fn target_triple() -> String {
    let arch = std::env::consts::ARCH;
    let os = std::env::consts::OS;
    match (arch, os) {
        ("aarch64", "macos") => "aarch64-apple-darwin".into(),
        ("x86_64", "macos") => "x86_64-apple-darwin".into(),
        ("x86_64", "windows") => "x86_64-pc-windows-msvc".into(),
        ("aarch64", "windows") => "aarch64-pc-windows-msvc".into(),
        ("x86_64", "linux") => "x86_64-unknown-linux-gnu".into(),
        ("aarch64", "linux") => "aarch64-unknown-linux-gnu".into(),
        _ => format!("{arch}-{os}"),
    }
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    let exe_ext = if cfg!(windows) { ".exe" } else { "" };
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(format!("{name}{exe_ext}"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Search well-known locations (important on macOS where GUI apps have limited PATH).
fn search_common_locations(name: &str) -> Option<PathBuf> {
    let exe_ext = if cfg!(windows) { ".exe" } else { "" };
    let triple = target_triple();
    let mut candidates: Vec<PathBuf> = if cfg!(windows) {
        vec![
            PathBuf::from(format!("C:\\ffmpeg\\bin\\{}{}", name, exe_ext)),
            PathBuf::from(format!("C:\\Program Files\\ffmpeg\\bin\\{}{}", name, exe_ext)),
            PathBuf::from(format!("C:\\Program Files (x86)\\ffmpeg\\bin\\{}{}", name, exe_ext)),
        ]
    } else {
        vec![
            PathBuf::from(format!("/opt/homebrew/bin/{}{}", name, exe_ext)),
            PathBuf::from(format!("/opt/homebrew/opt/ffmpeg/bin/{}{}", name, exe_ext)),
            PathBuf::from(format!("/usr/local/bin/{}{}", name, exe_ext)),
            PathBuf::from(format!("/usr/bin/{}{}", name, exe_ext)),
            PathBuf::from(format!("/bin/{}{}", name, exe_ext)),
        ]
    };

    // Search relative to the running exe (for bundled apps and some dev cases)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(format!("{}-{}", name, triple)));
            candidates.push(dir.join(format!("{}{}", name, exe_ext)));
            candidates.push(dir.join("binaries").join(format!("{}-{}", name, triple)));
            candidates.push(dir.join("binaries").join(format!("{}{}", name, exe_ext)));
            // Sometimes tauri puts them one level up in dev
            if let Some(parent) = dir.parent() {
                candidates.push(parent.join("binaries").join(format!("{}-{}", name, triple)));
            }
        }
    }

    // Dev convenience: walk up from current_dir looking for src-tauri/binaries
    if let Ok(start) = std::env::current_dir() {
        let mut p = Some(start);
        for _ in 0..8 {
            if let Some(cur) = p.take() {
                // direct src-tauri/binaries next to us
                candidates.push(cur.join("src-tauri").join("binaries").join(format!("{}-{}", name, triple)));
                candidates.push(cur.join("src-tauri").join("binaries").join(format!("{}{}", name, exe_ext)));
                // also check if we are already inside the crate dir
                candidates.push(cur.join("binaries").join(format!("{}-{}", name, triple)));
                candidates.push(cur.join("binaries").join(format!("{}{}", name, exe_ext)));
                p = cur.parent().map(|x| x.to_path_buf());
            } else {
                break;
            }
        }
    }

    // Also check a few fixed dev locations relative to common checkout
    let home = std::env::var("HOME").unwrap_or_default();
    candidates.push(PathBuf::from(&home).join("video-editor").join("src-tauri").join("binaries").join(format!("{}-{}", name, triple)));

    for pb in candidates {
        if pb.is_file() {
            return Some(pb);
        }
    }
    None
}

/// Run a binary capturing stdout (decoded as UTF-8).
pub async fn run_capture(path: &Path, args: &[&str]) -> Result<String> {
    let output = tokio::process::Command::new(path)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .with_context(|| format!("failed to execute {}", path.display()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("{} failed: {err}", path.display()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

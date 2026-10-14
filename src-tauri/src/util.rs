use anyhow::{Context, Result};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// `<app cache dir>/<sub>`, created on demand.
pub fn cache_dir(app: &AppHandle, sub: &str) -> Result<PathBuf> {
    let dir = app.path().app_cache_dir().context("no cache directory")?.join(sub);
    std::fs::create_dir_all(&dir).with_context(|| format!("cannot create {}", dir.display()))?;
    Ok(dir)
}

pub fn data_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_local_data_dir().context("no data directory")?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Stable-ish cache key for a media file: path + size + mtime, so replacing a
/// file at the same path invalidates derived data (thumbnails, waveforms, proxies).
pub fn media_key(path: &str, extra: &str) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    extra.hash(&mut h);
    if let Ok(meta) = std::fs::metadata(path) {
        meta.len().hash(&mut h);
        if let Ok(m) = meta.modified() {
            if let Ok(d) = m.duration_since(std::time::UNIX_EPOCH) {
                d.as_secs().hash(&mut h);
            }
        }
    }
    format!("{:016x}", h.finish())
}

/// Write via a temp file + rename so a crash never leaves a half-written file.
pub fn write_atomic(path: &Path, contents: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    std::fs::write(&tmp, contents).with_context(|| format!("cannot write {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("cannot write {}", path.display()))?;
    Ok(())
}

/// Format a float for an ffmpeg argument/filter (fixed precision, no exponent).
pub fn f(v: f64) -> String {
    let v = if v.is_finite() { v } else { 0.0 };
    let s = format!("{v:.6}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-0" { "0".into() } else { s.to_string() }
}

#[cfg(test)]
mod tests {
    use super::f;

    #[test]
    fn formats_numbers_compactly() {
        assert_eq!(f(1.0), "1");
        assert_eq!(f(0.5), "0.5");
        assert_eq!(f(-0.0), "0");
        assert_eq!(f(1.0 / 3.0), "0.333333");
        assert_eq!(f(f64::NAN), "0");
        assert_eq!(f(1e-9), "0");
    }
}

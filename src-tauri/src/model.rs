//! Project data model (v2). Mirrors `src/lib/types.ts`. Every field has a
//! serde default so a partially-filled payload from the frontend never fails
//! to deserialize — the frontend owns validation and migration.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Project {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub settings: ProjectSettings,
    pub media: Vec<MediaAsset>,
    pub tracks: Vec<Track>,
}

impl Default for Project {
    fn default() -> Self {
        Self {
            version: 2,
            id: String::new(),
            name: "Untitled".into(),
            settings: ProjectSettings::default(),
            media: vec![],
            tracks: vec![],
        }
    }
}

impl Project {
    /// End time of the last clip on any track.
    pub fn duration(&self) -> f64 {
        self.tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .map(|c| c.end())
            .fold(0.0, f64::max)
    }

    pub fn media(&self, id: &str) -> Option<&MediaAsset> {
        self.media.iter().find(|m| m.id == id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectSettings {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub sample_rate: u32,
    pub background: String,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self { width: 1920, height: 1080, fps: 30.0, sample_rate: 48000, background: "#000000".into() }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    #[default]
    Video,
    Audio,
    Image,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MediaAsset {
    pub id: String,
    pub path: String,
    pub name: String,
    pub kind: MediaKind,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_video: bool,
    pub has_audio: bool,
}

impl Default for MediaAsset {
    fn default() -> Self {
        Self {
            id: String::new(),
            path: String::new(),
            name: String::new(),
            kind: MediaKind::Video,
            duration: 0.0,
            width: 0,
            height: 0,
            fps: 0.0,
            has_video: false,
            has_audio: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    #[default]
    Video,
    Audio,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Track {
    pub id: String,
    pub kind: TrackKind,
    pub name: String,
    pub clips: Vec<Clip>,
    pub muted: bool,
    pub solo: bool,
    pub locked: bool,
    pub hidden: bool,
    pub volume: f64,
}

impl Default for Track {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: TrackKind::Video,
            name: String::new(),
            clips: vec![],
            muted: false,
            solo: false,
            locked: false,
            hidden: false,
            volume: 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ClipKind {
    #[default]
    Media,
    Title,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Clip {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ClipKind,
    pub media_id: Option<String>,
    /// Timeline position (seconds).
    pub start: f64,
    /// Source in/out (seconds of media time). For titles and stills `out - in`
    /// is simply the clip length.
    #[serde(rename = "in")]
    pub source_in: f64,
    #[serde(rename = "out")]
    pub source_out: f64,
    pub speed: f64,
    pub volume: f64,
    pub muted: bool,
    pub opacity: f64,
    pub transform: Transform,
    pub crop: Crop,
    pub color: ColorAdjust,
    pub fade_in: f64,
    pub fade_out: f64,
    /// Cross-dissolve (seconds) from the clip that ends where this one starts.
    pub transition_in: f64,
    /// Zoom / pan across the clip (src/lib/motion.ts).
    pub motion: Option<Motion>,
    /// Volume envelope in source time (src/lib/envelope.ts).
    pub volume_points: Vec<VolumePoint>,
    /// Position / scale / rotation / opacity over time, on the clip clock (src/lib/keyframes.ts).
    pub keyframes: Keyframes,
    /// Keyed values ease in and out of each key (smoothstep) instead of moving linearly.
    pub key_ease: bool,
    /// What fills the frame behind the clip.
    pub backdrop: Option<Backdrop>,
    /// Rounded corners: radius as a fraction of the visible picture's short side.
    pub corners: f64,
    /// Frame hold: the source frame at `in` for the clip's whole length, silent.
    pub freeze: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Backdrop {
    /// A blurred, frame-filling copy of the clip.
    Blur,
}

impl Default for Clip {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: ClipKind::Media,
            media_id: None,
            start: 0.0,
            source_in: 0.0,
            source_out: 0.0,
            speed: 1.0,
            volume: 1.0,
            muted: false,
            opacity: 1.0,
            transform: Transform::default(),
            crop: Crop::default(),
            color: ColorAdjust::default(),
            fade_in: 0.0,
            fade_out: 0.0,
            transition_in: 0.0,
            motion: None,
            volume_points: vec![],
            keyframes: Keyframes::default(),
            key_ease: false,
            backdrop: None,
            corners: 0.0,
            freeze: false,
        }
    }
}

impl Clip {
    pub fn speed(&self) -> f64 {
        if self.speed.is_finite() && self.speed > 0.0 { self.speed } else { 1.0 }
    }

    /// Length on the timeline (seconds).
    pub fn duration(&self) -> f64 {
        ((self.source_out - self.source_in) / self.speed()).max(0.0)
    }

    pub fn end(&self) -> f64 {
        self.start + self.duration()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    #[default]
    Contain,
    Cover,
    Stretch,
}

/// A gain at a source (media) time; linear in between, held outside.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(default)]
pub struct VolumePoint {
    pub t: f64,
    pub gain: f64,
}

impl Default for VolumePoint {
    fn default() -> Self {
        Self { t: 0.0, gain: 1.0 }
    }
}

/// A keyed value on the clip clock (`in + local * speed`); linear in between, held outside.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Key {
    pub t: f64,
    pub v: f64,
}

/// Keyed properties of a clip; an empty list means the static value applies.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Keyframes {
    pub x: Vec<Key>,
    pub y: Vec<Key>,
    pub scale: Vec<Key>,
    pub rotation: Vec<Key>,
    pub opacity: Vec<Key>,
}

/// One end of a clip's motion: multiplies its scale and offsets it (project pixels).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MotionPoint {
    pub scale: f64,
    pub x: f64,
    pub y: f64,
}

impl Default for MotionPoint {
    fn default() -> Self {
        Self { scale: 1.0, x: 0.0, y: 0.0 }
    }
}

/// Glide from `from` to `to`: over the clip's length, or its first `duration` seconds
/// (an entrance), linearly or easing out.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Motion {
    pub from: MotionPoint,
    pub to: MotionPoint,
    /// Seconds from the clip's start; 0 = the whole clip.
    pub duration: f64,
    pub ease_out: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Transform {
    /// Offset of the layer centre from the frame centre, in project pixels.
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    /// Degrees, clockwise.
    pub rotation: f64,
    pub fit: Fit,
    pub flip_h: bool,
    pub flip_v: bool,
}

impl Default for Transform {
    fn default() -> Self {
        Self { x: 0.0, y: 0.0, scale: 1.0, rotation: 0.0, fit: Fit::Contain, flip_h: false, flip_v: false }
    }
}

/// Fractions (0..1) of the layer removed from each edge.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Crop {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

impl Crop {
    pub fn is_active(&self) -> bool {
        self.top > 1e-4 || self.right > 1e-4 || self.bottom > 1e-4 || self.left > 1e-4
    }
}

/// Mirrors the CSS filter chain used by the preview:
/// `brightness() contrast() saturate() sepia() hue-rotate() blur()`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ColorAdjust {
    pub brightness: f64,
    pub contrast: f64,
    pub saturation: f64,
    pub sepia: f64,
    pub hue: f64,
    pub blur: f64,
}

impl Default for ColorAdjust {
    fn default() -> Self {
        Self { brightness: 1.0, contrast: 1.0, saturation: 1.0, sepia: 0.0, hue: 0.0, blur: 0.0 }
    }
}

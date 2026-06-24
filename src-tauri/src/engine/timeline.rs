use serde::{Deserialize, Serialize};

pub type Id = String;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: Id,
    pub version: u32,
    pub name: String,
    pub fps: f64,
    pub width: u32,
    pub height: u32,
    pub sample_rate: u32,
    pub tracks: Vec<Track>,
    pub media: Vec<MediaAsset>,
}

impl Default for Project {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            version: 1,
            name: "Untitled Project".into(),
            fps: 30.0,
            width: 1920,
            height: 1080,
            sample_rate: 48000,
            tracks: vec![
                Track::new(TrackKind::Video, "V1".into()),
                Track::new(TrackKind::Audio, "A1".into()),
            ],
            media: vec![],
        }
    }
}

impl Project {
    pub fn duration(&self) -> f64 {
        self.tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .map(|c| c.timeline_start + (c.source_out - c.source_in) / c.speed as f64)
            .fold(0.0_f64, |a, b| a.max(b))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: Id,
    pub path: String,
    pub name: String,
    pub duration_sec: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_video: bool,
    pub has_audio: bool,
    pub thumbnail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: Id,
    pub kind: TrackKind,
    pub name: String,
    pub clips: Vec<Clip>,
    pub locked: bool,
    pub muted: bool,
    pub solo: bool,
    pub volume: f32,
}

impl Track {
    pub fn new(kind: TrackKind, name: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            name,
            clips: vec![],
            locked: false,
            muted: false,
            solo: false,
            volume: 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Video,
    Audio,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Clip {
    pub id: Id,
    pub media_id: Id,
    pub source_in: f64,
    pub source_out: f64,
    pub timeline_start: f64,
    pub speed: f32,
    pub volume: f32,
    pub muted: bool,
    pub opacity: f32,
    pub transform: Transform,
    pub color: ColorGrade,
    pub fade_in: Option<f64>,
    pub fade_out: Option<f64>,
    pub transition_in: Option<Transition>,
    pub transition_out: Option<Transition>,
    pub text: Option<TextOverlay>,
    pub keyframes: Vec<Keyframe>,
}

impl Clip {
    pub fn new(media_id: Id) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            media_id,
            source_in: 0.0,
            source_out: 0.0,
            timeline_start: 0.0,
            speed: 1.0,
            volume: 1.0,
            muted: false,
            opacity: 1.0,
            transform: Transform::default(),
            color: ColorGrade::default(),
            fade_in: None,
            fade_out: None,
            transition_in: None,
            transition_out: None,
            text: None,
            keyframes: vec![],
        }
    }

    pub fn duration(&self) -> f64 {
        if self.speed <= 0.0 {
            return 0.0;
        }
        (self.source_out - self.source_in) / self.speed as f64
    }

    pub fn timeline_end(&self) -> f64 {
        self.timeline_start + self.duration()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transform {
    pub x: f32,
    pub y: f32,
    pub scale: f32,
    pub rotation: f32,
}

impl Default for Transform {
    fn default() -> Self {
        Self { x: 0.0, y: 0.0, scale: 1.0, rotation: 0.0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColorGrade {
    #[serde(default)]
    pub brightness: f32,
    #[serde(default = "default_contrast")]
    pub contrast: f32,
    #[serde(default = "default_saturation")]
    pub saturation: f32,
    #[serde(default = "default_gamma")]
    pub gamma: f32,
    #[serde(default)]
    pub hue: f32,
    #[serde(default)]
    pub blur: f32,
}

impl Default for ColorGrade {
    fn default() -> Self {
        Self { brightness: 0.0, contrast: 1.0, saturation: 1.0, gamma: 1.0, hue: 0.0, blur: 0.0 }
    }
}

fn default_contrast() -> f32 { 1.0 }
fn default_saturation() -> f32 { 1.0 }
fn default_gamma() -> f32 { 1.0 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transition {
    pub kind: TransitionKind,
    pub duration: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransitionKind {
    Crossfade,
    Cut,
    FadeBlack,
    FadeWhite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextOverlay {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub font_size: f32,
    pub color: String,
    pub font_family: String,
    pub bold: bool,
    pub italic: bool,
}

impl Default for TextOverlay {
    fn default() -> Self {
        Self {
            text: String::new(),
            x: 0.0,
            y: 0.0,
            font_size: 48.0,
            color: "#ffffff".into(),
            font_family: "sans-serif".into(),
            bold: false,
            italic: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Keyframe {
    pub time: f64,
    pub property: KeyframeProperty,
    pub value: f32,
    pub easing: Easing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyframeProperty {
    Opacity,
    Scale,
    PositionX,
    PositionY,
    Rotation,
    Volume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Easing {
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
}

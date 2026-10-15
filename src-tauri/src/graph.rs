//! Builds the ffmpeg command line for an export.
//!
//! Composition model (identical to the preview):
//! * a background colour canvas at the output size;
//! * every visible clip of every video track becomes a *layer*, stacked V1 (bottom)
//!   to Vn (top): fit into the frame (contain / cover / stretch), cropped, colour
//!   adjusted, scaled, rotated, faded (alpha) and offset to its timeline position,
//!   then `overlay`ed onto the canvas;
//! * every audible clip contributes an audio stream that is time-stretched,
//!   gain-adjusted, faded and delayed to its timeline position, then mixed;
//! * a cross-dissolve (`transition_in`) is centred on a cut: the incoming layer starts
//!   half the dissolve early holding its first frame and fades in, the outgoing layer
//!   runs on holding its last frame underneath, and the sound dips across the cut.
//!   Mirrors `src/lib/transitions.ts`;
//! * motion (Ken Burns) rescales the finished layer every frame and moves it in the
//!   overlay, both linear in the progress through the clip (`src/lib/motion.ts`);
//! * a volume envelope (source-time gain points, e.g. from ducking) becomes a
//!   piecewise-linear `volume` expression (`src/lib/envelope.ts`);
//! * keyframes (position / scale / rotation / opacity on the clip clock) become
//!   piecewise-linear expressions of time: in the overlay for position, a per-frame
//!   `scale` (from the layer laid out at its largest keyed size) and `rotate`, and
//!   per-frame alpha updates through `sendcmd` for opacity (`src/lib/keyframes.ts`);
//! * a "blur" backdrop is a second branch of the same input, scaled to cover the frame,
//!   blurred (`backdropBlur` in `src/lib/visual.ts`) and laid under the clip with its
//!   timing and fades.
//!
//! No user-provided strings ever end up inside the filtergraph: media is passed
//! with `-i`, titles arrive as pre-rendered PNGs, and numbers are formatted here.

use crate::model::{Backdrop, Clip, ClipKind, Fit, Key, MediaKind, Project, TrackKind, VolumePoint};
use crate::util::f;
use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    #[default]
    Mp4,
    Mov,
    Webm,
    Gif,
    Png,
    Mp3,
    Wav,
    M4a,
}

impl Format {
    pub fn is_audio_only(self) -> bool {
        matches!(self, Format::Mp3 | Format::Wav | Format::M4a)
    }
    fn has_audio(self) -> bool {
        !matches!(self, Format::Gif | Format::Png)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    #[default]
    H264,
    Hevc,
    Prores,
    Vp9,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    High,
    #[default]
    Medium,
    Low,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportSettings {
    pub format: Format,
    pub codec: Codec,
    /// Output size; 0 = project size. Height 0 keeps the project aspect ratio.
    pub width: u32,
    pub height: u32,
    /// 0 = project frame rate.
    pub fps: f64,
    pub quality: Quality,
    pub hardware: bool,
    pub audio_bitrate: u32,
    pub normalize_audio: bool,
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            format: Format::Mp4,
            codec: Codec::H264,
            width: 0,
            height: 0,
            fps: 0.0,
            quality: Quality::Medium,
            hardware: false,
            audio_bitrate: 192,
            normalize_audio: false,
        }
    }
}

pub struct Plan {
    pub args: Vec<String>,
    pub duration: f64,
}

const EPS: f64 = 1e-6;

/// The part of a clip that falls inside the export range.
struct Span {
    /// Start relative to the export range (seconds).
    at: f64,
    /// Length on the timeline (seconds).
    dur: f64,
    src_in: f64,
    src_len: f64,
    /// Seconds cut from the clip's head / tail by the range.
    head: f64,
    tail: f64,
}

fn span(clip: &Clip, r0: f64, r1: f64) -> Option<Span> {
    let (cs, ce) = (clip.start, clip.end());
    if ce <= r0 + EPS || cs >= r1 - EPS || clip.duration() <= EPS {
        return None;
    }
    let head = (r0 - cs).max(0.0);
    let tail = (ce - r1).max(0.0);
    let dur = clip.duration() - head - tail;
    if dur <= EPS {
        return None;
    }
    let speed = clip.speed();
    Some(Span { at: cs + head - r0, dur, src_in: clip.source_in + head * speed, src_len: dur * speed, head, tail })
}

/// Clips closer than this count as butted together (transitions.ts: CUT_EPS).
const CUT_EPS: f64 = 1e-3;

/// Half the effective length of the dissolve into `clip` from the clip that ends where it
/// starts on the same track; 0 when there is none.
fn dissolve_half(track: &[Clip], clip: &Clip) -> f64 {
    if clip.transition_in.is_nan() || clip.transition_in <= 0.0 {
        return 0.0;
    }
    let Some(from) = track.iter().find(|c| !std::ptr::eq(*c, clip) && (c.end() - clip.start).abs() < CUT_EPS) else {
        return 0.0;
    };
    let half = (clip.transition_in / 2.0).min(from.duration() / 2.0).min(clip.duration() / 2.0);
    if half > EPS { half } else { 0.0 }
}

/// (into, out of) dissolve halves at the two ends of `clip`.
fn dissolves(track: &[Clip], clip: &Clip) -> (f64, f64) {
    let next = track.iter().find(|c| !std::ptr::eq(*c, clip) && (c.start - clip.end()).abs() < CUT_EPS);
    (dissolve_half(track, clip), next.map_or(0.0, |n| dissolve_half(track, n)))
}

/// `volume` expression for a clip's envelope over its rendered span: `t` runs from 0 at
/// the span start, which is source time `src_in`. None when it leaves the gain at 1.
fn envelope(points: &[VolumePoint], src_in: f64, speed: f64, dur: f64) -> Option<String> {
    let mut pts: Vec<(f64, f64)> = points.iter().filter(|p| p.t.is_finite()).map(|p| ((p.t - src_in) / speed, p.gain.clamp(0.0, 4.0))).collect();
    pts.sort_by(|a, b| a.0.total_cmp(&b.0));
    // Only the points that shape [0, dur]: the last one before it, those inside, the first after.
    let first = pts.iter().rposition(|p| p.0 <= 0.0).unwrap_or(0);
    let last = pts.iter().position(|p| p.0 >= dur).unwrap_or(pts.len().saturating_sub(1));
    let pts = pts.get(first..=last)?;
    if pts.iter().all(|p| (p.1 - 1.0).abs() < 1e-4) {
        return None;
    }
    let mut terms = vec![format!("{}*lt(t,{})", f(pts[0].1), f(pts[0].0))];
    for w in pts.windows(2) {
        let ((a, ga), (b, gb)) = (w[0], w[1]);
        if b - a > 1e-6 {
            terms.push(format!("gte(t,{})*lt(t,{})*({}{}*(t{})/{})", f(a), f(b), f(ga), signed(gb - ga), signed(-a), f(b - a)));
        }
    }
    let end = pts[pts.len() - 1];
    terms.push(format!("{}*gte(t,{})", f(end.1), f(end.0)));
    Some(terms.join("+"))
}

/// Value of keys at clip-clock time `t`: linear between keys (smoothstep with `ease`),
/// held outside.
fn key_value(keys: &[Key], t: f64, ease: bool) -> f64 {
    let Some(first) = keys.first() else { return 0.0 };
    if t <= first.t {
        return first.v;
    }
    for w in keys.windows(2) {
        let (a, b) = (w[0], w[1]);
        if t <= b.t {
            if b.t - a.t <= 1e-9 {
                return b.v;
            }
            let u = (t - a.t) / (b.t - a.t);
            return a.v + (b.v - a.v) * if ease { u * u * (3.0 - 2.0 * u) } else { u };
        }
    }
    keys[keys.len() - 1].v
}

/// Keys as an expression of time `t`, for a clip whose local time 0 falls at t = `t0`,
/// times `k`: the first value plus, per segment, its change times how far into it `t` is
/// (clamped; through smoothstep when the clip eases), so it needs no conditionals.
fn key_expr(keys: &[Key], clip: &Clip, t0: f64, k: f64) -> String {
    let at: Vec<(f64, f64)> = keys.iter().map(|key| (t0 + (key.t - clip.source_in) / clip.speed(), key.v * k)).collect();
    let mut e = f(at[0].1);
    for w in at.windows(2) {
        let ((ta, va), (tb, vb)) = (w[0], w[1]);
        if tb - ta > 1e-9 && (vb - va).abs() > 1e-9 {
            if clip.key_ease {
                let u = format!("clip((t{})/{},0,1)", signed(-ta), f(tb - ta));
                e += &format!("{}*{u}*{u}*(3-2*{u})", signed(vb - va));
            } else {
                e += &format!("{}*(clip(t,{},{}){})", signed((vb - va) / (tb - ta)), f(ta), f(tb), signed(-ta));
            }
        }
    }
    e
}

/// Keyed opacity on a layer's own clock (clip time 0 at `t0`, `len` long): an alpha gain
/// named `name`, updated through `sendcmd` on every frame where the value changes.
fn opacity_keys(keys: &[Key], clip: &Clip, t0: f64, len: f64, fps: f64, name: &str) -> Vec<String> {
    let at = |tau: f64| (key_value(keys, clip.source_in + (tau - t0) * clip.speed(), clip.key_ease).clamp(0.0, 1.0) * 1000.0).round() / 1000.0;
    let mut cmds = vec![];
    let mut last = at(0.0);
    for i in 1..=(len * fps).ceil() as usize {
        let tau = i as f64 / fps;
        let v = at(tau);
        if v != last {
            cmds.push(format!("{} colorchannelmixer@{name} aa {}", f(tau), f(v)));
            last = v;
        }
    }
    let mixer = format!("colorchannelmixer@{name}=aa={}", f(at(0.0)));
    if cmds.is_empty() { vec![mixer] } else { vec![format!("sendcmd=c='{}'", cmds.join(";")), mixer] }
}

/// One overlay coordinate: `centre` ("(W-w)/2"), plus the clip's position (static `base`,
/// or the keyed expression), plus its motion (from, to, progress), times `k`.
fn place_expr(centre: &str, keyed: Option<String>, base: f64, motion: Option<(f64, f64, &str)>, k: f64) -> String {
    match (keyed, motion) {
        (None, None) => format!("{centre}{}", signed(base * k)),
        (None, Some((from, to, p))) => format!("'{centre}{}{}*{p}'", signed((base + from) * k), signed((to - from) * k)),
        (Some(e), None) => format!("'{centre}+({e})'"),
        (Some(e), Some((from, to, p))) => format!("'{centre}+({e}){}{}*{p}'", signed(from * k), signed((to - from) * k)),
    }
}

/// Working pixel format of a layer: RGB when colour maths runs, alpha when it's needed.
fn pix_fmt(rgb: bool, alpha: bool) -> &'static str {
    match (rgb, alpha) {
        (true, true) => "gbrap",
        (true, false) => "gbrp",
        (false, true) => "yuva420p",
        (false, false) => "yuv420p",
    }
}

/// Blur (std. deviation, project pixels) of a "blur" backdrop; visual.ts: backdropBlur.
fn backdrop_sigma(w: f64, h: f64) -> f64 {
    0.03 * w.min(h)
}

fn even(v: f64) -> u32 {
    (((v / 2.0).round() * 2.0) as i64).max(2) as u32
}

fn fps_str(fps: f64) -> String {
    for (n, d) in [(24000.0, 1001.0), (30000.0, 1001.0), (60000.0, 1001.0)] {
        if (fps - n / d).abs() < 0.01 {
            return format!("{}/{}", n as u32, d as u32);
        }
    }
    f(fps)
}

fn signed(v: f64) -> String {
    if v < 0.0 { format!("-{}", f(-v)) } else { format!("+{}", f(v)) }
}

fn safe_color(c: &str) -> String {
    let ok = c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit());
    if ok { format!("0x{}", &c[1..]) } else { "black".into() }
}

/// Fit media of size (mw, mh) into a (w, h) frame.
pub fn fit_box(mw: f64, mh: f64, w: f64, h: f64, fit: Fit) -> (f64, f64) {
    if mw <= 0.0 || mh <= 0.0 {
        return (w, h);
    }
    match fit {
        Fit::Stretch => (w, h),
        Fit::Contain => {
            let s = (w / mw).min(h / mh);
            (mw * s, mh * s)
        }
        Fit::Cover => {
            let s = (w / mw).max(h / mh);
            (mw * s, mh * s)
        }
    }
}

type M3 = [[f64; 3]; 3];

fn mul(a: M3, b: M3) -> M3 {
    let mut r = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            r[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    r
}

// Matrices from the CSS Filter Effects spec so export matches the preview.
fn saturate_m(s: f64) -> M3 {
    [
        [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
        [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
        [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
    ]
}

fn sepia_m(p: f64) -> M3 {
    let q = 1.0 - p.clamp(0.0, 1.0);
    [
        [0.393 + 0.607 * q, 0.769 - 0.769 * q, 0.189 - 0.189 * q],
        [0.349 - 0.349 * q, 0.686 + 0.314 * q, 0.168 - 0.168 * q],
        [0.272 - 0.272 * q, 0.534 - 0.534 * q, 0.131 + 0.869 * q],
    ]
}

fn hue_m(deg: f64) -> M3 {
    let (s, c) = deg.to_radians().sin_cos();
    [
        [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
        [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
        [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
    ]
}

fn color_filters(c: &crate::model::ColorAdjust) -> Vec<String> {
    let mut out = vec![];
    let b = c.brightness.clamp(0.0, 2.0);
    if (b - 1.0).abs() > 1e-4 {
        out.push(format!("colorchannelmixer=rr={0}:gg={0}:bb={0}", f(b)));
    }
    let k = c.contrast.clamp(0.0, 3.0);
    if (k - 1.0).abs() > 1e-4 {
        // CSS contrast(): out = (in - 0.5) * k + 0.5, expressed as a levels mapping.
        if k > 1.0 {
            let (lo, hi) = (0.5 - 0.5 / k, 0.5 + 0.5 / k);
            out.push(format!("colorlevels=rimin={0}:gimin={0}:bimin={0}:rimax={1}:gimax={1}:bimax={1}", f(lo), f(hi)));
        } else {
            let (lo, hi) = (0.5 - 0.5 * k, 0.5 + 0.5 * k);
            out.push(format!("colorlevels=romin={0}:gomin={0}:bomin={0}:romax={1}:gomax={1}:bomax={1}", f(lo), f(hi)));
        }
    }
    let m = mul(hue_m(c.hue), mul(sepia_m(c.sepia), saturate_m(c.saturation.clamp(0.0, 3.0))));
    let identity = (0..3).all(|i| (0..3).all(|j| (m[i][j] - if i == j { 1.0 } else { 0.0 }).abs() < 1e-4));
    if !identity {
        let v = |x: f64| f(x.clamp(-2.0, 2.0));
        out.push(format!(
            "colorchannelmixer=rr={}:rg={}:rb={}:gr={}:gg={}:gb={}:br={}:bg={}:bb={}",
            v(m[0][0]), v(m[0][1]), v(m[0][2]), v(m[1][0]), v(m[1][1]), v(m[1][2]), v(m[2][0]), v(m[2][1]), v(m[2][2])
        ));
    }
    out
}

fn atempo(speed: f64) -> Vec<String> {
    let mut s = speed;
    let mut out = vec![];
    while s < 0.5 {
        out.push("atempo=0.5".to_string());
        s /= 0.5;
    }
    while s > 100.0 {
        out.push("atempo=100".to_string());
        s /= 100.0;
    }
    if (s - 1.0).abs() > 1e-6 {
        out.push(format!("atempo={}", f(s)));
    }
    out
}

pub fn build(
    project: &Project,
    settings: &ExportSettings,
    range: Option<(f64, f64)>,
    titles: &HashMap<String, PathBuf>,
    output: &str,
) -> Result<Plan> {
    let ps = &project.settings;
    let (pw, ph) = (ps.width.max(2) as f64, ps.height.max(2) as f64);
    let total = project.duration();
    let (r0, r1) = match range {
        Some((a, b)) => (a.max(0.0), b.max(0.0)),
        None => (0.0, total),
    };
    let dur = r1 - r0;
    if dur <= 1e-3 {
        return Err(anyhow!("The timeline is empty — add some clips first."));
    }

    let fmt = settings.format;
    let fps = if settings.fps > 0.0 { settings.fps } else if ps.fps > 0.0 { ps.fps } else { 30.0 };
    let ow = if settings.width > 0 { even(settings.width as f64) } else { even(pw) };
    let oh = if settings.height > 0 { even(settings.height as f64) } else { even(ow as f64 * ph / pw) };
    let (kx, ky) = (ow as f64 / pw, oh as f64 / ph);
    let sr = if ps.sample_rate >= 8000 { ps.sample_rate } else { 48000 };

    let mut inputs: Vec<Vec<String>> = vec![];
    let mut graph: Vec<String> = vec![];
    let mut clip_input: HashMap<&str, usize> = HashMap::new();

    // ---------------------------------------------------------------- video
    if !fmt.is_audio_only() {
        graph.push(format!(
            "color=c={}:s={ow}x{oh}:r={}:d={},format=yuv420p[base]",
            safe_color(&ps.background),
            fps_str(fps),
            f(dur)
        ));
        let mut prev = "base".to_string();
        let mut n = 0usize;

        for track in project.tracks.iter().filter(|t| t.kind == TrackKind::Video && !t.hidden) {
            let mut clips: Vec<&Clip> = track.clips.iter().collect();
            clips.sort_by(|a, b| a.start.total_cmp(&b.start));
            for clip in clips {
                let Some(sp) = span(clip, r0, r1) else { continue };
                // Dissolves extend the layer: `pre` before the clip holding its first frame,
                // `post` after it holding its last (only the parts inside the range).
                let (x_in, x_out) = dissolves(&track.clips, clip);
                let pre = if sp.head > 0.0 { 0.0 } else { x_in.min(clip.start - r0).max(0.0) };
                let post = if sp.tail > 0.0 { 0.0 } else { x_out.min(r1 - clip.end()).max(0.0) };
                let (input, mw, mh, is_video, has_alpha) = match clip.kind {
                    ClipKind::Title => {
                        let Some(png) = titles.get(&clip.id) else { continue };
                        (still_input(png.to_string_lossy().as_ref(), fps, sp.dur + pre + post), pw, ph, false, true)
                    }
                    ClipKind::Media => {
                        let Some(m) = clip.media_id.as_deref().and_then(|id| project.media(id)) else { continue };
                        if !m.has_video {
                            continue;
                        }
                        let (mw, mh) = if m.width > 0 && m.height > 0 { (m.width as f64, m.height as f64) } else { (pw, ph) };
                        if m.kind == MediaKind::Image {
                            (still_input(&m.path, fps, sp.dur + pre + post), mw, mh, false, true)
                        } else if clip.freeze {
                            // A frame hold reads just the frame at `in`.
                            (seek_input(&m.path, clip.source_in, 2.0 / fps), mw, mh, true, false)
                        } else {
                            (seek_input(&m.path, sp.src_in, sp.src_len), mw, mh, true, false)
                        }
                    }
                };
                let idx = inputs.len();
                inputs.push(input);
                clip_input.insert(clip.id.as_str(), idx);

                let t = &clip.transform;
                let kf = &clip.keyframes;
                // Keyed scale lays the layer out at its largest and shrinks it per frame,
                // so it is never upscaled.
                let scale = if !kf.scale.is_empty() {
                    kf.scale.iter().map(|k| k.v).fold(0.01, f64::max)
                } else if t.scale.is_finite() && t.scale > 0.0 {
                    t.scale
                } else {
                    1.0
                };
                let (fw, fh) = fit_box(mw, mh, pw, ph, t.fit);
                let (lw, lh) = (even(fw * scale * kx), even(fh * scale * ky));
                if lw > 16384 || lh > 16384 {
                    continue; // absurdly zoomed layer; ffmpeg would refuse it
                }

                // Keyed opacity replaces the static one.
                let keyed_opacity = !kf.opacity.is_empty();
                let opacity = if keyed_opacity { 1.0 } else { clip.opacity.clamp(0.0, 1.0) };
                if opacity <= 1e-3 || (keyed_opacity && kf.opacity.iter().all(|k| k.v <= 1e-3)) {
                    continue;
                }
                let fade_in = (clip.fade_in - sp.head).max(0.0).min(sp.dur);
                let fade_out = (clip.fade_out - sp.tail).max(0.0).min(sp.dur);
                let rotation = t.rotation % 360.0;
                let keyed_rotation = !kf.rotation.is_empty();
                let colors = color_filters(&clip.color);
                let rgb = !colors.is_empty() || opacity < 0.999 || keyed_opacity;
                // The incoming side of a dissolve ramps 0 → 1 over [start - x_in, start + x_in].
                let ramp = (x_in > 0.0).then(|| {
                    let layer_start = clip.start + sp.head - pre;
                    let (a, b) = (clip.start - x_in - layer_start, clip.start + x_in - layer_start);
                    (a.max(0.0), b - a.max(0.0))
                });
                let ramp = ramp.filter(|&(_, d)| d > EPS);
                let alpha = has_alpha
                    || opacity < 0.999
                    || keyed_opacity
                    || fade_in > 0.0
                    || fade_out > 0.0
                    || rotation.abs() > 1e-3
                    || keyed_rotation
                    || clip.crop.is_active()
                    || ramp.is_some();

                // Timing and fading, shared by the clip and its backdrop.
                let mut timing: Vec<String> = vec![if is_video && !clip.freeze {
                    format!("setpts=(PTS-STARTPTS)/{}", f(clip.speed()))
                } else {
                    "setpts=PTS-STARTPTS".into()
                }];
                if clip.freeze {
                    timing.push("trim=end_frame=1".into());
                    timing.push(format!("tpad=start_mode=clone:start_duration={}:stop_mode=clone:stop_duration={}", f(pre), f(sp.dur + post)));
                } else {
                    timing.push(format!("trim=duration={}", f(sp.dur)));
                    if pre > 0.0 || post > 0.0 {
                        timing.push(format!("tpad=start_mode=clone:start_duration={}:stop_mode=clone:stop_duration={}", f(pre), f(post)));
                    }
                }
                // `tag` names the keyed-opacity mixer apart in the clip and its backdrop.
                let fades = |tag: &str| {
                    let mut out: Vec<String> = vec![];
                    if keyed_opacity {
                        out.extend(opacity_keys(&kf.opacity, clip, pre - sp.head, pre + sp.dur + post, fps, &format!("{tag}{n}")));
                    } else if opacity < 0.999 {
                        out.push(format!("colorchannelmixer=aa={}", f(opacity)));
                    }
                    if fade_in > 0.0 {
                        out.push(format!("fade=t=in:st={}:d={}:alpha=1", f(pre), f(fade_in)));
                    }
                    if fade_out > 0.0 {
                        out.push(format!("fade=t=out:st={}:d={}:alpha=1", f(pre + sp.dur - fade_out), f(fade_out)));
                    }
                    if let Some((st, d)) = ramp {
                        out.push(format!("fade=t=in:st={}:d={}:alpha=1", f(st), f(d)));
                    }
                    out
                };
                let offset = (sp.at - pre > 0.0).then(|| format!("setpts=PTS+{}/TB", f(sp.at - pre)));
                let backdrop = clip.kind == ClipKind::Media && clip.backdrop == Some(Backdrop::Blur);
                let source = if backdrop {
                    graph.push(format!("[{idx}:v]split=2[c{n}][b{n}]"));
                    // Blur at a quarter of the size, then scale up: same look, far cheaper.
                    let (bw, bh) = (even(ow as f64 / 4.0), even(oh as f64 / 4.0));
                    let mut b = timing.clone();
                    b.push(format!("scale={bw}:{bh}:force_original_aspect_ratio=increase:flags=bilinear"));
                    b.push(format!("crop={bw}:{bh}"));
                    b.push(format!("format={}", pix_fmt(rgb, alpha)));
                    b.extend(colors.iter().cloned());
                    b.push(format!("gblur=sigma={}", f(backdrop_sigma(pw, ph) * kx / 4.0)));
                    b.push(format!("scale={ow}:{oh}:flags=bilinear"));
                    b.extend(fades("ob"));
                    b.extend(offset.clone());
                    graph.push(format!("[b{n}]{}[bl{n}]", b.join(",")));
                    graph.push(format!("[{prev}][bl{n}]overlay=x=0:y=0:eof_action=pass:format=auto[bv{n}]"));
                    prev = format!("bv{n}");
                    format!("c{n}")
                } else {
                    format!("{idx}:v")
                };

                let mut chain = timing;
                chain.push(format!("scale={lw}:{lh}:flags=bicubic"));
                if t.flip_h {
                    chain.push("hflip".into());
                }
                if t.flip_v {
                    chain.push("vflip".into());
                }
                chain.push(format!("format={}", pix_fmt(rgb, alpha)));
                chain.extend(colors.iter().cloned());
                if clip.crop.is_active() {
                    let c = &clip.crop;
                    let (l, r, tp, b) = (c.left.clamp(0.0, 1.0), c.right.clamp(0.0, 1.0), c.top.clamp(0.0, 1.0), c.bottom.clamp(0.0, 1.0));
                    let cw = ((lw as f64) * (1.0 - l - r)).round().max(1.0) as u32;
                    let ch = ((lh as f64) * (1.0 - tp - b)).round().max(1.0) as u32;
                    let cx = ((lw as f64) * l).round() as u32;
                    let cy = ((lh as f64) * tp).round() as u32;
                    chain.push(format!("crop={cw}:{ch}:{cx}:{cy}:exact=1"));
                    chain.push(format!("pad={lw}:{lh}:{cx}:{cy}:color=black@0"));
                }
                if clip.color.blur > 0.01 {
                    chain.push(format!("gblur=sigma={}", f(clip.color.blur * scale * kx)));
                }
                chain.extend(fades("o"));
                if keyed_rotation {
                    // A canvas that fits every angle; the overlay centres it.
                    let a = format!("({})*PI/180", key_expr(&kf.rotation, clip, pre - sp.head, 1.0));
                    chain.push(format!("rotate=a='{a}':ow='2*ceil(hypot(iw,ih)/2)':oh='2*ceil(hypot(iw,ih)/2)':c=black@0"));
                } else if rotation.abs() > 1e-3 {
                    let a = f(rotation.to_radians());
                    chain.push(format!("rotate=a={a}:ow=rotw({a}):oh=roth({a}):c=black@0"));
                }
                // Progress through the whole clip as an expression of time `t`, where the
                // clip starts at `t0` (the layer's own clock here, the export's in the overlay).
                let still = crate::model::MotionPoint::default();
                let motion = clip.motion.filter(|m| m.from != still || m.to != still);
                let progress = |t0: f64| {
                    let m = motion.unwrap_or_default();
                    let d = if m.duration > 0.0 { m.duration.min(clip.duration()) } else { clip.duration() };
                    let p = format!("clip((t{})/{},0,1)", signed(-t0), f(d.max(EPS)));
                    if m.ease_out { format!("(1-pow(1-{p},3))") } else { p }
                };
                let zoom = motion.map(|m| format!("({}{}*{})", f(m.from.scale), signed(m.to.scale - m.from.scale), progress(pre - sp.head)));
                let keyed_zoom = (!kf.scale.is_empty()).then(|| format!("({})/{}", key_expr(&kf.scale, clip, pre - sp.head, 1.0), f(scale)));
                let z = match (zoom, keyed_zoom) {
                    (Some(a), Some(b)) => Some(format!("{a}*{b}")),
                    (a, b) => a.or(b),
                };
                if let Some(z) = z {
                    chain.push(format!("scale=w='max(2,trunc(iw*{z}/2)*2)':h='max(2,trunc(ih*{z}/2)*2)':eval=frame:flags=bicubic"));
                }
                chain.extend(offset);
                graph.push(format!("[{source}]{}[l{n}]", chain.join(",")));
                let p = progress(clip.start - r0);
                let keyed = |keys: &[Key], k: f64| (!keys.is_empty()).then(|| key_expr(keys, clip, clip.start - r0, k));
                let ox = place_expr("(W-w)/2", keyed(&kf.x, kx), t.x, motion.map(|m| (m.from.x, m.to.x, p.as_str())), kx);
                let oy = place_expr("(H-h)/2", keyed(&kf.y, ky), t.y, motion.map(|m| (m.from.y, m.to.y, p.as_str())), ky);
                graph.push(format!("[{prev}][l{n}]overlay=x={ox}:y={oy}:eof_action=pass:format=auto[v{n}]"));
                prev = format!("v{n}");
                n += 1;
            }
        }

        match fmt {
            Format::Gif => graph.push(format!(
                "[{prev}]split[g0][g1];[g0]palettegen=max_colors=256:stats_mode=diff[pal];[g1][pal]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[vout]"
            )),
            Format::Mov if settings.codec == Codec::Prores => graph.push(format!("[{prev}]format=yuv422p10le[vout]")),
            Format::Png => graph.push(format!("[{prev}]format=rgb24[vout]")),
            _ => graph.push(format!("[{prev}]format=yuv420p[vout]")),
        }
    }

    // ---------------------------------------------------------------- audio
    if fmt.has_audio() {
        let any_solo = project.tracks.iter().any(|t| t.solo);
        let mut labels: Vec<String> = vec![];
        for track in &project.tracks {
            if track.muted || (any_solo && !track.solo) {
                continue;
            }
            let track_gain = if track.volume.is_finite() { track.volume.max(0.0) } else { 1.0 };
            for clip in &track.clips {
                if clip.kind != ClipKind::Media || clip.muted || clip.freeze {
                    continue;
                }
                let Some(m) = clip.media_id.as_deref().and_then(|id| project.media(id)) else { continue };
                if !m.has_audio || m.kind == MediaKind::Image {
                    continue;
                }
                let gain = clip.volume.max(0.0) * track_gain;
                if gain <= 1e-4 {
                    continue;
                }
                let Some(sp) = span(clip, r0, r1) else { continue };
                let idx = match clip_input.get(clip.id.as_str()) {
                    Some(&i) if track.kind == TrackKind::Video => i,
                    _ => {
                        inputs.push(seek_input(&m.path, sp.src_in, sp.src_len));
                        inputs.len() - 1
                    }
                };

                let mut chain = vec![
                    "asetpts=PTS-STARTPTS".to_string(),
                    format!("aformat=sample_fmts=fltp:sample_rates={sr}:channel_layouts=stereo"),
                ];
                chain.extend(atempo(clip.speed()));
                chain.push(format!("atrim=duration={}", f(sp.dur)));
                if (gain - 1.0).abs() > 1e-4 {
                    chain.push(format!("volume={}", f(gain)));
                }
                if let Some(expr) = envelope(&clip.volume_points, sp.src_in, clip.speed(), sp.dur) {
                    // Small frames so the gain moves in 5 ms steps, not 20 ms ones.
                    chain.push("asetnsamples=n=256:p=0".into());
                    chain.push(format!("volume='{expr}':eval=frame"));
                }
                let fade_in = (clip.fade_in - sp.head).max(0.0).min(sp.dur);
                let fade_out = (clip.fade_out - sp.tail).max(0.0).min(sp.dur);
                if fade_in > 0.0 {
                    chain.push(format!("afade=t=in:st=0:d={}", f(fade_in)));
                }
                if fade_out > 0.0 {
                    chain.push(format!("afade=t=out:st={}:d={}", f(sp.dur - fade_out), f(fade_out)));
                }
                // Sound dips across a dissolved cut: out over the half before it, in over the half after.
                let (x_in, x_out) = dissolves(&track.clips, clip);
                let (dip_in, dip_out) = ((x_in - sp.head).max(0.0).min(sp.dur), (x_out - sp.tail).max(0.0).min(sp.dur));
                if dip_in > 0.0 {
                    chain.push(format!("afade=t=in:st=0:d={}", f(dip_in)));
                }
                if dip_out > 0.0 {
                    chain.push(format!("afade=t=out:st={}:d={}", f(sp.dur - dip_out), f(dip_out)));
                }
                let delay = (sp.at * sr as f64).round() as u64;
                if delay > 0 {
                    chain.push(format!("adelay={delay}S:all=1"));
                }
                // Re-stamp from the sample count: delayed inputs reach amix without
                // timestamps (ffmpeg 6.x), which yields a silent, broken audio stream.
                chain.push("asetpts=N/SR/TB".to_string());
                let label = format!("a{}", labels.len());
                graph.push(format!("[{idx}:a]{}[{label}]", chain.join(",")));
                labels.push(label);
            }
        }

        let mut tail = vec![];
        if settings.normalize_audio && !labels.is_empty() {
            tail.push("loudnorm=I=-14:TP=-1:LRA=11".to_string());
            tail.push(format!("aresample={sr}"));
        }
        tail.push(format!("aformat=sample_rates={sr}:channel_layouts=stereo"));
        if labels.is_empty() {
            graph.push(format!("anullsrc=r={sr}:cl=stereo,atrim=duration={},{}[aout]", f(dur), tail.join(",")));
        } else {
            let ins: String = labels.iter().map(|l| format!("[{l}]")).collect();
            graph.push(format!(
                // Bounded padding: a bare (infinite) `apad` can starve the video branch
                // in ffmpeg's scheduler and hang the export near the end.
                "{ins}amix=inputs={}:duration=longest:dropout_transition=0:normalize=0,apad=whole_dur={d},atrim=duration={d},{}[aout]",
                labels.len(),
                tail.join(","),
                d = f(dur)
            ));
        }
    }

    // ---------------------------------------------------------------- command
    let mut args: Vec<String> = inputs.into_iter().flatten().collect();
    args.push("-filter_complex".into());
    args.push(graph.join(";"));
    if !fmt.is_audio_only() {
        args.extend(["-map".into(), "[vout]".into()]);
    }
    if fmt.has_audio() {
        args.extend(["-map".into(), "[aout]".into()]);
    }
    args.extend(encoder_args(settings, ow, oh, fps));
    args.extend(["-max_muxing_queue_size".into(), "4096".into()]);
    if fmt != Format::Png {
        args.extend(["-t".into(), f(dur)]);
    }
    args.push(output.into());
    Ok(Plan { args, duration: dur })
}

fn seek_input(path: &str, src_in: f64, src_len: f64) -> Vec<String> {
    let mut v = vec![];
    if src_in > 0.0 {
        v.extend(["-ss".into(), f(src_in)]);
    }
    v.extend(["-t".into(), f(src_len.max(0.001)), "-i".into(), path.into()]);
    v
}

fn still_input(path: &str, fps: f64, dur: f64) -> Vec<String> {
    vec![
        "-loop".into(),
        "1".into(),
        "-framerate".into(),
        fps_str(fps),
        "-t".into(),
        f(dur.max(0.001)),
        "-i".into(),
        path.into(),
    ]
}

fn encoder_args(s: &ExportSettings, w: u32, h: u32, fps: f64) -> Vec<String> {
    let q = s.quality;
    let abr = format!("{}k", s.audio_bitrate.clamp(64, 512));
    // Bitrate for hardware encoders (they have no CRF): bits per pixel per frame.
    let bpp = match q {
        Quality::High => 0.12,
        Quality::Medium => 0.075,
        Quality::Low => 0.045,
    };
    let kbps = ((w as f64 * h as f64 * fps * bpp) / 1000.0).round().max(500.0) as u64;
    let sv = |a: &[&str]| a.iter().map(|x| x.to_string()).collect::<Vec<String>>();

    match s.format {
        Format::Mp3 => sv(&["-c:a", "libmp3lame", "-b:a", &abr]),
        Format::Wav => sv(&["-c:a", "pcm_s16le"]),
        Format::M4a => sv(&["-c:a", "aac", "-b:a", &abr, "-movflags", "+faststart"]),
        Format::Gif => sv(&["-loop", "0"]),
        Format::Png => sv(&["-frames:v", "1", "-update", "1"]),
        Format::Webm => {
            let crf = match q { Quality::High => "28", Quality::Medium => "33", Quality::Low => "38" };
            sv(&["-c:v", "libvpx-vp9", "-crf", crf, "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4",
                 "-c:a", "libopus", "-b:a", &abr])
        }
        Format::Mp4 | Format::Mov => {
            let mut v = match (s.codec, s.hardware) {
                (Codec::Prores, _) => {
                    let profile = match q { Quality::High => "3", Quality::Medium => "2", Quality::Low => "1" };
                    return sv(&["-c:v", "prores_ks", "-profile:v", profile, "-vendor", "apl0", "-c:a", "pcm_s16le"]);
                }
                (Codec::Hevc, true) => sv(&["-c:v", "hevc_videotoolbox", "-b:v", &format!("{}k", kbps * 7 / 10), "-tag:v", "hvc1"]),
                (Codec::Hevc, false) => {
                    let crf = match q { Quality::High => "20", Quality::Medium => "24", Quality::Low => "29" };
                    sv(&["-c:v", "libx265", "-preset", "medium", "-crf", crf, "-tag:v", "hvc1", "-x265-params", "log-level=error"])
                }
                (_, true) => sv(&["-c:v", "h264_videotoolbox", "-b:v", &format!("{kbps}k"), "-profile:v", "high"]),
                (_, false) => {
                    let crf = match q { Quality::High => "18", Quality::Medium => "22", Quality::Low => "27" };
                    sv(&["-c:v", "libx264", "-preset", "medium", "-crf", crf, "-profile:v", "high"])
                }
            };
            v.extend(sv(&["-c:a", "aac", "-b:a", &abr, "-movflags", "+faststart"]));
            v
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;
    use std::process::Command;

    fn ffmpeg_ok() -> bool {
        Command::new("ffmpeg").arg("-version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn tmpdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("revind_graph_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn ff(args: &[&str]) {
        let out = Command::new("ffmpeg").args(["-hide_banner", "-v", "error", "-y"]).args(args).output().unwrap();
        assert!(out.status.success(), "ffmpeg {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
    }

    /// Solid-colour test clip, optionally with a sine tone.
    fn solid(path: &PathBuf, color: &str, w: u32, h: u32, dur: f64, tone: Option<u32>) {
        let src = format!("color=c={color}:s={w}x{h}:r=30:d={dur}");
        let p = path.to_str().unwrap();
        match tone {
            Some(hz) => ff(&["-f", "lavfi", "-i", &src, "-f", "lavfi", "-i", &format!("sine=frequency={hz}:duration={dur}"),
                             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", p]),
            None => ff(&["-f", "lavfi", "-i", &src, "-c:v", "libx264", "-pix_fmt", "yuv420p", p]),
        }
    }

    fn media(id: &str, path: &PathBuf, w: u32, h: u32, dur: f64, audio: bool) -> MediaAsset {
        MediaAsset {
            id: id.into(), path: path.to_string_lossy().into(), name: id.into(), kind: MediaKind::Video,
            duration: dur, width: w, height: h, fps: 30.0, has_video: true, has_audio: audio,
        }
    }

    fn clip(id: &str, media: &str, start: f64, src_in: f64, len: f64) -> Clip {
        Clip { id: id.into(), media_id: Some(media.into()), start, source_in: src_in, source_out: src_in + len, ..Default::default() }
    }

    fn project(w: u32, h: u32) -> Project {
        Project {
            settings: ProjectSettings { width: w, height: h, fps: 30.0, ..Default::default() },
            tracks: vec![
                Track { id: "v1".into(), kind: TrackKind::Video, name: "V1".into(), ..Default::default() },
                Track { id: "v2".into(), kind: TrackKind::Video, name: "V2".into(), ..Default::default() },
                Track { id: "a1".into(), kind: TrackKind::Audio, name: "A1".into(), ..Default::default() },
            ],
            ..Default::default()
        }
    }

    fn run(p: &Project, s: &ExportSettings, range: Option<(f64, f64)>, out: &PathBuf) -> Plan {
        run_titles(p, s, range, &HashMap::new(), out)
    }

    fn run_titles(p: &Project, s: &ExportSettings, range: Option<(f64, f64)>, titles: &HashMap<String, PathBuf>, out: &PathBuf) -> Plan {
        let plan = build(p, s, range, titles, out.to_str().unwrap()).unwrap();
        let res = Command::new("ffmpeg").args(["-hide_banner", "-v", "error", "-y"]).args(&plan.args).output().unwrap();
        assert!(res.status.success(), "export failed\nARGS: {:?}\n{}", plan.args, String::from_utf8_lossy(&res.stderr));
        plan
    }

    /// RGB of the pixel at (x, y) of the frame at time t.
    fn pixel(file: &PathBuf, t: f64, x: u32, y: u32) -> [u8; 3] {
        let out = Command::new("ffmpeg")
            .args(["-v", "error", "-ss", &f(t), "-i", file.to_str().unwrap(), "-frames:v", "1",
                   "-vf", &format!("format=rgb24,crop=1:1:{x}:{y}"), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output()
            .unwrap();
        assert!(out.stdout.len() >= 3, "no pixel: {}", String::from_utf8_lossy(&out.stderr));
        [out.stdout[0], out.stdout[1], out.stdout[2]]
    }

    fn mean_volume(file: &PathBuf, t: f64, len: f64) -> f64 {
        let out = Command::new("ffmpeg")
            .args(["-hide_banner", "-ss", &f(t), "-t", &f(len), "-i", file.to_str().unwrap(), "-vn", "-af", "volumedetect", "-f", "null", "-"])
            .output()
            .unwrap();
        let log = String::from_utf8_lossy(&out.stderr);
        log.lines()
            .find_map(|l| l.split("mean_volume:").nth(1))
            .and_then(|v| v.trim().trim_end_matches("dB").trim().parse().ok())
            .unwrap_or(-200.0)
    }

    fn duration(file: &PathBuf) -> f64 {
        let out = Command::new("ffprobe")
            .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file.to_str().unwrap()])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0.0)
    }

    fn near(a: [u8; 3], b: [u8; 3], tol: i32) -> bool {
        (0..3).all(|i| (a[i] as i32 - b[i] as i32).abs() <= tol)
    }

    #[test]
    fn layers_stack_with_timing_transform_and_audio() {
        if !ffmpeg_ok() { return; }
        let d = tmpdir();
        let (red, blue) = (d.join("red.mp4"), d.join("blue.mp4"));
        solid(&red, "red", 320, 180, 4.0, Some(440));
        solid(&blue, "blue", 320, 180, 3.0, None);

        let mut p = project(640, 360);
        p.media = vec![media("r", &red, 320, 180, 4.0, true), media("b", &blue, 320, 180, 3.0, false)];
        // V1: red from 1s for 3s. V2: half-size blue from 2s to 3s, moved right by 100px.
        p.tracks[0].clips.push(clip("c1", "r", 1.0, 0.5, 3.0));
        let mut top = clip("c2", "b", 2.0, 0.0, 1.0);
        top.transform.scale = 0.5;
        top.transform.x = 100.0;
        p.tracks[1].clips.push(top);

        let out = d.join("out.mp4");
        let plan = run(&p, &ExportSettings::default(), None, &out);
        assert!((plan.duration - 4.0).abs() < 1e-6);
        assert!((duration(&out) - 4.0).abs() < 0.1, "duration {}", duration(&out));

        assert!(near(pixel(&out, 0.5, 320, 180), [0, 0, 0], 20), "black before first clip");
        assert!(near(pixel(&out, 1.5, 320, 180), [254, 0, 0], 40), "red layer");
        // Blue layer: 320x180 centred at (420, 180) -> covers x 260..580.
        assert!(near(pixel(&out, 2.5, 420, 180), [0, 0, 254], 40), "blue layer offset");
        assert!(near(pixel(&out, 2.5, 100, 180), [254, 0, 0], 40), "red outside blue layer");
        assert!(near(pixel(&out, 3.5, 320, 180), [254, 0, 0], 40), "blue ended");

        // Audio only where the red clip (which has a tone) sits.
        assert!(mean_volume(&out, 0.2, 0.6) < -80.0, "silence before clip");
        assert!(mean_volume(&out, 1.5, 0.5) > -40.0, "tone during clip");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn jump_cut_pieces_and_delayed_music_stay_audible() {
        if !ffmpeg_ok() { return; }
        let d = tmpdir();
        // Opus-in-WebM sources, as recorded by browsers and screen recorders.
        let (talk, music) = (d.join("talk.webm"), d.join("music.webm"));
        for (path, hz, dur) in [(&talk, 440, 8), (&music, 330, 12)] {
            ff(&["-f", "lavfi", "-i", &format!("color=c=red:s=160x90:r=30:d={dur}"), "-f", "lavfi", "-i", &format!("sine=frequency={hz}:duration={dur}"),
                 "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", "-shortest", path.to_str().unwrap()]);
        }
        let mut p = project(160, 90);
        p.media = vec![media("t", &talk, 160, 90, 8.0, true), media("m", &music, 160, 90, 12.0, true)];
        // The layout "Remove silences" produced in the UI: seeked pieces butted together
        // (the first at 2x), plus music on an audio track from 3s.
        let mut first = clip("p0", "t", 1.0 / 3.0, 0.0, 1.12);
        first.speed = 2.0;
        p.tracks[0].clips.push(first);
        for (i, (start, src_in)) in [(1.4533, 1.88), (2.6933, 3.88), (3.9333, 5.88)].into_iter().enumerate() {
            p.tracks[0].clips.push(clip(&format!("p{}", i + 1), "t", start, src_in, 1.24));
        }
        p.tracks[2].clips.push(clip("m", "m", 3.0, 0.0, 12.0));
        let out = d.join("mix.mp4");
        run(&p, &ExportSettings::default(), None, &out);
        assert!(mean_volume(&out, 0.1, 0.15) < -80.0, "silence before the first piece");
        assert!(mean_volume(&out, 2.0, 0.5) > -40.0, "talk pieces audible");
        assert!(mean_volume(&out, 10.0, 0.5) > -40.0, "music audible");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn fades_opacity_color_rotation_crop_and_range() {
        if !ffmpeg_ok() { return; }
        let d = tmpdir();
        let white = d.join("white.mp4");
        solid(&white, "white", 320, 180, 6.0, Some(300));
        let mut p = project(320, 180);
        p.media = vec![media("w", &white, 320, 180, 6.0, true)];

        let mut c = clip("c", "w", 0.0, 0.0, 6.0);
        c.fade_in = 2.0;
        c.opacity = 0.5;
        c.color.brightness = 0.5;
        c.transform.rotation = 90.0;
        c.crop.left = 0.25;
        p.tracks[0].clips.push(c);

        // Export 3s..5s: fade already finished, half opacity, half brightness.
        let out = d.join("range.mp4");
        let plan = run(&p, &ExportSettings::default(), Some((3.0, 5.0)), &out);
        assert!((plan.duration - 2.0).abs() < 1e-6);
        assert!((duration(&out) - 2.0).abs() < 0.1);
        let px = pixel(&out, 1.0, 160, 90);
        // white * 0.5 brightness * 0.5 opacity over black ≈ 64
        assert!(near(px, [64, 64, 64], 16), "got {:?}", px);
        // Rotated 90° (contain-fit 320x180 -> 180 tall layer stands up): corners stay black.
        assert!(near(pixel(&out, 1.0, 10, 90), [0, 0, 0], 16));

        // Whole clip: half way through the fade-in the layer is ~half as bright again.
        let full = d.join("full.mp4");
        run(&p, &ExportSettings::default(), None, &full);
        let early = pixel(&full, 1.0, 160, 90);
        assert!(early[0] > 15 && early[0] < 50, "fade-in mid value {:?}", early);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn hidden_muted_and_solo_tracks_are_respected() {
        if !ffmpeg_ok() { return; }
        let d = tmpdir();
        let red = d.join("red.mp4");
        solid(&red, "red", 160, 90, 2.0, Some(440));
        let mut p = project(160, 90);
        p.media = vec![media("r", &red, 160, 90, 2.0, true)];
        p.tracks[0].clips.push(clip("c1", "r", 0.0, 0.0, 2.0));
        p.tracks[0].hidden = true;
        p.tracks[2].clips.push(clip("c2", "r", 0.0, 0.0, 2.0));
        p.tracks[2].muted = true;
        p.tracks[0].solo = false;

        let out = d.join("out.mp4");
        run(&p, &ExportSettings::default(), None, &out);
        assert!(near(pixel(&out, 1.0, 80, 45), [0, 0, 0], 20), "hidden track not drawn");
        // V1 audio still plays (hidden ≠ muted); muted A1 does not add to it.
        let with_v1 = mean_volume(&out, 0.5, 1.0);
        assert!(with_v1 > -40.0);

        p.tracks[0].muted = true;
        p.tracks[2].muted = false;
        p.tracks[2].solo = true;
        let out2 = d.join("out2.mp4");
        run(&p, &ExportSettings::default(), None, &out2);
        assert!(mean_volume(&out2, 0.5, 1.0) > -40.0, "soloed audio track plays");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn titles_images_and_speed() {
        if !ffmpeg_ok() { return; }
        let d = tmpdir();
        let green = d.join("green.mp4");
        solid(&green, "green", 160, 90, 4.0, Some(500));
        // A "title": transparent 160x90 PNG with a white box in the top-left quarter.
        let title = d.join("title.png");
        ff(&["-f", "lavfi", "-i", "color=c=black@0:s=160x90,format=rgba,drawbox=x=0:y=0:w=80:h=45:color=white@1:t=fill:replace=1",
             "-frames:v", "1", title.to_str().unwrap()]);
        let still = d.join("still.png");
        ff(&["-f", "lavfi", "-i", "color=c=yellow:s=90x90", "-frames:v", "1", still.to_str().unwrap()]);

        let mut p = project(160, 90);
        p.media = vec![
            media("g", &green, 160, 90, 4.0, true),
            MediaAsset { id: "s".into(), path: still.to_string_lossy().into(), kind: MediaKind::Image, width: 90, height: 90,
                         has_video: true, ..Default::default() },
        ];
        let mut fast = clip("g1", "g", 0.0, 0.0, 4.0);
        fast.speed = 2.0; // 4s of source in 2s
        p.tracks[0].clips.push(fast);
        p.tracks[0].clips.push(Clip { id: "img".into(), media_id: Some("s".into()), start: 2.0, source_in: 0.0, source_out: 1.0, ..Default::default() });
        p.tracks[1].clips.push(Clip { id: "t1".into(), kind: ClipKind::Title, start: 0.0, source_in: 0.0, source_out: 3.0, ..Default::default() });
        let titles: HashMap<String, PathBuf> = [("t1".to_string(), title.clone())].into_iter().collect();

        let out = d.join("out.mp4");
        let plan = run_titles(&p, &ExportSettings::default(), None, &titles, &out);
        assert!((plan.duration - 3.0).abs() < 1e-6, "2s fast clip + 1s still");
        assert!(near(pixel(&out, 1.0, 20, 20), [255, 255, 255], 30), "title box");
        assert!(near(pixel(&out, 1.0, 120, 70), [0, 128, 0], 40), "green under title");
        assert!(near(pixel(&out, 2.5, 80, 45), [255, 255, 0], 40), "still image (contain fit)");
        assert!(near(pixel(&out, 2.5, 10, 45), [0, 0, 0], 20), "pillarbox around square still");
        assert!(mean_volume(&out, 0.5, 1.0) > -40.0, "sped-up audio present");
        assert!(mean_volume(&out, 2.2, 0.6) < -80.0, "still image is silent");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn every_output_format_encodes() {
        if !ffmpeg_ok() { return; }
        let d = tmpdir();
        let src = d.join("src.mp4");
        solid(&src, "orange", 160, 90, 1.0, Some(440));
        let mut p = project(160, 90);
        p.media = vec![media("m", &src, 160, 90, 1.0, true)];
        p.tracks[0].clips.push(clip("c", "m", 0.0, 0.0, 1.0));

        let cases: Vec<(&str, ExportSettings)> = vec![
            ("h264.mp4", ExportSettings::default()),
            ("hevc.mp4", ExportSettings { codec: Codec::Hevc, ..Default::default() }),
            ("prores.mov", ExportSettings { format: Format::Mov, codec: Codec::Prores, ..Default::default() }),
            ("vp9.webm", ExportSettings { format: Format::Webm, codec: Codec::Vp9, ..Default::default() }),
            ("anim.gif", ExportSettings { format: Format::Gif, fps: 10.0, width: 80, ..Default::default() }),
            ("frame.png", ExportSettings { format: Format::Png, ..Default::default() }),
            ("audio.mp3", ExportSettings { format: Format::Mp3, ..Default::default() }),
            ("audio.wav", ExportSettings { format: Format::Wav, normalize_audio: true, ..Default::default() }),
            ("audio.m4a", ExportSettings { format: Format::M4a, ..Default::default() }),
            ("half.mp4", ExportSettings { width: 80, quality: Quality::Low, ..Default::default() }),
        ];
        for (name, s) in cases {
            let out = d.join(name);
            run(&p, &s, None, &out);
            assert!(std::fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false), "{name} not written");
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Two solid colours back to back (first for `a` seconds, then the second for `b`).
    fn two_colors(path: &PathBuf, c1: &str, a: f64, c2: &str, b: f64, tone: u32) {
        ff(&["-f", "lavfi", "-i", &format!("color=c={c1}:s=160x90:r=30:d={a}"), "-f", "lavfi", "-i", &format!("color=c={c2}:s=160x90:r=30:d={b}"),
             "-f", "lavfi", "-i", &format!("sine=frequency={tone}:duration={}", a + b),
             "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.to_str().unwrap()]);
    }

    #[test]
    fn dissolve_blends_held_frames_across_the_cut() {
        if !ffmpeg_ok() { return; }
        let d = tmpdir();
        // A is red, but its source turns green right after the out point; B is blue, but its
        // source is yellow right before the in point: a dissolve must never show either.
        let (src_a, src_b) = (d.join("a.mp4"), d.join("b.mp4"));
        two_colors(&src_a, "red", 2.0, "green", 2.0, 440);
        two_colors(&src_b, "yellow", 1.0, "blue", 3.0, 660);
        let mut p = project(160, 90);
        p.media = vec![media("a", &src_a, 160, 90, 4.0, true), media("b", &src_b, 160, 90, 4.0, true)];
        p.tracks[0].clips.push(clip("ca", "a", 0.0, 0.0, 2.0));
        let mut b = clip("cb", "b", 2.0, 1.0, 2.0);
        b.transition_in = 1.0; // 1.5s .. 2.5s
        p.tracks[0].clips.push(b);
        let out = d.join("dissolve.mp4");
        let plan = run(&p, &ExportSettings::default(), None, &out);
        assert!((plan.duration - 4.0).abs() < 1e-6, "a dissolve doesn't change the length");

        let (red, blue) = ([254, 0, 0], [0, 0, 254]);
        let mix = |k: f64| [(254.0 * (1.0 - k)) as u8, 0, (254.0 * k) as u8];
        assert!(near(pixel(&out, 1.2, 80, 45), red, 24), "before: {:?}", pixel(&out, 1.2, 80, 45));
        // First half: B held on its first (blue) frame, fading in over A.
        let early = pixel(&out, 1.8, 80, 45);
        assert!(near(early, mix(0.3), 40) && early[1] < 40, "30% in: {early:?}");
        // Second half: A held on its last (red) frame under B.
        let late = pixel(&out, 2.2, 80, 45);
        assert!(near(late, mix(0.7), 40) && late[1] < 40, "70% in: {late:?}");
        assert!(near(pixel(&out, 2.8, 80, 45), blue, 24), "after: {:?}", pixel(&out, 2.8, 80, 45));
        // The sound dips across the cut.
        assert!(mean_volume(&out, 1.97, 0.06) < mean_volume(&out, 1.0, 0.3) - 12.0, "audio dip at the cut");
        assert!(mean_volume(&out, 3.0, 0.3) > -40.0, "B audible after the dissolve");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn motion_zooms_and_pans_across_the_clip() {
        if !ffmpeg_ok() { return; }
        let d = tmpdir();
        // A white 20x20 square in the middle of a black frame.
        let src = d.join("square.mp4");
        ff(&["-f", "lavfi", "-i", "color=c=black:s=160x90:r=30:d=4,drawbox=x=70:y=35:w=20:h=20:color=white:t=fill",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", src.to_str().unwrap()]);
        let mut p = project(160, 90);
        p.media = vec![media("sq", &src, 160, 90, 4.0, false)];
        let mut zoom = clip("z", "sq", 0.0, 0.0, 2.0);
        zoom.motion = Some(Motion { from: MotionPoint::default(), to: MotionPoint { scale: 2.0, ..Default::default() }, ..Default::default() });
        let mut pan = clip("p", "sq", 2.0, 0.0, 2.0);
        pan.motion = Some(Motion { from: MotionPoint { x: -40.0, ..Default::default() }, to: MotionPoint { x: 40.0, ..Default::default() }, ..Default::default() });
        p.tracks[0].clips.extend([zoom, pan]);
        let out = d.join("motion.mp4");
        run(&p, &ExportSettings::default(), None, &out);
        let white = |t: f64, x: u32| pixel(&out, t, x, 45)[0] > 200;
        // Zoom 1x -> 2x: the square (x 70..90) grows to x 60..100.
        assert!(!white(0.05, 95), "square still small at the start");
        assert!(white(1.95, 95), "square doubled by the end");
        assert!(white(1.0, 70) && !white(1.0, 97), "1.5x half way: x 65..95");
        // Pan -40 -> +40: the square slides from x 30..50 to x 110..130.
        assert!(white(2.05, 40) && !white(2.05, 120), "starts left");
        assert!(white(3.95, 120) && !white(3.95, 40), "ends right");
        assert!(white(3.0, 80), "centred half way");
        // Range export starting mid-clip keeps the motion on the clip's own clock.
        let half = d.join("motion_range.mp4");
        run(&p, &ExportSettings::default(), Some((3.0, 4.0)), &half);
        assert!(pixel(&half, 0.02, 80, 45)[0] > 200, "range starts with the square centred");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn keyframes_move_fade_scale_and_rotate_on_the_clip_clock() {
        if !ffmpeg_ok() { return; }
        let d = tmpdir();
        let keys = |v: &[(f64, f64)]| v.iter().map(|&(t, v)| Key { t, v }).collect::<Vec<_>>();
        // A white 20x20 square, a white frame, and a white 60x10 bar, all on black.
        let square = d.join("square.mp4");
        ff(&["-f", "lavfi", "-i", "color=c=black:s=160x90:r=30:d=8,drawbox=x=70:y=35:w=20:h=20:color=white:t=fill",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", square.to_str().unwrap()]);
        let white = d.join("white.mp4");
        solid(&white, "white", 160, 90, 4.0, None);
        let bar = d.join("bar.mp4");
        ff(&["-f", "lavfi", "-i", "color=c=black:s=160x90:r=30:d=4,drawbox=x=50:y=40:w=60:h=10:color=white:t=fill",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", bar.to_str().unwrap()]);
        let mut p = project(160, 90);
        p.media = vec![media("sq", &square, 160, 90, 8.0, false), media("w", &white, 160, 90, 4.0, false), media("bar", &bar, 160, 90, 4.0, false)];
        // 0-2s: x from -40 to +40 over source 1s..2s (the clip uses source 1s..3s), then holds.
        let mut slide = clip("s", "sq", 0.0, 1.0, 2.0);
        slide.keyframes.x = keys(&[(1.0, -40.0), (2.0, 40.0)]);
        slide.keyframes.y = keys(&[(1.0, 0.0)]);
        // 2-4s: fades in from transparent over its first 2s (2x speed: source 0..4).
        let mut fade = clip("f", "w", 2.0, 0.0, 4.0);
        fade.speed = 2.0;
        fade.keyframes.opacity = keys(&[(0.0, 0.0), (4.0, 1.0)]);
        // 4-6s: scale 1 -> 2.
        let mut grow = clip("g", "sq", 4.0, 0.0, 2.0);
        grow.keyframes.scale = keys(&[(0.0, 1.0), (2.0, 2.0)]);
        // 6-8s: rotate 0 -> 90 degrees.
        let mut turn = clip("r", "bar", 6.0, 0.0, 2.0);
        turn.keyframes.rotation = keys(&[(0.0, 0.0), (2.0, 90.0)]);
        p.tracks[0].clips.extend([slide, fade, grow, turn]);
        let out = d.join("keys.mp4");
        run(&p, &ExportSettings::default(), None, &out);
        let lum = |t: f64, x: u32, y: u32| pixel(&out, t, x, y)[0];
        // Position: x 30..50 at the start, 70..90 half way (source 1.5s), 110..130 from 1s on.
        assert!(lum(0.05, 40, 45) > 200 && lum(0.05, 80, 45) < 60, "starts left");
        assert!(lum(0.5, 80, 45) > 200, "centred half way");
        assert!(lum(1.5, 120, 45) > 200 && lum(1.5, 80, 45) < 60, "holds at the right after its last key");
        // Opacity 0 -> 1 across the clip (keys are on the 2x clip clock).
        let (a, b, c) = (lum(2.05, 80, 45), lum(3.0, 80, 45), lum(3.95, 80, 45));
        assert!(a < 30 && (100..160).contains(&b) && c > 225, "fades in: {a} {b} {c}");
        // Scale: the square grows to x 60..100.
        assert!(lum(4.05, 95, 45) < 60 && lum(5.95, 95, 45) > 200, "grows");
        // Rotation: the horizontal bar ends up vertical.
        assert!(lum(6.05, 105, 45) > 200 && lum(6.05, 80, 20) < 60, "starts horizontal");
        assert!(lum(7.95, 80, 20) > 200 && lum(7.95, 105, 45) < 60, "ends vertical");
        // A range starting mid-clip keeps the keys on the clip's clock.
        let part = d.join("keys_range.mp4");
        run(&p, &ExportSettings::default(), Some((0.5, 4.0)), &part);
        assert!(pixel(&part, 0.02, 80, 45)[0] > 200, "range starts with the square centred");
        assert!((100..160).contains(&pixel(&part, 2.5, 80, 45)[0]), "and the fade half way at 3s");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn eased_keyframes_start_slow() {
        if !ffmpeg_ok() { return; }
        let d = tmpdir();
        let keys = |v: &[(f64, f64)]| v.iter().map(|&(t, v)| Key { t, v }).collect::<Vec<_>>();
        let square = d.join("square.mp4");
        ff(&["-f", "lavfi", "-i", "color=c=black:s=160x90:r=30:d=2,drawbox=x=70:y=35:w=20:h=20:color=white:t=fill",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", square.to_str().unwrap()]);
        let white = d.join("white.mp4");
        solid(&white, "white", 160, 90, 2.0, None);
        let mut p = project(160, 90);
        p.media = vec![media("sq", &square, 160, 90, 2.0, false), media("w", &white, 160, 90, 2.0, false)];
        let mut slide = clip("s", "sq", 0.0, 0.0, 2.0);
        slide.key_ease = true;
        slide.keyframes.x = keys(&[(0.0, -40.0), (2.0, 40.0)]);
        let mut fade = clip("f", "w", 2.0, 0.0, 2.0);
        fade.key_ease = true;
        fade.keyframes.opacity = keys(&[(0.0, 0.0), (2.0, 1.0)]);
        p.tracks[0].clips.extend([slide, fade]);
        let out = d.join("eased.mp4");
        run(&p, &ExportSettings::default(), None, &out);
        // A quarter of the way in, smoothstep has covered 15.6% (linear: 25%): the square's
        // centre is at x ≈ 52.5 (linear: 60), and the white is at ≈ 40 (linear: 64).
        assert!(pixel(&out, 0.5, 45, 45)[0] > 200 && pixel(&out, 0.5, 66, 45)[0] < 60, "eased position");
        assert!(pixel(&out, 1.0, 80, 45)[0] > 200, "half way is still the middle");
        let w = pixel(&out, 2.5, 80, 45)[0];
        assert!((28..52).contains(&w), "eased opacity: {w}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn colour_adjustments_move_picture_stats_as_autocolor_models() {
        if !ffmpeg_ok() { return; }
        let d = tmpdir();
        // A washed-out test pattern; src/lib/autocolor.test.ts holds its measured stats, and
        // matchColor() to the original picks brightness 0.8, contrast 2.28, saturation 1.24.
        let dull = d.join("dull.mp4");
        ff(&["-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=2,eq=contrast=0.55:brightness=0.12:saturation=0.45",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", dull.to_str().unwrap()]);
        let mut p = project(640, 360);
        p.media = vec![media("d", &dull, 640, 360, 2.0, false)];
        let mut c = clip("c", "d", 0.0, 0.0, 2.0);
        c.color = ColorAdjust { brightness: 0.8, contrast: 2.28, saturation: 1.24, ..Default::default() };
        p.tracks[0].clips.push(c);
        let out = d.join("matched.mp4");
        run(&p, &ExportSettings::default(), None, &out);
        let stats = |file: &PathBuf| {
            let o = Command::new("ffmpeg").args(crate::analysis::stats_args(file.to_str().unwrap(), 0.0, 2.0)).output().unwrap();
            crate::analysis::parse_stats(&String::from_utf8_lossy(&o.stderr)).unwrap()
        };
        let s = stats(&out);
        // The model's prediction (and, near enough, the original's own stats).
        assert!((s.low - 0.118).abs() < 0.05 && (s.high - 0.892).abs() < 0.05, "{s:?}");
        assert!((s.sat - 0.862).abs() < 0.12, "{s:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn clean_voice_lowers_the_noise_between_words() {
        if !ffmpeg_ok() { return; }
        let d = tmpdir();
        // "Speech": a 220 Hz buzz with harmonics, 1 s on / 1 s off, over steady hiss and hum.
        let noisy = d.join("noisy.mp4");
        ff(&["-f", "lavfi", "-i", "aevalsrc='(0.5*sin(2*PI*220*t)+0.25*sin(2*PI*440*t)+0.12*sin(2*PI*660*t))*lt(mod(t,2),1)':s=48000:d=8",
             "-f", "lavfi", "-i", "anoisesrc=c=pink:a=0.03:d=8:r=48000", "-f", "lavfi", "-i", "sine=frequency=50:duration=8:sample_rate=48000",
             "-filter_complex", "[0][1][2]amix=inputs=3:normalize=0[a]", "-map", "[a]", "-c:a", "aac", "-b:a", "192k", noisy.to_str().unwrap()]);
        let clean = d.join("clean.m4a");
        let o = Command::new("ffmpeg").args(crate::analysis::clean_voice_args(noisy.to_str().unwrap(), 2.0, 6.0, clean.to_str().unwrap())).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        assert!((duration(&clean) - 6.0).abs() < 0.1);
        // Speech vs the gap after it, before and after (the clean copy starts 2 s in).
        let snr = |file: &PathBuf, t: f64| mean_volume(file, t + 0.2, 0.6) - mean_volume(file, t + 1.3, 0.5);
        let (before, after) = (snr(&noisy, 4.0), snr(&clean, 2.0));
        assert!(after > before + 8.0, "speech-to-noise {before:.1} dB -> {after:.1} dB");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn volume_envelope_ducks_music_on_its_own_clock() {
        if !ffmpeg_ok() { return; }
        let d = tmpdir();
        let music = d.join("music.mp4");
        solid(&music, "black", 160, 90, 12.0, Some(440));
        let mut p = project(160, 90);
        p.media = vec![media("m", &music, 160, 90, 12.0, true)];
        // Ducked to 1/4 between source 4s and 6s (ramps 3.5-4 and 6-6.5), and the clip
        // uses source 2s.. from timeline 1s, so the dip lands at timeline 3s-5s.
        let mut c = clip("c", "m", 1.0, 2.0, 8.0);
        c.volume_points = vec![
            VolumePoint { t: 3.5, gain: 1.0 },
            VolumePoint { t: 4.0, gain: 0.25 },
            VolumePoint { t: 6.0, gain: 0.25 },
            VolumePoint { t: 6.5, gain: 1.0 },
        ];
        p.tracks[2].clips.push(c);
        let out = d.join("duck.mp4");
        run(&p, &ExportSettings::default(), None, &out);
        let (full, ducked, after) = (mean_volume(&out, 1.5, 0.5), mean_volume(&out, 3.5, 1.0), mean_volume(&out, 6.0, 0.5));
        assert!((full - ducked - 12.0).abs() < 1.5, "ducked by ~12 dB: {full} -> {ducked}");
        assert!((full - after).abs() < 1.0, "back up after: {full} vs {after}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn envelope_expression_keeps_only_what_shapes_the_span() {
        let pts = |v: &[(f64, f64)]| v.iter().map(|&(t, gain)| VolumePoint { t, gain }).collect::<Vec<_>>();
        assert_eq!(envelope(&pts(&[(0.0, 1.0), (9.0, 1.0)]), 0.0, 1.0, 5.0), None);
        assert_eq!(envelope(&[], 0.0, 1.0, 5.0), None);
        // Only (4, 0.5) and (20, 1) matter for source 5..10 at 2x speed (t = 0..2.5).
        let e = envelope(&pts(&[(1.0, 1.0), (4.0, 0.5), (20.0, 1.0), (30.0, 0.0)]), 5.0, 2.0, 2.5).unwrap();
        assert_eq!(e, "0.5*lt(t,-0.5)+gte(t,-0.5)*lt(t,7.5)*(0.5+0.5*(t+0.5)/8)+1*gte(t,7.5)");
    }

    #[test]
    fn timed_motion_eases_in_then_holds() {
        if !ffmpeg_ok() { return; }
        let d = tmpdir();
        let src = d.join("square.mp4");
        ff(&["-f", "lavfi", "-i", "color=c=black:s=160x90:r=30:d=3,drawbox=x=70:y=35:w=20:h=20:color=white:t=fill",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", src.to_str().unwrap()]);
        let mut p = project(160, 90);
        p.media = vec![media("sq", &src, 160, 90, 3.0, false)];
        // A "pop": 0.5x -> 1x over the first second, easing out, then held.
        let mut c = clip("c", "sq", 0.0, 0.0, 3.0);
        c.motion = Some(Motion { from: MotionPoint { scale: 0.5, ..Default::default() }, to: MotionPoint::default(), duration: 1.0, ease_out: true });
        p.tracks[0].clips.push(c);
        let out = d.join("pop.mp4");
        run(&p, &ExportSettings::default(), None, &out);
        let white = |t: f64, x: u32| pixel(&out, t, x, 45)[0] > 200;
        assert!(!white(0.02, 87), "starts at half size (x 75..85)");
        // Eased: 1-(1-0.4)^3 = 0.78 of the way at 0.4s -> scale 0.89 (x ~71..89).
        assert!(white(0.4, 87), "well on its way after 0.4s thanks to the ease");
        assert!(white(2.0, 88) && !white(2.0, 92), "held at full size (x 70..90)");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn blur_backdrop_fills_the_bars() {
        if !ffmpeg_ok() { return; }
        let d = tmpdir();
        let src = d.join("wide.mp4");
        solid(&src, "green", 160, 90, 2.0, None);
        // Landscape footage in a portrait frame: bars above and below.
        let mut p = project(90, 160);
        p.media = vec![media("w", &src, 160, 90, 2.0, false)];
        p.tracks[0].clips.push(clip("c", "w", 0.0, 0.0, 2.0));
        let plain = d.join("bars.mp4");
        run(&p, &ExportSettings::default(), None, &plain);
        assert!(pixel(&plain, 1.0, 45, 10)[1] < 30, "bars are the black background");
        p.tracks[0].clips[0].backdrop = Some(Backdrop::Blur);
        p.tracks[0].clips[0].fade_in = 0.5;
        let filled = d.join("filled.mp4");
        run(&p, &ExportSettings::default(), None, &filled);
        let top = pixel(&filled, 1.0, 45, 10);
        assert!(top[1] > 90 && top[0] < 60, "bars show the blurred clip: {top:?}");
        assert!(pixel(&filled, 1.0, 45, 80)[1] > 90, "clip itself in the middle");
        assert!(pixel(&filled, 0.05, 45, 10)[1] < 30, "the backdrop fades in with the clip");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn frame_hold_shows_one_frame_silently() {
        if !ffmpeg_ok() { return; }
        let d = tmpdir();
        // Red for 2s then blue for 2s, with a tone throughout.
        let src = d.join("rb.mp4");
        two_colors(&src, "red", 2.0, "blue", 2.0, 440);
        let mut p = project(160, 90);
        p.media = vec![media("rb", &src, 160, 90, 4.0, true)];
        // Hold the frame at source 1.5s (red) for 2s on the timeline, then play on from 1.5s.
        let mut hold = clip("h", "rb", 1.0, 1.5, 2.0);
        hold.freeze = true;
        hold.muted = true;
        p.tracks[0].clips.extend([clip("a", "rb", 0.0, 0.5, 1.0), hold, clip("b", "rb", 3.0, 1.5, 2.0)]);
        let out = d.join("hold.mp4");
        run(&p, &ExportSettings::default(), None, &out);
        // Through the hold it stays red although the source has turned blue by then.
        for t in [1.2, 2.5, 2.9] {
            let c = pixel(&out, t, 80, 45);
            assert!(c[0] > 200 && c[2] < 60, "held red at {t}: {c:?}");
        }
        assert!(pixel(&out, 3.8, 80, 45)[2] > 200, "plays on into the blue part");
        assert!(mean_volume(&out, 1.2, 1.6) < -60.0, "the hold is silent");
        assert!(mean_volume(&out, 0.2, 0.6) > -40.0, "sound around it");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn empty_timeline_is_an_error() {
        let p = project(640, 360);
        assert!(build(&p, &ExportSettings::default(), None, &HashMap::new(), "/tmp/x.mp4").is_err());
    }

    #[test]
    fn color_matrices_are_identity_at_defaults() {
        assert!(color_filters(&ColorAdjust::default()).is_empty());
        let gray = color_filters(&ColorAdjust { saturation: 0.0, ..Default::default() });
        assert_eq!(gray.len(), 1);
        assert!(gray[0].starts_with("colorchannelmixer=rr=0.213:rg=0.715:rb=0.072"));
    }
}

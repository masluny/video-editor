use crate::engine::timeline::{Clip, Project, TrackKind};

struct FilterContext {
    video_inputs: usize,
    audio_inputs: usize,
    video_filters: Vec<String>,
    audio_filters: Vec<String>,
    video_labels: Vec<String>,
    audio_labels: Vec<String>,
}

pub fn build_export_args(
    project: &Project,
    media_map: &std::collections::HashMap<String, String>,
    output_path: &str,
    range_in: Option<f64>,
    range_out: Option<f64>,
) -> Vec<String> {
    let mut args: Vec<String> = vec![];
    let mut ctx = FilterContext {
        video_inputs: 0,
        audio_inputs: 0,
        video_filters: vec![],
        audio_filters: vec![],
        video_labels: vec![],
        audio_labels: vec![],
    };

    // When an export range is set, filter and trim clips to only include content
    // within [range_in, range_out]. Clips fully outside are dropped; partially
    // overlapping clips have their source_in/source_out and timeline_start adjusted.
    let trim_clip_to_range = |clip: &Clip, ri: f64, ro: f64| -> Option<Clip> {
        let clip_end = clip.timeline_start + (clip.source_out - clip.source_in) / clip.speed as f64;
        // Fully outside the range
        if clip.timeline_start >= ro || clip_end <= ri {
            return None;
        }
        let mut c = clip.clone();
        // Trim the head if clip starts before range_in
        if c.timeline_start < ri {
            let cut = ri - c.timeline_start;
            c.source_in += cut * c.speed as f64;
            c.timeline_start = ri;
        }
        // Trim the tail if clip ends after range_out
        let new_end = c.timeline_start + (c.source_out - c.source_in) / c.speed as f64;
        if new_end > ro {
            let excess = new_end - ro;
            c.source_out -= excess * c.speed as f64;
        }
        // Shift timeline so output starts at 0
        c.timeline_start -= ri;
        Some(c)
    };

    let filter_track_clips = |clips: &[Clip]| -> Vec<Clip> {
        match (range_in, range_out) {
            (Some(ri), Some(ro)) => clips.iter().filter_map(|c| trim_clip_to_range(c, ri, ro)).collect(),
            (Some(ri), None) => {
                let ro = f64::MAX;
                clips.iter().filter_map(|c| trim_clip_to_range(c, ri, ro)).collect()
            },
            (None, Some(ro)) => clips.iter().filter_map(|c| trim_clip_to_range(c, 0.0, ro)).collect(),
            (None, None) => clips.to_vec(),
        }
    };

    // Build range-filtered copies of tracks for export
    use crate::engine::timeline::Track;
    let make_filtered_tracks = |kind: TrackKind| -> Vec<Track> {
        project.tracks.iter()
            .filter(|t| t.kind == kind)
            .map(|t| {
                let mut t2 = t.clone();
                t2.clips = filter_track_clips(&t.clips);
                t2
            })
            .collect()
    };

    let video_tracks_owned = make_filtered_tracks(TrackKind::Video);
    let audio_tracks_owned = make_filtered_tracks(TrackKind::Audio);
    let video_tracks: Vec<&Track> = video_tracks_owned.iter().collect();
    let audio_tracks: Vec<&Track> = audio_tracks_owned.iter().collect();

    // Whether a clip's source actually carries an audio stream. Referencing
    // `[idx:a]` for a source without audio makes ffmpeg abort the whole export.
    let media_has_audio = |media_id: &str| -> bool {
        project.media.iter().any(|m| m.id == media_id && m.has_audio)
    };

    for track in &video_tracks {
        for clip in &track.clips {
            add_clip_inputs(&mut args, clip, media_map, &mut ctx, true);
        }
    }
    for track in &audio_tracks {
        for clip in &track.clips {
            add_clip_inputs(&mut args, clip, media_map, &mut ctx, false);
        }
    }

    if ctx.video_inputs == 0 && ctx.audio_inputs == 0 {
        return vec![];
    }

    let mut vidx = 0usize;
    let mut first_video_track_processed = false;
    let mut audio_from_video_clips: Vec<String> = vec![];

    for (ti, track) in video_tracks.iter().enumerate() {
        let mut track_clips: Vec<&Clip> = track.clips.iter().collect();
        if track_clips.is_empty() { continue; }
        track_clips.sort_by(|a, b| a.timeline_start.partial_cmp(&b.timeline_start).unwrap_or(std::cmp::Ordering::Equal));

        // Only produce video output for the first video track (others could be overlays later)
        if ti > 0 && first_video_track_processed {
            // still need to consume the input indices and optionally pull their audio
            for clip in &track_clips {
                let input_idx = vidx;
                vidx += 1;
                // Try to grab audio from this video clip too (for cases with multiple V tracks)
                if !media_has_audio(&clip.media_id) { continue; }
                let a_out = format!("av{}{}", track.id.chars().take(4).collect::<String>(), input_idx);
                let mut af = format!("[{input_idx}:a]");
                af.push_str(&atempo_expr(clip.speed));
                af.push_str(&format!(",volume={}", if clip.muted { 0.0 } else { clip.volume }));
                if let Some(fi) = clip.fade_in { af.push_str(&format!(",afade=t=in:st=0:d={fi:.3}")); }
                if let Some(fo) = clip.fade_out {
                    let d = (clip.source_out - clip.source_in) / clip.speed as f64;
                    let st = (d - fo).max(0.0);
                    af.push_str(&format!(",afade=t=out:st={st:.3}:d={fo:.3}"));
                }
                af.push_str(&format!("[{a_out}]"));
                ctx.audio_filters.push(af);
                audio_from_video_clips.push(a_out);
            }
            continue;
        }

        first_video_track_processed = true;

        // Build segments with gap fillers for correct timeline
        let mut segments: Vec<String> = vec![]; // labels in concat order
        let mut cur_time = 0.0f64;

        for (i, clip) in track_clips.iter().enumerate() {
            let gap = clip.timeline_start - cur_time;
            if gap > 0.0005 {
                // insert black filler for video (matched to the project's fps/format/SAR so concat accepts it)
                let filler = format!("fv{t}{i}", t=track.id.chars().take(4).collect::<String>(), i=i);
                ctx.video_filters.push(format!(
                    "color=c=black:s={}x{}:r={:.5}:d={:.6},format=yuv420p,setsar=1[{}]",
                    project.width, project.height, project.fps, gap, filler
                ));
                segments.push(filler);
                cur_time += gap;
            }

            let input_idx = vidx;
            vidx += 1;

            let v_out = format!("vt{}{}", track.id.chars().take(4).collect::<String>(), i);

            let mut chain = format!("[{input_idx}:v]");
            chain.push_str(&format!("setpts=PTS*{}", 1.0 / clip.speed as f64));

            // Normalize to project resolution (letterbox if needed) AND to a single
            // fps + pixel format + SAR. Concat demands every segment share these.
            chain.push_str(&format!(
                ",scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps:.5},format=yuv420p",
                w = project.width,
                h = project.height,
                fps = project.fps
            ));

            if clip.color.brightness != 0.0 || clip.color.contrast != 1.0 || clip.color.saturation != 1.0 || clip.color.gamma != 1.0 {
                chain.push_str(&format!(
                    ",eq=brightness={}:contrast={}:saturation={}:gamma={}",
                    clip.color.brightness, clip.color.contrast, clip.color.saturation, clip.color.gamma
                ));
            }
            if clip.color.hue != 0.0 {
                chain.push_str(&format!(",hue=h={}", clip.color.hue));
            }
            if clip.color.blur > 0.0 {
                chain.push_str(&format!(",gblur=sigma={}", clip.color.blur));
            }
            if let Some(fi) = clip.fade_in {
                chain.push_str(&format!(",fade=t=in:st=0:d={fi:.3}"));
            }
            if let Some(fo) = clip.fade_out {
                let d = (clip.source_out - clip.source_in) / clip.speed as f64;
                let st = (d - fo).max(0.0);
                chain.push_str(&format!(",fade=t=out:st={st:.3}:d={fo:.3}"));
            }
            if let Some(ref txt) = clip.text {
                if !txt.text.is_empty() {
                    let escaped = txt.text.replace('\'', "'\\''").replace(':', "\\:");
                    // x/y in UI are 0-100 (percent of frame). Convert to expressions.
                    chain.push_str(&format!(
                        ",drawtext=text='{}':fontsize={}:fontcolor={}:x='(w*{x}/100)':y='(h*{y}/100)'",
                        escaped, txt.font_size as i32, txt.color, x = txt.x, y = txt.y
                    ));
                }
            }
            // Note: per-clip transform (scale/pos/rot) and opacity are approximated in preview only for now.
            chain.push_str(&format!("[{}]", v_out));
            ctx.video_filters.push(chain);
            segments.push(v_out);

            // Also extract audio from this video clip's input so it is not lost
            // (only if the source actually has an audio stream).
            if media_has_audio(&clip.media_id) {
                let a_out = format!("av{}{}", track.id.chars().take(4).collect::<String>(), i);
                let mut af = format!("[{input_idx}:a]{}", atempo_expr(clip.speed));
                af.push_str(&format!(",volume={}", if clip.muted { 0.0 } else { clip.volume }));
                if let Some(fi) = clip.fade_in { af.push_str(&format!(",afade=t=in:st=0:d={fi:.3}")); }
                if let Some(fo) = clip.fade_out {
                    let d = (clip.source_out - clip.source_in) / clip.speed as f64;
                    let st = (d - fo).max(0.0);
                    af.push_str(&format!(",afade=t=out:st={st:.3}:d={fo:.3}"));
                }
                af.push_str(&format!("[{}]", a_out));
                ctx.audio_filters.push(af);
                audio_from_video_clips.push(a_out);
            }

            cur_time = clip.timeline_start + (clip.source_out - clip.source_in) / clip.speed as f64;
        }

        if !segments.is_empty() {
            let concat_inputs = segments.iter().map(|l| format!("[{l}]")).collect::<Vec<_>>().join("");
            let out_label = format!("vmain{}", track.id.chars().take(4).collect::<String>());
            ctx.video_filters.push(format!(
                "{}concat=n={}:v=1:a=0[{}]",
                concat_inputs, segments.len(), out_label
            ));
            ctx.video_labels.push(out_label);
        }
    }

    let mut aidx = vidx;
    for track in &audio_tracks {
        let mut track_clips: Vec<&Clip> = track.clips.iter().collect();
        if track_clips.is_empty() { continue; }
        track_clips.sort_by(|a, b| a.timeline_start.partial_cmp(&b.timeline_start).unwrap_or(std::cmp::Ordering::Equal));

        let mut stream_labels: Vec<String> = vec![];
        let mut cur_time = 0.0f64;

        for (i, clip) in track_clips.iter().enumerate() {
            let gap = clip.timeline_start - cur_time;
            if gap > 0.0005 {
                // silence filler
                let filler = format!("fa{}{}", track.id.chars().take(4).collect::<String>(), i);
                ctx.audio_filters.push(format!("anullsrc=channel_layout=stereo:sample_rate=48000:d={:.6}[{}]", gap, filler));
                stream_labels.push(filler);
                cur_time += gap;
            }

            let input_idx = aidx;
            aidx += 1;

            let a_out = format!("at{}{}", track.id.chars().take(4).collect::<String>(), i);
            let dur = (clip.source_out - clip.source_in) / clip.speed as f64;

            if media_has_audio(&clip.media_id) {
                // atempo only accepts 0.5..2.0 per instance; chain for extreme speeds.
                let mut chain = format!("[{input_idx}:a]{}", atempo_expr(clip.speed));
                chain.push_str(&format!(",volume={}", if clip.muted { 0.0 } else { clip.volume }));
                if let Some(fi) = clip.fade_in {
                    chain.push_str(&format!(",afade=t=in:st=0:d={fi:.3}"));
                }
                if let Some(fo) = clip.fade_out {
                    let st = (dur - fo).max(0.0);
                    chain.push_str(&format!(",afade=t=out:st={st:.3}:d={fo:.3}"));
                }
                chain.push_str(&format!("[{a_out}]"));
                ctx.audio_filters.push(chain);
            } else {
                // Source carries no audio — emit matching silence to preserve timing.
                ctx.audio_filters.push(format!(
                    "anullsrc=channel_layout=stereo:sample_rate=48000:d={:.6}[{}]",
                    dur, a_out
                ));
            }
            stream_labels.push(a_out);

            cur_time = clip.timeline_start + dur;
        }

        if stream_labels.len() > 1 {
            let concat_inputs = stream_labels.iter().map(|l| format!("[{l}]")).collect::<Vec<_>>().join("");
            let out_label = format!("amain{}", track.id.chars().take(4).collect::<String>());
            ctx.audio_filters.push(format!(
                "{}concat=n={}:v=0:a=1[{}]",
                concat_inputs, stream_labels.len(), out_label
            ));
            ctx.audio_labels.push(out_label);
        } else if let Some(l) = stream_labels.into_iter().next() {
            ctx.audio_labels.push(l);
        }
    }

    // Mix all audio sources we collected (dedicated audio tracks + audio extracted from video clips)
    let mut all_audio: Vec<String> = vec![];
    all_audio.extend(ctx.audio_labels.clone());
    all_audio.extend(audio_from_video_clips.clone());

    if all_audio.len() > 1 {
        let inputs = all_audio.iter().map(|l| format!("[{l}]")).collect::<String>();
        let mixed = "aout".to_string();
        ctx.audio_filters.push(format!("{}amix=inputs={}:duration=longest:normalize=0[{}]", inputs, all_audio.len(), mixed));
        ctx.audio_labels = vec![mixed];
    } else if all_audio.len() == 1 {
        ctx.audio_labels = all_audio;
    }

    // Build filter_complex
    let mut filter_complex = String::new();
    filter_complex.push_str(&ctx.video_filters.join(";"));
    if !ctx.audio_filters.is_empty() {
        if !filter_complex.is_empty() { filter_complex.push(';'); }
        filter_complex.push_str(&ctx.audio_filters.join(";"));
    }

    if !filter_complex.is_empty() {
        args.push("-filter_complex".into());
        args.push(filter_complex);
    }

    // Map outputs
    for label in &ctx.video_labels {
        args.push("-map".into());
        args.push(format!("[{label}]"));
    }
    for label in &ctx.audio_labels {
        args.push("-map".into());
        args.push(format!("[{label}]"));
    }
    if ctx.video_labels.is_empty() && ctx.audio_labels.is_empty() {
        if ctx.video_inputs > 0 { args.push("-map".into()); args.push("0:v".into()); }
        if ctx.audio_inputs > 0 { args.push("-map".into()); args.push("0:a".into()); }
    }

    args.push("-c:v".into()); args.push("libx264".into());
    args.push("-preset".into()); args.push("medium".into());
    args.push("-crf".into()); args.push("23".into());
    args.push("-c:a".into()); args.push("aac".into());
    args.push("-b:a".into()); args.push("192k".into());
    args.push("-movflags".into()); args.push("+faststart".into());
    args.push("-y".into());
    args.push(output_path.into());

    args
}

fn atempo_expr(speed: f32) -> String {
    if speed <= 0.0 {
        return "atempo=1".to_string();
    }
    let mut s = speed as f64;
    let mut parts: Vec<String> = vec![];
    // atempo range is [0.5, 2.0] per instance; chain as needed
    while s < 0.5 {
        parts.push("atempo=0.5".to_string());
        s /= 0.5;
    }
    while s > 2.0 {
        parts.push("atempo=2".to_string());
        s /= 2.0;
    }
    parts.push(format!("atempo={:.6}", s));
    parts.join(",")
}

fn add_clip_inputs(
    args: &mut Vec<String>,
    clip: &Clip,
    media_map: &std::collections::HashMap<String, String>,
    ctx: &mut FilterContext,
    is_video: bool,
) {
    let path = media_map.get(&clip.media_id).cloned().unwrap_or_default();
    if path.is_empty() { return; }

    args.push("-ss".into());
    args.push(format!("{:.6}", clip.source_in));
    args.push("-t".into());
    args.push(format!("{:.6}", clip.source_out - clip.source_in));
    args.push("-i".into());
    args.push(path);

    if is_video {
        ctx.video_inputs += 1;
    } else {
        ctx.audio_inputs += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::build_export_args;
    use crate::engine::timeline::{Clip, MediaAsset, Project, TrackKind};
    use std::collections::HashMap;
    use std::process::Command;

    fn ffmpeg_available() -> bool {
        Command::new("ffmpeg").arg("-version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn gen_input(path: &str, with_audio: bool, dur: f64) {
        let mut args: Vec<String> = vec![
            "-y".into(),
            "-f".into(), "lavfi".into(),
            "-i".into(), format!("testsrc=size=320x240:rate=30:duration={dur}"),
        ];
        if with_audio {
            args.push("-f".into()); args.push("lavfi".into());
            args.push("-i".into()); args.push(format!("sine=frequency=440:duration={dur}"));
        }
        args.push("-t".into()); args.push(format!("{dur}"));
        args.push("-pix_fmt".into()); args.push("yuv420p".into());
        args.push(path.into());
        let out = Command::new("ffmpeg").args(&args).output().expect("spawn ffmpeg");
        assert!(out.status.success(), "input gen failed: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn vclip(media_id: &str, start: f64, len: f64) -> Clip {
        let mut c = Clip::new(media_id.to_string());
        c.source_in = 0.0;
        c.source_out = len;
        c.timeline_start = start;
        c
    }

    // Exercises the real ffmpeg filtergraph: concat of two clips (one of which has
    // NO audio stream — must not abort export) plus an audio-track clip (amix path).
    #[test]
    fn export_graph_runs_with_real_ffmpeg() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not available; skipping export graph test");
            return;
        }

        let dir = std::env::temp_dir().join(format!("vedit_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let in_a = dir.join("a.mp4");
        let in_b = dir.join("b.mp4");
        gen_input(in_a.to_str().unwrap(), true, 2.0); // has audio
        gen_input(in_b.to_str().unwrap(), false, 2.0); // video only

        let mut project = Project::default();
        project.width = 640;
        project.height = 360;
        project.fps = 30.0;
        project.media.push(MediaAsset {
            id: "media-a".into(), path: in_a.to_string_lossy().into(), name: "a".into(),
            duration_sec: 2.0, width: 320, height: 240, fps: 30.0,
            has_video: true, has_audio: true, thumbnail: None,
        });
        project.media.push(MediaAsset {
            id: "media-b".into(), path: in_b.to_string_lossy().into(), name: "b".into(),
            duration_sec: 2.0, width: 320, height: 240, fps: 30.0,
            has_video: true, has_audio: false, thumbnail: None,
        });

        for t in project.tracks.iter_mut() {
            match t.kind {
                TrackKind::Video => {
                    t.clips.push(vclip("media-a", 0.0, 2.0));
                    t.clips.push(vclip("media-b", 2.0, 2.0));
                }
                TrackKind::Audio => {
                    t.clips.push(vclip("media-a", 0.0, 2.0));
                }
            }
        }

        let media_map: HashMap<String, String> =
            project.media.iter().map(|m| (m.id.clone(), m.path.clone())).collect();
        let out = dir.join("out.mp4");
        let args = build_export_args(&project, &media_map, out.to_str().unwrap(), None, None);
        assert!(!args.is_empty(), "export args were empty");

        let result = Command::new("ffmpeg").args(&args).output().expect("spawn ffmpeg export");
        let ok = result.status.success();
        let produced = out.exists() && std::fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false);
        let stderr = String::from_utf8_lossy(&result.stderr).into_owned();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(ok && produced, "export failed.\nARGS: {:?}\n\nSTDERR:\n{}", args, stderr);
    }

    // Exercises gap fillers (black video + silence audio concatenated with real
    // segments) and atempo chaining for an out-of-range (4x) speed.
    #[test]
    fn export_graph_handles_gaps_and_speed() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not available; skipping gap/speed test");
            return;
        }

        let dir = std::env::temp_dir().join(format!("vedit_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let in_a = dir.join("a.mp4");
        gen_input(in_a.to_str().unwrap(), true, 3.0);

        let mut project = Project::default();
        project.media.push(MediaAsset {
            id: "media-a".into(), path: in_a.to_string_lossy().into(), name: "a".into(),
            duration_sec: 3.0, width: 320, height: 240, fps: 30.0,
            has_video: true, has_audio: true, thumbnail: None,
        });

        for t in project.tracks.iter_mut() {
            match t.kind {
                TrackKind::Video => {
                    // Starts at 1.0s -> leading black gap; 4x speed -> atempo chain on audio.
                    let mut c = vclip("media-a", 1.0, 2.0);
                    c.speed = 4.0;
                    t.clips.push(c);
                }
                TrackKind::Audio => {
                    // Two clips with a gap between -> silence filler concatenated with real audio.
                    t.clips.push(vclip("media-a", 0.0, 1.0));
                    t.clips.push(vclip("media-a", 2.5, 1.0));
                }
            }
        }

        let media_map: HashMap<String, String> =
            project.media.iter().map(|m| (m.id.clone(), m.path.clone())).collect();
        let out = dir.join("out.mp4");
        let args = build_export_args(&project, &media_map, out.to_str().unwrap(), None, None);

        let result = Command::new("ffmpeg").args(&args).output().expect("spawn ffmpeg export");
        let ok = result.status.success();
        let produced = out.exists() && std::fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false);
        let stderr = String::from_utf8_lossy(&result.stderr).into_owned();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(ok && produced, "gap/speed export failed.\nARGS: {:?}\n\nSTDERR:\n{}", args, stderr);
    }
}

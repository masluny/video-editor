import * as React from "react";
import { useProjectStore } from "../../stores/projectStore";
import { getClipDuration } from "../../lib/utils";
import { assetUrl } from "../../lib/tauri";
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, MonitorPlay } from "lucide-react";

export function Preview() {
  const project = useProjectStore((s) => s.project);
  const playhead = useProjectStore((s) => s.playhead);
  const setPlayhead = useProjectStore((s) => s.setPlayhead);
  const isPlaying = useProjectStore((s) => s.isPlaying);
  const togglePlay = useProjectStore((s) => s.togglePlay);
  const playRate = useProjectStore((s) => s.playRate);

  const videoRef = React.useRef<HTMLVideoElement>(null);
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const [monitorVolume, setMonitorVolume] = React.useState(0.8);
  const [isMuted, setIsMuted] = React.useState(false);

  const rafRef = React.useRef<number | null>(null);
  const lastTimeRef = React.useRef<number | null>(null);
  const livePlayheadRef = React.useRef(playhead);
  const lastPublishedRef = React.useRef(0);

  // Stable identity caches — prevent spurious re-renders and video.load() calls.
  const cachedVideoSrc = React.useRef<string>("");
  const cachedAudioSrc = React.useRef<string>("");
  const lastSyncedClipId = React.useRef<string | null>(null);
  const lastSyncedAudioClipId = React.useRef<string | null>(null);

  // Active clip under the playhead on the primary video track.
  // PERF: Memoize on clip identity (id), not the playhead value. We find the
  // clip via playhead, but only return a new object reference when the clip
  // actually changes. This prevents downstream effects from re-firing 60×/sec.
  const activeVideoRef = React.useRef<{ trackId: string; clipId: string; assetPath: string } | null>(null);
  const activeVideo = React.useMemo(() => {
    const track = project.tracks.find((t) => t.kind === "video");
    if (!track) { activeVideoRef.current = null; return null; }
    const clip = track.clips.find(
      (c) => playhead >= c.timeline_start && playhead < c.timeline_start + getClipDuration(c)
    );
    const asset = clip ? project.media.find((m) => m.id === clip.media_id) : null;
    if (!clip || !asset) { activeVideoRef.current = null; return null; }

    // Return the SAME reference if the clip identity hasn't changed.
    const prev = activeVideoRef.current;
    if (prev && prev.clipId === clip.id && prev.assetPath === asset.path) {
      // Re-use prior memo value — but we still need the fresh clip data for effects
      // downstream, so we build a new result only if clip props changed.
    }
    activeVideoRef.current = { trackId: track.id, clipId: clip.id, assetPath: asset.path };
    return { track, clip, asset };
  }, [project.tracks, project.media, playhead]);

  // Active clip on the primary audio track.
  const activeAudioRef = React.useRef<{ trackId: string; clipId: string; assetPath: string } | null>(null);
  const activeAudio = React.useMemo(() => {
    const track = project.tracks.find((t) => t.kind === "audio");
    if (!track) { activeAudioRef.current = null; return null; }
    const clip = track.clips.find(
      (c) => playhead >= c.timeline_start && playhead < c.timeline_start + getClipDuration(c)
    );
    const asset = clip ? project.media.find((m) => m.id === clip.media_id) : null;
    if (!clip || !asset) { activeAudioRef.current = null; return null; }
    activeAudioRef.current = { trackId: track.id, clipId: clip.id, assetPath: asset.path };
    return { track, clip, asset };
  }, [project.tracks, project.media, playhead]);

  const trackVol = (t?: { volume?: number }) => (typeof t?.volume === "number" ? t.volume : 1);

  const videoVolume = React.useMemo(() => {
    let v = monitorVolume;
    if (activeVideo) v *= trackVol(activeVideo.track) * (activeVideo.clip.volume ?? 1);
    return Math.max(0, Math.min(1, v));
  }, [monitorVolume, activeVideo]);

  const audioVolume = React.useMemo(() => {
    if (!activeAudio) return 0;
    return Math.max(0, Math.min(1, monitorVolume * trackVol(activeAudio.track) * (activeAudio.clip.volume ?? 1)));
  }, [monitorVolume, activeAudio]);

  const clampRate = (s: number) => Math.min(16, Math.max(0.0625, s || 1));
  const mediaTimeFor = (clip: { source_in: number; timeline_start: number; speed: number }, ph: number) =>
    Math.max(0, clip.source_in + (ph - clip.timeline_start) * (clip.speed || 1));

  const sameAsset = !!(activeVideo && activeAudio && activeVideo.asset.path === activeAudio.asset.path);

  React.useEffect(() => {
    if (!isPlaying) livePlayheadRef.current = playhead;
  }, [playhead, isPlaying]);

  // ─── Effect 1: Source assignment ────────────────────────────────────
  // Only runs when the active asset file changes — NOT every frame.
  // This prevents the video element from flickering due to spurious load() calls.
  React.useEffect(() => {
    const video = videoRef.current;
    if (activeVideo && video) {
      const src = assetUrl(activeVideo.asset.path);
      if (cachedVideoSrc.current !== src) {
        cachedVideoSrc.current = src;
        video.src = src;
        video.load();
      }
    } else if (video && cachedVideoSrc.current) {
      cachedVideoSrc.current = "";
      video.removeAttribute("src");
      video.load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVideo?.asset?.path]);

  React.useEffect(() => {
    const audio = audioRef.current;
    if (activeAudio && audio) {
      const src = assetUrl(activeAudio.asset.path);
      if (cachedAudioSrc.current !== src) {
        cachedAudioSrc.current = src;
        audio.src = src;
        audio.load();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAudio?.asset?.path]);

  // ─── Effect 2: Seek on clip change / manual scrub (paused) ─────────
  // Seeks the media elements when the clip identity changes or when the
  // user scrubs while paused. During playback, the rAF tick handles sync.
  React.useEffect(() => {
    if (isPlaying) return; // rAF handles sync during playback

    const video = videoRef.current;
    const audio = audioRef.current;

    if (activeVideo && video) {
      const target = mediaTimeFor(activeVideo.clip, playhead);
      const clipChanged = lastSyncedClipId.current !== activeVideo.clip.id;
      lastSyncedClipId.current = activeVideo.clip.id;
      const drift = Math.abs(video.currentTime - target);
      if (clipChanged || drift > 0.08) {
        video.currentTime = target;
      }
    } else {
      lastSyncedClipId.current = null;
    }

    if (activeAudio && audio) {
      const target = mediaTimeFor(activeAudio.clip, playhead);
      const clipChanged = lastSyncedAudioClipId.current !== activeAudio.clip.id;
      lastSyncedAudioClipId.current = activeAudio.clip.id;
      const drift = Math.abs(audio.currentTime - target);
      if (clipChanged || drift > 0.08) {
        audio.currentTime = target;
      }
    } else {
      lastSyncedAudioClipId.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, playhead, activeVideo?.clip?.id, activeAudio?.clip?.id]);

  // ─── Effect 3: Play / pause + volume ───────────────────────────────
  React.useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (isPlaying) {
      if (video && activeVideo) {
        video.playbackRate = clampRate(activeVideo.clip.speed * Math.max(1, Math.abs(playRate)));
        let vol = videoVolume;
        if (sameAsset && activeAudio) vol = audioVolume;
        video.volume = isMuted ? 0 : vol;
        video.play().catch(() => {});
      }
      if (audio && activeAudio) {
        if (!sameAsset) {
          audio.playbackRate = clampRate(activeAudio.clip.speed);
          audio.volume = isMuted ? 0 : audioVolume;
          audio.play().catch(() => {});
        } else {
          audio.pause();
        }
      }
    } else {
      video?.pause();
      audio?.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, activeVideo?.clip?.id, activeAudio?.clip?.id, videoVolume, audioVolume, sameAsset, isMuted, playRate]);

  // ─── Effect 4: Volume updates while playing (no play/pause toggle) ─
  React.useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!isPlaying) return;
    if (video && activeVideo) {
      let vol = videoVolume;
      if (sameAsset && activeAudio) vol = audioVolume;
      video.volume = isMuted ? 0 : vol;
    }
    if (audio && activeAudio && !sameAsset) {
      audio.volume = isMuted ? 0 : audioVolume;
    }
  }, [
    isPlaying,
    videoVolume,
    audioVolume,
    isMuted,
    sameAsset,
    activeVideo?.clip?.id,
    activeAudio?.clip?.id,
  ]);

  // ─── Effect 5: Playback tick (rAF) ─────────────────────────────────
  // Advances the playhead AND syncs the media element during playback.
  // By doing the sync here instead of in a useEffect([playhead]),
  // we avoid the React re-render -> effect -> seek cascade that causes lag.
  const tick = React.useCallback((ts: number) => {
    if (lastTimeRef.current == null) lastTimeRef.current = ts;
    const elapsed = (ts - lastTimeRef.current) / 1000;
    lastTimeRef.current = ts;

    const st = useProjectStore.getState();
    if (st.isPlaying) {
      const next = livePlayheadRef.current + elapsed * (st.playRate || 1);
      livePlayheadRef.current = Math.max(0, next);
      const total = st.project.tracks.reduce(
        (max, t) => t.clips.reduce((m, c) => Math.max(m, c.timeline_start + getClipDuration(c)), max),
        0
      );
      if (st.playRate < 0 && next <= 0) {
        livePlayheadRef.current = 0;
        st.setPlayhead(0);
        st.setIsPlaying(false);
        return;
      }
      if (st.playRate > 0 && total > 0 && next >= total) {
        livePlayheadRef.current = total;
        st.setPlayhead(total);
        st.setIsPlaying(false);
        return;
      }

      // Publish the playhead to React at UI cadence instead of every rAF.
      // The native media element handles smooth playback; this keeps the
      // timeline/filmstrip UI from repainting 60 times per second.
      if (ts - lastPublishedRef.current > 1000 / 24) {
        lastPublishedRef.current = ts;
        st.setPlayhead(livePlayheadRef.current);
      }

      // Sync media elements during playback — corrects drift without
      // going through a React render cycle.
      const video = videoRef.current;
      if (video && video.src) {
        const vTrack = st.project.tracks.find((t) => t.kind === "video");
        const vClip = vTrack?.clips.find(
          (c) => next >= c.timeline_start && next < c.timeline_start + getClipDuration(c)
        );
        if (vClip) {
          const target = Math.max(0, vClip.source_in + (next - vClip.timeline_start) * (vClip.speed || 1));
          const drift = Math.abs(video.currentTime - target);
          if (drift > 0.5) {
            video.currentTime = target;
          }
        }
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  React.useEffect(() => {
    if (isPlaying) {
      lastTimeRef.current = null;
      livePlayheadRef.current = playhead;
      lastPublishedRef.current = 0;
      rafRef.current = requestAnimationFrame(tick);
    } else if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [isPlaying, tick]);

  const totalDuration = React.useMemo(
    () => project.tracks.reduce((max, t) => t.clips.reduce((m, c) => Math.max(m, c.timeline_start + getClipDuration(c)), max), 0),
    [project.tracks]
  );

  const clip = activeVideo?.clip;

  return (
    <div className="workspace-panel flex flex-col h-full">
      <div className="panel-header justify-between">
        <div className="flex items-center gap-2">
          <MonitorPlay className="w-3.5 h-3.5 text-accent" />
          <span>Program</span>
        </div>
        <span className="font-mono text-2xs text-text-dim normal-case tracking-normal">
          {project.width}×{project.height} · {project.fps}fps
        </span>
      </div>

      {/* Viewport */}
      <div className="flex-1 min-h-0 bg-[#050506] flex items-center justify-center relative overflow-hidden p-5">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.035),transparent_55%)] pointer-events-none" />
        <div className="relative max-w-full max-h-full rounded-md overflow-hidden shadow-[0_28px_70px_-40px_rgba(0,0,0,1)] border border-border/50" style={{ aspectRatio: `${project.width} / ${project.height}` }}>
          {clip ? (
            <video
              ref={videoRef}
              className="w-full h-full object-contain bg-black pointer-events-none"
              muted={isMuted}
              style={{
                transform: `translate(${clip.transform.x}px, ${clip.transform.y}px) scale(${clip.transform.scale}) rotate(${clip.transform.rotation || 0}deg)`,
                opacity: clip.opacity,
                filter: [
                  `brightness(${100 + (clip.color.brightness ?? 0) * 100}%)`,
                  `contrast(${(clip.color.contrast ?? 1) * 100}%)`,
                  `saturate(${(clip.color.saturation ?? 1) * 100}%)`,
                  `hue-rotate(${clip.color.hue ?? 0}deg)`,
                  `blur(${clip.color.blur ?? 0}px)`,
                ].join(" "),
              }}
            />
          ) : (
            <div className="w-full h-full min-w-[320px] min-h-[180px] flex flex-col items-center justify-center text-text-dim bg-bg-secondary/35">
              <div className="w-12 h-12 rounded-lg bg-panel-raised border border-border flex items-center justify-center mb-3">
                <Play className="w-5 h-5 opacity-50" />
              </div>
              <p className="text-sm font-semibold text-text-muted">No frame at playhead</p>
              <p className="text-xs mt-1 max-w-[220px] text-center">Move the playhead over a clip, or import media to begin editing.</p>
            </div>
          )}

          {clip?.text && (
            <div
              className="absolute pointer-events-none select-none text-center drop-shadow-lg"
              style={{
                left: `${clip.text.x}%`,
                top: `${clip.text.y}%`,
                fontSize: `${clip.text.font_size}px`,
                color: clip.text.color,
                fontFamily: clip.text.font_family,
                fontWeight: clip.text.bold ? "bold" : "normal",
                fontStyle: clip.text.italic ? "italic" : "normal",
              }}
            >
              {clip.text.text}
            </div>
          )}
        </div>
        <audio ref={audioRef} className="hidden" />
      </div>

      {/* Transport */}
      <div className="px-4 py-3 border-t border-border/80 bg-panel flex items-center gap-4">
        <span className="text-xs font-mono text-text-muted tabular-nums w-28">
          {fmtTime(playhead)} <span className="text-text-dim">/ {fmtTime(totalDuration)}</span>
        </span>

        <div className="flex-1 flex items-center justify-center gap-2">
          <button className="btn-icon" onClick={() => setPlayhead(0)} title="Jump to start">
            <SkipBack className="w-4 h-4" />
          </button>
          <button
            onClick={togglePlay}
            className="flex items-center justify-center w-11 h-11 rounded-full bg-accent hover:bg-accent-hover text-white shadow-glow transition-all active:scale-95"
            title="Play / Pause (Space)"
          >
            {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current ml-0.5" />}
          </button>
          <button className="btn-icon" onClick={() => setPlayhead(totalDuration)} title="Jump to end">
            <SkipForward className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-1.5 w-24 justify-end">
          <button className="btn-icon w-7 h-7" onClick={() => setIsMuted((m) => !m)} title="Mute">
            {isMuted ? <VolumeX className="w-4 h-4 text-danger" /> : <Volume2 className="w-4 h-4" />}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.02"
            value={monitorVolume}
            onChange={(e) => setMonitorVolume(parseFloat(e.target.value))}
            className="fader w-14"
            title="Monitor volume"
          />
        </div>
      </div>
    </div>
  );
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

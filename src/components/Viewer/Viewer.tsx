import * as React from "react";
import {
  Camera,
  ChevronFirst,
  ChevronLast,
  Grid2x2,
  Loader2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Upload,
  Volume2,
  VolumeX,
} from "lucide-react";
import { store, useStore, findClip } from "../../store/store";
import { Engine } from "./engine";
import { fileUrl } from "../../lib/backend";
import { clipAt, clipEnd, nextEditPoint, prevEditPoint, projectDuration } from "../../lib/timeline";
import { timecode } from "../../lib/format";
import { fitBox } from "../../lib/visual";
import { titleBounds } from "../../lib/title";
import { IconButton } from "../ui/controls";
import { importViaDialog } from "../../lib/actions";
import { exportFrame } from "../dialogs/ExportDialog";
import { cn } from "../../lib/cn";
import type { MediaAsset } from "../../lib/types";

export function Viewer() {
  const viewport = React.useRef<HTMLDivElement>(null);
  const stage = React.useRef<HTMLDivElement>(null);
  const engineRef = React.useRef<Engine | null>(null);
  const settings = useStore((s) => s.project.settings);
  const [box, setBox] = React.useState({ w: 0, h: 0 });
  const [volume, setVolume] = React.useState(() => Number(localStorage.getItem("revind.volume") ?? 0.9));
  const [muted, setMuted] = React.useState(false);
  const [guides, setGuides] = React.useState(false);

  // Fit the project frame into the viewport.
  React.useLayoutEffect(() => {
    const el = viewport.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pad = 20;
  const k = box.w > 0 ? Math.max(0.01, Math.min((box.w - pad * 2) / settings.width, (box.h - pad * 2) / settings.height)) : 0;
  const fw = settings.width * k;
  const fh = settings.height * k;

  // Engine lifecycle + store wiring.
  React.useEffect(() => {
    const engine = new Engine(stage.current!, {
      project: () => store().project,
      source: (m: MediaAsset) => {
        const rt = store().runtime[m.id];
        if (rt?.missing) return null;
        if (rt?.needsProxy) return rt.proxy ? fileUrl(rt.proxy) : null;
        return fileUrl(m.path);
      },
      onTime: (t) => store().setPlayheadFromPlayback(t),
      onEnded: () => store().pause(),
    });
    engineRef.current = engine;
    const s0 = store();
    engine.setRate(s0.rate);
    engine.seek(s0.playhead);
    const unsub = useStore.subscribe((s, prev) => {
      if (s.project !== prev.project || s.runtime !== prev.runtime) engine.invalidate();
      if (s.rate !== prev.rate) engine.setRate(s.rate);
      if (s.playing !== prev.playing) {
        if (s.playing) engine.play(s.playhead);
        else engine.pause();
      }
      if (s.seekNonce !== prev.seekNonce) engine.seek(s.playhead);
    });
    return () => {
      unsub();
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    engineRef.current?.setMaster(volume, muted);
    localStorage.setItem("revind.volume", String(volume));
  }, [volume, muted]);

  const empty = useStore((s) => s.project.tracks.every((t) => t.clips.length === 0));

  return (
    <div className="panel flex h-full min-w-0 flex-col">
      <div ref={viewport} className="relative min-h-0 flex-1 overflow-hidden bg-bg-deep">
        <div className="absolute" style={{ left: (box.w - fw) / 2, top: (box.h - fh) / 2, width: fw, height: fh }}>
          <div className="absolute inset-0 overflow-hidden shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_30px_80px_-30px_rgba(0,0,0,0.9)]">
            <div
              ref={stage}
              className="absolute left-0 top-0 origin-top-left overflow-hidden"
              style={{ width: settings.width, height: settings.height, transform: `scale(${k})` }}
            />
          </div>
          {guides && <SafeGuides />}
          <TransformOverlay k={k} />
          <ProxyNotice />
        </div>
        {empty && <EmptyState />}
      </div>
      <Transport volume={volume} muted={muted} onVolume={setVolume} onMute={() => setMuted((m) => !m)} guides={guides} onGuides={() => setGuides((g) => !g)} />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex max-w-[340px] flex-col items-center rounded-2xl border border-dashed border-line-strong bg-panel/80 px-8 py-7 text-center backdrop-blur">
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-accent/14 text-accent-ink">
          <Upload className="h-5 w-5" />
        </div>
        <p className="text-md font-semibold text-ink">Start your edit</p>
        <p className="mt-1 text-sm text-ink-muted">Drop videos, music or images anywhere in this window, or import them from disk.</p>
        <button
          onClick={importViaDialog}
          className="mt-4 h-8 rounded-md bg-accent px-4 text-sm font-medium text-white shadow-glow transition-colors hover:bg-accent-hover"
        >
          Import media…
        </button>
        <p className="mt-3 text-2xs text-ink-dim">
          Tip: press <span className="kbd">?</span> for keyboard shortcuts
        </p>
      </div>
    </div>
  );
}

function SafeGuides() {
  return (
    <div className="pointer-events-none absolute inset-0">
      <div className="absolute inset-[5%] border border-dashed border-white/30" />
      <div className="absolute inset-[10%] border border-dashed border-white/20" />
      <div className="absolute left-1/3 top-0 h-full w-px bg-white/15" />
      <div className="absolute left-2/3 top-0 h-full w-px bg-white/15" />
      <div className="absolute left-0 top-1/3 h-px w-full bg-white/15" />
      <div className="absolute left-0 top-2/3 h-px w-full bg-white/15" />
    </div>
  );
}

/** Shows progress while a preview proxy is being generated for the clip under the playhead. */
function ProxyNotice() {
  const info = useStore((s) => {
    for (const t of s.project.tracks) {
      if (t.kind !== "video" || t.hidden) continue;
      const c = clipAt(t, s.playhead);
      const m = c?.type === "media" ? s.project.media.find((x) => x.id === c.mediaId) : undefined;
      if (!m) continue;
      const rt = s.runtime[m.id];
      if (rt?.missing) return `missing|${m.name}`;
      if (rt?.needsProxy && !rt.proxy) return `proxy|${m.name}|${rt.proxyError ? -1 : Math.round(rt.proxyProgress ?? 0)}`;
    }
    return null;
  });
  if (!info) return null;
  const [kind, name, pct] = info.split("|");
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
      <div className="flex items-center gap-2 rounded-full border border-line-strong bg-black/75 px-3 py-1.5 text-xs text-ink backdrop-blur">
        {kind === "missing" ? (
          <span className="text-danger">Media offline: {name}</span>
        ) : pct === "-1" ? (
          <span className="text-danger">Preview unavailable for {name}</span>
        ) : (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-ink" />
            Preparing preview for {name} · {pct}%
          </>
        )}
      </div>
    </div>
  );
}

/** Drag-to-move / corner-to-scale handles for the selected visual clip. */
function TransformOverlay({ k }: { k: number }) {
  const sel = useStore((s) => (s.selection.length === 1 && !s.playing ? s.selection[0] : null));
  const target = useStore((s) => {
    if (!sel) return null;
    const hit = findClip(s.project, sel);
    if (!hit || hit.track.kind !== "video" || hit.track.hidden || hit.track.locked) return null;
    if (s.playhead < hit.clip.start - 1e-6 || s.playhead >= clipEnd(hit.clip)) return null;
    return hit.clip;
  });
  const settings = useStore((s) => s.project.settings);
  const media = useStore((s) => (target?.mediaId ? s.project.media.find((m) => m.id === target.mediaId) : undefined));
  const [guide, setGuide] = React.useState<{ x: boolean; y: boolean }>({ x: false, y: false });
  if (!target || k <= 0 || (target.type === "media" && (!media || media.kind === "audio"))) return null;

  const W = settings.width;
  const H = settings.height;
  const tf = target.transform;
  const isTitle = target.type === "title";
  const fb = isTitle ? { width: W, height: H } : fitBox(media!.width, media!.height, W, H, tf.fit);
  const tb = isTitle && target.title ? titleBounds(target.title, W, H) : null;

  const startMove = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const id = target.id;
    const sx = e.clientX;
    const sy = e.clientY;
    const x0 = isTitle ? target.title!.x : tf.x;
    const y0 = isTitle ? target.title!.y : tf.y;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / k;
      const dy = (ev.clientY - sy) / k;
      if (isTitle) {
        const s = tf.scale || 1;
        let nx = x0 + (dx / s / W) * 100;
        let ny = y0 + (dy / s / H) * 100;
        const snapX = !ev.altKey && Math.abs(nx - 50) < (6 / k / W) * 100;
        const snapY = !ev.altKey && Math.abs(ny - 50) < (6 / k / H) * 100;
        if (snapX) nx = 50;
        if (snapY) ny = 50;
        setGuide({ x: snapX, y: snapY });
        store().updateClip(id, (c) => {
          c.title!.x = Math.round(nx * 100) / 100;
          c.title!.y = Math.round(ny * 100) / 100;
        }, { live: true });
      } else {
        let nx = x0 + dx;
        let ny = y0 + dy;
        const snapX = !ev.altKey && Math.abs(nx) < 6 / k;
        const snapY = !ev.altKey && Math.abs(ny) < 6 / k;
        if (snapX) nx = 0;
        if (snapY) ny = 0;
        setGuide({ x: snapX, y: snapY });
        store().updateClip(id, (c) => {
          c.transform.x = Math.round(nx);
          c.transform.y = Math.round(ny);
        }, { live: true });
      }
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setGuide({ x: false, y: false });
      store().commit();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const startScale = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const id = target.id;
    const frame = (e.currentTarget as HTMLElement).closest("[data-frame]")!.getBoundingClientRect();
    const cx = frame.left + (W / 2 + tf.x) * k;
    const cy = frame.top + (H / 2 + tf.y) * k;
    const d0 = Math.hypot(e.clientX - cx, e.clientY - cy) || 1;
    const s0 = tf.scale;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const d = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      const next = Math.max(0.05, Math.min(10, (s0 * d) / d0));
      store().updateClip(id, (c) => void (c.transform.scale = Math.round(next * 1000) / 1000), { live: true });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      store().commit();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const sx = tf.scale * (tf.flipH ? -1 : 1);
  const sy = tf.scale * (tf.flipV ? -1 : 1);
  const handle = "absolute h-2.5 w-2.5 rounded-sm border border-white bg-accent shadow pointer-events-auto";
  const inv = 1 / (k * Math.abs(tf.scale || 1));
  return (
    <div data-frame className="pointer-events-none absolute inset-0 overflow-visible">
      <div className="absolute left-0 top-0 origin-top-left" style={{ width: W, height: H, transform: `scale(${k})` }}>
        <div
          className="absolute"
          style={{
            left: (W - fb.width) / 2,
            top: (H - fb.height) / 2,
            width: fb.width,
            height: fb.height,
            transform: `translate(${tf.x}px, ${tf.y}px) rotate(${tf.rotation}deg) scale(${sx}, ${sy})`,
          }}
        >
          {tb ? (
            <div
              onPointerDown={startMove}
              className="pointer-events-auto absolute cursor-move outline outline-1 outline-accent"
              style={{ left: tb.x, top: tb.y, width: tb.w, height: tb.h, outlineWidth: inv }}
              title="Drag to move · Alt disables snapping"
            />
          ) : (
            <div
              onPointerDown={startMove}
              className="pointer-events-auto absolute inset-0 cursor-move outline outline-1 outline-accent"
              style={{ outlineWidth: inv }}
              title="Drag to move · drag a corner to scale · Alt disables snapping"
            >
              {(["-left-1.5 -top-1.5 cursor-nwse-resize", "-right-1.5 -top-1.5 cursor-nesw-resize", "-left-1.5 -bottom-1.5 cursor-nesw-resize", "-right-1.5 -bottom-1.5 cursor-nwse-resize"] as const).map((pos) => (
                <div key={pos} onPointerDown={startScale} className={cn(handle, pos)} style={{ transform: `scale(${inv})` }} />
              ))}
            </div>
          )}
        </div>
      </div>
      {guide.x && <div className="absolute left-1/2 top-0 h-full w-px bg-[#ff4fd8]" />}
      {guide.y && <div className="absolute left-0 top-1/2 h-px w-full bg-[#ff4fd8]" />}
    </div>
  );
}

function Transport({
  volume,
  muted,
  onVolume,
  onMute,
  guides,
  onGuides,
}: {
  volume: number;
  muted: boolean;
  onVolume: (v: number) => void;
  onMute: () => void;
  guides: boolean;
  onGuides: () => void;
}) {
  const playhead = useStore((s) => s.playhead);
  const playing = useStore((s) => s.playing);
  const rate = useStore((s) => s.rate);
  const fps = useStore((s) => s.project.settings.fps);
  const total = useStore((s) => projectDuration(s.project));
  const s = store;

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-t border-line bg-panel px-3">
      <div className="flex min-w-[180px] items-baseline gap-1.5 font-mono tabular">
        <span className="text-md text-ink">{timecode(playhead, fps, true)}</span>
        <span className="text-xs text-ink-dim">/ {timecode(total, fps, true)}</span>
      </div>
      <div className="flex flex-1 items-center justify-center gap-1">
        <IconButton title="Go to start (Home)" onClick={() => s().seek(0)}>
          <ChevronFirst className="h-4 w-4" />
        </IconButton>
        <IconButton title="Previous edit (↑)" onClick={() => s().seek(prevEditPoint(s().project.tracks, s().playhead))}>
          <SkipBack className="h-4 w-4" />
        </IconButton>
        <button
          onClick={() => s().togglePlay()}
          title="Play / pause (Space)"
          className="mx-1 flex h-9 w-9 items-center justify-center rounded-full bg-ink text-bg transition-transform hover:scale-105 active:scale-95"
        >
          {playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="ml-0.5 h-4 w-4 fill-current" />}
        </button>
        <IconButton title="Next edit (↓)" onClick={() => s().seek(nextEditPoint(s().project.tracks, s().playhead))}>
          <SkipForward className="h-4 w-4" />
        </IconButton>
        <IconButton title="Go to end (End)" onClick={() => s().seek(projectDuration(s().project))}>
          <ChevronLast className="h-4 w-4" />
        </IconButton>
        {playing && rate !== 1 && <span className="ml-1 rounded bg-accent/20 px-1.5 py-0.5 font-mono text-2xs text-accent-ink">{rate}×</span>}
      </div>
      <div className="flex min-w-[180px] items-center justify-end gap-1">
        <IconButton title="Safe areas & thirds" active={guides} onClick={onGuides}>
          <Grid2x2 className="h-4 w-4" />
        </IconButton>
        <IconButton title="Save frame as PNG" onClick={() => exportFrame()}>
          <Camera className="h-4 w-4" />
        </IconButton>
        <IconButton title={muted ? "Unmute preview" : "Mute preview"} onClick={onMute}>
          {muted || volume === 0 ? <VolumeX className="h-4 w-4 text-danger" /> : <Volume2 className="h-4 w-4" />}
        </IconButton>
        <input
          type="range"
          className="range w-20"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          style={{ ["--fill" as string]: `${volume * 100}%` }}
          onChange={(e) => onVolume(parseFloat(e.target.value))}
          title={`Preview volume ${Math.round(volume * 100)}%`}
        />
      </div>
    </div>
  );
}

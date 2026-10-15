import * as React from "react";
import { AlertTriangle, Gauge, Move, Type, VolumeX } from "lucide-react";
import type { Clip, MediaAsset, Track } from "../../lib/types";
import type { MediaRuntime } from "../../store/store";
import { clipDuration, speedOf } from "../../lib/timeline";
import { fileUrl, type Waveform } from "../../lib/backend";
import { isDefaultColor } from "../../lib/visual";
import { cn } from "../../lib/cn";

export type ClipGrab = "move" | "trim-left" | "trim-right" | "fade-in" | "fade-out";

interface Props {
  clip: Clip;
  track: Track;
  media?: MediaAsset;
  runtime?: MediaRuntime;
  zoom: number;
  height: number;
  selected: boolean;
  blade: boolean;
  /** Visible time window (for virtualising filmstrips & waveforms). */
  viewStart: number;
  viewEnd: number;
  /** Stable callbacks (shared by all clips) so React.memo can skip re-renders. */
  onPointerDown: (e: React.PointerEvent, grab: ClipGrab, clip: Clip, track: Track) => void;
  onContextMenu: (e: React.MouseEvent, clip: Clip, track: Track) => void;
  onDoubleClick: (clip: Clip) => void;
}

const COLORS = {
  video: { base: "#6f7dfb", bg: "rgba(111,125,251,0.28)" },
  image: { base: "#9b7cf6", bg: "rgba(155,124,246,0.28)" },
  audio: { base: "#2fbf8f", bg: "rgba(47,191,143,0.22)" },
  title: { base: "#e8a23d", bg: "rgba(232,162,61,0.26)" },
};

export const ClipView = React.memo(function ClipView({
  clip,
  track,
  media,
  runtime,
  zoom,
  height,
  selected,
  blade,
  viewStart,
  viewEnd,
  onPointerDown,
  onContextMenu,
  onDoubleClick,
}: Props) {
  const dur = clipDuration(clip);
  const left = clip.start * zoom;
  const width = Math.max(2, dur * zoom);
  const isTitle = clip.type === "title";
  const scheme = isTitle ? COLORS.title : track.kind === "audio" ? COLORS.audio : media?.kind === "image" ? COLORS.image : COLORS.video;
  const missing = !isTitle && (!media || runtime?.missing);
  const name = clip.label || (isTitle ? clip.title?.text.split("\n")[0] || "Title" : media?.name ?? "Missing media");

  // Visible slice of the clip, in px relative to the clip's left edge.
  const visL = Math.max(0, (viewStart - clip.start) * zoom);
  const visR = Math.min(width, (viewEnd - clip.start) * zoom);

  const showStrip = track.kind === "video" && !isTitle && media?.hasVideo && !!runtime?.thumbs?.length && height >= 40;
  const hasAudio = !isTitle && media?.hasAudio && media.kind !== "image";
  const showWave = hasAudio && !!runtime?.waveform && (track.kind === "audio" || height >= 60);
  const waveH = track.kind === "audio" ? height - 22 : Math.round(height * 0.3);
  const fadeIn = Math.min(clip.fadeIn, dur) * zoom;
  const fadeOut = Math.min(clip.fadeOut, dur) * zoom;
  const tiny = width < 28;

  return (
    <div
      data-clip={clip.id}
      className={cn(
        "group absolute top-[3px] overflow-hidden rounded-[5px]",
        selected ? "z-[3]" : "z-[2]",
        track.locked ? "cursor-not-allowed" : blade ? "cursor-crosshair" : "cursor-grab",
      )}
      style={{ left, width, bottom: 3, background: scheme.bg, boxShadow: `inset 0 0 0 1px ${scheme.base}${selected ? "" : "99"}` }}
      onPointerDown={(e) => onPointerDown(e, "move", clip, track)}
      onContextMenu={(e) => onContextMenu(e, clip, track)}
      onDoubleClick={() => onDoubleClick(clip)}
    >
      {showStrip && <Filmstrip clip={clip} media={media!} thumbs={runtime!.thumbs!} zoom={zoom} height={height - 6} visL={visL} visR={visR} />}
      {showWave && (
        <WaveformView
          clip={clip}
          wave={runtime!.waveform!}
          zoom={zoom}
          height={Math.max(8, waveH)}
          visL={visL}
          visR={visR}
          color={track.kind === "audio" ? "#5fe0b3" : "rgba(220,226,255,0.85)"}
          className={track.kind === "audio" ? "bottom-0" : "bottom-0 bg-black/35"}
          dim={clip.muted || track.muted}
        />
      )}
      {missing && <div className="absolute inset-0 bg-[repeating-linear-gradient(45deg,rgba(239,91,91,0.25)_0_6px,transparent_6px_12px)]" />}

      {/* Fades */}
      {fadeIn > 0 && (
        <svg className="pointer-events-none absolute left-0 top-0 h-full" width={fadeIn} preserveAspectRatio="none" viewBox="0 0 100 100">
          <path d="M0 0 L100 0 L0 100 Z" fill="rgba(0,0,0,0.45)" />
          <path d="M0 100 L100 0" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" fill="none" />
        </svg>
      )}
      {fadeOut > 0 && (
        <svg className="pointer-events-none absolute right-0 top-0 h-full" width={fadeOut} preserveAspectRatio="none" viewBox="0 0 100 100">
          <path d="M0 0 L100 0 L100 100 Z" fill="rgba(0,0,0,0.45)" />
          <path d="M0 0 L100 100" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" fill="none" />
        </svg>
      )}

      {/* Header strip */}
      {!tiny && (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 flex h-[18px] items-center gap-1 px-1.5 text-2xs font-medium text-white"
          style={{ background: `linear-gradient(to bottom, ${scheme.base}e6, ${scheme.base}b3)` }}
        >
          {isTitle && <Type className="h-3 w-3 shrink-0 opacity-90" />}
          {missing && <AlertTriangle className="h-3 w-3 shrink-0 text-white" />}
          <span className="truncate drop-shadow-[0_1px_1px_rgba(0,0,0,0.4)]" style={{ maxWidth: Math.max(0, visR - visL - 40), marginLeft: Math.max(0, visL) }}>
            {name}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {speedOf(clip) !== 1 && (
              <span className="flex items-center gap-0.5 rounded bg-black/30 px-1">
                <Gauge className="h-2.5 w-2.5" />
                {+speedOf(clip).toFixed(2)}×
              </span>
            )}
            {hasAudio && clip.muted && <VolumeX className="h-3 w-3 opacity-90" />}
            {clip.motion && <Move className="h-3 w-3 opacity-90" aria-label="Motion" />}
            {!isDefaultColor(clip.color) && <span className="rounded bg-black/30 px-1">fx</span>}
          </span>
        </div>
      )}

      {isTitle && height >= 40 && !tiny && (
        <div className="pointer-events-none absolute inset-x-1.5 bottom-1 top-[20px] truncate text-xs italic text-white/80">{clip.title?.text}</div>
      )}

      {selected && <div className="pointer-events-none absolute inset-0 rounded-[5px] ring-2 ring-inset ring-white" />}

      {!track.locked && !blade && (
        <>
          <div
            onPointerDown={(e) => onPointerDown(e, "trim-left", clip, track)}
            className="absolute bottom-0 left-0 top-0 z-[4] w-[7px] cursor-ew-resize rounded-l-[5px] hover:bg-white/80"
            title="Drag to trim start"
          />
          <div
            onPointerDown={(e) => onPointerDown(e, "trim-right", clip, track)}
            className="absolute bottom-0 right-0 top-0 z-[4] w-[7px] cursor-ew-resize rounded-r-[5px] hover:bg-white/80"
            title="Drag to trim end"
          />
          {width > 44 && (
            <>
              <div
                onPointerDown={(e) => onPointerDown(e, "fade-in", clip, track)}
                className="absolute top-[3px] z-[5] h-2.5 w-2.5 cursor-ew-resize rounded-full border border-black/40 bg-white opacity-0 shadow transition-opacity group-hover:opacity-100"
                style={{ left: Math.max(8, fadeIn - 5) }}
                title="Drag to fade in"
              />
              <div
                onPointerDown={(e) => onPointerDown(e, "fade-out", clip, track)}
                className="absolute top-[3px] z-[5] h-2.5 w-2.5 cursor-ew-resize rounded-full border border-black/40 bg-white opacity-0 shadow transition-opacity group-hover:opacity-100"
                style={{ right: Math.max(8, fadeOut - 5) }}
                title="Drag to fade out"
              />
            </>
          )}
        </>
      )}
    </div>
  );
});

function Filmstrip({
  clip,
  media,
  thumbs,
  zoom,
  height,
  visL,
  visR,
}: {
  clip: Clip;
  media: MediaAsset;
  thumbs: string[];
  zoom: number;
  height: number;
  visL: number;
  visR: number;
}) {
  const aspect = media.width > 0 && media.height > 0 ? media.width / media.height : 16 / 9;
  const tileW = Math.max(24, Math.round(height * aspect));
  const first = Math.floor(visL / tileW);
  const last = Math.ceil(visR / tileW);
  const sp = speedOf(clip);
  const n = thumbs.length;
  const tiles: { x: number; src: string }[] = [];
  for (let i = first; i < last && tiles.length < 200; i++) {
    const x = i * tileW;
    let idx = 0;
    if (media.kind !== "image" && media.duration > 0) {
      const src = clip.in + ((x + tileW / 2) / zoom) * sp;
      idx = Math.max(0, Math.min(n - 1, Math.floor((src / media.duration) * n)));
    }
    // Fall back to the nearest frame that actually decoded.
    let path = thumbs[idx];
    for (let d = 1; !path && d < n; d++) path = thumbs[idx - d] || thumbs[idx + d];
    if (path) tiles.push({ x, src: path });
  }
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {tiles.map((t) => (
        <img
          key={t.x}
          src={fileUrl(t.src)}
          draggable={false}
          alt=""
          className="absolute top-0 h-full object-cover opacity-90"
          style={{ left: t.x, width: tileW }}
        />
      ))}
      <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-black/30" />
    </div>
  );
}

function WaveformView({
  clip,
  wave,
  zoom,
  height,
  visL,
  visR,
  color,
  className,
  dim,
}: {
  clip: Clip;
  wave: Waveform;
  zoom: number;
  height: number;
  visL: number;
  visR: number;
  color: string;
  className?: string;
  dim?: boolean;
}) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  const left = Math.floor(visL);
  const width = Math.max(0, Math.min(8192, Math.ceil(visR - left)));

  React.useEffect(() => {
    const cv = ref.current;
    if (!cv || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.ceil(width * dpr);
    cv.height = Math.ceil(height * dpr);
    const ctx = cv.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = color;
    const sp = speedOf(clip);
    const peaks = wave.peaks;
    const gain = Math.min(2, clip.volume);
    const mid = height / 2;
    for (let x = 0; x < width; x++) {
      const t0 = clip.in + ((left + x) / zoom) * sp;
      const t1 = clip.in + ((left + x + 1) / zoom) * sp;
      let i0 = Math.floor(t0 * wave.rate);
      const i1 = Math.max(i0 + 1, Math.ceil(t1 * wave.rate));
      if (i0 >= peaks.length) break;
      let peak = 0;
      for (; i0 < i1 && i0 < peaks.length; i0++) if (i0 >= 0 && peaks[i0] > peak) peak = peaks[i0];
      const h = Math.max(0.5, Math.min(1, (peak / 255) * gain) * (height - 2));
      ctx.fillRect(x, mid - h / 2, 1, h);
    }
  }, [clip.in, clip.speed, clip.volume, wave, zoom, height, left, width, color]);

  return (
    <canvas
      ref={ref}
      className={cn("pointer-events-none absolute", className, dim && "opacity-40")}
      style={{ left, width, height }}
    />
  );
}

import * as React from "react";
import { useProjectStore } from "../../stores/projectStore";
import type { PlaceMode } from "../../stores/projectStore";
import type { Clip } from "../../lib/types";
import { assetUrl, saveExportFile, startClipExport } from "../../lib/tauri";
import { snapToFrame } from "../../lib/utils";
import { v4 as uuid } from "../../lib/uuid";
import { listen } from "@tauri-apps/api/event";
import { Play, Pause, Scissors, X, Check, ChevronLeft, ChevronRight, Plus, Share2, Loader2 } from "lucide-react";

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${m}:${s.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

/**
 * Focused source-trimming modal. The user previews the media, sets IN/OUT with
 * draggable handles (or I/O keys), auditions the selection (loops), then adds it
 * to the timeline with one click. Placement is automatic.
 */
export function ClipTrimmer() {
  const clipping = useProjectStore((s) => s.clipping);
  const project = useProjectStore((s) => s.project);
  const updateClipping = useProjectStore((s) => s.updateClipping);
  const commitClipping = useProjectStore((s) => s.commitClipping);
  const cancelClipping = useProjectStore((s) => s.cancelClipping);
  const pushHistory = useProjectStore((s) => s.pushHistory);
  const placeClip = useProjectStore((s) => s.placeClip);
  const playhead = useProjectStore((s) => s.playhead);
  const targetTrackId = useProjectStore((s) => s.targetTrackId);

  const asset = clipping ? project.media.find((m) => m.id === clipping.mediaId) : null;

  const videoRef = React.useRef<HTMLVideoElement>(null);
  const barRef = React.useRef<HTMLDivElement>(null);
  const rafRef = React.useRef<number | null>(null);

  const [cursor, setCursor] = React.useState(0); // current preview position (source seconds)
  const [playing, setPlaying] = React.useState(false);
  const [isExporting, setIsExporting] = React.useState(false);
  const [exportProgress, setExportProgress] = React.useState(0);
  const [exportStatus, setExportStatus] = React.useState("");

  const dur = asset && asset.durationSec > 0 ? asset.durationSec : Math.max(clipping?.sourceOut ?? 10, 10);
  const inP = clipping?.sourceIn ?? 0;
  const outP = clipping?.sourceOut ?? dur;
  const selDur = Math.max(0, outP - inP);

  // Keep live values in refs so the rAF loop never reads stale state.
  const refs = React.useRef({ inP, outP });
  refs.current = { inP, outP };

  // Reset cursor to the IN point each time a new media opens.
  React.useEffect(() => {
    if (clipping) setCursor(clipping.sourceIn);
    setPlaying(false);
    setIsExporting(false);
    setExportProgress(0);
    setExportStatus("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipping?.mediaId]);

  React.useEffect(() => {
    if (!clipping) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    try {
      listen<{ status: string; progress?: number; error?: string }>(
        "export-progress",
        (event) => {
          const { status, progress, error } = event.payload;
          if (status === "running") {
            setExportProgress(Math.min(99, Math.max(1, Math.round(progress || 0))));
            setExportStatus("Exporting selected clip...");
          } else if (status === "completed") {
            setExportProgress(100);
            setExportStatus("Selected clip exported.");
            setTimeout(() => setIsExporting(false), 1800);
          } else if (status === "failed") {
            setExportStatus(`Export failed: ${error || "Unknown error"}`);
            setTimeout(() => setIsExporting(false), 5000);
          }
        }
      ).then((fn) => {
        if (cancelled) fn();
        else cleanup = fn;
      }).catch(() => {});
    } catch {
      // Browser preview has no Tauri event bridge.
    }
    return () => {
      cancelled = true;
      if (cleanup) cleanup();
    };
  }, [clipping]);

  // Seek the video while scrubbing / paused.
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!playing && Math.abs(v.currentTime - cursor) > 0.04) {
      v.currentTime = cursor;
    }
  }, [cursor, playing]);

  // Playback loop: play within [in, out], looping at the out point.
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    if (playing) {
      if (v.currentTime < refs.current.inP || v.currentTime >= refs.current.outP - 0.02) {
        v.currentTime = refs.current.inP;
      }
      v.play().catch(() => {});
      const tick = () => {
        const vid = videoRef.current;
        if (vid) {
          if (vid.currentTime >= refs.current.outP - 0.02) {
            vid.currentTime = refs.current.inP;
          }
          setCursor(vid.currentTime);
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } else {
      v.pause();
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing]);

  const timeFromClientX = React.useCallback(
    (clientX: number) => {
      const bar = barRef.current;
      if (!bar) return 0;
      const rect = bar.getBoundingClientRect();
      const frac = (clientX - rect.left) / rect.width;
      return Math.max(0, Math.min(dur, frac * dur));
    },
    [dur]
  );

  const startHandleDrag = (which: "in" | "out") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPlaying(false);
    const move = (ev: PointerEvent) => {
      const t = timeFromClientX(ev.clientX);
      if (which === "in") {
        updateClipping({ sourceIn: t });
        setCursor(Math.min(t, refs.current.outP));
      } else {
        updateClipping({ sourceOut: t });
        setCursor(Math.max(t, refs.current.inP));
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const scrubTo = (clientX: number) => {
    setPlaying(false);
    setCursor(timeFromClientX(clientX));
  };

  const onScrubDown = (e: React.PointerEvent) => {
    // ignore clicks that originate on a handle (handled separately)
    if ((e.target as HTMLElement).dataset.handle) return;
    scrubTo(e.clientX);
    const move = (ev: PointerEvent) => setCursor(timeFromClientX(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const add = React.useCallback(() => {
    commitClipping();
    pushHistory();
  }, [commitClipping, pushHistory]);

  const exportSelection = React.useCallback(async () => {
    if (!asset || selDur <= 0.05) return;
    const out = await saveExportFile();
    if (!out) return;
    setPlaying(false);
    setIsExporting(true);
    setExportProgress(1);
    setExportStatus("Preparing selected clip export...");
    try {
      await startClipExport(asset.path, out, inP, outP);
    } catch (e: any) {
      setExportStatus(`Export failed: ${e?.message || e}`);
      setTimeout(() => setIsExporting(false), 5000);
    }
  }, [asset, inP, outP, selDur]);

  // Insert (ripple) / Overwrite the trimmed selection at the playhead on the target track.
  const placeAt = React.useCallback(
    (mode: PlaceMode) => {
      if (!asset) return;
      const want: "video" | "audio" = asset.hasVideo ? "video" : "audio";
      const target =
        targetTrackId ??
        project.tracks.find((t) => t.kind === want)?.id ??
        project.tracks.find((t) => t.kind === "video")?.id ??
        project.tracks[0]?.id;
      if (!target) return;
      const clip: Clip = {
        id: uuid(),
        media_id: asset.id,
        source_in: inP,
        source_out: outP,
        timeline_start: snapToFrame(playhead, asset.fps || project.fps),
        speed: 1,
        volume: 1,
        muted: false,
        opacity: 1,
        transform: { x: 0, y: 0, scale: 1, rotation: 0 },
        color: { brightness: 0, contrast: 1, saturation: 1, gamma: 1, hue: 0, blur: 0 },
        keyframes: [],
      };
      placeClip(target, clip, mode);
      pushHistory();
      cancelClipping(); // close the modal so the result is visible
    },
    [asset, targetTrackId, project, inP, outP, playhead, placeClip, pushHistory, cancelClipping]
  );

  const setIn = () => { updateClipping({ sourceIn: cursor }); };
  const setOut = () => { updateClipping({ sourceOut: cursor }); };
  const nudge = (d: number) => setCursor((c) => Math.max(0, Math.min(dur, c + d)));

  // Keyboard shortcuts while the trimmer is open.
  React.useEffect(() => {
    if (!clipping) return;
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.key === " " || e.code === "Space") { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === "Enter") { e.preventDefault(); add(); }
      else if (e.key === "Escape") { e.preventDefault(); cancelClipping(); }
      else if (k === "i") { e.preventDefault(); updateClipping({ sourceIn: cursor }); }
      else if (k === "o") { e.preventDefault(); updateClipping({ sourceOut: cursor }); }
      else if (e.key === ",") { e.preventDefault(); placeAt("insert"); }
      else if (e.key === ".") { e.preventDefault(); placeAt("overwrite"); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); nudge(e.shiftKey ? -1 : -1 / 30); }
      else if (e.key === "ArrowRight") { e.preventDefault(); nudge(e.shiftKey ? 1 : 1 / 30); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipping, cursor, add, placeAt]);

  if (!clipping || !asset) return null;

  const audioOnly = asset.hasAudio && !asset.hasVideo;
  const destTrack = audioOnly
    ? project.tracks.find((t) => t.kind === "audio")
    : project.tracks.find((t) => t.kind === "video");

  const pct = (t: number) => `${(t / dur) * 100}%`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/72 backdrop-blur-md animate-fadeIn"
      onPointerDown={(e) => { if (e.target === e.currentTarget) cancelClipping(); }}
    >
      <div className="w-[min(920px,92vw)] bg-panel border border-border rounded-lg shadow-panel overflow-hidden animate-scaleIn">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 h-14 border-b border-border/80">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent/12 text-accent border border-accent/20">
            <Scissors className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-text leading-tight">Select range</div>
            <div className="text-2xs text-text-muted truncate" title={asset.name}>{asset.name}</div>
          </div>
          <button className="btn-icon" onClick={cancelClipping} title="Close (Esc)">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Preview */}
        <div className="relative bg-[#050506] aspect-video flex items-center justify-center">
          {asset.hasVideo ? (
            <video
              ref={videoRef}
              src={assetUrl(asset.path)}
              className="max-w-full max-h-full object-contain"
              playsInline
              muted={false}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 text-text-muted">
              {/* audio-only: hidden media element drives playback */}
              <video ref={videoRef} src={assetUrl(asset.path)} className="hidden" />
              <div className="w-16 h-16 rounded-2xl bg-clip-audio/15 text-clip-audio flex items-center justify-center">
                <Scissors className="w-7 h-7" />
              </div>
              <span className="text-xs">Audio clip</span>
            </div>
          )}

          {/* Floating transport */}
          <button
            onClick={() => setPlaying((p) => !p)}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center justify-center w-11 h-11 rounded-full bg-white/95 text-bg shadow-lg hover:scale-105 active:scale-95 transition-transform"
            title="Play / pause selection (Space)"
          >
            {playing ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current ml-0.5" />}
          </button>
        </div>

        {/* Trim bar */}
        <div className="px-5 pt-5 pb-2 bg-panel">
          <div
            ref={barRef}
            className="relative h-16 rounded-lg bg-bg-secondary/80 border border-border cursor-pointer select-none overflow-hidden shadow-inset"
            onPointerDown={onScrubDown}
          >
            {/* dimmed outside-selection */}
            <div className="absolute inset-y-0 left-0 bg-black/50" style={{ width: pct(inP) }} />
            <div className="absolute inset-y-0 right-0 bg-black/50" style={{ left: pct(outP) }} />

            {/* selected region */}
            <div
              className="absolute inset-y-0 bg-accent/20 border-y-2 border-accent"
              style={{ left: pct(inP), width: pct(selDur) }}
            />

            {/* playhead */}
            <div className="absolute top-0 bottom-0 w-0.5 bg-white pointer-events-none" style={{ left: pct(cursor) }}>
              <div className="absolute -top-0.5 -left-[3px] w-2 h-2 rounded-full bg-white" />
            </div>

            {/* IN handle */}
            <div
              data-handle="in"
              onPointerDown={startHandleDrag("in")}
              className="absolute top-0 bottom-0 -ml-2 w-4 flex items-center justify-center cursor-ew-resize group"
              style={{ left: pct(inP) }}
              title="Drag to set IN"
            >
              <div data-handle="in" className="w-1.5 h-9 rounded-full bg-accent group-hover:bg-accent-hover shadow" />
            </div>

            {/* OUT handle */}
            <div
              data-handle="out"
              onPointerDown={startHandleDrag("out")}
              className="absolute top-0 bottom-0 -ml-2 w-4 flex items-center justify-center cursor-ew-resize group"
              style={{ left: pct(outP) }}
              title="Drag to set OUT"
            >
              <div data-handle="out" className="w-1.5 h-9 rounded-full bg-accent group-hover:bg-accent-hover shadow" />
            </div>
          </div>

          {/* Readouts */}
          <div className="flex items-center justify-between mt-3 text-xs">
            <button onClick={setIn} className="btn-ghost px-2.5 !py-1 font-mono" title="Set IN to playhead (I)">
              IN <span className="text-text ml-1">{fmt(inP)}</span>
            </button>
            <div className="flex items-center gap-1.5">
              <button className="btn-icon w-7 h-7" onClick={() => nudge(-1 / 30)} title="Step back 1 frame (←)">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <div className="px-3 py-1 rounded-md bg-accent/10 text-accent font-mono font-semibold tabular-nums">
                {fmt(selDur)}
              </div>
              <button className="btn-icon w-7 h-7" onClick={() => nudge(1 / 30)} title="Step forward 1 frame (→)">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <button onClick={setOut} className="btn-ghost px-2.5 !py-1 font-mono" title="Set OUT to playhead (O)">
              <span className="text-text mr-1">{fmt(outP)}</span> OUT
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 h-16 border-t border-border/80 bg-bg-secondary/50">
          <div className="text-2xs text-text-muted hidden md:block leading-tight">
            <span className="font-medium text-text-muted">Space</span> preview ·
            <span className="font-medium text-text-muted"> I/O</span> in/out ·
            <span className="font-medium text-text-muted"> ,</span> insert ·
            <span className="font-medium text-text-muted"> Enter</span> add at playhead
          </div>
          <div className="flex items-center gap-2">
            <button className="btn-ghost" onClick={cancelClipping}>Cancel</button>
            <button className="btn-ghost" onClick={() => placeAt("insert")} title="Insert at playhead, ripple later clips right (,)">
              <Plus className="w-4 h-4" /> Insert
            </button>
            <button className="btn-ghost" onClick={exportSelection} disabled={isExporting || selDur <= 0.05} title="Export only this selected clip range">
              {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
              Export Clip
            </button>
            <button className="btn-primary" onClick={add} title="Add at the playhead (Enter)">
              <Check className="w-4 h-4" />
              Add to {destTrack?.name ?? "Timeline"}
            </button>
          </div>
        </div>
        {isExporting && (
          <div className="px-5 py-3 border-t border-border bg-bg-secondary/70">
            <div className="flex items-center justify-between gap-3 text-2xs text-text-muted mb-2">
              <span className="truncate">{exportStatus}</span>
              <span className="font-mono text-text">{exportProgress}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-bg border border-border overflow-hidden">
              <div className="h-full bg-accent transition-all duration-200" style={{ width: `${exportProgress}%` }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

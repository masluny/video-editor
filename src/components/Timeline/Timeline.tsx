import * as React from "react";
import { useProjectStore } from "../../stores/projectStore";
import { cn } from "../../lib/cn";
import {
  Scissors,
  Trash2,
  ZoomIn,
  ZoomOut,
  Volume2,
  VolumeX,
  Lock,
  Unlock,
  Plus,
  Video,
  Music,
  MousePointer2,
  Magnet,
  Bookmark,
  X,
} from "lucide-react";
import type { Track, Clip, MediaAsset, Id } from "../../lib/types";
import { getClipDuration, clipEnd, snapToFrame, snapCandidates, snapTime } from "../../lib/utils";
import { importMedia, extractPathsFromDropEvent, assetUrl } from "../../lib/tauri";
import { v4 as uuid } from "../../lib/uuid";

const TRACK_H = 64;
const SNAP_PX = 8;

export function Timeline() {
  const store = useProjectStore();
  const {
    project,
    playhead,
    setPlayhead,
    zoom,
    setZoom,
    selectedClipId,
    selectedClipIds,
    selectClip,
    toggleClipSelection,
    deleteSelected,
    splitClip,
    moveClip,
    moveSelectedBy,
    addClipToTrack,
    addTrack,
    removeTrack,
    addMedia,
    toggleTrackMute,
    toggleTrackLock,
    setTrackVolume,
    updateClip,
    pushHistory,
    activeTool,
    setTool,
    snapEnabled,
    toggleSnap,
    targetTrackId,
    setTargetTrack,
    thumbs,
    exportRange,
    setExportIn,
    setExportOut,
    setExportRange,
    clearExportRange,
  } = store;

  const tracksContainerRef = React.useRef<HTMLDivElement>(null);
  const rulerRef = React.useRef<HTMLDivElement>(null);
  const lanesRef = React.useRef<HTMLDivElement>(null);
  const [snapGuide, setSnapGuide] = React.useState<number | null>(null);
  const [menu, setMenu] = React.useState<
    | { kind: "clip"; x: number; y: number; clip: Clip; track: Track }
    | { kind: "track"; x: number; y: number; track: Track }
    | null
  >(null);

  const timeToPx = (t: number) => t * zoom;
  const pxToTime = (px: number) => Math.max(0, px / zoom);
  const fps = project.fps;
  const effectiveTarget = targetTrackId ?? project.tracks.find((t) => t.kind === "video")?.id ?? project.tracks[0]?.id ?? null;

  const totalDuration = React.useMemo(() => {
    const end = project.tracks.reduce(
      (max, t) => t.clips.reduce((m, c) => Math.max(m, clipEnd(c)), max),
      0
    );
    return Math.max(end, playhead) + Math.max(6, 600 / zoom);
  }, [project.tracks, playhead, zoom]);

  React.useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);

  const handleDelete = () => {
    if (selectedClipIds.length || selectedClipId) {
      deleteSelected(false);
      pushHistory();
    }
  };

  const handleSplit = () => {
    if (!selectedClipId) return;
    const track = project.tracks.find((t) => t.clips.some((c) => c.id === selectedClipId));
    if (track) {
      splitClip(track.id, selectedClipId, playhead);
      pushHistory();
    }
  };

  // ----- ruler seek -----
  const seekFromRuler = (clientX: number) => {
    if (!rulerRef.current) return;
    const rect = rulerRef.current.getBoundingClientRect();
    setPlayhead(pxToTime(clientX - rect.left + rulerRef.current.scrollLeft));
  };
  const seekFromLanes = (clientX: number) => {
    if (!lanesRef.current) return;
    const rect = lanesRef.current.getBoundingClientRect();
    setPlayhead(pxToTime(clientX - rect.left));
  };
  const handleRulerDown = (e: React.MouseEvent) => {
    seekFromRuler(e.clientX);
    const move = (ev: MouseEvent) => seekFromRuler(ev.clientX);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const handlePlayheadDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    seekFromLanes(e.clientX);
    const move = (ev: MouseEvent) => seekFromLanes(ev.clientX);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const handleLaneBackgroundDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    seekFromLanes(e.clientX);
    selectClip(null, null);
  };

  // Determine which track lane a Y coordinate sits over.
  const trackAtY = (clientY: number): Track | null => {
    if (!lanesRef.current) return null;
    const rect = lanesRef.current.getBoundingClientRect();
    const idx = Math.floor((clientY - rect.top) / TRACK_H);
    return project.tracks[idx] ?? null;
  };

  // Snap a proposed start so the clip's start OR end lands on a candidate edge.
  const snapStart = (proposedStart: number, dur: number, edges: number[], disabled: boolean) => {
    const startQ = snapToFrame(proposedStart, fps);
    if (disabled || !snapEnabled) {
      setSnapGuide(null);
      return startQ;
    }
    const tol = SNAP_PX / zoom;
    const a = snapTime(startQ, edges, tol);
    const b = snapTime(startQ + dur, edges, tol);
    const da = a ? Math.abs(a.time - startQ) : Infinity;
    const db = b ? Math.abs(b.time - (startQ + dur)) : Infinity;
    if (a && da <= db) {
      setSnapGuide(a.guide);
      return a.time;
    }
    if (b) {
      setSnapGuide(b.guide);
      return b.time - dur;
    }
    setSnapGuide(null);
    return startQ;
  };

  const snapEdge = (proposed: number, edges: number[], disabled: boolean) => {
    const q = snapToFrame(proposed, fps);
    if (disabled || !snapEnabled) {
      setSnapGuide(null);
      return q;
    }
    const r = snapTime(q, edges, SNAP_PX / zoom);
    setSnapGuide(r ? r.guide : null);
    return r ? r.time : q;
  };

  // ----- clip interactions (move / trim / razor / select) -----
  const onClipMouseDown = (
    e: React.MouseEvent,
    clip: Clip,
    track: Track,
    mode: "move" | "left" | "right"
  ) => {
    e.stopPropagation();
    if (track.locked) return;

    // Razor tool: a click on the body cuts the clip at the cursor.
    if (mode === "move" && activeTool === "razor") {
      const rect = lanesRef.current!.getBoundingClientRect();
      const t = pxToTime(e.clientX - rect.left);
      splitClip(track.id, clip.id, snapToFrame(t, fps));
      pushHistory();
      return;
    }

    // Selection (shift to extend).
    if (mode === "move") {
      if (e.shiftKey) toggleClipSelection(clip.id, track.id);
      else if (!selectedClipIds.includes(clip.id)) selectClip(clip.id, track.id);
    } else {
      selectClip(clip.id, track.id);
    }

    const startX = e.clientX;
    const startStart = clip.timeline_start;
    const startIn = clip.source_in;
    const speed = clip.speed || 1;
    const dur = getClipDuration(clip);
    const asset = project.media.find((m) => m.id === clip.media_id);
    const maxOut = asset && asset.durationSec > 0 ? asset.durationSec : Infinity;
    const MIN = 0.05;

    // Same-track neighbours bound trims (you can't trim over an adjacent clip).
    const sameTrack = track.clips.filter((c) => c.id !== clip.id);
    const prevEnd = sameTrack
      .filter((c) => c.timeline_start <= startStart + 1e-6)
      .reduce((m, c) => Math.max(m, clipEnd(c)), 0);
    const nextStart = sameTrack
      .filter((c) => c.timeline_start >= clipEnd(clip) - 1e-6)
      .reduce((m, c) => Math.min(m, c.timeline_start), Infinity);

    const groupMove = mode === "move" && selectedClipIds.includes(clip.id) && selectedClipIds.length > 1;
    const excludeIds = new Set(groupMove ? selectedClipIds : [clip.id]);
    const edges = [...snapCandidates(project.tracks, excludeIds), playhead];

    let moved = false;
    let targetTrack = track;

    const move = (ev: MouseEvent) => {
      const rawDelta = (ev.clientX - startX) / zoom; // signed seconds delta
      if (Math.abs(ev.clientX - startX) > 2) moved = true;
      const disableSnap = ev.metaKey || ev.altKey;

      if (mode === "move") {
        if (groupMove) {
          const d = Math.round(rawDelta * fps) / fps; // signed, frame-quantized
          // live preview: shift each selected clip by d (no overwrite yet)
          const st = useProjectStore.getState();
          st.selectedClipIds.forEach((id) => {
            for (const t of st.project.tracks) {
              const c = t.clips.find((cc) => cc.id === id);
              if (c) {
                const orig = groupStarts.get(id) ?? c.timeline_start;
                useProjectStore.getState().updateClip(t.id, id, {
                  timeline_start: Math.max(0, orig + d),
                });
              }
            }
          });
          setSnapGuide(null);
        } else {
          const newStart = snapStart(startStart + rawDelta, dur, edges, disableSnap);
          updateClip(track.id, clip.id, { timeline_start: newStart });
          targetTrack = trackAtY(ev.clientY) ?? track;
        }
      } else if (mode === "left") {
        // trim in-point: clamp to >= prevEnd, <= end-MIN, within media
        let proposedStart = snapEdge(startStart + rawDelta, edges, disableSnap);
        proposedStart = Math.max(prevEnd, proposedStart);
        let newIn = startIn + (proposedStart - startStart) * speed;
        if (newIn < 0) { newIn = 0; proposedStart = startStart - startIn / speed; }
        if (proposedStart > clipEnd(clip) - MIN) proposedStart = clipEnd(clip) - MIN;
        newIn = startIn + (proposedStart - startStart) * speed;
        updateClip(track.id, clip.id, { source_in: newIn, timeline_start: Math.max(0, proposedStart) });
        moved = true;
      } else {
        // trim out-point: clamp to <= nextStart and media duration
        let proposedEnd = snapEdge(startStart + dur + rawDelta, edges, disableSnap);
        if (isFinite(nextStart)) proposedEnd = Math.min(proposedEnd, nextStart);
        let newOut = startIn + (proposedEnd - startStart) * speed;
        newOut = Math.max(startIn + MIN, Math.min(newOut, maxOut));
        updateClip(track.id, clip.id, { source_out: newOut });
        moved = true;
      }
    };

    const groupStarts = new Map<string, number>();
    if (groupMove) {
      for (const t of project.tracks)
        for (const c of t.clips) if (selectedClipIds.includes(c.id)) groupStarts.set(c.id, c.timeline_start);
    }

    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setSnapGuide(null);
      if (!moved) return;
      // Finalize with overlap resolution + history.
      if (mode === "move") {
        if (groupMove) {
          // we already previewed by shifting; resolve overlaps in place
          moveSelectedBy(0);
        } else {
          const dest = trackAtY(ev.clientY) ?? targetTrack ?? track;
          const finalStart = useProjectStore.getState().project.tracks
            .find((t) => t.id === track.id)?.clips.find((c) => c.id === clip.id)?.timeline_start ?? startStart;
          moveClip(track.id, dest.id, clip.id, finalStart);
        }
      }
      pushHistory();
    };

    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // ----- drops -----
  const handleDropOnTrack = async (e: React.DragEvent, trackId: Id) => {
    e.preventDefault();
    e.stopPropagation(); // don't let the window-level drop handler import it twice
    if (!lanesRef.current) return;
    const rect = lanesRef.current.getBoundingClientRect();
    const dropTime = snapToFrame(pxToTime(e.clientX - rect.left), fps);

    const mediaId = e.dataTransfer.getData("application/x-vedit-media");
    if (mediaId) {
      const asset = project.media.find((m) => m.id === mediaId);
      if (asset) {
        const dur = asset.durationSec > 0 ? asset.durationSec : 10;
        addClipToTrack(trackId, makeClip(mediaId, dur, dropTime));
        pushHistory();
      }
      return;
    }

    let paths = extractPathsFromDropEvent(e);
    if (paths.length === 0 && e.dataTransfer?.files?.length) {
      paths = Array.from(e.dataTransfer.files).map((f: any) => f?.path).filter((p): p is string => !!p);
    }
    if (paths.length === 0) return;
    try {
      const assets = await importMedia(paths);
      if (assets && assets.length > 0) {
        addMedia(assets, false);
        const first = assets[0];
        const dur = first.durationSec > 0 ? first.durationSec : 10;
        addClipToTrack(trackId, makeClip(first.id, dur, dropTime));
        pushHistory();
      } else {
        useProjectStore.getState().pushToast("Couldn't read that media file.", "error");
      }
    } catch (err: any) {
      useProjectStore.getState().pushToast(`Import failed: ${err?.message || String(err)}`, "error");
    }
  };

  const allowDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  return (
    <div className="workspace-panel flex flex-col h-full select-none">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 h-12 bg-panel border-b border-border/80 text-xs shrink-0">
        <div className="flex items-center gap-1">
          {/* tool group */}
          <div className="flex items-center bg-bg-secondary/80 border border-border/70 rounded-md p-0.5 mr-1">
            <button
              className={cn("btn-icon w-7 h-7", activeTool === "select" && "bg-accent/20 text-accent")}
              onClick={() => setTool("select")}
              title="Selection tool (V)"
            >
              <MousePointer2 className="w-3.5 h-3.5" />
            </button>
            <button
              className={cn("btn-icon w-7 h-7", activeTool === "razor" && "bg-accent/20 text-accent")}
              onClick={() => setTool("razor")}
              title="Razor tool (B)"
            >
              <Scissors className="w-3.5 h-3.5" />
            </button>
          </div>
          <button
            className={cn("btn-icon w-7 h-7", snapEnabled && "bg-accent/20 text-accent")}
            onClick={toggleSnap}
            title="Snapping (S)"
          >
            <Magnet className="w-3.5 h-3.5" />
          </button>

          <div className="w-px h-6 bg-border/80 mx-1" />

          <button className="btn-ghost text-xs" onClick={handleSplit} disabled={!selectedClipId} title="Split at playhead (⌘K)">
            <Scissors className="w-3.5 h-3.5" /> Split
          </button>
          <button
            className="btn-ghost text-xs hover:text-danger hover:bg-danger/10"
            onClick={handleDelete}
            disabled={!selectedClipId && selectedClipIds.length === 0}
            title="Delete (⌫) · ripple delete (⇧⌫)"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>

          <div className="w-px h-6 bg-border/80 mx-1" />

          {/* Export range (work area) controls */}
          <button
            className={cn("btn-ghost text-xs", exportRange && "text-accent")}
            onClick={() => setExportIn(playhead)}
            title="Set export range IN at playhead (I)"
          >
            <Bookmark className="w-3.5 h-3.5" /> In
          </button>
          <button
            className={cn("btn-ghost text-xs", exportRange && "text-accent")}
            onClick={() => setExportOut(playhead)}
            title="Set export range OUT at playhead (O)"
          >
            <Bookmark className="w-3.5 h-3.5 scale-x-[-1]" /> Out
          </button>
          {exportRange && (
            <button
              className="btn-ghost text-xs hover:text-danger hover:bg-danger/10"
              onClick={clearExportRange}
              title="Clear export range"
            >
              <X className="w-3.5 h-3.5" /> Clear
            </button>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="px-2.5 py-1 rounded-md bg-bg-secondary/85 border border-border font-mono text-text tabular-nums shadow-inset">
            {formatTimecode(playhead, fps)}
          </div>
          <div className="flex items-center gap-1">
            <button className="btn-icon w-7 h-7" onClick={() => setZoom(zoom - 15)} title="Zoom out (−)">
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <input type="range" min="5" max="200" value={zoom} onChange={(e) => setZoom(parseInt(e.target.value))} className="fader w-24" />
            <button className="btn-icon w-7 h-7" onClick={() => setZoom(zoom + 15)} title="Zoom in (+)">
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Track headers */}
        <div className="w-44 shrink-0 bg-panel border-r border-border/80 flex flex-col pt-7">
          <div className="flex-1 overflow-hidden">
            {project.tracks.map((track) => (
              <TrackHeader
                key={track.id}
                track={track}
                targeted={effectiveTarget === track.id}
                onTarget={() => setTargetTrack(track.id)}
                onMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenu({ kind: "track", x: e.clientX, y: e.clientY, track });
                }}
                onToggleMute={() => toggleTrackMute(track.id)}
                onToggleLock={() => toggleTrackLock(track.id)}
                onChangeVolume={(v) => setTrackVolume(track.id, v)}
              />
            ))}
          </div>
          <div className="p-2 border-t border-border/80 grid grid-cols-2 gap-1.5">
            <button className="btn-ghost !px-2 text-2xs justify-center" onClick={() => { addTrack("video"); pushHistory(); }}>
              <Plus className="w-3 h-3" /> Video
            </button>
            <button className="btn-ghost !px-2 text-2xs justify-center" onClick={() => { addTrack("audio"); pushHistory(); }}>
              <Plus className="w-3 h-3" /> Audio
            </button>
          </div>
        </div>

        {/* Tracks area */}
        <div
          ref={tracksContainerRef}
          className="flex-1 overflow-auto relative"
          onScroll={(e) => {
            if (rulerRef.current) rulerRef.current.scrollLeft = e.currentTarget.scrollLeft;
          }}
        >
          {/* Ruler */}
          <div
            ref={rulerRef}
            className="h-7 bg-panel border-b border-border/80 sticky top-0 z-20 overflow-hidden cursor-ew-resize"
            onMouseDown={handleRulerDown}
          >
            <div className="h-full relative" style={{ width: `${timeToPx(totalDuration)}px` }}>
              {renderRulerTicks(totalDuration, zoom, fps)}

              {/* Export range (work area bar) */}
              {exportRange && (
                <WorkAreaBar
                  inPoint={exportRange.inPoint}
                  outPoint={exportRange.outPoint}
                  timeToPx={timeToPx}
                  pxToTime={pxToTime}
                  onChangeIn={(t) => setExportRange(t, exportRange.outPoint)}
                  onChangeOut={(t) => setExportRange(exportRange.inPoint, t)}
                  onMove={(inP, outP) => setExportRange(inP, outP)}
                />
              )}
            </div>
          </div>

          {/* Clip lanes */}
          <div
            ref={lanesRef}
            className={cn("relative", activeTool === "razor" && "cursor-crosshair")}
            style={{ width: `${timeToPx(totalDuration)}px` }}
            onMouseDown={handleLaneBackgroundDown}
          >
            {project.tracks.map((track) => (
              <div
                key={track.id}
                className={cn(
                  "h-16 border-b border-border/60 relative",
                  track.kind === "video" ? "bg-bg-secondary/16" : "bg-bg-secondary/10",
                  effectiveTarget === track.id && "bg-accent/[0.055]",
                  track.locked && "opacity-60"
                )}
                onDragOver={allowDrop}
                onDrop={(e) => handleDropOnTrack(e, track.id)}
                onMouseDown={handleLaneBackgroundDown}
                onContextMenu={(e) => {
                  if (e.target !== e.currentTarget) return;
                  e.preventDefault();
                  setMenu({ kind: "track", x: e.clientX, y: e.clientY, track });
                }}
              >
                {track.clips.length === 0 && (
                    <div className="absolute inset-0 flex items-center pl-3 text-2xs text-text-dim pointer-events-none">
                      Drop {track.kind} here
                    </div>
                )}
                {track.clips.map((clip) => (
                  <TimelineClip
                    key={clip.id}
                    clip={clip}
                    asset={project.media.find((m) => m.id === clip.media_id)}
                    kind={track.kind}
                    locked={track.locked}
                    razor={activeTool === "razor"}
                    isSelected={selectedClipIds.includes(clip.id)}
                    isPrimary={selectedClipId === clip.id}
                    fps={fps}
                    frames={thumbs[clip.media_id] || []}
                    left={timeToPx(clip.timeline_start)}
                    width={Math.max(10, timeToPx(getClipDuration(clip)))}
                    onMouseDown={(e, m) => onClipMouseDown(e, clip, track, m)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenu({ kind: "clip", x: e.clientX, y: e.clientY, clip, track });
                    }}
                  />
                ))}
              </div>
            ))}

            {/* Snap guide */}
            {snapGuide != null && (
              <div className="absolute top-0 bottom-0 w-px bg-clip-audio z-40 pointer-events-none" style={{ left: `${timeToPx(snapGuide)}px` }} />
            )}

            {/* Playhead */}
            <div
              className="absolute top-0 bottom-0 z-30 w-3 -translate-x-1/2 cursor-ew-resize"
              style={{ left: `${timeToPx(playhead)}px` }}
              onMouseDown={handlePlayheadDown}
              title="Drag to scrub"
            >
              <div className="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-danger shadow-[0_0_10px_rgba(239,68,68,0.45)] pointer-events-none" />
              <div className="absolute -top-0 left-1/2 w-2.5 h-2.5 -translate-x-1/2 rotate-45 bg-danger rounded-[2px] shadow pointer-events-none" />
            </div>
          </div>

          {menu && (
            <TimelineContextMenu
              menu={menu}
              onClose={() => setMenu(null)}
              onDuplicateClip={(track, clip) => {
                const clone = { ...structuredClone(clip), id: uuid(), timeline_start: clipEnd(clip) };
                addClipToTrack(track.id, clone);
                selectClip(clone.id, track.id);
                pushHistory();
              }}
              onDeleteClip={(track, clip, ripple) => {
                selectClip(clip.id, track.id);
                if (ripple) {
                  useProjectStore.getState().deleteSelected(true);
                } else {
                  useProjectStore.getState().deleteSelected(false);
                }
                pushHistory();
              }}
              onTargetTrack={(track) => setTargetTrack(track.id)}
              onToggleMute={(track) => { toggleTrackMute(track.id); pushHistory(); }}
              onToggleLock={(track) => { toggleTrackLock(track.id); pushHistory(); }}
              onDeleteTrack={(track) => { removeTrack(track.id); pushHistory(); }}
              onAddTrack={(kind) => { addTrack(kind); pushHistory(); }}
            />
          )}
        </div>
      </div>
    </div>
  );

  function makeClip(mediaId: Id, dur: number, start: number): Clip {
    return {
      id: uuid(),
      media_id: mediaId,
      source_in: 0,
      source_out: dur,
      timeline_start: start,
      speed: 1,
      volume: 1,
      muted: false,
      opacity: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      color: { brightness: 0, contrast: 1, saturation: 1, gamma: 1, hue: 0, blur: 0 },
      keyframes: [],
    };
  }
}

function TrackHeader({
  track,
  targeted,
  onTarget,
  onMenu,
  onToggleMute,
  onToggleLock,
  onChangeVolume,
}: {
  track: Track;
  targeted: boolean;
  onTarget: () => void;
  onMenu: (e: React.MouseEvent) => void;
  onToggleMute: () => void;
  onToggleLock: () => void;
  onChangeVolume: (v: number) => void;
}) {
  const isVideo = track.kind === "video";
  return (
    <div
      className={cn(
        "h-16 border-b border-border/60 px-3 py-2 flex flex-col justify-between cursor-pointer",
        targeted ? "bg-accent/10 shadow-inset" : "hover:bg-surface-hover/40"
      )}
      onClick={onTarget}
      onContextMenu={onMenu}
      title={`Click to target ${track.name} for insert/overwrite/blade`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className={cn("flex items-center justify-center w-5 h-5 rounded", isVideo ? "bg-clip-video/15 text-clip-video" : "bg-clip-audio/15 text-clip-audio")}>
            {isVideo ? <Video className="w-3 h-3" /> : <Music className="w-3 h-3" />}
          </div>
          <span className="font-semibold text-text text-xs truncate">{track.name}</span>
          {targeted && <span className="w-1.5 h-1.5 rounded-full bg-accent" title="Target track" />}
        </div>
        <div className="flex items-center gap-0.5">
          <button className="btn-icon w-6 h-6" onClick={(e) => { e.stopPropagation(); onToggleMute(); }} title={track.muted ? "Unmute" : "Mute"}>
            {track.muted ? <VolumeX className="w-3.5 h-3.5 text-danger" /> : <Volume2 className="w-3.5 h-3.5" />}
          </button>
          <button className="btn-icon w-6 h-6" onClick={(e) => { e.stopPropagation(); onToggleLock(); }} title={track.locked ? "Unlock" : "Lock"}>
            {track.locked ? <Lock className="w-3.5 h-3.5 text-clip-title" /> : <Unlock className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <Volume2 className="w-3 h-3 text-text-dim shrink-0" />
        <input type="range" min="0" max="1" step="0.05" value={track.volume} onChange={(e) => onChangeVolume(parseFloat(e.target.value))} className="fader flex-1" title={`${track.name} volume`} />
      </div>
    </div>
  );
}

function TimelineClip({
  clip, asset, kind, locked, razor, isSelected, isPrimary, fps, frames, left, width, onMouseDown, onContextMenu,
}: {
  clip: Clip;
  asset?: MediaAsset;
  kind: "video" | "audio";
  locked: boolean;
  razor: boolean;
  isSelected: boolean;
  isPrimary: boolean;
  fps: number;
  frames: string[];
  left: number;
  width: number;
  onMouseDown: (e: React.MouseEvent, mode: "move" | "left" | "right") => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const isVideo = kind === "video";
  const showFilmstrip = isVideo && frames.length > 0 && width > 40;
  const filmstripTiles = React.useMemo(() => {
    if (!showFilmstrip) return [];
    const count = Math.min(180, Math.max(1, Math.ceil(width / 96)));
    return Array.from({ length: count }, (_, i) => {
      const idx = Math.min(frames.length - 1, Math.floor((i / count) * frames.length));
      return frames[idx];
    });
  }, [frames, showFilmstrip, width]);

  return (
    <div
      className={cn(
        "absolute top-1.5 bottom-1.5 rounded-md overflow-hidden group border shadow-[0_10px_22px_-18px_rgba(0,0,0,0.9)]",
        isVideo ? "border-clip-video/55" : "border-clip-audio/55",
        !showFilmstrip && (isVideo
          ? "bg-gradient-to-b from-clip-video/35 to-clip-video/15"
          : "bg-gradient-to-b from-clip-audio/35 to-clip-audio/15"),
        isSelected ? "ring-2 ring-white/90 z-10" : "hover:brightness-110",
        isPrimary && "ring-accent",
        locked ? "cursor-not-allowed" : razor ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"
      )}
      style={{ left: `${left}px`, width: `${width}px` }}
      onMouseDown={(e) => onMouseDown(e, "move")}
      onContextMenu={onContextMenu}
      title={asset ? `${asset.name} · in ${clip.source_in.toFixed(2)}s → out ${clip.source_out.toFixed(2)}s` : "Missing media"}
    >
      {/* Filmstrip (video) */}
      {showFilmstrip && (
        <div className="absolute inset-0 flex pointer-events-none overflow-hidden bg-black/30">
          {filmstripTiles.map((f, i) => (
            <img
              key={`${f}-${i}`}
              src={assetUrl(f)}
              className="h-full shrink-0 object-cover"
              style={{ width: `${Math.max(56, width / filmstripTiles.length)}px` }}
              draggable={false}
              alt=""
            />
          ))}
        </div>
      )}
      {/* Waveform-ish bars (audio) */}
      {!isVideo && <AudioBars seed={clip.id} />}

      {/* readability overlay + top stripe */}
      <div className={cn("absolute top-0 left-0 right-0 h-1", isVideo ? "bg-clip-video" : "bg-clip-audio")} />
      <div className="absolute inset-0 bg-gradient-to-t from-black/72 via-black/8 to-black/38 pointer-events-none" />
      <div className="relative px-2 py-1 flex flex-col h-full justify-between pointer-events-none">
        <span className="text-2xs font-semibold text-white truncate drop-shadow">{asset?.name ?? "Missing media"}</span>
        <div className="flex items-center justify-between text-[9px] font-mono text-white/80 leading-none drop-shadow">
          <span>{formatTimecode(getClipDuration(clip), fps)}</span>
          {clip.speed !== 1 && <span className="text-clip-title">{clip.speed}×</span>}
        </div>
      </div>

      {!locked && !razor && (
        <>
          <div onMouseDown={(e) => onMouseDown(e, "left")} className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize bg-white/0 group-hover:bg-white/70 transition-colors z-10" title="Trim in" />
          <div onMouseDown={(e) => onMouseDown(e, "right")} className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize bg-white/0 group-hover:bg-white/70 transition-colors z-10" title="Trim out" />
        </>
      )}
    </div>
  );
}

function TimelineContextMenu({
  menu,
  onClose,
  onDuplicateClip,
  onDeleteClip,
  onTargetTrack,
  onToggleMute,
  onToggleLock,
  onDeleteTrack,
  onAddTrack,
}: {
  menu:
    | { kind: "clip"; x: number; y: number; clip: Clip; track: Track }
    | { kind: "track"; x: number; y: number; track: Track };
  onClose: () => void;
  onDuplicateClip: (track: Track, clip: Clip) => void;
  onDeleteClip: (track: Track, clip: Clip, ripple: boolean) => void;
  onTargetTrack: (track: Track) => void;
  onToggleMute: (track: Track) => void;
  onToggleLock: (track: Track) => void;
  onDeleteTrack: (track: Track) => void;
  onAddTrack: (kind: "video" | "audio") => void;
}) {
  const item = "w-full px-3 py-2 text-left hover:bg-surface-hover";
  return (
    <div
      className="fixed z-[80] min-w-44 rounded-lg border border-border bg-surface shadow-panel py-1 text-xs"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {menu.kind === "clip" ? (
        <>
          <button className={item} onClick={() => { onDuplicateClip(menu.track, menu.clip); onClose(); }}>
            Copy / duplicate clip
          </button>
          <button className={item} onClick={() => { onDeleteClip(menu.track, menu.clip, false); onClose(); }}>
            Delete clip
          </button>
          <button className={item} onClick={() => { onDeleteClip(menu.track, menu.clip, true); onClose(); }}>
            Ripple delete
          </button>
        </>
      ) : (
        <>
          <button className={item} onClick={() => { onTargetTrack(menu.track); onClose(); }}>
            Target {menu.track.name}
          </button>
          <button className={item} onClick={() => { onToggleMute(menu.track); onClose(); }}>
            {menu.track.muted ? "Unmute" : "Mute"} track
          </button>
          <button className={item} onClick={() => { onToggleLock(menu.track); onClose(); }}>
            {menu.track.locked ? "Unlock" : "Lock"} track
          </button>
          <div className="h-px bg-border my-1" />
          <button className={item} onClick={() => { onAddTrack("video"); onClose(); }}>
            Add video track
          </button>
          <button className={item} onClick={() => { onAddTrack("audio"); onClose(); }}>
            Add audio track
          </button>
          <div className="h-px bg-border my-1" />
          <button className="w-full px-3 py-2 text-left text-danger hover:bg-danger/10" onClick={() => { onDeleteTrack(menu.track); onClose(); }}>
            Delete track
          </button>
        </>
      )}
    </div>
  );
}

// Lightweight stylized waveform for audio clips (deterministic from the clip id).
function AudioBars({ seed }: { seed: string }) {
  const bars = React.useMemo(() => {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    const rand = () => { h = (h * 1664525 + 1013904223) >>> 0; return (h >>> 8) / 0xffffff; };
    return Array.from({ length: 48 }, () => 0.25 + rand() * 0.7);
  }, [seed]);
  return (
    <div className="absolute inset-0 flex items-center gap-px px-1 pointer-events-none opacity-70">
      {bars.map((v, i) => (
        <div key={i} className="flex-1 bg-clip-audio rounded-full" style={{ height: `${v * 70}%` }} />
      ))}
    </div>
  );
}

/** Draggable work area bar for export range. Rendered inside the ruler area. */
function WorkAreaBar({
  inPoint,
  outPoint,
  timeToPx,
  pxToTime,
  onChangeIn,
  onChangeOut,
  onMove,
}: {
  inPoint: number;
  outPoint: number;
  timeToPx: (t: number) => number;
  pxToTime: (px: number) => number;
  onChangeIn: (t: number) => void;
  onChangeOut: (t: number) => void;
  onMove: (inP: number, outP: number) => void;
}) {
  const left = timeToPx(inPoint);
  const width = Math.max(4, timeToPx(outPoint) - left);

  const startDrag = (mode: "in" | "out" | "body") => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startIn = inPoint;
    const startOut = outPoint;
    const dur = outPoint - inPoint;

    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dt = pxToTime(Math.abs(dx)) * Math.sign(dx);

      if (mode === "in") {
        onChangeIn(Math.max(0, Math.min(startIn + dt, startOut - 0.05)));
      } else if (mode === "out") {
        onChangeOut(Math.max(startIn + 0.05, startOut + dt));
      } else {
        const newIn = Math.max(0, startIn + dt);
        onMove(newIn, newIn + dur);
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <>
      {/* Dimmed regions outside the work area */}
      <div
        className="absolute top-0 bottom-0 bg-black/30 pointer-events-none"
        style={{ left: 0, width: `${left}px` }}
      />
      <div
        className="absolute top-0 bottom-0 bg-black/30 pointer-events-none"
        style={{ left: `${left + width}px`, right: 0 }}
      />

      {/* Selected region body (draggable) */}
      <div
        className="absolute top-0 bottom-0 bg-accent/25 border-t-2 border-accent cursor-grab active:cursor-grabbing z-10"
        style={{ left: `${left}px`, width: `${width}px` }}
        onMouseDown={startDrag("body")}
        title={`Export range: ${inPoint.toFixed(1)}s – ${outPoint.toFixed(1)}s`}
      />

      {/* IN handle */}
      <div
        className="absolute top-0 bottom-0 w-2 cursor-ew-resize z-20 group"
        style={{ left: `${left - 4}px` }}
        onMouseDown={startDrag("in")}
        title="Drag to adjust range IN"
      >
        <div className="absolute top-0 bottom-0 left-1 w-0.5 bg-accent group-hover:bg-accent-hover" />
      </div>

      {/* OUT handle */}
      <div
        className="absolute top-0 bottom-0 w-2 cursor-ew-resize z-20 group"
        style={{ left: `${left + width - 4}px` }}
        onMouseDown={startDrag("out")}
        title="Drag to adjust range OUT"
      >
        <div className="absolute top-0 bottom-0 right-1 w-0.5 bg-accent group-hover:bg-accent-hover" />
      </div>
    </>
  );
}

function renderRulerTicks(totalSecs: number, zoom: number, fps: number) {
  const ticks = [];
  let step = 1;
  if (zoom < 10) step = 10;
  else if (zoom < 25) step = 5;
  else if (zoom < 60) step = 2;
  else if (zoom > 120) step = 0.5;

  for (let t = 0; t <= totalSecs; t += step) {
    const major = step >= 5 || t % (step * 5) < 0.001;
    ticks.push(
      <div key={t} className="absolute top-0 bottom-0 flex flex-col justify-center" style={{ left: `${t * zoom}px` }}>
        <div className={cn("w-px", major ? "h-3 bg-border-hover" : "h-1.5 bg-border")} />
        {major && <span className="absolute top-0.5 left-1 text-[9px] font-mono text-text-dim">{formatTimecode(t, fps).slice(3)}</span>}
      </div>
    );
  }
  return ticks;
}

function formatTimecode(sec: number, fps: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const f = Math.floor((sec % 1) * fps);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}

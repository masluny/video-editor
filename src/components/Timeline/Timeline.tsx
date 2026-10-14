import * as React from "react";
import {
  Copy,
  Eye,
  EyeOff,
  Flag,
  Lock,
  Magnet,
  Maximize2,
  MousePointer2,
  Plus,
  Scissors,
  Trash2,
  Unlock,
  Volume2,
  VolumeX,
  Wand2,
  ZoomIn,
  ZoomOut,
  Headphones,
  Unlink,
  ClipboardPaste,
  Type,
} from "lucide-react";
import type { Clip, Id, Track, TrackKind } from "../../lib/types";
import { findClip, store, useStore, ZOOM_MAX, ZOOM_MIN } from "../../store/store";
import { useDrag } from "../../store/drag";
import {
  clipDuration,
  clipEnd,
  EPS,
  gapAt,
  MIN_CLIP,
  projectDuration,
  snapToFrame,
  sourceBounds,
  speedOf,
} from "../../lib/timeline";
import { ClipView, type ClipGrab } from "./ClipView";
import { displayOrder, HEADER_W, RULER_H, snap, trackHeight, type TrackSize } from "./geometry";
import { dropTarget, payloadKind, payloadLength } from "./drop";
import { IconButton, Segmented } from "../ui/controls";
import { openMenu, type MenuItem } from "../ui/Menu";
import { useLocal } from "../../lib/useLocal";
import { timecode } from "../../lib/format";
import { cn } from "../../lib/cn";
import { MARKER_COLORS } from "../../lib/defaults";

interface Row {
  track: Track;
  top: number;
  height: number;
}

const mod = (e: { metaKey: boolean; ctrlKey: boolean }) => e.metaKey || e.ctrlKey;

export function Timeline() {
  const project = useStore((s) => s.project);
  const zoom = useStore((s) => s.zoom);
  const selection = useStore((s) => s.selection);
  const tool = useStore((s) => s.tool);
  const runtime = useStore((s) => s.runtime);
  const [size, setSize] = useLocal<TrackSize>("revind.trackSize", "m");
  const scroller = React.useRef<HTMLDivElement>(null);
  const [view, setView] = React.useState({ left: 0, width: 1200 });
  const [guide, setGuide] = React.useState<number | null>(null);
  const [marquee, setMarquee] = React.useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const rows = React.useMemo(() => {
    const out: Row[] = [];
    let y = RULER_H;
    for (const track of displayOrder(project)) {
      const h = trackHeight(track, size);
      out.push({ track, top: y, height: h });
      y += h;
    }
    return out;
  }, [project, size]);
  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;

  const duration = projectDuration(project);
  const laneW = Math.max(view.width - HEADER_W, (duration + 20) * zoom, 400);
  const totalH = rows.length ? rows[rows.length - 1].top + rows[rows.length - 1].height : RULER_H;
  const viewStart = view.left / zoom;
  const viewEnd = (view.left + view.width - HEADER_W) / zoom;
  const selected = React.useMemo(() => new Set(selection), [selection]);

  // --- viewport tracking ------------------------------------------------------
  React.useLayoutEffect(() => {
    const el = scroller.current!;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setView({ left: el.scrollLeft, width: el.clientWidth }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  /** Client X -> timeline seconds. */
  const timeAt = React.useCallback((clientX: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, (clientX - r.left - HEADER_W + el.scrollLeft) / store().zoom);
  }, []);

  // --- zoom: keep an anchor time under the same screen x -----------------------
  const anchor = React.useRef<{ time: number; x: number } | null>(null);
  const prevZoom = React.useRef(zoom);
  React.useLayoutEffect(() => {
    const el = scroller.current!;
    if (prevZoom.current === zoom) return;
    let a = anchor.current;
    if (!a) {
      const ph = store().playhead;
      const x = ph * prevZoom.current - el.scrollLeft;
      a = x >= 0 && x <= el.clientWidth - HEADER_W ? { time: ph, x } : { time: el.scrollLeft / prevZoom.current, x: 0 };
    }
    el.scrollLeft = Math.max(0, a.time * zoom - a.x);
    anchor.current = null;
    prevZoom.current = zoom;
  }, [zoom]);

  React.useEffect(() => {
    const el = scroller.current!;
    const onWheel = (e: WheelEvent) => {
      if (!mod(e) && !e.altKey) return;
      e.preventDefault();
      const s = store();
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left - HEADER_W;
      anchor.current = { time: (x + el.scrollLeft) / s.zoom, x };
      s.setZoom(s.zoom * Math.exp(-e.deltaY * 0.0025));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // --- keep the playhead in view ----------------------------------------------
  React.useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        const el = scroller.current;
        if (!el) return;
        const x = s.playhead * s.zoom;
        const w = el.clientWidth - HEADER_W;
        if (s.seekNonce !== prev.seekNonce) {
          if (x < el.scrollLeft || x > el.scrollLeft + w) el.scrollLeft = Math.max(0, x - w / 2);
        } else if (s.playing && s.playhead !== prev.playhead && x > el.scrollLeft + w - 4) {
          el.scrollLeft = Math.max(0, x - 40);
        }
      }),
    [],
  );

  const zoomToFit = React.useCallback(() => {
    const el = scroller.current!;
    const d = projectDuration(store().project);
    anchor.current = { time: 0, x: 0 };
    store().setZoom(d > 0 ? (el.clientWidth - HEADER_W - 40) / d : 60);
  }, []);

  // --- clip interactions -------------------------------------------------------
  const onClipPointerDown = React.useCallback(
    (e: React.PointerEvent, grab: ClipGrab, clip: Clip, track: Track) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const s = store();
      if (track.locked) {
        s.select([clip.id]);
        return;
      }
      if (s.tool === "blade") {
        const t = snap(timeAt(e.clientX), new Set(), { disabled: e.altKey }).time;
        if (e.shiftKey) {
          // Shift+blade cuts every unlocked track at that point.
          const prev = s.playhead;
          useStore.setState({ playhead: t });
          s.select([]);
          s.splitAtPlayhead();
          useStore.setState({ playhead: prev });
        } else s.splitClipAt(clip.id, t);
        return;
      }
      if (e.shiftKey || mod(e)) {
        s.toggleSelect(clip.id);
        return;
      }
      if (!s.selection.includes(clip.id)) s.select([clip.id]);
      if (grab === "move") startMove(e, clip, track);
      else if (grab === "trim-left" || grab === "trim-right") startTrim(clip, track, grab === "trim-left");
      else startFade(clip, grab === "fade-in");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function trackDrag(onMove: (ev: PointerEvent) => void, onUp: (ev: PointerEvent, cancelled: boolean) => void) {
    const move = (ev: PointerEvent) => onMove(ev);
    const finish = (ev: PointerEvent, cancelled: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", esc, true);
      document.body.style.cursor = "";
      onUp(ev, cancelled);
    };
    const up = (ev: PointerEvent) => finish(ev, false);
    const cancel = (ev: PointerEvent) => finish(ev, true);
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      finish(new PointerEvent("pointercancel"), true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", esc, true);
  }

  function startMove(e: React.PointerEvent, clip: Clip, track: Track) {
    const s0 = store();
    const proj = s0.project;
    let ids = (s0.selection.includes(clip.id) ? s0.selection : [clip.id]).filter((id) => {
      const hit = findClip(proj, id);
      return hit && !hit.track.locked;
    });
    const lanes: Record<TrackKind, Track[]> = { video: [], audio: [] };
    for (const t of displayOrder(proj)) lanes[t.kind].push(t);
    const laneIndex = (id: Id) => {
      const t = proj.tracks.find((x) => x.id === id)!;
      return { kind: t.kind, i: lanes[t.kind].findIndex((x) => x.id === id) };
    };
    let items = ids.map((id) => {
      const hit = findClip(proj, id)!;
      return { id, ...laneIndex(hit.track.id), start: hit.clip.start, dur: clipDuration(hit.clip) };
    });
    const grabbed = laneIndex(track.id);
    const minStart = Math.min(...items.map((i) => i.start));
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    let primary = clip.id;

    trackDrag(
      (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        if (!moved) {
          moved = true;
          document.body.style.cursor = "grabbing";
          if (ev.altKey) {
            const map = store().duplicateInPlaceLive(ids);
            items = items.map((i) => ({ ...i, id: map.get(i.id) ?? i.id }));
            ids = items.map((i) => i.id);
            primary = map.get(primary) ?? primary;
          }
        }
        const zoom = store().zoom;
        let dt = Math.max(-minStart, (ev.clientX - sx) / zoom);
        const g = items.find((i) => i.id === primary)!;
        const exclude = new Set(ids);
        const a = snap(g.start + dt, exclude, { disabled: ev.shiftKey });
        const b = snap(g.start + g.dur + dt, exclude, { disabled: ev.shiftKey });
        let shownGuide: number | null = null;
        if (b.guide != null && (a.guide == null || Math.abs(b.time - (g.start + g.dur + dt)) < Math.abs(a.time - (g.start + dt)))) {
          dt = b.time - g.dur - g.start;
          shownGuide = b.guide;
        } else {
          dt = a.time - g.start;
          shownGuide = a.guide;
        }
        dt = Math.max(-minStart, dt);

        // Vertical: move between lanes of the same kind.
        let shift = 0;
        const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-lane]");
        if (under && under.dataset.kind === grabbed.kind) {
          shift = lanes[grabbed.kind].findIndex((t) => t.id === under.dataset.lane) - grabbed.i;
        }
        const ok = items.every((i) => {
          const dest = lanes[i.kind][i.i + shift];
          return dest && !dest.locked;
        });
        if (!ok) shift = 0;
        store().moveClipsLive(items.map((i) => ({ id: i.id, trackId: lanes[i.kind][i.i + shift].id, start: i.start + dt })));
        setGuide(shownGuide);
      },
      (_ev, cancelled) => {
        setGuide(null);
        if (!moved) {
          store().select([clip.id]);
          return;
        }
        if (cancelled) {
          store().cancelLive();
          return;
        }
        store().settleClips(ids);
        store().select(ids.filter((id) => findClip(store().project, id)));
      },
    );
  }

  function startTrim(clip: Clip, track: Track, left: boolean) {
    const s0 = store();
    const media = s0.project.media.find((m) => m.id === clip.mediaId);
    const b = sourceBounds(clip, media);
    const sp = speedOf(clip);
    const end = clipEnd(clip);
    const others = track.clips.filter((c) => c.id !== clip.id);
    const prevEnd = Math.max(0, ...others.filter((c) => clipEnd(c) <= clip.start + EPS).map(clipEnd));
    const nextStart = Math.min(Infinity, ...others.filter((c) => c.start >= end - EPS).map((c) => c.start));
    document.body.style.cursor = "ew-resize";
    trackDrag(
      (ev) => {
        const { time, guide } = snap(timeAt(ev.clientX), new Set([clip.id]), { disabled: ev.shiftKey });
        if (left) {
          const lo = Math.max(prevEnd, clip.start - (clip.in - b.min) / sp);
          const t = Math.min(end - MIN_CLIP, Math.max(lo, time));
          store().updateClip(
            clip.id,
            (c) => {
              c.start = t;
              c.in = clip.in + (t - clip.start) * sp;
              const d = clipDuration(c as Clip);
              c.fadeIn = Math.min(c.fadeIn, d);
              c.fadeOut = Math.min(c.fadeOut, d - c.fadeIn);
            },
            { live: true },
          );
        } else {
          const hi = Math.min(nextStart, clip.start + (b.max - clip.in) / sp);
          const t = Math.max(clip.start + MIN_CLIP, Math.min(hi, time));
          store().updateClip(
            clip.id,
            (c) => {
              c.out = clip.in + (t - clip.start) * sp;
              const d = clipDuration(c as Clip);
              c.fadeOut = Math.min(c.fadeOut, d);
              c.fadeIn = Math.min(c.fadeIn, d - c.fadeOut);
            },
            { live: true },
          );
        }
        setGuide(guide);
      },
      (_ev, cancelled) => {
        setGuide(null);
        if (cancelled) store().cancelLive();
        else store().commit();
      },
    );
  }

  function startFade(clip: Clip, fadeIn: boolean) {
    document.body.style.cursor = "ew-resize";
    const d = clipDuration(clip);
    const fps = store().project.settings.fps;
    trackDrag(
      (ev) => {
        const t = timeAt(ev.clientX);
        if (fadeIn) {
          const v = snapToFrame(Math.max(0, Math.min(d - clip.fadeOut, t - clip.start)), fps);
          store().updateClip(clip.id, (c) => void (c.fadeIn = v), { live: true });
        } else {
          const v = snapToFrame(Math.max(0, Math.min(d - clip.fadeIn, clipEnd(clip) - t)), fps);
          store().updateClip(clip.id, (c) => void (c.fadeOut = v), { live: true });
        }
      },
      (_ev, cancelled) => (cancelled ? store().cancelLive() : store().commit()),
    );
  }

  const onClipContextMenu = React.useCallback((e: React.MouseEvent, clip: Clip, track: Track) => {
    const s = store();
    if (!s.selection.includes(clip.id)) s.select([clip.id]);
    const ids = store().selection;
    const media = clip.mediaId ? s.project.media.find((m) => m.id === clip.mediaId) : undefined;
    const hasAudio = clip.type === "media" && !!media?.hasAudio && media.kind !== "image";
    const under = s.playhead > clip.start + EPS && s.playhead < clipEnd(clip) - EPS;
    const items: MenuItem[] = [
      { label: "Split at playhead", icon: <Scissors className="h-3.5 w-3.5" />, shortcut: "S", disabled: !under || track.locked, onSelect: () => s.splitClipAt(clip.id, s.playhead) },
      { label: "Duplicate", icon: <Copy className="h-3.5 w-3.5" />, shortcut: "⌘D", disabled: track.locked, onSelect: () => s.duplicateClips(ids) },
      { label: "Copy", shortcut: "⌘C", onSelect: () => s.copy() },
      { label: "Cut", shortcut: "⌘X", disabled: track.locked, onSelect: () => s.cut() },
      { separator: true },
    ];
    if (hasAudio) {
      items.push(
        { label: "Remove silences…", icon: <Wand2 className="h-3.5 w-3.5" />, disabled: track.locked, onSelect: () => s.openDialog({ kind: "silence", clipId: clip.id }) },
        {
          label: clip.muted ? "Unmute clip audio" : "Mute clip audio",
          icon: clip.muted ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />,
          disabled: track.locked,
          onSelect: () => s.updateClip(clip.id, (c) => void (c.muted = !c.muted)),
        },
      );
      if (track.kind === "video")
        items.push({ label: "Detach audio", icon: <Unlink className="h-3.5 w-3.5" />, disabled: track.locked || clip.muted, onSelect: () => s.detachAudio(clip.id) });
      items.push({ separator: true });
    }
    if (media)
      items.push({ label: "Show in library", onSelect: () => s.setSelectedMedia(media.id) }, { separator: true });
    items.push(
      { label: "Delete", icon: <Trash2 className="h-3.5 w-3.5" />, shortcut: "⌫", danger: true, disabled: track.locked, onSelect: () => s.deleteClips(ids, false) },
      { label: "Ripple delete", shortcut: "⇧⌫", danger: true, disabled: track.locked, onSelect: () => s.deleteClips(ids, true) },
    );
    openMenu(e, items);
  }, []);

  const onClipDoubleClick = React.useCallback((clip: Clip) => {
    const s = store();
    s.select([clip.id]);
    if (s.playhead < clip.start || s.playhead >= clipEnd(clip)) s.seek(clip.start);
  }, []);

  // --- lane background: marquee / deselect / menu ------------------------------
  const onLanePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const s = store();
    if (s.tool === "blade") return;
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    const toContent = (cx: number, cy: number) => ({ x: cx - r.left + el.scrollLeft, y: cy - r.top + el.scrollTop });
    const p0 = toContent(e.clientX, e.clientY);
    const base = e.shiftKey || mod(e) ? s.selection : [];
    let moved = false;
    trackDrag(
      (ev) => {
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
        moved = true;
        const p1 = toContent(ev.clientX, ev.clientY);
        setMarquee({ x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y });
        const x0 = Math.min(p0.x, p1.x) - HEADER_W;
        const x1 = Math.max(p0.x, p1.x) - HEADER_W;
        const y0 = Math.min(p0.y, p1.y);
        const y1 = Math.max(p0.y, p1.y);
        const z = store().zoom;
        const hits: Id[] = [];
        for (const row of rowsRef.current) {
          if (row.track.locked || row.top + row.height < y0 || row.top > y1) continue;
          for (const c of row.track.clips) if (c.start * z < x1 && clipEnd(c) * z > x0) hits.push(c.id);
        }
        store().select([...new Set([...base, ...hits])]);
      },
      () => {
        setMarquee(null);
        if (!moved && !e.shiftKey && !mod(e)) store().select([]);
      },
    );
  };

  const onLaneContextMenu = (e: React.MouseEvent, track: Track) => {
    const s = store();
    const t = timeAt(e.clientX);
    const gap = gapAt(track, t);
    openMenu(e, [
      { label: "Paste here", icon: <ClipboardPaste className="h-3.5 w-3.5" />, disabled: !s.clipboard.length, onSelect: () => (s.seek(snapToFrame(t, s.project.settings.fps)), s.paste()) },
      { label: "Close gap", disabled: !gap || track.locked, onSelect: () => s.closeGapAt(track.id, t) },
      ...(track.kind === "video"
        ? [{ label: "Add title here", icon: <Type className="h-3.5 w-3.5" />, disabled: track.locked, onSelect: () => s.placeTitle(undefined, { trackId: track.id, at: t }) } as MenuItem]
        : []),
      { label: "Add marker here", icon: <Flag className="h-3.5 w-3.5" />, onSelect: () => s.addMarker(t) },
      { separator: true },
      ...trackMenu(track),
    ]);
  };

  return (
    <div className="panel flex h-full min-h-0 flex-col">
      <Toolbar size={size} onSize={setSize} onFit={zoomToFit} />
      <div
        ref={scroller}
        className={cn("relative min-h-0 flex-1 overflow-auto overscroll-none bg-bg-deep/40", tool === "blade" && "[&_[data-lane]]:cursor-crosshair")}
      >
        <div className="relative" style={{ width: HEADER_W + laneW, height: Math.max(totalH, 1) }}>
          {/* Ruler */}
          <div className="sticky top-0 z-[20] flex" style={{ height: RULER_H, width: HEADER_W + laneW }}>
            <div className="sticky left-0 z-[2] flex shrink-0 items-center gap-1 border-b border-r border-line bg-panel px-2" style={{ width: HEADER_W }}>
              <AddTrackButton />
              <span className="ml-auto font-mono text-2xs text-ink-dim tabular">{timecode(duration, project.settings.fps)}</span>
            </div>
            <Ruler width={laneW} viewLeft={view.left} viewWidth={view.width - HEADER_W} timeAt={timeAt} />
          </div>

          {/* Tracks */}
          {rows.map((row) => (
            <div key={row.track.id} className="absolute left-0 flex" style={{ top: row.top, height: row.height, width: HEADER_W + laneW }}>
              <TrackHeader track={row.track} height={row.height} />
              <div
                data-lane={row.track.id}
                data-kind={row.track.kind}
                className={cn(
                  "relative border-b border-line-soft",
                  row.track.kind === "audio" ? "bg-[#0f1211]" : "bg-[#0f0f13]",
                  row.track.locked && "bg-[repeating-linear-gradient(135deg,transparent_0_8px,rgba(255,255,255,0.025)_8px_16px)]",
                  row.track.hidden && "opacity-50",
                )}
                style={{ width: laneW }}
                onPointerDown={onLanePointerDown}
                onContextMenu={(e) => onLaneContextMenu(e, row.track)}
              >
                {row.track.clips.map((c) => {
                  if (clipEnd(c) < viewStart - 2 || c.start > viewEnd + 2) return null;
                  const media = c.mediaId ? project.media.find((m) => m.id === c.mediaId) : undefined;
                  return (
                    <ClipView
                      key={c.id}
                      clip={c}
                      track={row.track}
                      media={media}
                      runtime={media ? runtime[media.id] : undefined}
                      zoom={zoom}
                      height={row.height}
                      selected={selected.has(c.id)}
                      blade={tool === "blade"}
                      viewStart={viewStart}
                      viewEnd={viewEnd}
                      onPointerDown={onClipPointerDown}
                      onContextMenu={onClipContextMenu}
                      onDoubleClick={onClipDoubleClick}
                    />
                  );
                })}
              </div>
            </div>
          ))}

          <RangeOverlay height={totalH} />
          <DropGhost rows={rows} />
          {guide != null && (
            <div className="pointer-events-none absolute top-0 z-[15] w-px bg-[#ffd84f]" style={{ left: HEADER_W + guide * zoom, height: totalH }} />
          )}
          {marquee && (
            <div
              className="pointer-events-none absolute z-[16] rounded-sm border border-accent bg-accent/10"
              style={{
                left: Math.min(marquee.x0, marquee.x1),
                top: Math.min(marquee.y0, marquee.y1),
                width: Math.abs(marquee.x1 - marquee.x0),
                height: Math.abs(marquee.y1 - marquee.y0),
              }}
            />
          )}
          <Playhead height={totalH} timeAt={timeAt} viewLeft={view.left} />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- toolbar

function Toolbar({ size, onSize, onFit }: { size: TrackSize; onSize: (s: TrackSize) => void; onFit: () => void }) {
  const tool = useStore((s) => s.tool);
  const snapping = useStore((s) => s.snapping);
  const zoom = useStore((s) => s.zoom);
  const hasSel = useStore((s) => s.selection.length > 0);
  const s = store;
  const lz = (z: number) => Math.log(z);
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
      <Segmented
        value={tool}
        onChange={(t) => s().setTool(t)}
        size="sm"
        options={[
          { value: "select", label: <MousePointer2 className="h-3 w-3" />, title: "Select (V)" },
          { value: "blade", label: <Scissors className="h-3 w-3" />, title: "Blade (B) — click a clip to cut it; Shift cuts all tracks" },
        ]}
      />
      <div className="mx-1 h-4 w-px bg-line" />
      <IconButton size="sm" title="Snapping (N)" active={snapping} onClick={() => s().toggleSnapping()}>
        <Magnet className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton size="sm" title="Split at playhead (S)" onClick={() => s().splitAtPlayhead()}>
        <Scissors className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton size="sm" title="Delete selection (⌫) · Shift: ripple" disabled={!hasSel} onClick={(e) => s().deleteClips(s().selection, e.shiftKey)}>
        <Trash2 className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton size="sm" title="Add marker (M)" onClick={() => s().addMarker()}>
        <Flag className="h-3.5 w-3.5" />
      </IconButton>
      <div className="flex-1" />
      <Segmented
        value={size}
        onChange={onSize}
        size="sm"
        className="mr-2"
        options={[
          { value: "s", label: "S", title: "Compact tracks" },
          { value: "m", label: "M", title: "Medium tracks" },
          { value: "l", label: "L", title: "Large tracks" },
        ]}
      />
      <IconButton size="sm" title="Zoom out (−)" onClick={() => s().setZoom(zoom / 1.4)}>
        <ZoomOut className="h-3.5 w-3.5" />
      </IconButton>
      <input
        type="range"
        className="range w-28"
        min={lz(ZOOM_MIN)}
        max={lz(ZOOM_MAX)}
        step={0.01}
        value={lz(zoom)}
        style={{ ["--fill" as string]: `${((lz(zoom) - lz(ZOOM_MIN)) / (lz(ZOOM_MAX) - lz(ZOOM_MIN))) * 100}%` }}
        onChange={(e) => s().setZoom(Math.exp(parseFloat(e.target.value)))}
        title="Zoom (⌘ + scroll)"
      />
      <IconButton size="sm" title="Zoom in (+)" onClick={() => s().setZoom(zoom * 1.4)}>
        <ZoomIn className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton size="sm" title="Zoom to fit (Shift+Z)" onClick={onFit}>
        <Maximize2 className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  );
}

function AddTrackButton() {
  return (
    <IconButton
      size="xs"
      title="Add track"
      onClick={(e) =>
        openMenu({ clientX: e.clientX, clientY: e.clientY + 8, preventDefault: () => {}, stopPropagation: () => {} }, [
          { label: "Add video track", onSelect: () => store().addTrack("video") },
          { label: "Add audio track", onSelect: () => store().addTrack("audio") },
        ])
      }
    >
      <Plus className="h-3.5 w-3.5" />
    </IconButton>
  );
}

// -------------------------------------------------------------- track header

function trackMenu(track: Track): MenuItem[] {
  const s = store();
  return [
    { label: "Add video track", onSelect: () => s.addTrack("video") },
    { label: "Add audio track", onSelect: () => s.addTrack("audio") },
    { separator: true },
    { label: track.locked ? "Unlock track" : "Lock track", onSelect: () => s.updateTrack(track.id, { locked: !track.locked }) },
    { label: `Delete ${track.name}`, danger: true, onSelect: () => s.removeTrack(track.id) },
  ];
}

const TrackHeader = React.memo(function TrackHeader({ track, height }: { track: Track; height: number }) {
  const [editing, setEditing] = React.useState(false);
  const s = store;
  const isVideo = track.kind === "video";
  return (
    <div
      className="sticky left-0 z-[10] flex shrink-0 flex-col justify-center gap-1 border-b border-r border-line bg-panel px-2"
      style={{ width: HEADER_W, height }}
      onContextMenu={(e) => openMenu(e, trackMenu(track))}
    >
      <div className="flex items-center gap-1">
        <span className={cn("h-3.5 w-1 shrink-0 rounded-full", isVideo ? "bg-video" : "bg-audio")} />
        {editing ? (
          <input
            autoFocus
            defaultValue={track.name}
            className="field h-5 w-16 px-1 text-xs"
            onBlur={(e) => {
              s().updateTrack(track.id, { name: e.target.value.trim() || track.name });
              setEditing(false);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span className="w-10 truncate text-xs font-semibold text-ink" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
            {track.name}
          </span>
        )}
        <div className="ml-auto flex items-center">
          {isVideo && (
            <IconButton size="xs" title={track.hidden ? "Show track" : "Hide track"} active={track.hidden} tone="danger" onClick={() => s().updateTrack(track.id, { hidden: !track.hidden })}>
              {track.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            </IconButton>
          )}
          <IconButton size="xs" title={track.muted ? "Unmute track" : "Mute track"} active={track.muted} tone="danger" onClick={() => s().updateTrack(track.id, { muted: !track.muted })}>
            {track.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
          </IconButton>
          <IconButton size="xs" title={track.solo ? "Unsolo" : "Solo (only soloed tracks are heard)"} active={track.solo} onClick={() => s().updateTrack(track.id, { solo: !track.solo })}>
            <Headphones className="h-3 w-3" />
          </IconButton>
          <IconButton size="xs" title={track.locked ? "Unlock track" : "Lock track"} active={track.locked} onClick={() => s().updateTrack(track.id, { locked: !track.locked })}>
            {track.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
          </IconButton>
        </div>
      </div>
      {height >= 50 && (
        <div className="flex items-center gap-1.5 pl-2" title={`Track volume ${Math.round(track.volume * 100)}%`}>
          <input
            type="range"
            className="range h-3 flex-1"
            min={0}
            max={2}
            step={0.01}
            value={track.volume}
            style={{ ["--fill" as string]: `${(track.volume / 2) * 100}%` }}
            onChange={(e) => s().apply((p) => void (p.tracks.find((t) => t.id === track.id)!.volume = parseFloat(e.target.value)), { live: true })}
            onPointerUp={() => s().commit()}
            onKeyUp={() => s().commit()}
            onDoubleClick={() => s().updateTrack(track.id, { volume: 1 })}
          />
          <span className="w-8 text-right font-mono text-2xs text-ink-dim tabular">{Math.round(track.volume * 100)}%</span>
        </div>
      )}
    </div>
  );
});

// --------------------------------------------------------------------- ruler

function tickStep(zoom: number, fps: number): { major: number; minor: number } {
  const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
  const major = steps.find((s) => s * zoom >= 90) ?? 3600;
  const minor = major >= 1 ? (major % 5 === 0 ? major / 5 : major / 2) : major / 2;
  return { major, minor };
}

function rulerLabel(t: number, major: number, fps: number): string {
  if (major < 1) return timecode(t, fps);
  const m = Math.floor(t / 60);
  const s = Math.round(t - m * 60);
  if (t >= 3600) return `${Math.floor(t / 3600)}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function Ruler({ width, viewLeft, viewWidth, timeAt }: { width: number; viewLeft: number; viewWidth: number; timeAt: (x: number) => number }) {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const zoom = useStore((s) => s.zoom);
  const fps = useStore((s) => s.project.settings.fps);
  const markers = useStore((s) => s.project.markers);
  const w = Math.max(1, Math.min(width - viewLeft, viewWidth + 2));

  React.useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.ceil(w * dpr);
    cv.height = Math.ceil(RULER_H * dpr);
    const ctx = cv.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, RULER_H);
    const { major, minor } = tickStep(zoom, fps || 30);
    const t0 = viewLeft / zoom;
    const t1 = (viewLeft + w) / zoom;
    ctx.fillStyle = "#3a3a44";
    for (let i = Math.floor(t0 / minor); i * minor <= t1; i++) {
      const x = Math.round(i * minor * zoom - viewLeft) + 0.5;
      ctx.fillRect(x, RULER_H - 6, 1, 6);
    }
    ctx.fillStyle = "#6c6c78";
    ctx.font = '10px "SF Mono", ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = "top";
    for (let i = Math.floor(t0 / major); i * major <= t1 + major; i++) {
      const t = i * major;
      const x = Math.round(t * zoom - viewLeft) + 0.5;
      ctx.fillRect(x, RULER_H - 12, 1, 12);
      ctx.fillText(rulerLabel(t, major, fps || 30), x + 4, 6);
    }
  }, [w, zoom, fps, viewLeft]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const s = store();
    if (s.playing) s.pause();
    const seek = (x: number, free: boolean) => s.seek(free ? snapToFrame(timeAt(x), s.project.settings.fps) : snap(timeAt(x), new Set()).time);
    seek(e.clientX, e.altKey);
    const move = (ev: PointerEvent) => seek(ev.clientX, ev.altKey);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    const s = store();
    const t = snapToFrame(timeAt(e.clientX), s.project.settings.fps);
    openMenu(e, [
      { label: "Add marker here", icon: <Flag className="h-3.5 w-3.5" />, onSelect: () => s.addMarker(t) },
      { label: "Set range in here", shortcut: "I", onSelect: () => s.setRangeIn(t) },
      { label: "Set range out here", shortcut: "O", onSelect: () => s.setRangeOut(t) },
      { label: "Clear range", shortcut: "⌥X", disabled: !s.range, onSelect: () => s.setRange(null) },
    ]);
  };

  return (
    <div
      className="relative shrink-0 cursor-text border-b border-line bg-panel"
      style={{ width, height: RULER_H }}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
    >
      <canvas ref={canvas} className="pointer-events-none absolute top-0" style={{ left: viewLeft, width: w, height: RULER_H }} />
      <RangeBand />
      {markers.map((m) => (
        <MarkerFlag key={m.id} id={m.id} time={m.time} label={m.label} color={m.color} zoom={zoom} timeAt={timeAt} />
      ))}
    </div>
  );
}

function RangeBand() {
  const range = useStore((s) => s.range);
  const zoom = useStore((s) => s.zoom);
  if (!range) return null;
  return (
    <div
      className="pointer-events-none absolute bottom-0 h-1.5 rounded-sm bg-accent/70"
      style={{ left: range.in * zoom, width: (range.out - range.in) * zoom }}
      title="Export range"
    />
  );
}

function RangeOverlay({ height }: { height: number }) {
  const range = useStore((s) => s.range);
  const zoom = useStore((s) => s.zoom);
  if (!range) return null;
  return (
    <div
      className="pointer-events-none absolute z-[5] border-x border-accent/60 bg-accent/[0.06]"
      style={{ left: HEADER_W + range.in * zoom, width: (range.out - range.in) * zoom, top: RULER_H, height: height - RULER_H }}
    />
  );
}

function MarkerFlag({ id, time, label, color, zoom, timeAt }: { id: Id; time: number; label: string; color: string; zoom: number; timeAt: (x: number) => number }) {
  const [editing, setEditing] = React.useState(false);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const s = store();
    const sx = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - sx) < 3) return;
      moved = true;
      const t = snap(timeAt(ev.clientX), new Set(), { disabled: ev.altKey }).time;
      s.apply((p) => {
        const m = p.markers.find((x) => x.id === id);
        if (m) m.time = t;
      }, { live: true });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) {
        store().apply((p) => void p.markers.sort((a, b) => a.time - b.time), { live: true });
        store().commit();
      } else store().seek(time);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onContextMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const s = store();
    openMenu(e, [
      { label: "Rename…", onSelect: () => setEditing(true) },
      { label: "Go to marker", onSelect: () => s.seek(time) },
      { separator: true },
      ...MARKER_COLORS.map(
        (c, i): MenuItem => ({
          label: ["Amber", "Sky", "Rose", "Lime", "Lilac"][i] ?? "Colour",
          icon: <span className={cn("h-3 w-3 rounded-full", c === color && "ring-2 ring-white/70")} style={{ background: c }} />,
          onSelect: () => s.updateMarker(id, { color: c }),
        }),
      ),
      { separator: true },
      { label: "Delete marker", danger: true, onSelect: () => s.removeMarker(id) },
    ]);
  };
  return (
    <div className="absolute top-0 z-[3]" style={{ left: time * zoom - 5 }}>
      <div
        onPointerDown={onPointerDown}
        onContextMenu={onContextMenu}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        className="flex cursor-pointer items-start"
        title={label ? `${label} · drag to move, double-click to rename` : "Marker · drag to move, double-click to name"}
      >
        <svg width="10" height="14" viewBox="0 0 10 14" className="shrink-0">
          <path d="M0 0h10v9l-5 5-5-5z" fill={color} />
        </svg>
        {label && !editing && <span className="ml-0.5 max-w-[120px] truncate rounded-sm bg-black/50 px-1 text-2xs leading-[14px] text-ink">{label}</span>}
      </div>
      {editing && (
        <input
          autoFocus
          defaultValue={label}
          placeholder="Marker name"
          className="field absolute left-3 top-0 h-5 w-36 px-1 text-xs"
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => {
            store().updateMarker(id, { label: e.target.value.trim() });
            setEditing(false);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ playhead

function Playhead({ height, timeAt, viewLeft }: { height: number; timeAt: (x: number) => number; viewLeft: number }) {
  const playhead = useStore((s) => s.playhead);
  const zoom = useStore((s) => s.zoom);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const s = store();
    if (s.playing) s.pause();
    const move = (ev: PointerEvent) => s.seek(snap(timeAt(ev.clientX), new Set(), { disabled: ev.altKey }).time);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // Drawn above the sticky ruler; hidden while scrolled under the track headers.
  if (playhead * zoom < viewLeft - 1) return null;
  return (
    <div className="pointer-events-none absolute top-0 z-[22]" style={{ left: HEADER_W + playhead * zoom, height }}>
      <div className="absolute -left-px top-0 h-full w-[2px] bg-playhead shadow-[0_0_8px_rgba(255,79,109,0.5)]" />
      <div
        onPointerDown={onPointerDown}
        className="pointer-events-auto absolute -left-[6px] top-[14px] h-4 w-3 cursor-ew-resize rounded-b-[3px] rounded-t-[1px] bg-playhead"
        style={{ clipPath: "polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%)" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- drop ghost

function DropGhost({ rows }: { rows: Row[] }) {
  const payload = useDrag((s) => s.payload);
  const x = useDrag((s) => s.x);
  const y = useDrag((s) => s.y);
  const zoom = useStore((s) => s.zoom);
  if (!payload || payload.kind === "files") return null;
  const target = dropTarget(payload, x, y);
  if (!target) return null;
  const kind = payloadKind(payload);
  const row =
    rows.find((r) => r.track.id === target.trackId) ??
    rows.find((r) => r.track.kind === kind && !r.track.locked);
  if (!row) return null;
  const len = payloadLength(payload);
  return (
    <>
      <div
        className={cn(
          "pointer-events-none absolute z-[14] rounded-[5px] border-2 border-dashed",
          kind === "audio" ? "border-audio bg-audio/20" : payload.kind === "title" ? "border-title bg-title/20" : "border-video bg-video/20",
        )}
        style={{ left: HEADER_W + target.at * zoom, width: Math.max(4, len * zoom), top: row.top + 3, height: row.height - 6 }}
      />
      {target.guide != null && (
        <div className="pointer-events-none absolute top-0 z-[15] w-px bg-[#ffd84f]" style={{ left: HEADER_W + target.guide * zoom, height: rows.length ? rows[rows.length - 1].top + rows[rows.length - 1].height : 0 }} />
      )}
    </>
  );
}

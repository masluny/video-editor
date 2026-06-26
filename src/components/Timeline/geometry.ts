import type { Id, Project, Track, TrackKind } from "../../lib/types";
import { useStore } from "../../store/store";
import { snapTargets, snapTime, snapToFrame } from "../../lib/timeline";

export const HEADER_W = 184;
export const RULER_H = 30;
export const SNAP_PX = 8;

export type TrackSize = "s" | "m" | "l";
export const TRACK_HEIGHTS: Record<TrackSize, { video: number; audio: number }> = {
  s: { video: 44, audio: 36 },
  m: { video: 66, audio: 54 },
  l: { video: 100, audio: 76 },
};

/** Video tracks top-down (highest layer first), then audio tracks. */
export function displayOrder(p: Project): Track[] {
  const videos = p.tracks.filter((t) => t.kind === "video").reverse();
  const audios = p.tracks.filter((t) => t.kind === "audio");
  return [...videos, ...audios];
}

export function trackHeight(t: Track, size: TrackSize) {
  return TRACK_HEIGHTS[size][t.kind];
}

/** Snap a time to clip edges / playhead / markers / range (unless disabled). */
export function snap(time: number, exclude: Set<string>, opts: { disabled?: boolean } = {}): { time: number; guide: number | null } {
  const s = useStore.getState();
  const t = snapToFrame(time, s.project.settings.fps);
  if (!s.snapping || opts.disabled) return { time: t, guide: null };
  const extra = [s.playhead, ...s.project.markers.map((m) => m.time)];
  if (s.range) extra.push(s.range.in, s.range.out);
  const hit = snapTime(t, snapTargets(s.project.tracks, exclude, extra), SNAP_PX / s.zoom);
  return hit == null ? { time: t, guide: null } : { time: hit, guide: hit };
}

/** Which track lane (and time) is under a client point, if any. */
export function laneAt(x: number, y: number): { trackId: Id; kind: TrackKind; time: number } | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-lane]");
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const zoom = useStore.getState().zoom;
  return { trackId: el.dataset.lane!, kind: el.dataset.kind as TrackKind, time: Math.max(0, (x - rect.left) / zoom) };
}

export function overViewer(x: number, y: number): boolean {
  return !!document.elementFromPoint(x, y)?.closest("[data-viewer]");
}

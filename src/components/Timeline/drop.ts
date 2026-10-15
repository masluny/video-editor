// Dropping library items (media, title presets) onto the timeline or the viewer.

import type { DragPayload } from "../../store/drag";
import { mainTrackId, store } from "../../store/store";
import { clipEnd } from "../../lib/timeline";
import { DEFAULT_STILL_DURATION, DEFAULT_TITLE_DURATION, TITLE_PRESETS } from "../../lib/defaults";
import { laneAt, overViewer, snap } from "./geometry";
import type { Id, TrackKind } from "../../lib/types";

/** Length (seconds) the payload will occupy once placed. */
export function payloadLength(payload: DragPayload): number {
  if (payload.kind === "title") return DEFAULT_TITLE_DURATION;
  if (payload.kind === "media") {
    const m = store().project.media.find((x) => x.id === payload.mediaId);
    if (!m) return 0;
    return m.kind === "image" || !(m.duration > 0) ? DEFAULT_STILL_DURATION : m.duration;
  }
  return DEFAULT_STILL_DURATION;
}

/** Track kind the payload wants to land on. */
export function payloadKind(payload: DragPayload): TrackKind | null {
  if (payload.kind === "title") return "video";
  if (payload.kind === "media") {
    const m = store().project.media.find((x) => x.id === payload.mediaId);
    return m ? (m.kind === "audio" ? "audio" : "video") : null;
  }
  return null;
}

/**
 * Where a drop at (x, y) would land: a lane + snapped start time. On the magnetic main
 * track it slots in at the nearest edit point instead (`flip`, i.e. ⌘, places it freely).
 */
export function dropTarget(payload: DragPayload, x: number, y: number, flip = false): { trackId?: Id; at: number; guide: number | null; magnetic?: boolean } | null {
  const lane = laneAt(x, y);
  if (!lane) return null;
  const kind = payloadKind(payload);
  const len = payloadLength(payload);
  const s = store();
  if (payload.kind === "media" && s.rippleMain && !flip && kind === lane.kind && lane.trackId === mainTrackId(s.project)) {
    const edges = s.project.tracks.find((t) => t.id === lane.trackId)!.clips.flatMap((c) => [c.start, clipEnd(c)]);
    if (edges.length) {
      const at = edges.reduce((best, e) => (Math.abs(e - lane.time) < Math.abs(best - lane.time) ? e : best));
      return { trackId: lane.trackId, at, guide: at, magnetic: true };
    }
  }
  // Snap whichever edge (start or end) is closer to a target.
  const a = snap(lane.time, new Set());
  const b = snap(lane.time + len, new Set());
  const useEnd = b.guide != null && (a.guide == null || Math.abs(b.time - (lane.time + len)) < Math.abs(a.time - lane.time));
  const at = Math.max(0, useEnd ? b.time - len : a.time);
  return { trackId: kind === lane.kind ? lane.trackId : undefined, at, guide: useEnd ? b.guide : a.guide };
}

/** Handle a library drag ending at (x, y). Returns true when something was placed. */
export function dropPayload(payload: DragPayload, x: number, y: number, insert: boolean): boolean {
  const s = store();
  const mode = insert ? "insert" : "overwrite";
  if (overViewer(x, y)) {
    if (payload.kind === "media") return !!s.placeMedia(payload.mediaId, { mode });
    if (payload.kind === "title") return !!s.placeTitle(TITLE_PRESETS.find((p) => p.id === payload.presetId)?.style, {});
    return false;
  }
  const target = dropTarget(payload, x, y, insert);
  if (!target) return false;
  // ⌘ means insert on ordinary tracks, and placing freely (overwrite) on the magnetic one.
  const onMain = s.rippleMain && target.trackId === mainTrackId(s.project);
  const how = target.magnetic ? "magnetic" : onMain ? "overwrite" : mode;
  if (payload.kind === "media") return !!s.placeMedia(payload.mediaId, { trackId: target.trackId, at: target.at, mode: how });
  if (payload.kind === "title") {
    const preset = TITLE_PRESETS.find((p) => p.id === payload.presetId);
    return !!s.placeTitle(preset?.style, { trackId: target.trackId, at: target.at });
  }
  return false;
}

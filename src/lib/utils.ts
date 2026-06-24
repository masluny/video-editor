import type { Clip, Track } from "./types";
import { v4 as uuid } from "./uuid";

const EPS = 1e-6;

export function getClipDuration(clip: Clip): number {
  if (clip.speed <= 0) return 0;
  return (clip.source_out - clip.source_in) / clip.speed;
}

export function clipEnd(clip: Clip): number {
  return clip.timeline_start + getClipDuration(clip);
}

/** Quantize a time (seconds) to the nearest frame boundary for the given fps. */
export function snapToFrame(t: number, fps: number): number {
  if (!fps || fps <= 0) return Math.max(0, t);
  return Math.max(0, Math.round(t * fps) / fps);
}

// --- Trimming primitives (pure; map timeline edits back to source in/out) ---

/** Return a copy of `clip` whose tail is cut so it now ends at timeline time `cut`. */
function trimTail(clip: Clip, cut: number): Clip {
  const speed = clip.speed || 1;
  return { ...clip, source_out: clip.source_in + (cut - clip.timeline_start) * speed };
}

/** Return a copy of `clip` whose head is cut so it now starts at timeline time `cut`. */
function trimHead(clip: Clip, cut: number): Clip {
  const speed = clip.speed || 1;
  return {
    ...clip,
    source_in: clip.source_in + (cut - clip.timeline_start) * speed,
    timeline_start: cut,
  };
}

const hasLength = (c: Clip) => getClipDuration(c) > EPS;

/**
 * Place `incoming` onto a track, resolving overlaps by OVERWRITE (Premiere-style):
 * existing clips covered by [s,e] are trimmed, split, or removed. Pure: returns a new
 * array of plain clips and never mutates the inputs.
 */
export function overwriteInto(clips: Clip[], incoming: Clip): Clip[] {
  const s = incoming.timeline_start;
  const e = clipEnd(incoming);
  const out: Clip[] = [];

  for (const x of clips) {
    if (x.id === incoming.id) continue;
    const xs = x.timeline_start;
    const xe = clipEnd(x);

    if (xe <= s + EPS || xs >= e - EPS) {
      out.push(x); // no overlap
    } else if (xs >= s - EPS && xe <= e + EPS) {
      // fully covered -> drop
    } else if (xs < s && xe > e) {
      // incoming sits inside x -> keep head and tail, drop the middle
      const head = trimTail(x, s);
      const tail = { ...trimHead(x, e), id: uuid() };
      if (hasLength(head)) out.push(head);
      if (hasLength(tail)) out.push(tail);
    } else if (xs < s) {
      const head = trimTail(x, s); // x overlaps left edge -> trim its tail
      if (hasLength(head)) out.push(head);
    } else {
      const tail = trimHead(x, e); // x overlaps right edge -> trim its head
      if (hasLength(tail)) out.push(tail);
    }
  }

  out.push(incoming);
  out.sort((a, b) => a.timeline_start - b.timeline_start);
  return out;
}

/**
 * Place `incoming` with INSERT (ripple): a clip straddling the insert point is split, and
 * everything at/after the insert point shifts right by the incoming duration. Pure.
 */
export function insertInto(clips: Clip[], incoming: Clip): Clip[] {
  const s = incoming.timeline_start;
  const dur = getClipDuration(incoming);
  const out: Clip[] = [];

  for (const x of clips) {
    if (x.id === incoming.id) continue;
    const xs = x.timeline_start;
    const xe = clipEnd(x);

    if (xe <= s + EPS) {
      out.push(x); // entirely before
    } else if (xs >= s - EPS) {
      out.push({ ...x, timeline_start: xs + dur }); // entirely after -> shift right
    } else {
      // straddles the insert point -> split, push the tail past the inserted clip
      const head = trimTail(x, s);
      const tail = { ...trimHead(x, s), id: uuid(), timeline_start: s + dur };
      if (hasLength(head)) out.push(head);
      if (hasLength(tail)) out.push(tail);
    }
  }

  out.push(incoming);
  out.sort((a, b) => a.timeline_start - b.timeline_start);
  return out;
}

/** Remove `clipIds` from a track and close the gaps they leave (ripple delete). Pure. */
export function rippleDeleteFrom(clips: Clip[], clipIds: Set<string>): Clip[] {
  const removed = clips.filter((c) => clipIds.has(c.id));
  const kept = clips.filter((c) => !clipIds.has(c.id));
  return kept
    .map((c) => {
      let shift = 0;
      for (const r of removed) if (r.timeline_start < c.timeline_start - EPS) shift += getClipDuration(r);
      return { ...c, timeline_start: Math.max(0, c.timeline_start - shift) };
    })
    .sort((a, b) => a.timeline_start - b.timeline_start);
}

// --- Edit-point navigation & snapping ---

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Sorted unique edit points (clip starts/ends, plus 0) for a track or the whole project. */
export function editPoints(tracks: Track[], trackId?: string): number[] {
  const set = new Set<number>([0]);
  for (const t of tracks) {
    if (trackId && t.id !== trackId) continue;
    for (const c of t.clips) {
      set.add(round4(c.timeline_start));
      set.add(round4(clipEnd(c)));
    }
  }
  return Array.from(set).sort((a, b) => a - b);
}

export function nextEditPoint(tracks: Track[], time: number, trackId?: string): number {
  const pts = editPoints(tracks, trackId);
  return pts.find((p) => p > time + EPS) ?? time;
}

export function prevEditPoint(tracks: Track[], time: number, trackId?: string): number {
  const pts = editPoints(tracks, trackId);
  let prev = 0;
  for (const p of pts) {
    if (p < time - EPS) prev = p;
    else break;
  }
  return prev;
}

/** Candidate snap times (clip edges + 0) excluding the clips currently being dragged. */
export function snapCandidates(tracks: Track[], excludeIds: Set<string>): number[] {
  const arr: number[] = [0];
  for (const t of tracks) {
    for (const c of t.clips) {
      if (excludeIds.has(c.id)) continue;
      arr.push(c.timeline_start, clipEnd(c));
    }
  }
  return arr;
}

/**
 * Snap `time` to the closest candidate within `tolerance` (seconds). Returns the snapped
 * time and the candidate it locked onto (for drawing the guide), or null when nothing is
 * close enough.
 */
export function snapTime(
  time: number,
  candidates: number[],
  tolerance: number
): { time: number; guide: number } | null {
  let best: number | null = null;
  let bestDist = tolerance;
  for (const c of candidates) {
    const d = Math.abs(c - time);
    if (d <= bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best == null ? null : { time: best, guide: best };
}

// Pure timeline operations. Nothing here mutates its inputs.

import type { Clip, MediaAsset, Project, Track } from "./types";
import { uid } from "./uid";
import { splitMotion } from "./motion";

export const EPS = 1e-6;
/** Shortest clip the editor will create (seconds). */
export const MIN_CLIP = 1 / 30;

export function speedOf(c: Clip): number {
  return Number.isFinite(c.speed) && c.speed > 0 ? c.speed : 1;
}

export function clipDuration(c: Clip): number {
  return Math.max(0, (c.out - c.in) / speedOf(c));
}

export function clipEnd(c: Clip): number {
  return c.start + clipDuration(c);
}

export function trackEnd(t: Track): number {
  return t.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

export function projectDuration(p: Pick<Project, "tracks">): number {
  return p.tracks.reduce((m, t) => Math.max(m, trackEnd(t)), 0);
}

export function snapToFrame(t: number, fps: number): number {
  if (!(fps > 0)) return Math.max(0, t);
  return Math.max(0, Math.round(t * fps) / fps);
}

/**
 * Where to place a clip at `t`: exactly on an edit point less than a frame away (clip
 * edges needn't sit on the frame grid, and rounding past one leaves a black sliver),
 * else on the nearest frame.
 */
export function snapToEdit(t: number, tracks: Track[], fps: number): number {
  const edit = fps > 0 ? snapTime(t, snapTargets(tracks, new Set()), 1 / fps - EPS) : null;
  return edit ?? snapToFrame(t, fps);
}

/** Titles, stills and frame holds have no source bounds; they can be stretched freely. */
export function isUnbounded(c: Clip, media?: MediaAsset): boolean {
  return c.type === "title" || !!c.freeze || media?.kind === "image" || !media || !(media.duration > 0);
}

/** Source-time limits for a clip's in/out points. */
export function sourceBounds(c: Clip, media?: MediaAsset): { min: number; max: number } {
  return isUnbounded(c, media) ? { min: -Infinity, max: Infinity } : { min: 0, max: media!.duration };
}

/** Copy of `c` cut so it ends at timeline time `t` (its motion stops where it was at `t`). */
export function cutTail(c: Clip, t: number): Clip {
  const out = { ...c, out: c.in + (t - c.start) * speedOf(c) };
  if (c.motion) out.motion = splitMotion(c.motion, t - c.start, clipDuration(c))[0];
  return out;
}

/** Copy of `c` cut so it starts at timeline time `t` (its motion carries on from `t`). */
export function cutHead(c: Clip, t: number): Clip {
  const out = { ...c, in: c.in + (t - c.start) * speedOf(c), start: t };
  if (c.motion) out.motion = splitMotion(c.motion, t - c.start, clipDuration(c))[1];
  return out;
}

const hasLength = (c: Clip) => clipDuration(c) > EPS;

/**
 * Place `incoming` on a track, resolving overlaps by OVERWRITE: whatever it covers
 * is trimmed, split or removed.
 */
export function overwrite(clips: Clip[], incoming: Clip): Clip[] {
  const s = incoming.start;
  const e = clipEnd(incoming);
  const out: Clip[] = [];
  for (const x of clips) {
    if (x.id === incoming.id) continue;
    const xs = x.start;
    const xe = clipEnd(x);
    if (xe <= s + EPS || xs >= e - EPS) out.push(x);
    else if (xs >= s - EPS && xe <= e + EPS) continue; // fully covered
    else if (xs < s && xe > e) {
      const head = cutTail(x, s);
      const tail = { ...cutHead(x, e), id: uid(), fadeIn: 0, transitionIn: undefined };
      if (hasLength(head)) out.push({ ...head, fadeOut: 0 });
      if (hasLength(tail)) out.push(tail);
    } else if (xs < s) {
      const head = cutTail(x, s);
      if (hasLength(head)) out.push({ ...head, fadeOut: Math.min(head.fadeOut, clipDuration(head)) });
    } else {
      const tail = cutHead(x, e);
      if (hasLength(tail)) out.push({ ...tail, fadeIn: Math.min(tail.fadeIn, clipDuration(tail)) });
    }
  }
  out.push(incoming);
  return sortClips(out);
}

/**
 * Place `incoming` with INSERT (ripple): a clip straddling the insert point is split,
 * and everything from the insert point on moves right by the incoming length.
 */
export function insert(clips: Clip[], incoming: Clip): Clip[] {
  const s = incoming.start;
  const d = clipDuration(incoming);
  const out: Clip[] = [];
  for (const x of clips) {
    if (x.id === incoming.id) continue;
    const xs = x.start;
    const xe = clipEnd(x);
    if (xe <= s + EPS) out.push(x);
    else if (xs >= s - EPS) out.push({ ...x, start: xs + d });
    else {
      const head = cutTail(x, s);
      const tail = { ...cutHead(x, s), id: uid(), start: s + d, fadeIn: 0, transitionIn: undefined };
      if (hasLength(head)) out.push({ ...head, fadeOut: 0 });
      if (hasLength(tail)) out.push(tail);
    }
  }
  out.push(incoming);
  return sortClips(out);
}

/**
 * Lay `clips` end to end from the first one's start so that every cut lands on a beat.
 * Without `every`, each clip keeps as many beats as fit in its current length (it only
 * grows when it's shorter than the next beat, and its source has room). With `every`,
 * each clip runs exactly that many beats when its source allows. `room` gives a clip's
 * longest possible timeline length from its in point. Returns the clips in order.
 */
export function cutToBeats(clips: Clip[], beats: number[], room: (c: Clip) => number, every?: number): Clip[] {
  const marks = [...beats].sort((a, b) => a - b);
  const out: Clip[] = [];
  let cursor = clips.length ? Math.min(...clips.map((c) => c.start)) : 0;
  for (const c of [...clips].sort((a, b) => a.start - b.start)) {
    const dur = clipDuration(c);
    const max = Math.max(dur, room(c));
    const ahead = marks.filter((b) => b > cursor + MIN_CLIP);
    const fits = ahead.filter((b) => b <= cursor + max + EPS);
    let end: number | undefined;
    if (every) end = ahead[every - 1] !== undefined && ahead[every - 1] <= cursor + max + EPS ? ahead[every - 1] : fits[fits.length - 1];
    else end = ahead.filter((b) => b <= cursor + dur + EPS).pop() ?? fits[0];
    const length = end !== undefined ? end - cursor : dur;
    const moved = { ...c, start: cursor };
    const next = length < dur - EPS ? cutTail(moved, cursor + length) : { ...moved, out: c.in + length * speedOf(c) };
    next.fadeIn = Math.min(next.fadeIn, length);
    next.fadeOut = Math.min(next.fadeOut, length - next.fadeIn);
    out.push(next);
    cursor += length;
  }
  return out;
}

/**
 * A magnetic drop: `movers` go end to end (in their order) at the edit point of `clips`
 * nearest `at` (a clip's start or end; after the last clip at most), and everything from
 * that point on moves right to make room. Into an empty track they land at `at`.
 */
export function magneticInsert(clips: Clip[], movers: Clip[], at: number): Clip[] {
  const sorted = sortClips(clips);
  const edges = [...new Set(sorted.flatMap((c) => [c.start, clipEnd(c)]))];
  const point = edges.length ? edges.reduce((best, e) => (Math.abs(e - at) < Math.abs(best - at) ? e : best)) : Math.max(0, at);
  const block = movers.reduce((d, c) => d + clipDuration(c), 0);
  const out = sorted.map((c) => (c.start >= point - EPS ? { ...c, start: c.start + block } : c));
  let t = point;
  for (const m of movers) {
    out.push({ ...m, start: t });
    t += clipDuration(m);
  }
  return sortClips(out);
}

/** Where a clip's source time 0 falls on the timeline: what keeps two clips in sync. */
export function sourceOrigin(c: Clip): number {
  return c.start - c.in / speedOf(c);
}

/**
 * Detached audio follows its video: in `next`, every linked clip whose video's source
 * origin moved since `prev` (a move, a reorder, a ripple), but which didn't move itself,
 * shifts by the same amount. Returns `next` untouched when nothing has to follow.
 */
export function followLinks(prev: Project, next: Project): Project {
  if (prev === next || !next.tracks.some((t) => t.clips.some((c) => c.link))) return next;
  const origins = (p: Project) => new Map(p.tracks.flatMap((t) => t.clips.map((c) => [c.id, sourceOrigin(c)] as const)));
  const [before, after] = [origins(prev), origins(next)];
  const shifts = new Map<string, number>();
  for (const t of next.tracks)
    for (const c of t.clips) {
      if (!c.link) continue;
      const [v0, v1, a0] = [before.get(c.link), after.get(c.link), before.get(c.id)];
      if (v0 == null || v1 == null || a0 == null || Math.abs(v1 - v0) < EPS || Math.abs(after.get(c.id)! - a0) > EPS) continue;
      shifts.set(c.id, v1 - v0);
    }
  if (!shifts.size) return next;
  return {
    ...next,
    tracks: next.tracks.map((t) =>
      t.clips.some((c) => shifts.has(c.id)) ? { ...t, clips: sortClips(t.clips.map((c) => (shifts.has(c.id) ? { ...c, start: Math.max(0, c.start + shifts.get(c.id)!) } : c))) } : t,
    ),
  };
}

/** Remove clips and close the gaps they leave. */
export function rippleDelete(clips: Clip[], ids: Set<string>): Clip[] {
  const removed = clips.filter((c) => ids.has(c.id));
  return sortClips(
    clips
      .filter((c) => !ids.has(c.id))
      .map((c) => {
        let shift = 0;
        for (const r of removed) if (r.start < c.start - EPS) shift += clipDuration(r);
        return { ...c, start: Math.max(0, c.start - shift) };
      }),
  );
}

/** Split a clip at timeline time `t`. Returns null when `t` isn't strictly inside it. */
export function split(c: Clip, t: number): [Clip, Clip] | null {
  if (t <= c.start + EPS || t >= clipEnd(c) - EPS) return null;
  const left = { ...cutTail(c, t), fadeOut: 0 };
  const right = { ...cutHead(c, t), id: uid(), fadeIn: 0, transitionIn: undefined };
  left.fadeIn = Math.min(left.fadeIn, clipDuration(left));
  right.fadeOut = Math.min(right.fadeOut, clipDuration(right));
  return [left, right];
}

/**
 * Cut the span [a, b) out of a track. Clips straddling an edge are split (as by `split`);
 * with `ripple` everything after the span moves left to close it (extract), otherwise
 * a gap is left (lift).
 */
export function removeRange(clips: Clip[], a: number, b: number, ripple: boolean): Clip[] {
  if (b - a <= EPS) return clips;
  const shift = ripple ? b - a : 0;
  const out: Clip[] = [];
  for (const x of clips) {
    const xs = x.start;
    const xe = clipEnd(x);
    if (xe <= a + EPS) out.push(x);
    else if (xs >= b - EPS) out.push(shift ? { ...x, start: xs - shift } : x);
    else {
      if (xs < a - EPS) {
        const head = { ...cutTail(x, a), fadeOut: 0 };
        out.push({ ...head, fadeIn: Math.min(head.fadeIn, clipDuration(head)) });
      }
      if (xe > b + EPS) {
        const tail = { ...cutHead(x, b), id: xs < a - EPS ? uid() : x.id, start: b - shift, fadeIn: 0, transitionIn: undefined };
        out.push({ ...tail, fadeOut: Math.min(tail.fadeOut, clipDuration(tail)) });
      }
    }
  }
  return sortClips(out);
}

/**
 * Ripple-trim one clip to time `t`: drop its head (start stays put) or its tail, and pull
 * the rest of the track left by the removed length. No-op unless `t` is inside the clip.
 */
export function rippleTrim(clips: Clip[], id: string, t: number, side: "head" | "tail"): Clip[] {
  const c = clips.find((x) => x.id === id);
  if (!c || t <= c.start + EPS || t >= clipEnd(c) - EPS) return clips;
  const end = clipEnd(c);
  const removed = side === "head" ? t - c.start : end - t;
  const trimmed = side === "head" ? { ...cutHead(c, t), start: c.start } : cutTail(c, t);
  const d = clipDuration(trimmed);
  trimmed.fadeIn = Math.min(trimmed.fadeIn, d);
  trimmed.fadeOut = Math.min(trimmed.fadeOut, d - trimmed.fadeIn);
  return sortClips(clips.map((x) => (x === c ? trimmed : x.start >= end - EPS ? { ...x, start: x.start - removed } : x)));
}

/** Butt every clip against the one before it, keeping the first clip where it is. */
export function closeAllGaps(clips: Clip[]): Clip[] {
  let at = -Infinity;
  return sortClips(clips).map((c) => {
    const start = at === -Infinity ? c.start : at;
    at = start + clipDuration(c);
    return Math.abs(start - c.start) > EPS ? { ...c, start } : c;
  });
}

/** End of the picture: the last clip on a visible video track (0 when there is none). */
export function videoEnd(tracks: Track[], exclude?: Set<string>): number {
  let end = 0;
  for (const t of tracks) {
    if (t.kind !== "video" || t.hidden) continue;
    for (const c of t.clips) if (!exclude?.has(c.id)) end = Math.max(end, clipEnd(c));
  }
  return end;
}

/** The gap (empty span) on a track that contains time `t`, if any. */
export function gapAt(t: Track, time: number): { start: number; end: number } | null {
  const sorted = sortClips(t.clips);
  let prevEnd = 0;
  for (const c of sorted) {
    if (time >= prevEnd - EPS && time < c.start - EPS) return { start: prevEnd, end: c.start };
    prevEnd = Math.max(prevEnd, clipEnd(c));
  }
  return null;
}

/** Shift every clip that starts at/after `from` left by `amount`. */
export function closeGap(clips: Clip[], from: number, amount: number): Clip[] {
  return clips.map((c) => (c.start >= from - EPS ? { ...c, start: Math.max(0, c.start - amount) } : c));
}

/**
 * Keep only the given source ranges of a clip and butt them together, starting at the
 * clip's original position. Used by "Remove silences".
 */
export function keepSourceRanges(c: Clip, ranges: [number, number][]): Clip[] {
  const sp = speedOf(c);
  let at = c.start;
  const out: Clip[] = [];
  for (const [a, b] of ranges) {
    const lo = Math.max(a, c.in);
    const hi = Math.min(b, c.out);
    if (hi - lo <= MIN_CLIP * sp) continue;
    const piece: Clip = { ...c, id: out.length === 0 ? c.id : uid(), in: lo, out: hi, start: at, fadeIn: 0, fadeOut: 0, transitionIn: out.length === 0 ? c.transitionIn : undefined };
    out.push(piece);
    at += (hi - lo) / sp;
  }
  return out;
}

/** Complement of `silences` inside [from, to], each kept range padded by `pad` seconds. */
export function speechRanges(silences: [number, number][], from: number, to: number, pad: number): [number, number][] {
  const keep: [number, number][] = [];
  let cursor = from;
  for (const [s, e] of [...silences].sort((a, b) => a[0] - b[0])) {
    if (s > cursor) keep.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < to) keep.push([cursor, to]);
  // Pad each kept range into the neighbouring silence, then merge overlaps.
  const padded = keep.map(([a, b]) => [Math.max(from, a - pad), Math.min(to, b + pad)] as [number, number]);
  const merged: [number, number][] = [];
  for (const r of padded) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + EPS) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

export function sortClips(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.start - b.start);
}

export function clipAt(t: Track, time: number): Clip | undefined {
  return t.clips.find((c) => time >= c.start - EPS && time < clipEnd(c) - EPS);
}

// --- navigation & snapping -------------------------------------------------

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function editPoints(tracks: Track[]): number[] {
  const set = new Set<number>([0]);
  for (const t of tracks)
    for (const c of t.clips) {
      set.add(round4(c.start));
      set.add(round4(clipEnd(c)));
    }
  return [...set].sort((a, b) => a - b);
}

export function nextEditPoint(tracks: Track[], time: number): number {
  return editPoints(tracks).find((p) => p > time + 1e-3) ?? time;
}

export function prevEditPoint(tracks: Track[], time: number): number {
  let prev = 0;
  for (const p of editPoints(tracks)) {
    if (p < time - 1e-3) prev = p;
    else break;
  }
  return prev;
}

export function snapTargets(tracks: Track[], exclude: Set<string>, extra: number[] = []): number[] {
  const out = [0, ...extra];
  for (const t of tracks)
    for (const c of t.clips) {
      if (exclude.has(c.id)) continue;
      out.push(c.start, clipEnd(c));
    }
  return out;
}

/** Closest target within `tolerance` of `time`, or null. */
export function snapTime(time: number, targets: number[], tolerance: number): number | null {
  let best: number | null = null;
  let bestDist = tolerance;
  for (const t of targets) {
    const d = Math.abs(t - time);
    if (d <= bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

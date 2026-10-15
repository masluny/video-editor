// Transitions between clips on one track: cross-dissolves, and moves (push, slide, zoom).
//
// A dissolve belongs to the incoming clip (`transitionIn`, seconds) and is centred on its
// cut with the clip that ends exactly where it starts. No extra source frames are needed:
// during the first half the incoming clip holds its first frame and fades in on top of
// the outgoing one; during the second half the outgoing clip holds its last frame
// underneath. Their sound dips across the cut. A moving style changes how the two layers
// meet in that window (see transitionFx). The export (graph.rs) mirrors this.

import type { Clip, Track } from "./types";
import { clipDuration, clipEnd, EPS } from "./timeline";

/** Clips closer than this count as butted together. */
export const CUT_EPS = 1e-3;
export const DEFAULT_DISSOLVE = 1;

export interface Dissolve {
  from: Clip;
  to: Clip;
  cut: number;
  /** Half the effective length: it never takes more than half of either clip. */
  half: number;
}

/** The clip on `track` that ends where `clip` starts, if any. */
export function clipBefore(track: Track, clip: Clip): Clip | undefined {
  return track.clips.find((c) => c !== clip && Math.abs(clipEnd(c) - clip.start) < CUT_EPS);
}

/** The clip on `track` that starts where `clip` ends, if any. */
export function clipAfter(track: Track, clip: Clip): Clip | undefined {
  return track.clips.find((c) => c !== clip && Math.abs(c.start - clipEnd(clip)) < CUT_EPS);
}

/** The dissolve into `clip`, if it has one and a clip butts against its start. */
export function dissolveInto(track: Track, clip: Clip): Dissolve | null {
  const d = clip.transitionIn ?? 0;
  if (!(d > 0)) return null;
  const from = clipBefore(track, clip);
  if (!from) return null;
  const half = Math.min(d / 2, clipDuration(from) / 2, clipDuration(clip) / 2);
  return half > EPS ? { from, to: clip, cut: clip.start, half } : null;
}

/** The dissolve out of `clip` into the clip that follows it, if any. */
export function dissolveOutOf(track: Track, clip: Clip): Dissolve | null {
  const to = clipAfter(track, clip);
  return to ? dissolveInto(track, to) : null;
}

/** The dissolve in progress at time `t` on a track, if any. */
export function dissolveAt(track: Track, t: number): Dissolve | null {
  for (const c of track.clips) {
    const d = dissolveInto(track, c);
    if (d && t >= d.cut - d.half - EPS && t < d.cut + d.half - EPS) return d;
  }
  return null;
}

/** Opacity of the incoming clip at `t`: 0 → 1 across the dissolve. */
export function dissolveMix(d: Dissolve, t: number): number {
  return Math.max(0, Math.min(1, (t - (d.cut - d.half)) / (2 * d.half)));
}

/** Gain from the dissolves at either end of `clip` at time `t` (sound dips across each cut). */
export function dissolveGain(track: Track, clip: Clip, t: number): number {
  let g = 1;
  const into = dissolveInto(track, clip);
  if (into && t < into.cut + into.half) g *= Math.max(0, Math.min(1, (t - into.cut) / into.half));
  const out = dissolveOutOf(track, clip);
  if (out && t > out.cut - out.half) g *= Math.max(0, Math.min(1, (out.cut - t) / out.half));
  return g;
}

export type TransitionStyle = "dissolve" | "push" | "slide" | "zoom";

export const TRANSITION_STYLES: { id: TransitionStyle; label: string; hint: string }[] = [
  { id: "dissolve", label: "Dissolve", hint: "Fade from one clip to the next" },
  { id: "push", label: "Push", hint: "The next clip pushes this one out to the left" },
  { id: "slide", label: "Slide", hint: "The next clip slides in from the right, over this one" },
  { id: "zoom", label: "Zoom", hint: "The next clip fades in while zooming out of a close-up" },
];

/** Where a transition's layers are at `mix` (0 → 1 across it), for a frame `W` wide. */
export interface TransitionFx {
  /** Incoming clip: opacity, horizontal offset (px) and scale factor. */
  inAlpha: number;
  inDx: number;
  inScale: number;
  /** Outgoing clip: horizontal offset (px). */
  outDx: number;
}

/** Zoom starts this much larger than the clip's own framing. */
export const TRANSITION_ZOOM = 0.2;

const smooth = (p: number) => p * p * (3 - 2 * p);

export function transitionFx(style: TransitionStyle | undefined, mix: number, W: number): TransitionFx {
  const p = Math.max(0, Math.min(1, mix));
  switch (style) {
    case "push":
      return { inAlpha: 1, inDx: W * (1 - smooth(p)), inScale: 1, outDx: -W * smooth(p) };
    case "slide":
      return { inAlpha: 1, inDx: W * (1 - smooth(p)), inScale: 1, outDx: 0 };
    case "zoom":
      return { inAlpha: p, inDx: 0, inScale: 1 + TRANSITION_ZOOM * (1 - p) * (1 - p), outDx: 0 };
    default:
      return { inAlpha: p, inDx: 0, inScale: 1, outDx: 0 };
  }
}

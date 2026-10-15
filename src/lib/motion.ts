// Motion: a clip glides from one framing to another, over its whole length (Ken Burns)
// or over its first moments (an entrance like Pop or Rise). Each point scales and offsets
// the clip's own transform (scale multiplies, x/y add, in project pixels); in between it
// moves linearly, or easing out. graph.rs renders the same thing.

export type MotionPreset = "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "pan-up" | "pan-down" | "pop-in" | "rise-in" | "slide-in" | "wipe-in";

export interface MotionPoint {
  scale: number;
  x: number;
  y: number;
}

export interface Motion {
  /** Which preset made it (for the inspector); the points are what renders. */
  preset?: MotionPreset;
  from: MotionPoint;
  to: MotionPoint;
  /** Seconds the move takes from the clip's start; missing: the whole clip. */
  duration?: number;
  /** Decelerate into the end point instead of moving at a constant speed. */
  easeOut?: boolean;
  /** Also reveal the clip from left to right over the move (a wipe-on). */
  reveal?: boolean;
}

export const DEFAULT_MOTION_AMOUNT = 0.15;

/** Entrances: quick eased moves at the start of a clip, made for titles. */
export const ENTRANCE_PRESETS: { id: MotionPreset; label: string }[] = [
  { id: "pop-in", label: "Pop" },
  { id: "rise-in", label: "Rise" },
  { id: "slide-in", label: "Slide" },
  { id: "wipe-in", label: "Wipe" },
];

export const isEntrance = (preset?: MotionPreset) => ENTRANCE_PRESETS.some((p) => p.id === preset);

export const MOTION_PRESETS: { id: MotionPreset; label: string }[] = [
  { id: "zoom-in", label: "Zoom in" },
  { id: "zoom-out", label: "Zoom out" },
  { id: "pan-left", label: "Pan ←" },
  { id: "pan-right", label: "Pan →" },
  { id: "pan-up", label: "Pan ↑" },
  { id: "pan-down", label: "Pan ↓" },
];

/**
 * A preset's start and end points. `amount` is the extra zoom (0.15 = 15 %); pans zoom
 * in by it and travel as far as that zoom allows without uncovering a full-frame clip.
 * Pans are named for the camera: panning right slides the picture left.
 */
export function motionPreset(preset: MotionPreset, amount: number, W: number, H: number): Motion {
  const a = Math.max(0.01, Math.min(1, amount));
  const s = 1 + a;
  const dx = (a * W) / 2;
  const dy = (a * H) / 2;
  const at = (scale: number, x = 0, y = 0): MotionPoint => ({ scale, x, y });
  // Entrances: [start point, seconds], easing out into the clip's own framing.
  const entrances: Partial<Record<MotionPreset, [MotionPoint, number]>> = {
    "pop-in": [at(0.6), 0.35],
    "rise-in": [at(1, 0, 0.08 * H), 0.5],
    "slide-in": [at(1, -0.5 * W), 0.5],
  };
  const entrance = entrances[preset];
  if (entrance) return { preset, from: entrance[0], to: at(1), duration: entrance[1], easeOut: true };
  if (preset === "wipe-in") return { preset, from: at(1), to: at(1), duration: 0.6, easeOut: true, reveal: true };
  const glides: Partial<Record<MotionPreset, [MotionPoint, MotionPoint]>> = {
    "zoom-in": [at(1), at(s)],
    "zoom-out": [at(s), at(1)],
    "pan-left": [at(s, -dx), at(s, dx)],
    "pan-right": [at(s, dx), at(s, -dx)],
    "pan-up": [at(s, 0, -dy), at(s, 0, dy)],
    "pan-down": [at(s, 0, dy), at(s, 0, -dy)],
  };
  const [from, to] = glides[preset]!;
  return { preset, from, to };
}

/** The preset's amount, read back from its points. */
export function motionAmount(m: Motion): number {
  return Math.max(m.from.scale, m.to.scale) - 1;
}

/** Progress of a motion `local` seconds into a clip of length `clipDur`, 0 → 1 (eased). */
export function motionProgress(m: Motion, local: number, clipDur: number): number {
  const d = m.duration && m.duration > 0 ? Math.min(m.duration, clipDur) : clipDur;
  const p = d > 0 ? Math.max(0, Math.min(1, local / d)) : 1;
  return m.easeOut ? 1 - (1 - p) ** 3 : p;
}

/** How much of a revealing clip shows (0 → 1, left to right) `local` seconds in; 1 when it doesn't reveal. */
export function revealAt(m: Motion | undefined, local: number, clipDur: number): number {
  return m?.reveal ? motionProgress(m, local, clipDur) : 1;
}

/** The motion point at progress `p` (0 → 1). */
export function motionAt(m: Motion, p: number): MotionPoint {
  const k = Math.max(0, Math.min(1, p));
  const lerp = (a: number, b: number) => a + (b - a) * k;
  return { scale: lerp(m.from.scale, m.to.scale), x: lerp(m.from.x, m.to.x), y: lerp(m.from.y, m.to.y) };
}

/**
 * A clip `clipDur` long cut `local` seconds in: the motions of the piece before and the
 * piece after, so each carries on where the original was rather than restarting.
 */
export function splitMotion(m: Motion, local: number, clipDur: number): [Motion, Motion] {
  if (!(m.duration && m.duration > 0) && !m.easeOut) {
    const p = clipDur > 0 ? Math.max(0, Math.min(1, local / clipDur)) : 0;
    return [
      { from: m.from, to: motionAt(m, p) },
      { from: motionAt(m, p), to: m.to },
    ];
  }
  // A timed move keeps its clock in the first piece; the second picks up from there.
  const end = m.duration && m.duration > 0 ? Math.min(m.duration, clipDur) : clipDur;
  if (local >= end) return [m, { from: m.to, to: m.to }];
  return [m, { from: motionAt(m, motionProgress(m, local, clipDur)), to: m.to, duration: end - local, easeOut: m.easeOut }];
}

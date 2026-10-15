// Ken Burns style motion: a clip glides from one framing to another over its length.
// Each point scales and offsets the clip's own transform (scale multiplies, x/y add, in
// project pixels); in between it moves linearly. graph.rs renders the same thing.

export type MotionPreset = "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "pan-up" | "pan-down";

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
}

export const DEFAULT_MOTION_AMOUNT = 0.15;

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
  const [from, to] = {
    "zoom-in": [at(1), at(s)],
    "zoom-out": [at(s), at(1)],
    "pan-left": [at(s, -dx), at(s, dx)],
    "pan-right": [at(s, dx), at(s, -dx)],
    "pan-up": [at(s, 0, -dy), at(s, 0, dy)],
    "pan-down": [at(s, 0, dy), at(s, 0, -dy)],
  }[preset];
  return { preset, from, to };
}

/** The preset's amount, read back from its points. */
export function motionAmount(m: Motion): number {
  return Math.max(m.from.scale, m.to.scale) - 1;
}

/** The motion point at progress `p` (0 → 1 through the clip). */
export function motionAt(m: Motion, p: number): MotionPoint {
  const k = Math.max(0, Math.min(1, p));
  const lerp = (a: number, b: number) => a + (b - a) * k;
  return { scale: lerp(m.from.scale, m.to.scale), x: lerp(m.from.x, m.to.x), y: lerp(m.from.y, m.to.y) };
}

/** The stretch of a motion between progress p0 and p1, for a piece cut out of its clip. */
export function sliceMotion(m: Motion, p0: number, p1: number): Motion {
  return { from: motionAt(m, p0), to: motionAt(m, p1) };
}

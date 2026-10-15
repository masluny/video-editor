// Keyframes: a clip's position, scale, rotation or opacity changing over time.
//
// Like volume envelopes, keys live on the clip's own clock (`in + local × speed`, the
// source time for media), so trimming, moving or splitting a clip never shifts them. Values
// move linearly between keys and hold before the first and after the last. A keyed
// property ignores its static value (transform.x, opacity, …). graph.rs renders the same.

import type { Clip, Transform } from "./types";
import { clipDuration, speedOf } from "./timeline";

export type KeyProp = "x" | "y" | "scale" | "rotation" | "opacity";

export interface Key {
  /** Clip clock: `in + local × speed`. */
  t: number;
  v: number;
}

export type Keyframes = Partial<Record<KeyProp, Key[]>>;

/** What the inspector animates as one: position moves x and y together. */
export type KeyGroup = "position" | "scale" | "rotation" | "opacity";
export const GROUP_PROPS: Record<KeyGroup, KeyProp[]> = { position: ["x", "y"], scale: ["scale"], rotation: ["rotation"], opacity: ["opacity"] };

/** The clip clock `local` seconds into the clip. */
export function keyClock(c: Clip, local: number): number {
  return c.in + local * speedOf(c);
}

/** Seconds into the clip where clip-clock time `t` falls. */
export function keyLocal(c: Clip, t: number): number {
  return (t - c.in) / speedOf(c);
}

/** Piecewise-linear value of keys at clip-clock `t`, or `fallback` without keys. */
export function valueAt(keys: Key[] | undefined, t: number, fallback: number): number {
  if (!keys?.length) return fallback;
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i++) {
    const [a, b] = [keys[i - 1], keys[i]];
    if (t <= b.t) return b.t - a.t > 1e-9 ? a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t) : b.v;
  }
  return keys[keys.length - 1].v;
}

const staticValue = (c: Clip, p: KeyProp): number => (p === "opacity" ? c.opacity : c.transform[p]);

/** A property's value `local` seconds into the clip. */
export function propAt(c: Clip, p: KeyProp, local: number): number {
  return valueAt(c.keyframes?.[p], keyClock(c, local), staticValue(c, p));
}

/** The clip's transform and opacity `local` seconds in, keyframes applied. */
export function posed(c: Clip, local: number): { transform: Transform; opacity: number } {
  if (!c.keyframes) return { transform: c.transform, opacity: c.opacity };
  const at = (p: KeyProp) => propAt(c, p, local);
  return { transform: { ...c.transform, x: at("x"), y: at("y"), scale: at("scale"), rotation: at("rotation") }, opacity: at("opacity") };
}

export function isAnimated(c: Clip, g: KeyGroup): boolean {
  return GROUP_PROPS[g].some((p) => !!c.keyframes?.[p]?.length);
}

/** Keys of `keys` without the one within `tol` of `t`, plus {t, v}; sorted. */
export function withKey(keys: Key[] | undefined, t: number, v: number, tol: number): Key[] {
  return [...(keys ?? []).filter((k) => Math.abs(k.t - t) > tol), { t, v }].sort((a, b) => a.t - b.t);
}

export function hasKeyAt(keys: Key[] | undefined, t: number, tol: number): boolean {
  return !!keys?.some((k) => Math.abs(k.t - t) <= tol);
}

/** Half a frame on the clip clock: keys closer than this are the same key. */
export function keyTolerance(c: Clip, fps: number): number {
  return (0.5 / (fps > 0 ? fps : 30)) * speedOf(c);
}

/** Seconds into the clip (sorted, unique) where its keys (of `group`, or any) fall inside it. */
export function keyTimes(c: Clip, group?: KeyGroup): number[] {
  const d = clipDuration(c);
  const out: number[] = [];
  const lists = group ? GROUP_PROPS[group].map((p) => c.keyframes?.[p]) : Object.values(c.keyframes ?? {});
  for (const keys of lists)
    for (const k of keys ?? []) {
      const l = keyLocal(c, k.t);
      if (l >= -1e-6 && l <= d + 1e-6 && !out.some((x) => Math.abs(x - l) < 1e-3)) out.push(Math.max(0, Math.min(d, l)));
    }
  return out.sort((a, b) => a - b);
}

// Geometry & colour helpers shared by the preview compositor. The export engine
// (src-tauri/src/graph.rs) implements the same maths so preview == export.

import type { Clip, ColorAdjust, Crop, Fit } from "./types";
import { clipDuration } from "./timeline";

export function fitBox(mw: number, mh: number, w: number, h: number, fit: Fit): { width: number; height: number } {
  if (!(mw > 0) || !(mh > 0) || fit === "stretch") return { width: w, height: h };
  const s = fit === "cover" ? Math.max(w / mw, h / mh) : Math.min(w / mw, h / mh);
  return { width: mw * s, height: mh * s };
}

/** CSS filter string; order must match graph.rs::color_filters. */
export function cssFilter(c: ColorAdjust): string {
  const parts: string[] = [];
  if (Math.abs(c.brightness - 1) > 1e-4) parts.push(`brightness(${c.brightness})`);
  if (Math.abs(c.contrast - 1) > 1e-4) parts.push(`contrast(${c.contrast})`);
  if (Math.abs(c.saturation - 1) > 1e-4) parts.push(`saturate(${c.saturation})`);
  if (c.sepia > 1e-4) parts.push(`sepia(${c.sepia})`);
  if (Math.abs(c.hue) > 1e-4) parts.push(`hue-rotate(${c.hue}deg)`);
  if (c.blur > 0.01) parts.push(`blur(${c.blur}px)`);
  return parts.join(" ") || "none";
}

export function cssClipPath(c: Crop): string {
  if (c.top + c.right + c.bottom + c.left < 1e-4) return "none";
  const p = (v: number) => `${(Math.max(0, Math.min(1, v)) * 100).toFixed(3)}%`;
  return `inset(${p(c.top)} ${p(c.right)} ${p(c.bottom)} ${p(c.left)})`;
}

/** Fade multiplier (0..1) at `local` seconds into the clip. */
export function fadeFactor(c: Clip, local: number): number {
  const d = clipDuration(c);
  let f = 1;
  if (c.fadeIn > 0 && local < c.fadeIn) f = Math.min(f, Math.max(0, local / c.fadeIn));
  if (c.fadeOut > 0 && local > d - c.fadeOut) f = Math.min(f, Math.max(0, (d - local) / c.fadeOut));
  return f;
}

export function isDefaultColor(c: ColorAdjust): boolean {
  return cssFilter(c) === "none";
}

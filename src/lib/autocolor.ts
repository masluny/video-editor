// Automatic colour: "Auto" stretches a clip's tonal range to a pleasant one, "Match" makes
// one clip look like another. Both read picture statistics measured by ffmpeg
// (analysis.rs) and answer with the editor's own adjustments, which apply brightness
// (multiply), then contrast (around mid-grey), then saturation, in the preview and export.

import type { ColorAdjust } from "./types";

export interface PictureStats {
  /** Luma at the 10th and 90th percentiles and on average, 0..1. */
  low: number;
  high: number;
  avg: number;
  /** Mean chroma, 0..1 of full scale. */
  sat: number;
}

type Tone = Pick<ColorAdjust, "brightness" | "contrast" | "saturation">;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round = (v: number) => Math.round(v * 100) / 100;

/** The stats after a clip's adjustment (brightness and contrast also scale chroma). */
export function adjusted(s: PictureStats, c: Tone): PictureStats {
  const y = (v: number) => clamp((v * c.brightness - 0.5) * c.contrast + 0.5, 0, 1);
  return { low: y(s.low), high: y(s.high), avg: y(s.avg), sat: s.sat * c.brightness * c.contrast * c.saturation };
}

/** Brightness and contrast that map luma `low`/`high` onto `toLow`/`toHigh`. */
function stretch(low: number, high: number, toLow: number, toHigh: number): { brightness: number; contrast: number } {
  const span = Math.max(0.02, high - low);
  // (low·b − ½)k + ½ = toLow and (high·b − ½)k + ½ = toHigh give the contrast; within
  // its limits, brightness then puts the middle of the range where it should be.
  const bk = (toHigh - toLow) / span;
  const k = clamp((low + high) * bk - (toLow + toHigh - 1), 0.5, 2.5);
  const [mid, toMid] = [(low + high) / 2, (toLow + toHigh) / 2];
  const b = clamp(((toMid - 0.5) / k + 0.5) / Math.max(0.02, mid), 0.4, 2);
  return { brightness: b, contrast: k };
}

/** Where Auto puts the 10th and 90th luma percentiles, and the chroma it lifts dull footage to. */
const TARGET = { low: 0.1, high: 0.9, sat: 0.3 };

/** A gentle one-click correction: full tonal range, and a lift for washed-out colour. */
export function autoColor(s: PictureStats): Tone {
  const { brightness, contrast } = stretch(s.low, s.high, TARGET.low, TARGET.high);
  const after = s.sat * brightness * contrast;
  // Never desaturates; at most +40 %.
  const saturation = after > 0.01 ? clamp(TARGET.sat / after, 1, 1.4) : 1;
  return { brightness: round(brightness), contrast: round(contrast), saturation: round(saturation) };
}

/** The adjustment that makes a picture with stats `s` look like `ref` (as it's shown). */
export function matchColor(s: PictureStats, ref: PictureStats): Tone {
  const { brightness, contrast } = stretch(s.low, s.high, ref.low, ref.high);
  const after = s.sat * brightness * contrast;
  const saturation = after > 0.01 ? clamp(ref.sat / after, 0.3, 2.5) : 1;
  return { brightness: round(brightness), contrast: round(contrast), saturation: round(saturation) };
}

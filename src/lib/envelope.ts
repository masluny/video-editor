// Volume envelopes and automatic ducking.
//
// A clip's envelope is a list of gain points in *source* time (seconds of its media), so
// trimming, moving or splitting the clip never shifts it against the sound. Between points
// the gain moves linearly; before the first and after the last it holds. graph.rs renders
// the same curve.

export interface VolumePoint {
  /** Source (media) time, seconds. */
  t: number;
  gain: number;
}

/** Envelope gain at source time `s` (1 without an envelope). */
export function gainAt(points: VolumePoint[] | undefined, s: number): number {
  if (!points?.length) return 1;
  if (s <= points[0].t) return points[0].gain;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    if (s <= b.t) return b.t - a.t > 1e-9 ? a.gain + ((b.gain - a.gain) * (s - a.t)) / (b.t - a.t) : b.gain;
  }
  return points[points.length - 1].gain;
}

export interface DuckOptions {
  /** Gain while ducked (0.25 ≈ -12 dB). */
  depth: number;
  /** Seconds to fade down before speech starts / back up after it ends. */
  attack: number;
  release: number;
  /** Pauses shorter than this stay ducked (no pumping between words). */
  bridge: number;
}

export const DUCK_DEFAULTS: DuckOptions = { depth: 0.25, attack: 0.3, release: 0.6, bridge: 1.2 };

/** Merge overlapping regions and close gaps shorter than `bridge`. */
export function mergeRegions(regions: [number, number][], bridge = 0): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [...regions].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + bridge) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Envelope (in source time) that ducks a clip under the given speech regions (timeline
 * seconds). `toSource` maps timeline time to the clip's media time.
 */
export function duckingPoints(speech: [number, number][], span: [number, number], toSource: (t: number) => number, opts: DuckOptions = DUCK_DEFAULTS): VolumePoint[] {
  const [s0, s1] = span;
  const regions = mergeRegions(speech, opts.bridge).filter(([a, b]) => b > s0 - opts.release && a < s1 + opts.attack);
  const pts: VolumePoint[] = [];
  for (const [a, b] of regions) {
    const down = Math.max(a - opts.attack, pts.length ? pts[pts.length - 1].t : -Infinity);
    pts.push({ t: down, gain: 1 }, { t: a, gain: opts.depth }, { t: b, gain: opts.depth }, { t: b + opts.release, gain: 1 });
  }
  // Timeline → source time; drop points that collapse onto each other.
  const out: VolumePoint[] = [];
  for (const p of pts) {
    const q = { t: toSource(p.t), gain: p.gain };
    const last = out[out.length - 1];
    if (last && q.t - last.t < 1e-4) last.gain = Math.min(last.gain, q.gain);
    else out.push(q);
  }
  return out;
}

/**
 * Where there's sound worth ducking under, in seconds: levels (0..1, `rate` per second,
 * e.g. the timeline waveform's peaks) above a threshold relative to the loud parts, held
 * for a moment so syllables join up.
 */
export function speechRegions(levels: ArrayLike<number>, rate: number, hold = 0.3, minLength = 0.25): [number, number][] {
  if (!levels.length || !(rate > 0)) return [];
  const sorted = Array.from(levels).sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.95)];
  const threshold = Math.max(0.02, loud * 0.15); // well above the noise floor, within ~16 dB of the loud parts
  const regions: [number, number][] = [];
  for (let i = 0; i < levels.length; i++) if (levels[i] > threshold) regions.push([i / rate, (i + 1) / rate]);
  return mergeRegions(regions, hold).filter(([a, b]) => b - a >= minLength);
}

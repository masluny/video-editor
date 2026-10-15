import { describe, expect, it } from "vitest";
import { BEAT_RATE, detectBeats, toBeatRate } from "./beats";

/** A drum-ish click track: decaying noise bursts on the beat over quiet noise. */
function clicks(bpm: number, seconds: number, offset: number, seed = 1): { samples: Float32Array; beats: number[] } {
  let x = seed;
  const rand = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  const samples = new Float32Array(Math.round(seconds * BEAT_RATE));
  for (let i = 0; i < samples.length; i++) samples[i] = 0.02 * rand();
  const beats: number[] = [];
  for (let t = offset; t < seconds - 0.1; t += 60 / bpm) {
    beats.push(t);
    const at = Math.round(t * BEAT_RATE);
    for (let i = 0; i < 0.06 * BEAT_RATE && at + i < samples.length; i++) samples[at + i] += 0.8 * rand() * Math.exp(-i / (0.012 * BEAT_RATE));
  }
  return { samples, beats };
}

/** Share of true beats with a detected beat within `tol` seconds. */
const hitRate = (truth: number[], found: number[], tol = 0.03) => truth.filter((b) => found.some((f) => Math.abs(f - b) <= tol)).length / truth.length;

describe("beat detection", () => {
  it("finds a 120 BPM pulse and lands on the beats", () => {
    const { samples, beats } = clicks(120, 20, 0.25);
    const found = detectBeats(samples);
    expect(found.bpm).toBeGreaterThan(118);
    expect(found.bpm).toBeLessThan(122);
    expect(hitRate(beats, found.times)).toBeGreaterThan(0.9);
  });

  it("finds a slower 100 BPM pulse with an offset", () => {
    const { samples, beats } = clicks(100, 24, 0.43, 7);
    const found = detectBeats(samples);
    expect(Math.abs(found.bpm - 100)).toBeLessThan(2.5);
    expect(hitRate(beats, found.times)).toBeGreaterThan(0.9);
    // No phantom beats between the real ones.
    expect(found.times.length).toBeLessThan(beats.length * 1.15);
  });

  it("works on audio decoded at 44.1 kHz", () => {
    const { samples, beats } = clicks(120, 12, 0.25, 3);
    const up = new Float32Array(samples.length * 4); // 44.1 kHz, sample-and-hold
    for (let i = 0; i < up.length; i++) up[i] = samples[i >> 2];
    const found = detectBeats(toBeatRate(up, 44100));
    expect(hitRate(beats, found.times)).toBeGreaterThan(0.9);
  });

  it("copes with silence and very short audio", () => {
    expect(detectBeats(new Float32Array(BEAT_RATE)).times).toEqual([]);
    expect(detectBeats(new Float32Array(10 * BEAT_RATE)).times).toEqual([]);
  });
});

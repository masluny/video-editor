import { describe, expect, it } from "vitest";
import { activeLevel, duckingPoints, gainAt, mergeRegions, speechRegions } from "./envelope";

describe("volume envelopes", () => {
  it("interpolates between points and holds outside them", () => {
    const pts = [
      { t: 1, gain: 1 },
      { t: 2, gain: 0.5 },
      { t: 4, gain: 0.5 },
    ];
    expect(gainAt(undefined, 3)).toBe(1);
    expect(gainAt(pts, 0)).toBe(1);
    expect(gainAt(pts, 1.5)).toBeCloseTo(0.75);
    expect(gainAt(pts, 3)).toBe(0.5);
    expect(gainAt(pts, 9)).toBe(0.5);
  });

  it("merges regions across short pauses", () => {
    expect(mergeRegions([[5, 6], [0, 1], [1.2, 2], [0.5, 0.8]], 0.5)).toEqual([[0, 2], [5, 6]]);
  });

  it("ducks around speech in the clip's source time, with ramps", () => {
    // Clip at timeline 10s uses source 30s.. at 2x: source = 30 + (t - 10) * 2.
    const pts = duckingPoints([[12, 13], [13.5, 14], [30, 31]], [10, 20], (t) => 30 + (t - 10) * 2, { depth: 0.25, attack: 0.3, release: 0.6, bridge: 1 });
    expect(pts.map((p) => [+p.t.toFixed(3), p.gain])).toEqual([
      [33.4, 1],
      [34, 0.25],
      [38, 0.25],
      [39.2, 1],
    ]);
  });

  it("finds talking in a waveform and ignores the noise floor", () => {
    const rate = 100;
    const levels = new Array(1000).fill(0.01);
    const talk = (a: number, b: number) => {
      for (let i = a * rate; i < b * rate; i++) levels[i] = i % 7 === 0 ? 0.05 : 0.6; // syllables dip
    };
    talk(1, 3);
    talk(3.2, 4); // a short breath: joined up
    talk(6, 6.1); // a click: too short
    expect(speechRegions(levels, rate).map(([a, b]) => [+a.toFixed(1), +b.toFixed(1)])).toEqual([[1, 4]]);
    expect(speechRegions(new Array(500).fill(0.005), rate)).toEqual([]);
  });

  it("measures loudness over the parts with sound only", () => {
    const levels = new Array(1000).fill(0.005);
    for (let i = 200; i < 400; i++) levels[i] = 0.4;
    expect(activeLevel(levels, 100)).toBeCloseTo(0.4, 2); // the silence doesn't drag it down
    expect(activeLevel(new Array(300).fill(0), 100)).toBe(0);
  });
});

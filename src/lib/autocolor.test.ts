import { describe, expect, it } from "vitest";
import { adjusted, autoColor, matchColor, type PictureStats } from "./autocolor";

// Measured by ffmpeg signalstats: a test pattern, and the same washed out
// (eq=contrast=0.55:brightness=0.12:saturation=0.45).
const luma = (y: number) => (y - 16) / 219;
const good: PictureStats = { low: luma(41), high: luma(210), avg: luma(125.1), sat: 109.8 / 128 };
const dull: PictureStats = { low: luma(107), high: luma(200), avg: luma(153.3), sat: 48.8 / 128 };

describe("auto colour", () => {
  it("leaves well-exposed, colourful footage almost alone", () => {
    const c = autoColor(good);
    expect(Math.abs(c.brightness - 1)).toBeLessThan(0.05);
    expect(Math.abs(c.contrast - 1)).toBeLessThan(0.05);
    expect(c.saturation).toBe(1);
  });

  it("stretches washed-out footage back to a full range", () => {
    const c = autoColor(dull);
    const after = adjusted(dull, c);
    expect(c.contrast).toBeGreaterThan(1.5);
    expect(after.low).toBeLessThan(0.2);
    expect(after.high).toBeGreaterThan(0.8);
  });

  it("matches one clip's look to another's", () => {
    const c = matchColor(dull, good);
    const after = adjusted(dull, c);
    expect(after.low).toBeCloseTo(good.low, 1);
    expect(after.high).toBeCloseTo(good.high, 1);
    expect(after.sat).toBeCloseTo(good.sat, 1);
  });

  it("matches to how the reference is shown, adjustments included", () => {
    const shown = adjusted(good, { brightness: 1, contrast: 1, saturation: 0 }); // a black & white reference
    expect(matchColor(dull, shown).saturation).toBe(0.3); // as grey as the limits allow
  });
});

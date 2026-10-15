import { describe, expect, it } from "vitest";
import { cornerLayout, cornerOf, cornerRadius, cssClipPath, squareCrop } from "./visual";

describe("picture-in-picture corners", () => {
  it("tucks a fitted clip into a corner with a margin", () => {
    // 1920x1080 frame, 16:9 clip at 35%: 672x378, margin 43 px.
    expect(cornerLayout("bottom-right", 1280, 720, 1920, 1080)).toEqual({ scale: 0.35, x: 581, y: 308 });
    expect(cornerLayout("top-left", 1280, 720, 1920, 1080)).toEqual({ scale: 0.35, x: -581, y: -308 });
    // A portrait clip in a landscape frame keeps its shape: 1080 tall -> 378 tall, 213 wide.
    const p = cornerLayout("top-right", 1080, 1920, 1920, 1080);
    expect(p.x).toBe(Math.round(960 - (1080 * (1080 / 1920) * 0.35) / 2 - 43.2));
  });
});

describe("rounded corners and circles", () => {
  it("rounds the visible part of the picture, after its crop", () => {
    const crop = squareCrop(1600, 900);
    expect(crop.left).toBeCloseTo(0.21875);
    expect(cornerRadius(crop, 0.5, 1600, 900)).toBeCloseTo(450); // a circle 900 across
    expect(cssClipPath({ top: 0, right: 0, bottom: 0, left: 0 }, 0.1, 800, 450)).toBe("inset(0.000% 0.000% 0.000% 0.000% round 45.00px)");
    expect(cssClipPath({ top: 0, right: 0, bottom: 0, left: 0 })).toBe("none");
  });

  it("keeps a cropped picture-in-picture flush with its corner", () => {
    const crop = squareCrop(1920, 1080);
    // The visible square is 378 px: its right edge sits 43 px from the frame's.
    const { x } = cornerLayout("bottom-right", 1280, 720, 1920, 1080, 0.35, crop);
    expect(960 - (x + 378 / 2)).toBeCloseTo(43.2, 0);
    expect(cornerOf(x, 300)).toBe("bottom-right");
    expect(cornerOf(0, 300)).toBeNull();
  });
});

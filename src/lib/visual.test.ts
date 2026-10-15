import { describe, expect, it } from "vitest";
import { cornerLayout } from "./visual";

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

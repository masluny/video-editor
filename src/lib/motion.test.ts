import { describe, expect, it } from "vitest";
import type { MediaAsset } from "./types";
import { mediaClip } from "./defaults";
import { split } from "./timeline";
import { motionAmount, motionAt, motionPreset } from "./motion";
import { migrateProject } from "./migrate";

const media: MediaAsset = {
  id: "m", path: "/m.mp4", name: "m.mp4", kind: "video", duration: 100, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true,
};

describe("motion", () => {
  it("builds presets that never uncover a full-frame clip", () => {
    expect(motionPreset("zoom-in", 0.2, 1920, 1080)).toEqual({ preset: "zoom-in", from: { scale: 1, x: 0, y: 0 }, to: { scale: 1.2, x: 0, y: 0 } });
    const pan = motionPreset("pan-right", 0.2, 1920, 1080);
    // 1.2x is 384 px wider than the frame: 192 px of travel each way; the camera pans
    // right, so the picture slides left.
    expect(pan.from).toEqual({ scale: 1.2, x: 192, y: 0 });
    expect(pan.to).toEqual({ scale: 1.2, x: -192, y: 0 });
    expect(motionAmount(pan)).toBeCloseTo(0.2);
    expect(motionAt(pan, 0.25)).toEqual({ scale: 1.2, x: 96, y: 0 });
  });

  it("carries on across a split instead of restarting in each half", () => {
    const c = { ...mediaClip(media, 0, { in: 0, out: 4 }), motion: motionPreset("zoom-in", 0.4, 1920, 1080) };
    const [left, right] = split(c, 1)!;
    expect(left.motion).toEqual({ from: { scale: 1, x: 0, y: 0 }, to: { scale: 1.1, x: 0, y: 0 } });
    expect(right.motion!.from.scale).toBeCloseTo(1.1);
    expect(right.motion!.to.scale).toBeCloseTo(1.4);
  });

  it("survives a save and drops garbage", () => {
    const p = migrateProject({
      version: 2,
      settings: {},
      media: [media],
      tracks: [{ kind: "video", clips: [
        { type: "media", mediaId: "m", in: 0, out: 2, motion: { preset: "zoom-out", from: { scale: 1.3 }, to: { scale: 1 } } },
        { type: "media", mediaId: "m", start: 2, in: 0, out: 2, motion: { from: 3 } },
      ] }],
    });
    expect(p.tracks[0].clips[0].motion).toEqual({ preset: "zoom-out", from: { scale: 1.3, x: 0, y: 0 }, to: { scale: 1, x: 0, y: 0 } });
    expect(p.tracks[0].clips[1].motion).toBeUndefined();
  });
});

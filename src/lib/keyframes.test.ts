import { describe, expect, it } from "vitest";
import { mediaClip } from "./defaults";
import { hasKeyAt, isAnimated, keyClock, keyTimes, posed, propAt, valueAt, withKey } from "./keyframes";
import { split } from "./timeline";
import { migrateProject } from "./migrate";
import type { Clip, MediaAsset } from "./types";

const media: MediaAsset = { id: "m", path: "/m.mp4", name: "m.mp4", kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true };
const clip = (patch: Partial<Clip> = {}): Clip => ({ ...mediaClip(media, 10, { in: 5, out: 15 }), ...patch });

describe("keyframes", () => {
  it("interpolates linearly and holds outside the keys", () => {
    const keys = [{ t: 1, v: 0 }, { t: 3, v: 100 }, { t: 4, v: 100 }];
    expect([0, 1, 2, 3, 3.5, 9].map((t) => valueAt(keys, t, -1))).toEqual([0, 0, 50, 100, 100, 100]);
    expect(valueAt(undefined, 2, 7)).toBe(7);
  });

  it("eases in and out of keys when asked", () => {
    const keys = [{ t: 0, v: 0 }, { t: 4, v: 100 }];
    expect(valueAt(keys, 1, 0, true)).toBeCloseTo(15.625); // smoothstep(0.25)
    expect(valueAt(keys, 2, 0, true)).toBe(50);
    const c = clip({ keyEase: true, keyframes: { opacity: [{ t: 5, v: 0 }, { t: 9, v: 1 }] } });
    expect(propAt(c, "opacity", 1)).toBeCloseTo(0.15625);
  });

  it("runs on the clip clock: source time for media, through speed", () => {
    const c = clip({ speed: 2, keyframes: { x: [{ t: 5, v: 0 }, { t: 9, v: 400 }] } });
    expect(keyClock(c, 1)).toBe(7);
    expect(propAt(c, "x", 1)).toBe(200); // 1s in = source 7 = halfway
    expect(propAt(c, "y", 1)).toBe(c.transform.y); // unkeyed: the static value
    expect(posed(c, 2).transform.x).toBe(400);
  });

  it("keeps the curve where it was when a clip is split", () => {
    const c = clip({ keyframes: { opacity: [{ t: 5, v: 0 }, { t: 15, v: 1 }], scale: [{ t: 6, v: 1 }, { t: 14, v: 2 }] } });
    const [a, b] = split(c, 13)!;
    for (const t of [10, 11.5, 12.9]) expect(posed(a, t - a.start)).toEqual(posed(c, t - c.start));
    for (const t of [13, 14.2, 19.9]) expect(posed(b, t - b.start)).toEqual(posed(c, t - c.start));
  });

  it("adds, replaces and finds keys within a tolerance", () => {
    let k = withKey(undefined, 2, 10, 0.01);
    k = withKey(k, 1, 5, 0.01);
    k = withKey(k, 2.005, 20, 0.01); // replaces the key at 2
    expect(k).toEqual([{ t: 1, v: 5 }, { t: 2.005, v: 20 }]);
    expect(hasKeyAt(k, 2, 0.01)).toBe(true);
    expect(hasKeyAt(k, 1.5, 0.01)).toBe(false);
  });

  it("lists key times inside the clip once, and knows what's animated", () => {
    const c = clip({ keyframes: { x: [{ t: 5, v: 0 }, { t: 7, v: 1 }], y: [{ t: 7, v: 0 }], opacity: [{ t: 20, v: 1 }] } });
    expect(keyTimes(c)).toEqual([0, 2]); // opacity's key lies past the clip's end
    expect(isAnimated(c, "position")).toBe(true);
    expect(isAnimated(c, "rotation")).toBe(false);
  });

  it("survives a save, sorting keys and dropping garbage", () => {
    const p = migrateProject({
      version: 2,
      settings: {},
      media: [media],
      tracks: [{ kind: "video", clips: [{ type: "media", mediaId: "m", in: 0, out: 2, keyframes: { x: [{ t: 2, v: 5 }, { t: 1, v: 3 }, { t: "a" }], opacity: [{ t: 0, v: 7 }], wobble: [{ t: 0, v: 1 }], scale: [] } }] }],
    });
    expect(p.tracks[0].clips[0].keyframes).toEqual({ x: [{ t: 1, v: 3 }, { t: 2, v: 5 }], opacity: [{ t: 0, v: 1 }] });
  });
});

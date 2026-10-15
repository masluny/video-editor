import { describe, expect, it } from "vitest";
import type { Clip, MediaAsset, Track } from "./types";
import { mediaClip } from "./defaults";
import { split } from "./timeline";
import { dissolveAt, dissolveGain, dissolveInto, dissolveMix, dissolveOutOf } from "./transitions";
import { migrateProject } from "./migrate";

const media: MediaAsset = {
  id: "m", path: "/m.mp4", name: "m.mp4", kind: "video", duration: 100, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true,
};
const c = (id: string, start: number, len: number, transitionIn?: number): Clip => ({ ...mediaClip(media, start, { in: 0, out: len }), id, transitionIn });
const track = (...clips: Clip[]): Track => ({ id: "t", kind: "video", name: "V1", hidden: false, locked: false, muted: false, solo: false, volume: 1, clips });

describe("dissolves", () => {
  it("is centred on a cut between butted clips", () => {
    const t = track(c("a", 0, 4), c("b", 4, 4, 1));
    const d = dissolveInto(t, t.clips[1])!;
    expect(d).toMatchObject({ cut: 4, half: 0.5 });
    expect(d.from.id).toBe("a");
    expect(dissolveOutOf(t, t.clips[0])).toEqual(d);
    expect(dissolveAt(t, 3.4)).toBeNull();
    expect(dissolveAt(t, 3.6)).toEqual(d);
    expect(dissolveAt(t, 4.49)).toEqual(d);
    expect(dissolveAt(t, 4.5)).toBeNull();
    expect(dissolveMix(d, 3.5)).toBe(0);
    expect(dissolveMix(d, 4)).toBe(0.5);
    expect(dissolveMix(d, 4.5)).toBe(1);
  });

  it("never takes more than half of either clip, and needs a neighbour", () => {
    const t = track(c("a", 0, 1), c("b", 1, 4, 3));
    expect(dissolveInto(t, t.clips[1])!.half).toBe(0.5);
    const gap = track(c("a", 0, 1), c("b", 2, 4, 1));
    expect(dissolveInto(gap, gap.clips[1])).toBeNull();
  });

  it("dips the sound across the cut", () => {
    const t = track(c("a", 0, 4), c("b", 4, 4, 1));
    const [a, b] = t.clips;
    expect(dissolveGain(t, a, 3)).toBe(1);
    expect(dissolveGain(t, a, 3.75)).toBeCloseTo(0.5);
    expect(dissolveGain(t, b, 4.25)).toBeCloseTo(0.5);
    expect(dissolveGain(t, b, 5)).toBe(1);
  });

  it("stays with the head when a clip is split, and survives a save", () => {
    const [left, right] = split(c("b", 4, 4, 1), 6)!;
    expect(left.transitionIn).toBe(1);
    expect(right.transitionIn).toBeUndefined();
    const p = migrateProject({ version: 2, settings: {}, media: [media], tracks: [{ kind: "video", clips: [c("a", 0, 4), c("b", 4, 4, 1.5)] }] });
    expect(p.tracks[0].clips.map((x) => x.transitionIn)).toEqual([undefined, 1.5]);
  });
});

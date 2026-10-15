import { describe, expect, it } from "vitest";
import { followMain } from "./connect";
import { mediaClip, newProject, newTrack } from "./defaults";
import type { Clip, MediaAsset, Project } from "./types";

const media: MediaAsset = { id: "m", path: "/m.mp4", name: "m.mp4", kind: "video", duration: 100, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true };
const c = (id: string, start: number, len: number, inP = 0): Clip => ({ ...mediaClip(media, start, { in: inP, out: inP + len }), id });

function project(v1: Clip[], v2: Clip[], a1: Clip[] = []): Project {
  const p = newProject();
  const [main, over, music] = [newTrack("video", "V1"), newTrack("video", "V2"), newTrack("audio", "A1")];
  return { ...p, tracks: [{ ...main, id: "v1", clips: v1 }, { ...over, id: "v2", clips: v2 }, { ...music, id: "a1", clips: a1 }] };
}
const starts = (p: Project, track: string) => p.tracks.find((t) => t.id === track)!.clips.map((x) => [x.id, x.start]);

describe("connected clips", () => {
  it("keeps titles on the clip they sit on when the main track is reordered", () => {
    const prev = project([c("a", 0, 2), c("b", 2, 3)], [c("ta", 0.5, 1), c("tb", 3, 1)], [c("music", 0, 5)]);
    // Swap A and B on V1.
    const next = { ...prev, tracks: prev.tracks.map((t) => (t.id === "v1" ? { ...t, clips: [{ ...t.clips[1], start: 0 }, { ...t.clips[0], start: 3 }] } : t)) };
    const out = followMain(prev, next, "v1");
    expect(starts(out, "v2")).toEqual([["tb", 1], ["ta", 3.5]]);
    expect(starts(out, "a1")).toEqual([["music", 0]]); // sound isn't connected
  });

  it("follows a ripple head trim (the picture slides back) but not a plain head trim", () => {
    const prev = project([c("a", 0, 4)], [c("t", 2, 1)]);
    const ripple = { ...prev, tracks: prev.tracks.map((t) => (t.id === "v1" ? { ...t, clips: [{ ...t.clips[0], in: 1 }] } : t)) };
    expect(starts(followMain(prev, ripple, "v1"), "v2")).toEqual([["t", 1]]);
    const plain = { ...prev, tracks: prev.tracks.map((t) => (t.id === "v1" ? { ...t, clips: [{ ...t.clips[0], start: 1, in: 1 }] } : t)) };
    expect(starts(followMain(prev, plain, "v1"), "v2")).toEqual([["t", 2]]);
  });

  it("leaves clips that moved themselves, or with nothing under them, alone; and does nothing without the magnet", () => {
    const prev = project([c("a", 0, 2), c("b", 2, 2)], [c("moved", 2.5, 1), c("free", 9, 1)]);
    const next = {
      ...prev,
      tracks: prev.tracks.map((t) =>
        t.id === "v1" ? { ...t, clips: [{ ...t.clips[1], start: 0 }, { ...t.clips[0], start: 2 }] } : t.id === "v2" ? { ...t, clips: [{ ...t.clips[0], start: 6 }, t.clips[1]] } : t,
      ),
    };
    expect(starts(followMain(prev, next, "v1"), "v2")).toEqual([["moved", 6], ["free", 9]]);
    expect(followMain(prev, next, null)).toBe(next);
  });
});

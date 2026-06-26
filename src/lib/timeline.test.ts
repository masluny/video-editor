import { describe, expect, it } from "vitest";
import type { Clip, MediaAsset } from "./types";
import { mediaClip } from "./defaults";
import {
  clipDuration,
  clipEnd,
  gapAt,
  insert,
  keepSourceRanges,
  nextEditPoint,
  overwrite,
  prevEditPoint,
  rippleDelete,
  snapTime,
  speechRanges,
  split,
} from "./timeline";

const media: MediaAsset = {
  id: "m", path: "/m.mp4", name: "m.mp4", kind: "video", duration: 100, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true,
};

function c(id: string, start: number, len: number, inP = 0): Clip {
  return { ...mediaClip(media, start, { in: inP, out: inP + len }), id };
}

const spans = (clips: Clip[]) => clips.map((x) => [x.start, +clipEnd(x).toFixed(6), +x.in.toFixed(6)]);

describe("overwrite", () => {
  it("trims, splits and removes covered clips", () => {
    const track = [c("a", 0, 10), c("b", 10, 10)];
    const out = overwrite(track, c("n", 5, 10, 50));
    expect(spans(out)).toEqual([[0, 5, 0], [5, 15, 50], [15, 20, 5]]);
  });

  it("splits a clip the incoming one sits inside", () => {
    const out = overwrite([c("a", 0, 10)], c("n", 4, 2, 50));
    expect(spans(out)).toEqual([[0, 4, 0], [4, 6, 50], [6, 10, 6]]);
    expect(new Set(out.map((x) => x.id)).size).toBe(3);
  });

  it("does not touch neighbours that only share an edge", () => {
    const out = overwrite([c("a", 0, 5), c("b", 10, 5)], c("n", 5, 5));
    expect(spans(out)).toEqual([[0, 5, 0], [5, 10, 0], [10, 15, 0]]);
  });
});

describe("insert", () => {
  it("ripples later clips and splits a straddled one", () => {
    const out = insert([c("a", 0, 10), c("b", 10, 5)], c("n", 4, 3, 80));
    expect(spans(out)).toEqual([[0, 4, 0], [4, 7, 80], [7, 13, 4], [13, 18, 0]]);
  });
});

describe("rippleDelete", () => {
  it("closes the gap left by deleted clips", () => {
    const out = rippleDelete([c("a", 0, 5), c("b", 5, 5), c("x", 10, 5)], new Set(["b"]));
    expect(spans(out)).toEqual([[0, 5, 0], [5, 10, 0]]);
  });
});

describe("split", () => {
  it("respects speed when mapping to source time", () => {
    const fast = { ...c("a", 10, 8), speed: 2 }; // 8s of source over 4s
    expect(clipDuration(fast)).toBe(4);
    const [l, r] = split(fast, 11)!;
    expect([l.in, l.out, r.in, r.out, r.start]).toEqual([0, 2, 2, 8, 11]);
  });

  it("refuses to split at the edges", () => {
    expect(split(c("a", 0, 5), 0)).toBeNull();
    expect(split(c("a", 0, 5), 5)).toBeNull();
  });

  it("keeps fades on the outer ends only", () => {
    const faded = { ...c("a", 0, 10), fadeIn: 1, fadeOut: 2 };
    const [l, r] = split(faded, 5)!;
    expect([l.fadeIn, l.fadeOut, r.fadeIn, r.fadeOut]).toEqual([1, 0, 0, 2]);
  });
});

describe("silence removal helpers", () => {
  it("turns silences into padded speech ranges", () => {
    expect(speechRanges([[2, 4], [6, 7]], 0, 10, 0.25)).toEqual([[0, 2.25], [3.75, 6.25], [6.75, 10]]);
  });

  it("merges ranges whose padding overlaps", () => {
    expect(speechRanges([[2, 2.4]], 0, 5, 0.25)).toEqual([[0, 5]]);
  });

  it("butts kept ranges together from the clip start", () => {
    const pieces = keepSourceRanges(c("a", 3, 10, 20), [[20, 22], [25, 30]]);
    expect(spans(pieces)).toEqual([[3, 5, 20], [5, 10, 25]]);
    expect(pieces[0].id).toBe("a");
  });
});

describe("navigation", () => {
  const tracks = [{ id: "t", kind: "video" as const, name: "V1", clips: [c("a", 0, 5), c("b", 8, 4)], muted: false, solo: false, locked: false, hidden: false, volume: 1 }];

  it("finds edit points", () => {
    expect(nextEditPoint(tracks, 0)).toBe(5);
    expect(nextEditPoint(tracks, 5)).toBe(8);
    expect(prevEditPoint(tracks, 8)).toBe(5);
    expect(prevEditPoint(tracks, 0)).toBe(0);
  });

  it("finds gaps", () => {
    expect(gapAt(tracks[0], 6)).toEqual({ start: 5, end: 8 });
    expect(gapAt(tracks[0], 2)).toBeNull();
    expect(gapAt(tracks[0], 20)).toBeNull();
  });

  it("snaps within tolerance only", () => {
    expect(snapTime(4.9, [0, 5, 8], 0.2)).toBe(5);
    expect(snapTime(4.5, [0, 5, 8], 0.2)).toBeNull();
  });
});

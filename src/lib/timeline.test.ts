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
  closeAllGaps,
  cutToBeats,
  removeRange,
  rippleDelete,
  rippleTrim,
  snapTime,
  snapToEdit,
  speechRanges,
  split,
  videoEnd,
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

describe("snapToEdit", () => {
  const track = { id: "t", kind: "video" as const, name: "V1", hidden: false, locked: false, muted: false, solo: false, volume: 1, clips: [c("a", 0, 8.195729)] };

  it("lands exactly on an edit point less than a frame away", () => {
    expect(snapToEdit(8.195729, [track], 23.759)).toBe(8.195729);
    expect(snapToEdit(8.207416, [track], 23.759)).toBe(8.195729);
    expect(snapToEdit(8.17, [track], 23.759)).toBe(8.195729);
  });

  it("rounds to the frame grid elsewhere", () => {
    expect(snapToEdit(4.01, [track], 25)).toBe(4);
    expect(snapToEdit(8.195729 + 2 / 23.759, [track], 23.759)).toBeCloseTo(197 / 23.759, 9);
  });
});

describe("removeRange", () => {
  const track = () => [c("a", 0, 4), c("b", 4, 4, 20), c("d", 10, 2, 40)];

  it("extracts a span across clips and closes it up", () => {
    const out = removeRange(track(), 3, 5, true);
    expect(spans(out)).toEqual([[0, 3, 0], [3, 6, 21], [8, 10, 40]]);
    expect(out.map((x) => x.id)).toEqual(["a", "b", "d"]);
  });

  it("lifts a span, leaving a gap", () => {
    expect(spans(removeRange(track(), 3, 5, false))).toEqual([[0, 3, 0], [5, 8, 21], [10, 12, 40]]);
  });

  it("splits a clip that spans the whole range into two pieces", () => {
    const fading = { ...c("a", 0, 10), fadeIn: 1, fadeOut: 1 };
    const out = removeRange([fading], 4, 6, true);
    expect(spans(out)).toEqual([[0, 4, 0], [4, 8, 6]]);
    expect(out[0]).toMatchObject({ id: "a", fadeIn: 1, fadeOut: 0 });
    expect(out[1]).toMatchObject({ fadeIn: 0, fadeOut: 1 });
    expect(out[1].id).not.toBe("a");
  });

  it("drops clips inside the range", () => {
    expect(removeRange(track(), 9, 13, true).map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("rippleTrim", () => {
  it("trims a head in place and pulls later clips left", () => {
    const out = rippleTrim([c("a", 0, 4), c("b", 4, 4, 20), c("d", 9, 1)], "b", 5.5, "head");
    expect(spans(out)).toEqual([[0, 4, 0], [4, 6.5, 21.5], [7.5, 8.5, 0]]);
  });

  it("trims a tail and pulls later clips left", () => {
    const out = rippleTrim([c("a", 0, 4), c("b", 4, 4, 20), c("d", 9, 1)], "b", 5, "tail");
    expect(spans(out)).toEqual([[0, 4, 0], [4, 5, 20], [6, 7, 0]]);
  });

  it("keeps fades within the shorter clip and ignores a playhead outside it", () => {
    const fading = { ...c("a", 0, 4), fadeIn: 1, fadeOut: 2 };
    const out = rippleTrim([fading], "a", 1.5, "tail");
    expect(out[0]).toMatchObject({ fadeIn: 1, fadeOut: 0.5 });
    const same = [c("a", 0, 4)];
    expect(rippleTrim(same, "a", 6, "tail")).toBe(same);
  });
});

describe("closeAllGaps", () => {
  it("packs clips behind the first one", () => {
    expect(spans(closeAllGaps([c("b", 6, 2), c("a", 1, 2), c("d", 20, 1)]))).toEqual([[1, 3, 0], [3, 5, 0], [5, 6, 0]]);
  });
});

describe("videoEnd", () => {
  const track = (kind: "video" | "audio", clips: Clip[], hidden = false) => ({ id: kind, kind, name: kind, hidden, locked: false, muted: false, solo: false, volume: 1, clips });

  it("is the end of the last clip on a visible video track", () => {
    expect(videoEnd([track("video", [c("v", 0, 8.2), c("w", 9, 1)]), track("audio", [c("m", 0, 30)])])).toBeCloseTo(10);
    expect(videoEnd([track("video", [c("v", 0, 8.2), c("w", 9, 1)])], new Set(["w"]))).toBeCloseTo(8.2);
    expect(videoEnd([track("video", [c("v", 0, 5)], true), track("audio", [c("m", 0, 30)])])).toBe(0);
  });
});

describe("cutToBeats", () => {
  // A beat every half second (120 BPM) from 0.25s.
  const beats = Array.from({ length: 40 }, (_, i) => 0.25 + i * 0.5);
  const unlimited = () => Infinity;

  it("trims each clip back to its last whole beat and closes the gaps", () => {
    const out = cutToBeats([c("a", 0, 1.9), c("b", 3, 1.2, 5), c("c", 6, 2.2, 10)], beats, unlimited);
    expect(spans(out)).toEqual([
      [0, 1.75, 0], // ends on the beat at 1.75
      [1.75, 2.75, 5], // 1.2s → the beat at 2.75
      [2.75, 4.75, 10], // 2.2s → 4.75
    ]);
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("grows a clip shorter than a beat to the next one when its source has room", () => {
    const out = cutToBeats([c("a", 0.25, 0.3), c("b", 2, 0.2, 99.7)], beats, (x) => (media.duration - x.in) / 1);
    // a: 0.25 + 0.3 = 0.55 is before the next beat (0.75) → grows to it.
    // b: starts at 0.75, the next beat is 1.25 but its source ends 0.3s on → keeps 0.2s.
    expect(spans(out)).toEqual([
      [0.25, 0.75, 0],
      [0.75, 0.95, 99.7],
    ]);
  });

  it("gives every clip exactly N beats when asked", () => {
    const out = cutToBeats([c("a", 0, 5), c("b", 5, 0.4, 20), c("c", 9, 3, 40)], beats, unlimited, 2);
    expect(spans(out)).toEqual([
      [0, 0.75, 0], // the 2nd beat after 0 is 0.75
      [0.75, 1.75, 20],
      [1.75, 2.75, 40],
    ]);
  });

  it("keeps clip timing when there are no beats ahead", () => {
    const out = cutToBeats([c("a", 50, 2)], beats, unlimited);
    expect(spans(out)).toEqual([[50, 52, 0]]);
  });

  it("respects speed: a 2x clip needs twice the source", () => {
    const fast = { ...c("a", 0, 4), speed: 2 }; // 2s on the timeline
    const [out] = cutToBeats([fast], beats, unlimited);
    expect(+clipEnd(out).toFixed(6)).toBe(1.75);
    expect(+out.out.toFixed(6)).toBe(3.5);
  });
});

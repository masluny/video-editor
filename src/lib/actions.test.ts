import { beforeEach, describe, expect, it, vi } from "vitest";

const detectScenes = vi.fn<(path: string, from: number, to: number, threshold: number) => Promise<number[]>>();
const pictureStats = vi.fn<(path: string, from: number, to: number) => Promise<PictureStats>>();
const cleanVoice = vi.fn<(path: string, from: number, to: number) => Promise<string>>();
const probe = vi.fn<(paths: string[]) => Promise<{ path: string; info?: Omit<MediaAsset, "id"> | null; error?: string | null }[]>>();
vi.mock("./backend", async (orig) => {
  const real = await orig<typeof import("./backend")>();
  return {
    ...real,
    backend: {
      ...real.backend,
      detectScenes: (...a: [string, number, number, number]) => detectScenes(...a),
      pictureStats: (...a: [string, number, number]) => pictureStats(...a),
      cleanVoice: (...a: [string, number, number]) => cleanVoice(...a),
      probe: (paths: string[]) => probe(paths),
    },
  };
});

import { useStore } from "../store/store";
import { clipEnd } from "./timeline";
import { autoColorClips, cleanUpVoice, cutToBeat, matchColorTo, splitAtShotChanges, SHOT_THRESHOLD } from "./actions";
import type { PictureStats } from "./autocolor";
import type { MediaAsset } from "./types";

const video: MediaAsset = {
  id: "v", path: "/clip.mov", name: "clip.mov", kind: "video", duration: 20, width: 1920, height: 1080, fps: 25, hasVideo: true, hasAudio: true,
};
const st = () => useStore.getState();
const clips = () => st().project.tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips);

beforeEach(() => {
  detectScenes.mockReset();
  st().newProject();
  st().addMedia([video]);
});

describe("split at shot changes", () => {
  it("cuts at the detected changes, mapped through the clip's trim and speed, in one undo step", async () => {
    const id = st().placeMedia("v", { at: 2, range: { in: 4, out: 16 } })!;
    st().updateClip(id, (c) => void (c.speed = 2));
    // Source 6s and 10s are 1s and 3s into the 2x clip; 17s lies outside its source range.
    detectScenes.mockResolvedValue([6, 10, 17]);
    await splitAtShotChanges(id);
    expect(detectScenes).toHaveBeenCalledWith("/clip.mov", 4, 16, SHOT_THRESHOLD.normal);
    expect(clips().map((c) => [c.start, +clipEnd(c).toFixed(6), c.in])).toEqual([
      [2, 3, 4],
      [3, 5, 6],
      [5, 8, 10],
    ]);
    expect(st().toasts[st().toasts.length - 1].message).toMatch(/3 shots/);
    st().undo();
    expect(clips()).toHaveLength(1);
  });

  it("offers a more sensitive pass when nothing is found", async () => {
    const id = st().placeMedia("v", { at: 0 })!;
    detectScenes.mockResolvedValue([]);
    await splitAtShotChanges(id);
    const t = st().toasts[st().toasts.length - 1];
    expect(t.action?.label).toBe("Look harder");
    detectScenes.mockResolvedValue([5]);
    t.action!.run();
    await vi.waitFor(() => expect(clips()).toHaveLength(2));
    expect(detectScenes).toHaveBeenLastCalledWith("/clip.mov", 0, 20, SHOT_THRESHOLD.more);
  });

  it("reports a failure without touching the clip", async () => {
    const id = st().placeMedia("v", { at: 0 })!;
    detectScenes.mockRejectedValue(new Error("ffmpeg went away"));
    await splitAtShotChanges(id);
    expect(clips()).toHaveLength(1);
    expect(st().toasts.some((t) => t.kind === "error" && /ffmpeg went away/.test(t.message))).toBe(true);
  });
});

describe("cut to the beat", () => {
  it("explains what's missing when there are no markers and no music", async () => {
    const id = st().placeMedia("v", { at: 0 })!;
    await cutToBeat([id]);
    expect(clips()[0].out).toBe(20);
    expect(st().toasts[st().toasts.length - 1].message).toMatch(/needs beat markers/);
  });

  it("re-cuts with Undo in the toast", async () => {
    const id = st().placeMedia("v", { at: 0 })!;
    st().addMarkers([4.5, 9]);
    await cutToBeat([id]);
    expect(+clipEnd(clips()[0]).toFixed(6)).toBe(9);
    const t = st().toasts[st().toasts.length - 1];
    t.action!.run();
    expect(clipEnd(clips()[0])).toBe(20);
  });
});

describe("auto and matched colour", () => {
  const dull: PictureStats = { low: 0.42, high: 0.84, avg: 0.63, sat: 0.38 };
  const good: PictureStats = { low: 0.11, high: 0.89, avg: 0.5, sat: 0.86 };

  it("corrects each clip from its own picture, in one undo step", async () => {
    const a = st().placeMedia("v", { at: 0, range: { in: 2, out: 6 } })!;
    pictureStats.mockResolvedValue(dull);
    await autoColorClips([a]);
    expect(pictureStats).toHaveBeenCalledWith("/clip.mov", 2, 6);
    const c = clips()[0].color;
    expect(c.contrast).toBeGreaterThan(2);
    st().undo();
    expect(clips()[0].color.contrast).toBe(1);
  });

  it("matches clips to a reference as it's shown, look included", async () => {
    const a = st().placeMedia("v", { at: 0, range: { in: 0, out: 2 } })!;
    const ref = st().placeMedia("v", { at: 2, range: { in: 10, out: 12 } })!;
    st().updateClip(ref, (c) => void (c.color.sepia = 0.3));
    pictureStats.mockImplementation(async (_p, from) => (from === 10 ? good : dull));
    await matchColorTo([a, ref], ref);
    const [ca, cr] = clips().map((c) => c.color);
    expect(ca.sepia).toBe(0.3);
    expect(ca.contrast).toBeGreaterThan(1.5);
    expect(cr.contrast).toBe(1); // the reference itself is untouched
  });
});

describe("clean up voice", () => {
  it("cleans the detached audio of a video, and the result plays from the copy", async () => {
    const v = st().placeMedia("v", { at: 0, range: { in: 3, out: 7 } })!;
    st().detachAudio(v);
    cleanVoice.mockResolvedValue("/data/processed/abc.m4a");
    probe.mockResolvedValue([{ path: "/data/processed/abc.m4a", info: { path: "/data/processed/abc.m4a", name: "abc.m4a", kind: "audio", duration: 4, width: 0, height: 0, fps: 0, hasVideo: false, hasAudio: true } }]);
    await cleanUpVoice(v);
    expect(cleanVoice).toHaveBeenCalledWith("/clip.mov", 3, 7);
    const audio = st().project.tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips);
    expect(audio).toHaveLength(1); // the detached clip was re-pointed, not duplicated
    const m = st().project.media.find((x) => x.id === audio[0].mediaId)!;
    expect(m.name).toBe("clip (clean voice)");
    expect(audio[0]).toMatchObject({ in: 0, out: 4, link: v });
  });
});

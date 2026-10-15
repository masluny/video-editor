import { beforeEach, describe, expect, it, vi } from "vitest";

const detectScenes = vi.fn<(path: string, from: number, to: number, threshold: number) => Promise<number[]>>();
vi.mock("./backend", async (orig) => {
  const real = await orig<typeof import("./backend")>();
  return { ...real, backend: { ...real.backend, detectScenes: (...a: [string, number, number, number]) => detectScenes(...a) } };
});

import { useStore } from "../store/store";
import { clipEnd } from "./timeline";
import { splitAtShotChanges, SHOT_THRESHOLD } from "./actions";
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

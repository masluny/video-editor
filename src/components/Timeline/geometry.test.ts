import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../../store/store";
import { videoEnd } from "../../lib/timeline";
import type { MediaAsset } from "../../lib/types";
import { snap } from "./geometry";

const video: MediaAsset = {
  id: "v", path: "/v.mp4", name: "v.mp4", kind: "video", duration: 8.195729, width: 1280, height: 720, fps: 23.759, hasVideo: true, hasAudio: true,
};
const song: MediaAsset = {
  id: "s", path: "/s.mp3", name: "s.mp3", kind: "audio", duration: 30, width: 0, height: 0, fps: 0, hasVideo: false, hasAudio: true,
};

const st = () => useStore.getState();

beforeEach(() => {
  st().newProject();
  st().addMedia([video, song]);
  st().placeMedia("v", { at: 0 });
  st().placeMedia("s", { at: 0 });
  st().setZoom(60); // 8 px of plain snapping = 0.13 s
  st().seek(20);
  if (!st().snapping) st().toggleSnapping();
});

describe("magnetic snapping", () => {
  it("pulls a music edge onto the exact end of the video from further away", () => {
    const end = videoEnd(st().project.tracks);
    const songId = st().project.tracks.find((t) => t.kind === "audio")!.clips[0].id;
    const exclude = new Set([songId]);
    // 0.3 s off: too far for ordinary snapping, close enough for the magnet.
    expect(snap(end + 0.3, exclude).guide).toBeNull();
    expect(snap(end + 0.3, exclude, { magnet: end })).toEqual({ time: end, guide: end });
    expect(snap(end - 0.3, exclude, { magnet: end }).time).toBe(end);
    expect(snap(end + 0.6, exclude, { magnet: end }).guide).toBeNull();
  });

  it("lets a closer ordinary target win, and respects snapping being off", () => {
    const end = videoEnd(st().project.tracks);
    st().addMarker(end + 0.25);
    const marker = st().project.markers[0].time;
    expect(snap(end + 0.27, new Set(), { magnet: end }).time).toBe(marker);
    st().toggleSnapping();
    expect(snap(end + 0.1, new Set(), { magnet: end }).guide).toBeNull();
  });
});

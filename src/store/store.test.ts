import { beforeEach, describe, expect, it } from "vitest";
import { useStore, findClip } from "./store";
import type { MediaAsset } from "../lib/types";
import { clipEnd } from "../lib/timeline";
import { migrateProject } from "../lib/migrate";

const video: MediaAsset = {
  id: "v", path: "/clip.mov", name: "clip.mov", kind: "video", duration: 10, width: 1080, height: 1920, fps: 30, hasVideo: true, hasAudio: true,
};
const song: MediaAsset = {
  id: "s", path: "/song.mp3", name: "song.mp3", kind: "audio", duration: 30, width: 0, height: 0, fps: 0, hasVideo: false, hasAudio: true,
};

const st = () => useStore.getState();
const clipsOf = (kind: "video" | "audio") => st().project.tracks.filter((t) => t.kind === kind).flatMap((t) => t.clips);

beforeEach(() => {
  st().newProject();
  st().addMedia([video, song]);
});

describe("placing media", () => {
  it("routes by media kind and adopts the first footage's format", () => {
    st().placeMedia("v", { at: 0 });
    st().placeMedia("s", { at: 0 });
    expect(clipsOf("video")).toHaveLength(1);
    expect(clipsOf("audio")).toHaveLength(1);
    expect(st().project.settings).toMatchObject({ width: 1080, height: 1920, fps: 30 });
  });

  it("puts titles above footage", () => {
    st().placeMedia("v", { at: 0 });
    st().updateTrack(st().project.tracks[1].id, {}); // no-op
    st().placeTitle({ text: "Hi" }, { at: 1 });
    const videos = st().project.tracks.filter((t) => t.kind === "video");
    const titleTrack = videos.findIndex((t) => t.clips.some((c) => c.type === "title"));
    const footageTrack = videos.findIndex((t) => t.clips.some((c) => c.type === "media"));
    expect(titleTrack).toBeGreaterThan(footageTrack);
  });
});

describe("history", () => {
  it("undoes and redoes edits", () => {
    st().placeMedia("v", { at: 0 });
    expect(clipsOf("video")).toHaveLength(1);
    st().undo();
    expect(clipsOf("video")).toHaveLength(0);
    st().redo();
    expect(clipsOf("video")).toHaveLength(1);
  });

  it("collapses a live drag into one undo step", () => {
    const id = st().placeMedia("v", { at: 0 })!;
    const before = st().past.length;
    for (let i = 1; i <= 20; i++) st().updateClip(id, (c) => void (c.start = i * 0.1), { live: true });
    st().settleClips([id]);
    expect(st().past.length).toBe(before + 1);
    expect(findClip(st().project, id)!.clip.start).toBeCloseTo(2);
    st().undo();
    expect(findClip(st().project, id)!.clip.start).toBe(0);
  });

  it("drops selection of clips that no longer exist after undo", () => {
    const id = st().placeMedia("v", { at: 0 })!;
    st().select([id]);
    st().undo();
    expect(st().selection).toEqual([]);
  });
});

describe("editing", () => {
  it("splits selected clips at the playhead", () => {
    const id = st().placeMedia("v", { at: 0 })!;
    st().select([id]);
    st().seek(4);
    st().splitAtPlayhead();
    const clips = clipsOf("video");
    expect(clips.map((c) => [c.start, clipEnd(c)])).toEqual([[0, 4], [4, 10]]);
    expect(st().selection).toHaveLength(1);
  });

  it("detaches audio onto an audio track and mutes the original", () => {
    const id = st().placeMedia("v", { at: 2 })!;
    st().detachAudio(id);
    const a = clipsOf("audio")[0];
    expect(a.mediaId).toBe("v");
    expect(a.start).toBe(2);
    expect(findClip(st().project, id)!.clip.muted).toBe(true);
  });

  it("copies and pastes at the playhead", () => {
    const id = st().placeMedia("v", { at: 0 })!;
    st().select([id]);
    st().copy();
    st().seek(10);
    st().paste();
    expect(clipsOf("video").map((c) => c.start)).toEqual([0, 10]);
  });

  it("removes silences and ripples later clips", () => {
    const a = st().placeMedia("v", { at: 0 })!;
    st().placeMedia("v", { at: 10 });
    const removed = st().replaceWithRanges(a, [[0, 3], [5, 10]]);
    expect(removed).toBeCloseTo(2);
    expect(clipsOf("video").map((c) => [c.start, +clipEnd(c).toFixed(6)])).toEqual([[0, 3], [3, 8], [8, 18]]);
  });

  it("ripple-deletes", () => {
    const a = st().placeMedia("v", { at: 0 })!;
    st().placeMedia("v", { at: 10 });
    st().deleteClips([a], true);
    expect(clipsOf("video").map((c) => c.start)).toEqual([0]);
  });
});

describe("migration", () => {
  it("loads v1 projects", () => {
    const v1 = {
      id: "p", version: 1, name: "Old", fps: 25, width: 1280, height: 720, sample_rate: 48000,
      media: [{ id: "m1", path: "/a.mp4", name: "a.mp4", durationSec: 8, width: 1280, height: 720, fps: 25, hasVideo: true, hasAudio: true }],
      tracks: [
        { id: "t1", kind: "video", name: "V1", locked: false, muted: false, solo: false, volume: 1, clips: [
          { id: "c1", media_id: "m1", source_in: 1, source_out: 5, timeline_start: 2, speed: 1, volume: 1, muted: false, opacity: 1,
            transform: { x: 0, y: 0, scale: 1, rotation: 0 }, color: { brightness: 0.2, contrast: 1, saturation: 1, gamma: 1, hue: 0, blur: 0 },
            text: { text: "Hello", x: 30, y: 40, font_size: 48, color: "#ffffff", font_family: "sans-serif", bold: true, italic: false }, keyframes: [] },
        ] },
        { id: "t2", kind: "audio", name: "A1", locked: false, muted: false, solo: false, volume: 1, clips: [] },
      ],
    };
    const p = migrateProject(v1);
    expect(p.version).toBe(2);
    expect(p.settings).toMatchObject({ width: 1280, height: 720, fps: 25 });
    const v = p.tracks.filter((t) => t.kind === "video");
    expect(v[0].clips[0]).toMatchObject({ mediaId: "m1", in: 1, out: 5, start: 2 });
    expect(v[0].clips[0].color.brightness).toBeCloseTo(1.2);
    expect(v[1].clips[0]).toMatchObject({ type: "title", start: 2 });
    expect(v[1].clips[0].title!.text).toBe("Hello");
  });

  it("rejects non-projects and drops clips with unknown media", () => {
    expect(() => migrateProject({ foo: 1 })).toThrow();
    const p = migrateProject({ version: 2, settings: {}, media: [], tracks: [{ kind: "video", clips: [{ type: "media", mediaId: "nope", in: 0, out: 1 }] }] });
    expect(p.tracks[0].clips).toHaveLength(0);
    expect(p.tracks.some((t) => t.kind === "audio")).toBe(true);
  });
});

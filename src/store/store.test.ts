import { beforeEach, describe, expect, it } from "vitest";
import { useStore, findClip } from "./store";
import type { MediaAsset } from "../lib/types";
import { clipEnd, snapToFrame } from "../lib/timeline";
import { migrateProject } from "../lib/migrate";

const video: MediaAsset = {
  id: "v", path: "/clip.mov", name: "clip.mov", kind: "video", duration: 10, width: 1080, height: 1920, fps: 30, hasVideo: true, hasAudio: true,
};
// The clip from the stutter report: its end isn't on the 23.759 fps frame grid.
const shot: MediaAsset = {
  id: "o", path: "/shot.mp4", name: "shot.mp4", kind: "video", duration: 8.195729, width: 1280, height: 720, fps: 23.759, hasVideo: true, hasAudio: true,
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

  it("butts a clip against the edit at the playhead instead of rounding past it", () => {
    st().addMedia([shot]);
    const first = st().placeMedia("o", { at: 0 })!;
    const end = clipEnd(findClip(st().project, first)!.clip);
    const fps = st().project.settings.fps;
    expect(fps).toBe(23.759);
    // Exactly at the edit (End key, playback ended) and a sub-frame past it (frame stepping).
    for (const playhead of [end, snapToFrame(end, fps)]) {
      st().seek(playhead);
      const id = st().placeMedia("o")!;
      expect(findClip(st().project, id)!.clip.start).toBe(end);
      st().undo();
    }
    // Away from edits it still lands on a frame.
    st().seek(3.01);
    const mid = st().placeMedia("o", { mode: "insert" })!;
    expect(findClip(st().project, mid)!.clip.start).toBe(snapToFrame(3.01, fps));
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

describe("music and the video's length", () => {
  const audioClips = () => clipsOf("audio");

  it("offers to trim a song that outlasts the video, and trims it to end with the picture", () => {
    st().placeMedia("v", { at: 0 }); // 10 s of video
    st().placeMedia("s", { at: 0 }); // 30 s song
    const toast = st().toasts[st().toasts.length - 1];
    expect(toast.message).toMatch(/runs 20.00s past the end of the video/);
    toast.action!.run();
    expect(audioClips().map((c) => [c.start, clipEnd(c)])).toEqual([[0, 10]]);
  });

  it("matches the video's length with an optional fade-out, leaving shorter clips alone", () => {
    st().placeMedia("v", { at: 0 });
    st().placeMedia("v", { at: 10, range: { in: 0, out: 2.5 } }); // video now ends at 12.5
    const song = st().placeMedia("s", { at: 1 })!;
    expect(st().matchVideoLength([song], 1.5)).toBe(1);
    const c = findClip(st().project, song)!.clip;
    expect(clipEnd(c)).toBeCloseTo(12.5, 9);
    expect(c.fadeOut).toBe(1.5);
    // Already matching: nothing left to do (but a fade can still be added).
    expect(st().matchVideoLength([song])).toBe(0);
    // Video clips are never touched.
    const v = clipsOf("video")[0].id;
    expect(st().matchVideoLength([v])).toBe(0);
  });

  it("loops a short song until the video ends, fading out only at the very end", () => {
    st().placeMedia("v", { at: 0 });
    const song = st().placeMedia("s", { at: 0, range: { in: 5, out: 9 } })!; // 4 s
    st().updateClip(song, (c) => void (c.fadeOut = 1));
    expect(st().loopToVideoLength(song)).toBe(2);
    expect(audioClips().map((c) => [c.start, +clipEnd(c).toFixed(6), c.in, c.fadeOut])).toEqual([
      [0, 4, 5, 0],
      [4, 8, 5, 0],
      [8, 10, 5, 1],
    ]);
    st().undo();
    expect(audioClips()).toHaveLength(1);
  });
});

describe("library", () => {
  it("removes only the media no clip uses, in one undo step", () => {
    st().placeMedia("v", { at: 0 });
    expect(st().removeUnusedMedia()).toBe(1); // the song
    expect(st().project.media.map((m) => m.id)).toEqual(["v"]);
    expect(st().removeUnusedMedia()).toBe(0);
    st().undo();
    expect(st().project.media).toHaveLength(2);
  });
});

describe("reframing", () => {
  it("sets how picture clips fit, skipping titles, sound and locked tracks", () => {
    const a = st().placeMedia("v", { at: 0 })!;
    const b = st().placeMedia("v", { at: 10 })!;
    st().placeTitle({ text: "Hi" }, { at: 0 });
    st().placeMedia("s", { at: 0 });
    expect(st().fitClips("cover", [a])).toBe(1);
    expect(st().fitClips("cover")).toBe(1); // only b was left
    expect([a, b].map((id) => findClip(st().project, id)!.clip.transform.fit)).toEqual(["cover", "cover"]);
    const title = st().project.tracks.flatMap((t) => t.clips).find((c) => c.type === "title")!;
    expect(title.transform.fit).toBe("contain");
  });

  it("fills the bars with a blur (back to Fit) and takes it away again", () => {
    const a = st().placeMedia("v", { at: 0 })!;
    st().fitClips("cover");
    expect(st().setBackdrop("blur")).toBe(1);
    expect(findClip(st().project, a)!.clip).toMatchObject({ backdrop: "blur", transform: { fit: "contain" } });
    expect(st().setBackdrop("blur")).toBe(0);
    expect(st().setBackdrop(undefined, [a])).toBe(1);
    expect("backdrop" in findClip(st().project, a)!.clip).toBe(false);
  });
});

describe("markers", () => {
  it("adds a batch in one undo step, skipping duplicates, and clears them all", () => {
    st().addMarker(1);
    const before = st().past.length;
    expect(st().addMarkers([0.5, 1, 1.0004, 2, -1])).toBe(2);
    expect(st().project.markers.map((m) => m.time)).toEqual([0.5, 1, 2]);
    expect(st().past.length).toBe(before + 1);
    expect(st().addMarkers([2])).toBe(0);
    st().clearMarkers();
    expect(st().project.markers).toEqual([]);
    st().undo();
    expect(st().project.markers).toHaveLength(3);
  });
});

describe("captions", () => {
  it("puts cues on a new captions track on top, styled as subtitles, in one undo step", () => {
    st().placeMedia("v", { at: 0 }); // 1080×1920 project
    st().placeMedia("v", { at: 0 });
    const before = st().past.length;
    const n = st().addCaptions([
      { start: 1, end: 3, text: "Hello" },
      { start: 2.5, end: 4, text: "Overlaps the first" },
      { start: 5, end: 5.01, text: "too short" },
    ], 0.5);
    expect(n).toBe(2);
    expect(st().past.length).toBe(before + 1);
    const videos = st().project.tracks.filter((t) => t.kind === "video");
    const captions = videos[videos.length - 1];
    expect(captions.name).toBe("Captions");
    expect(captions.clips.map((c) => [c.start, +clipEnd(c).toFixed(6), c.title!.text, c.fadeIn])).toEqual([
      [1.5, 3, "Hello", 0],
      [3, 4.5, "Overlaps the first", 0],
    ]);
    // The 1080p subtitle preset, scaled to the 1080-wide frame, sits at the bottom.
    expect(captions.clips[0].title).toMatchObject({ fontSize: 56, y: 88, box: true });
  });
});

describe("ducking", () => {
  it("lowers music under the sound of the other tracks, once their waveforms are known", () => {
    st().placeMedia("v", { at: 0, range: { in: 0, out: 6 } }); // talking head on V1
    const song = st().placeMedia("s", { at: 0, range: { in: 10, out: 20 } })!; // music from source 10s
    expect(st().duckUnderVoice([song])).toBe(-1); // waveform of the talk not read yet
    const peaks = new Array(1000).fill(3);
    for (let i = 200; i < 400; i++) peaks[i] = 180; // the talk speaks from 2s to 4s
    st().setRuntime("v", { waveform: { rate: 100, peaks } });
    expect(st().duckUnderVoice([song])).toBe(1);
    const pts = findClip(st().project, song)!.clip.volumePoints!;
    // Timeline 2s..4s is source 12s..14s of the song.
    expect(pts.map((p) => [+p.t.toFixed(2), p.gain])).toEqual([[11.7, 1], [12, 0.25], [14, 0.25], [14.6, 1]]);
    st().clearVolumeChanges([song]);
    expect(findClip(st().project, song)!.clip.volumePoints).toBeUndefined();
  });
});

describe("pro edits", () => {
  it("ripple-trims the clip under the playhead (Q / W)", () => {
    const a = st().placeMedia("v", { at: 0 })!;
    st().placeMedia("v", { at: 10 });
    st().select([]);
    st().seek(4);
    st().rippleTrimToPlayhead("head");
    expect(clipsOf("video").map((c) => [c.start, clipEnd(c), c.in])).toEqual([[0, 6, 4], [6, 16, 0]]);
    expect(st().playhead).toBe(0);
    st().seek(2);
    st().select([a]);
    st().rippleTrimToPlayhead("tail");
    expect(clipsOf("video").map((c) => [c.start, clipEnd(c), c.in])).toEqual([[0, 2, 4], [2, 12, 0]]);
  });

  it("extracts the In–Out range from every track and moves markers with it", () => {
    st().placeMedia("v", { at: 0 });
    st().placeMedia("s", { at: 0, range: { in: 0, out: 12 } });
    st().addMarker(1);
    st().addMarker(3);
    st().addMarker(8);
    st().setRange({ in: 2, out: 5 });
    st().extractRange();
    expect(clipsOf("video").map((c) => [c.start, +clipEnd(c).toFixed(6)])).toEqual([[0, 2], [2, 7]]);
    expect(clipsOf("audio").map((c) => [c.start, +clipEnd(c).toFixed(6)])).toEqual([[0, 2], [2, 9]]);
    expect(st().project.markers.map((m) => m.time)).toEqual([1, 5]);
    expect(st().range).toBeNull();
    expect(st().playhead).toBe(2);
  });

  it("lifts the range, leaving a gap, in one undo step", () => {
    st().placeMedia("v", { at: 0 });
    const before = st().past.length;
    st().setRange({ in: 2, out: 5 });
    st().liftRange();
    expect(clipsOf("video").map((c) => [c.start, +clipEnd(c).toFixed(6)])).toEqual([[0, 2], [5, 10]]);
    expect(st().past.length).toBe(before + 1);
  });

  it("nudges clips by frames, never before zero", () => {
    const id = st().placeMedia("v", { at: 1 })!;
    st().nudgeClips([id], 3);
    expect(findClip(st().project, id)!.clip.start).toBeCloseTo(1.1, 9);
    st().nudgeClips([id], -100);
    expect(findClip(st().project, id)!.clip.start).toBe(0);
  });

  it("adds dissolves at the nearest cut on every track, and turns one into a dip to black", () => {
    st().placeMedia("v", { at: 0, range: { in: 0, out: 4 } });
    st().placeMedia("v", { at: 4, range: { in: 5, out: 9 } });
    st().detachAudio(clipsOf("video")[0].id);
    st().detachAudio(clipsOf("video")[1].id);
    st().seek(4.6);
    expect(st().dissolveAtPlayhead()).toBe(2); // the video cut and the detached audio cut
    expect(clipsOf("video")[1].transitionIn).toBe(1);
    expect(clipsOf("audio")[1].transitionIn).toBe(1);
    expect(st().dissolveAtPlayhead()).toBe(0); // already there
    st().seek(8);
    expect(st().dissolveAtPlayhead()).toBe(0);

    const b = clipsOf("video")[1].id;
    st().dipToBlack(b, 1);
    const [va, vb] = clipsOf("video");
    expect([va.fadeOut, vb.fadeIn, vb.transitionIn]).toEqual([0.5, 0.5, undefined]);
    st().setDissolve(b, 0.75);
    expect(clipsOf("video")[1].transitionIn).toBe(0.75);
    st().setDissolve(b, 0);
    expect("transitionIn" in clipsOf("video")[1]).toBe(false);
  });

  it("closes every gap on a track", () => {
    st().placeMedia("v", { at: 0, range: { in: 0, out: 2 } });
    st().placeMedia("v", { at: 5, range: { in: 0, out: 2 } });
    st().placeMedia("v", { at: 9, range: { in: 0, out: 1 } });
    const track = st().project.tracks.find((t) => t.clips.length)!;
    st().closeTrackGaps(track.id);
    expect(clipsOf("video").map((c) => [c.start, clipEnd(c)])).toEqual([[0, 2], [2, 4], [4, 5]]);
    const steps = st().past.length;
    st().closeTrackGaps(track.id); // nothing left to close: no empty undo step
    expect(st().past.length).toBe(steps);
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

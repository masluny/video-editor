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

  it("keeps a frame size picked before any footage, adopting only the frame rate", () => {
    st().pickFormat({ width: 1080, height: 1920, label: "9:16" } as { width: number; height: number });
    expect(Object.keys(st().project.settings)).not.toContain("label");
    st().placeMedia("v", { at: 0 }); // 1080×1920 footage: same shape, no bars
    expect(st().project.settings).toMatchObject({ width: 1080, height: 1920, fps: 30 });
    st().newProject();
    st().addMedia([video, { ...video, id: "w", path: "/wide.mov", width: 1920, height: 1080, fps: 25 }]);
    st().pickFormat({ width: 1080, height: 1920 });
    expect(st().formatChosen).toBe(true);
    st().placeMedia("w", { at: 0 });
    expect(st().project.settings).toMatchObject({ width: 1080, height: 1920, fps: 25 });
    const last = st().toasts[st().toasts.length - 1];
    expect(last.message).toMatch(/different shape/);
    last.action!.run(); // Fill frame
    expect(clipsOf("video")[0].transform.fit).toBe("cover");
    // A new project goes back to matching the first clip.
    st().newProject();
    st().addMedia([{ ...video, id: "w", path: "/wide.mov", width: 1920, height: 1080, fps: 25 }]);
    st().placeMedia("w", { at: 0 });
    expect(st().project.settings).toMatchObject({ width: 1920, height: 1080 });
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

describe("even out volume", () => {
  it("brings clips to their median loudness from the waveforms", () => {
    const quiet = st().placeMedia("v", { at: 0, range: { in: 0, out: 3 } })!;
    const loud = st().placeMedia("v", { at: 3, range: { in: 5, out: 8 } })!;
    const mid = st().placeMedia("s", { at: 0, range: { in: 0, out: 3 } })!;
    expect(st().evenOutVolume([quiet, loud, mid])).toBe(-1);
    // Talk at 0.1 for the first 5 s of the video, 0.4 after; the song plays at 0.2.
    st().setRuntime("v", { waveform: { rate: 100, peaks: Array.from({ length: 1000 }, (_, i) => (i < 500 ? 26 : 102)) } });
    st().setRuntime("s", { waveform: { rate: 100, peaks: new Array(3000).fill(51) } });
    expect(st().evenOutVolume([quiet, loud, mid])).toBe(2);
    const vol = (id: string) => findClip(st().project, id)!.clip.volume;
    expect([vol(quiet), vol(loud), vol(mid)]).toEqual([1.96, 0.5, 1]);
  });
});

describe("freeze frame", () => {
  it("holds the frame under the playhead and pushes the rest of the track along", () => {
    const a = st().placeMedia("v", { at: 0 })!; // 10s, 30 fps project
    st().updateClip(a, (c) => void (c.speed = 2)); // 5s long at 2x
    st().placeMedia("v", { at: 5, range: { in: 0, out: 1 } });
    st().placeMedia("s", { at: 0 }); // music on another track stays put
    st().select([]);
    st().seek(2);
    const hold = st().freezeFrame(1.5)!;
    const clips = clipsOf("video").map((c) => [c.start, +clipEnd(c).toFixed(6), c.in, !!c.freeze]);
    expect(clips).toEqual([
      [0, 2, 0, false],
      [2, 3.5, 4, true], // source 4s = 2s into a 2x clip
      [3.5, 6.5, 4, false],
      [6.5, 7.5, 0, false],
    ]);
    expect(findClip(st().project, hold)!.clip).toMatchObject({ muted: true, speed: 1, fadeIn: 0 });
    expect(st().selection).toEqual([hold]);
    expect(clipsOf("audio")[0].start).toBe(0);
    st().seek(100);
    expect(st().freezeFrame()).toBeNull();
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

describe("cut to the beat", () => {
  it("re-cuts the run between the first and last selected clip and ripples the rest", () => {
    const a = st().placeMedia("v", { at: 0, range: { in: 0, out: 3 } })!;
    st().placeMedia("v", { at: 3, range: { in: 3, out: 5 } }); // between: joins the run
    const c = st().placeMedia("v", { at: 6, range: { in: 5, out: 8 } })!; // after a 1s gap
    st().placeMedia("v", { at: 10, range: { in: 0, out: 1 } }); // after the run: ripples
    st().placeMedia("s", { at: 0 });
    expect(st().cutToBeat([a, c])).toBe(-1); // no markers yet
    st().addMarkers([0.9, 1.8, 2.7, 3.6, 4.5, 5.4, 6.3, 7.2]);
    expect(st().cutToBeat([a, c])).toBe(3);
    expect(clipsOf("video").map((x) => [x.start, +clipEnd(x).toFixed(6), x.in])).toEqual([
      [0, 2.7, 0],
      [2.7, 4.5, 3],
      [4.5, 7.2, 5],
      [8.2, 9.2, 0], // was 1s after the run's end (9), still is
    ]);
    expect(clipsOf("audio")[0].start).toBe(0); // the music never moves
    st().undo();
    expect(clipsOf("video").map((x) => x.start)).toEqual([0, 3, 6, 10]);
  });

  it("gives every clip N beats, growing short ones from their source", () => {
    const a = st().placeMedia("v", { at: 0, range: { in: 0, out: 0.3 } })!;
    const b = st().placeMedia("v", { at: 0.3, range: { in: 2, out: 2.3 } })!;
    st().addMarkers([0.5, 1, 1.5, 2, 2.5]);
    st().cutToBeat([a, b], 2);
    expect(clipsOf("video").map((x) => [x.start, +clipEnd(x).toFixed(6)])).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });
});

describe("keyframes", () => {
  it("animates a property from the diamond and keys edits at the playhead", () => {
    const id = st().placeMedia("v", { at: 2, range: { in: 1, out: 9 } })!;
    const clip = () => findClip(st().project, id)!.clip;
    st().seek(3); // 1s in: clip clock 2
    st().toggleKeyframe(id, "position");
    expect(clip().keyframes).toEqual({ x: [{ t: 2, v: 0 }], y: [{ t: 2, v: 0 }] });
    st().seek(7); // 5s in: clip clock 6
    st().setPose(id, { x: 300, y: -100 });
    expect(clip().keyframes!.x).toEqual([{ t: 2, v: 0 }, { t: 6, v: 300 }]);
    // Unkeyed properties still set their static value.
    st().setPose(id, { scale: 2 });
    expect(clip().transform.scale).toBe(2);
    expect(clip().keyframes!.scale).toBeUndefined();
    // The diamond on an existing key removes it; on the last one, the value stays put.
    st().toggleKeyframe(id, "position");
    expect(clip().keyframes!.x).toEqual([{ t: 2, v: 0 }]);
    st().seek(3);
    st().toggleKeyframe(id, "position");
    expect(clip().keyframes).toBeUndefined();
    expect(clip().transform).toMatchObject({ x: 0, y: 0 });
  });

  it("adds a key with the current in-between value, and clears to the value at the playhead", () => {
    const id = st().placeMedia("v", { at: 0, range: { in: 0, out: 10 } })!;
    const clip = () => findClip(st().project, id)!.clip;
    st().toggleKeyframe(id, "opacity");
    st().seek(10);
    st().setPose(id, { opacity: 0 });
    st().seek(5);
    st().toggleKeyframe(id, "opacity"); // no key here yet: adds one at 50%
    expect(clip().keyframes!.opacity).toEqual([{ t: 0, v: 1 }, { t: 5, v: 0.5 }, { t: 10, v: 0 }]);
    st().seek(7.5);
    st().clearKeyframes(id, "opacity");
    expect(clip().keyframes).toBeUndefined();
    expect(clip().opacity).toBeCloseTo(0.25);
    st().undo();
    expect(clip().keyframes!.opacity).toHaveLength(3);
  });
});

describe("magnetic main track", () => {
  it("closes gaps when deleting on V1 only, unless turned off", () => {
    const ids = [0, 2, 4].map((at) => st().placeMedia("v", { at, range: { in: 0, out: 2 } })!);
    const over = st().placeTitle({ text: "Hi" }, { at: 0 })!;
    st().placeTitle({ text: "Later" }, { at: 6 });
    expect(st().rippleMain).toBe(true);
    st().deleteClips([ids[0], over], false);
    expect(clipsOf("video").filter((c) => c.type === "media").map((c) => c.start)).toEqual([0, 2]);
    expect(clipsOf("video").filter((c) => c.type === "title").map((c) => c.start)).toEqual([6]); // titles lift
    st().toggleRippleMain();
    st().deleteClips([ids[1]], false);
    expect(clipsOf("video").filter((c) => c.type === "media").map((c) => c.start)).toEqual([2]);
    st().toggleRippleMain();
  });

  it("reorders when a clip is dragged along V1, closes up when it leaves, overwrites with the magnet off", () => {
    const [a, b, c] = [0, 2, 4].map((at) => st().placeMedia("v", { at, range: { in: 0, out: 2 } })!);
    const v1 = st().project.tracks.find((t) => t.kind === "video")!.id;
    const v2 = st().project.tracks.filter((t) => t.kind === "video")[1].id;
    const order = () => st().project.tracks.find((t) => t.id === v1)!.clips.map((x) => [x.id, x.start]);
    // Without A, B is at 0-2 and C at 2-4: A's left edge at 1.5 is nearest the cut at 2.
    const from = st().project;
    st().dragLive(from, [{ id: a, trackId: v1, start: 3.2 }], true); // (nearest the end: after C)
    expect(order().map(([id]) => id)).toEqual([b, c, a]);
    st().dragLive(from, [{ id: a, trackId: v1, start: 1.5 }], true); // each move starts over from `from`
    st().settleClips([a]);
    expect(order()).toEqual([[b, 0], [a, 2], [c, 4]]);
    st().undo();
    expect(order()).toEqual([[a, 0], [b, 2], [c, 4]]);
    // Up to V2: V1 closes up.
    st().dragLive(st().project, [{ id: b, trackId: v2, start: 2 }], true);
    st().settleClips([b]);
    expect(order()).toEqual([[a, 0], [c, 2]]);
    st().undo();
    // Magnet off (⌘): A lands on B's place and overwrites most of it.
    st().dragLive(st().project, [{ id: a, trackId: v1, start: 1.5 }], false);
    st().settleClips([a]);
    expect(order().map(([, t]) => t)).toEqual([1.5, 3.5, 4]);
  });
});


describe("magnetic drops", () => {
  it("slots library media in at an edit point on V1", () => {
    st().placeMedia("v", { at: 0, range: { in: 0, out: 2 } });
    st().placeMedia("v", { at: 2, range: { in: 0, out: 2 } });
    st().placeMedia("v", { at: 2, mode: "magnetic", range: { in: 5, out: 6 } });
    expect(clipsOf("video").map((c) => [c.start, c.in])).toEqual([[0, 0], [2, 5], [3, 0]]);
  });
});

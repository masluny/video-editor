import { beforeEach, describe, expect, it } from "vitest";
import { commands, searchCommands } from "./commands";
import { useStore } from "../store/store";
import type { MediaAsset } from "./types";

const song: MediaAsset = { id: "s", path: "/s.mp3", name: "s.mp3", kind: "audio", duration: 30, width: 0, height: 0, fps: 0, hasVideo: false, hasAudio: true };
const video: MediaAsset = { id: "v", path: "/v.mp4", name: "v.mp4", kind: "video", duration: 10, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true };
const st = () => useStore.getState();

beforeEach(() => {
  st().newProject();
  st().addMedia([video, song]);
});

describe("command palette", () => {
  const ids = (q: string) => searchCommands(commands(), q).map((c) => c.id);

  it("finds actions by name, synonym and group, best matches first", () => {
    expect(ids("freeze")[0]).toBe("freeze");
    expect(ids("hold")).toContain("freeze");
    expect(ids("tiktok")).toContain("blur-all");
    expect(ids("music trim")).toEqual(["match-video"]);
    expect(ids("split")[0]).toBe("split");
    expect(ids("zzz")).toEqual([]);
    expect(ids("").length).toBe(commands().length);
  });

  it("says why an action can't run yet, and runs it once it can", () => {
    const duck = () => commands().find((c) => c.id === "duck")!;
    expect(duck().blocked!()).toMatch(/Select music/);
    st().placeMedia("v", { at: 0 });
    const songClip = st().placeMedia("s", { at: 0 })!;
    st().select([songClip]);
    expect(duck().blocked!()).toBe(false);
    const match = commands().find((c) => c.id === "match-video")!;
    expect(match.blocked!()).toBe(false);
    match.run();
    const audio = st().project.tracks.find((t) => t.kind === "audio")!.clips[0];
    expect(audio.out - audio.in).toBeCloseTo(10);
  });

  it("has unique ids", () => {
    const all = commands().map((c) => c.id);
    expect(new Set(all).size).toBe(all.length);
  });
});

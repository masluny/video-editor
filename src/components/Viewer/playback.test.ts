import { describe, expect, it } from "vitest";
import { mediaTime, Slot, Transport, type Voice } from "./playback";
import { mediaClip } from "../../lib/defaults";
import { clipEnd, EPS } from "../../lib/timeline";
import type { Clip, MediaAsset } from "../../lib/types";

const FRAME = 1000 / 60;

const media: MediaAsset = {
  id: "m", path: "/m.mp4", name: "m.mp4", kind: "video", duration: 60, width: 1280, height: 720, fps: 24, hasVideo: true, hasAudio: true,
};

function clip(start: number, len: number, inP = 0): Clip {
  return mediaClip(media, start, { in: inP, out: inP + len });
}

/**
 * Just enough of a media element, on a simulated clock: play() takes `startMs` to get
 * going, seeks take `seekMs`, and while playing currentTime is refreshed only every
 * `reportMs` (WebKit reports it late).
 */
class FakeMedia {
  preload = "";
  src = "";
  muted = false;
  readyState = 4;
  playbackRate = 1;
  duration = 60;
  paused = true;
  seeking = false;
  seeks = 0;
  pauses = 0;
  private pos = 0;
  private shown = 0;
  private clock = 0;
  private runsFrom = 0;
  private seekDone = 0;
  private reported = 0;
  private onSeeked: (() => void)[] = [];

  constructor(private opts: { startMs?: number; seekMs?: number; reportMs?: number } = {}) {}

  get ended() {
    return this.pos >= this.duration;
  }
  get currentTime() {
    return this.paused || this.seeking ? this.pos : this.shown;
  }
  set currentTime(t: number) {
    this.pos = this.shown = Math.max(0, Math.min(this.duration, t));
    this.seeking = true;
    this.seekDone = this.clock + (this.opts.seekMs ?? 100);
    this.seeks++;
  }
  play() {
    if (this.paused) {
      this.paused = false;
      this.runsFrom = this.clock + (this.opts.startMs ?? 250);
    }
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.pauses++;
  }
  addEventListener(type: string, fn: () => void) {
    if (type === "seeked") this.onSeeked.push(fn);
  }
  /** Move the playback position without a seek, the way drift does. */
  shift(by: number) {
    this.pos = this.shown = this.pos + by;
  }
  step(now: number) {
    if (this.seeking && now >= this.seekDone) {
      this.seeking = false;
      for (const fn of this.onSeeked) fn();
    }
    if (!this.paused && !this.seeking) {
      const from = Math.max(this.clock, this.runsFrom, this.seekDone);
      if (now > from) this.pos = Math.min(this.duration, this.pos + ((now - from) / 1000) * this.playbackRate);
      if (now - this.reported >= (this.opts.reportMs ?? 0)) {
        this.shown = this.pos;
        this.reported = now;
      }
      if (this.ended) this.paused = true;
    }
    this.clock = now;
  }
}

function voice(c: Clip, opts?: ConstructorParameters<typeof FakeMedia>[0], kind: "video" | "audio" = "video") {
  const el = new FakeMedia(opts);
  const v: Voice = { slot: new Slot(el as unknown as HTMLVideoElement), clip: c, video: kind === "video", lead: true };
  return { v, el };
}

/** Drives a Transport the way Engine.tick does, at 60 fps on a simulated clock. */
class Rig {
  tp = new Transport();
  now = 0;
  times: number[] = [];
  prerolled = 0;
  constructor(private voices: Voice[]) {}

  play(from = 0) {
    this.tp.play(this.now, from);
  }

  frame(): number {
    this.now += FRAME;
    for (const el of new Set(this.voices.map((v) => v.slot.el))) (el as unknown as FakeMedia).step(this.now);
    const t = this.tp.advance(this.now);
    const active = this.voices.filter((v) => t >= v.clip.start - EPS && t < clipEnd(v.clip) - EPS);
    const used = new Set(active.map((v) => v.slot));
    for (const v of this.voices) if (!used.has(v.slot)) v.slot.hide();
    const was = this.tp.prerolling;
    this.tp.sync(this.now, t, active, 24);
    if (this.tp.prerolling && !was) this.prerolled++;
    this.times.push(t);
    return t;
  }

  run(ms: number): number {
    let t = this.tp.time;
    for (let i = 0; i < Math.round(ms / FRAME); i++) t = this.frame();
    return t;
  }
}

const monotonic = (ts: number[]) => ts.every((t, i) => i === 0 || t >= ts[i - 1]);

describe("playback clock", () => {
  it("follows a master that starts late and reports currentTime late, without seeks or pre-roll", () => {
    // The measured WebKit case: 270 ms from play() to motion, coarse currentTime updates.
    const video = voice(clip(0, 20), { startMs: 270, reportMs: 50 });
    const music = voice(clip(0, 20), { startMs: 270, reportMs: 50 }, "audio");
    const rig = new Rig([video.v, music.v]);
    rig.play();
    rig.frame(); // initial pre-roll: everything is ready, so it ends right away
    expect(rig.tp.prerolling).toBe(false);

    const t5 = rig.run(5000);
    const t10 = rig.run(5000);
    for (const { el } of [video, music]) {
      expect(el.seeks).toBe(0);
      expect(el.pauses).toBe(0);
    }
    expect(rig.prerolled).toBe(0);
    expect(monotonic(rig.times)).toBe(true);
    expect((t10 - t5) / 5).toBeCloseTo(1, 2);
    // The clock waited for the master instead of running ahead of it.
    expect(Math.abs(t10 - video.el.currentTime)).toBeLessThan(0.06);
  });

  it("nudges a follower drifting 100 ms back in with playbackRate", () => {
    const video = voice(clip(0, 20));
    const music = voice(clip(0, 20), {}, "audio");
    const rig = new Rig([video.v, music.v]);
    rig.play();
    rig.run(2000);
    music.el.shift(-0.1);
    const t = rig.frame();
    expect(music.el.playbackRate).toBeCloseTo(1.05);
    expect(video.el.playbackRate).toBe(1);
    expect(t).toBeGreaterThan(1.7);

    rig.run(3000);
    expect(music.el.playbackRate).toBe(1);
    expect(Math.abs(music.el.currentTime - mediaTime(music.v.clip, rig.tp.time))).toBeLessThan(0.015);
    expect(music.el.seeks).toBe(0);
    expect(rig.prerolled).toBe(0);
  });

  it("seeks a follower that is 2 s off without stopping the clock", () => {
    const video = voice(clip(0, 20));
    const music = voice(clip(0, 20), { seekMs: 200 }, "audio");
    const rig = new Rig([video.v, music.v]);
    rig.play();
    rig.run(2000);
    music.el.shift(2);
    const before = rig.frame();
    expect(music.el.seeks).toBe(1);
    expect(music.el.seeking).toBe(true);

    const after = rig.run(250); // while the follower seeks
    expect(rig.tp.prerolling).toBe(false);
    expect(rig.prerolled).toBe(0);
    expect(video.el.paused).toBe(false);
    expect(after - before).toBeCloseTo(0.25, 1);

    rig.run(3000); // left a little behind by the seek: nudged, not seeked again
    expect(music.el.seeks).toBe(1);
    expect(Math.abs(music.el.currentTime - mediaTime(music.v.clip, rig.tp.time))).toBeLessThan(0.05);
  });

  it("still pre-rolls a cut to a clip that isn't ready", () => {
    const a = voice(clip(0, 2));
    const b = voice(clip(2, 2, 5), { seekMs: 300 }); // not preloaded: has to seek to 5 s at the cut
    const rig = new Rig([a.v, b.v]);
    rig.play();
    let t = 0;
    while (t < 2) t = rig.frame();
    expect(rig.tp.prerolling).toBe(true);
    expect(b.el.seeking).toBe(true);

    const held = rig.run(200);
    expect(held).toBe(t);
    expect(b.el.paused).toBe(true);

    rig.run(800);
    expect(rig.tp.prerolling).toBe(false);
    expect(rig.prerolled).toBe(1);
    expect(b.el.paused).toBe(false);
    expect(rig.tp.time).toBeGreaterThan(t + 0.3);
    expect(Math.abs(b.el.currentTime - mediaTime(b.v.clip, rig.tp.time))).toBeLessThan(0.05);
    expect(monotonic(rig.times)).toBe(true);
  });

  it("plays straight through a cut to a preloaded clip", () => {
    const a = voice(clip(0, 2));
    const b = voice(clip(2, 2, 5));
    b.v.slot.seek(5, 0.01);
    const rig = new Rig([a.v, b.v]);
    rig.play();
    rig.run(3000);
    expect(rig.prerolled).toBe(0);
    expect(b.el.seeks).toBe(1); // just the preload
    expect(monotonic(rig.times)).toBe(true);
    expect(Math.abs(b.el.currentTime - mediaTime(b.v.clip, rig.tp.time))).toBeLessThan(0.05);
  });

  it("keeps one element playing across a split", () => {
    const a = voice(clip(0, 2));
    const b: Voice = { ...a.v, clip: clip(2, 2, 2) };
    const rig = new Rig([a.v, b]);
    rig.play();
    rig.run(3000);
    expect(b.slot.activeClip).toBe(b.clip.id);
    expect(a.el.seeks).toBe(0);
    expect(a.el.pauses).toBe(0);
    expect(rig.prerolled).toBe(0);
    expect(monotonic(rig.times)).toBe(true);
  });

  it("follows J/K/L rate changes", () => {
    const video = voice(clip(0, 20));
    const rig = new Rig([video.v]);
    rig.play();
    rig.run(1000);
    rig.tp.setRate(2);
    const t1 = rig.run(500);
    const t2 = rig.run(1000);
    expect(video.el.playbackRate).toBe(2);
    expect(t2 - t1).toBeCloseTo(2, 1);
    expect(video.el.seeks).toBe(0);

    rig.tp.setRate(-1);
    const t3 = rig.run(500);
    expect(video.el.paused).toBe(true);
    expect(t3).toBeCloseTo(t2 - 0.5, 1);
  });

  it("runs on the wall clock where no media plays, and hands over without jumping back", () => {
    const later = voice(clip(1, 2));
    const rig = new Rig([later.v]);
    rig.play();
    expect(rig.run(500)).toBeCloseTo(0.5, 1);
    rig.run(2000);
    expect(later.el.paused).toBe(false);
    expect(monotonic(rig.times)).toBe(true);
    expect(rig.prerolled).toBe(0);
  });
});

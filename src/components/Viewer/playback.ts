// Playback clock and media sync for the preview engine (engine.ts). No DOM globals, so
// it can be unit tested with fake media elements.
//
// While playing, the timeline follows a master element (the topmost visible video, else
// audio that's heard): its currentTime *is* the clock, so play() start-up latency and
// WebKit's late-reported currentTime can't read as drift. The wall clock only runs while
// no element can lead (gaps, titles, stills, reverse shuttle); the clock slews towards
// the master instead of stepping, and never runs backwards. The other active elements
// follow: small drift is absorbed by nudging playbackRate, only large drift is seeked,
// and neither stops the clock. Pre-roll (clock held, everything paused) is kept for clips
// that become active without being ready: start of playback, seeks and cuts.

import type { Clip, Id } from "../../lib/types";
import { speedOf } from "../../lib/timeline";

/** Pre-roll stops waiting for media after this long (ms). */
const PREROLL_MS = 2500;
/** How long (ms) the clock waits for a just-played master to start moving. */
const STARTUP_MS = 1000;
/** A master whose currentTime hasn't moved for this long (ms) has stalled. */
const STALL_MS = 500;
/** Time constant (s) of the slew from the wall clock to the master. */
const SLEW = 0.2;
/** Follower drift (timeline seconds, scaled up for fast shuttle): nudge above NUDGE_AT until under SETTLED, seek above SEEK_AT. */
const SETTLED = 0.01;
const NUDGE_AT = 0.04;
const SEEK_AT = 1;
/** playbackRate offset that pulls a drifting follower back in. */
const NUDGE = 0.05;
/** An element playing on across a cut (one file, contiguous clips) is re-cued beyond this drift. */
const CONTIGUOUS = 0.1;

const clampRate = (r: number) => Math.min(16, Math.max(0.0625, r));

/** Source time of `clip` at timeline time `t`. */
export function mediaTime(clip: Clip, t: number): number {
  return clip.in + (t - clip.start) * speedOf(clip);
}

/** One media element: queued seeks plus the state needed to keep it in sync. */
export class Slot {
  url = "";
  /** Clip loaded (or preloaded) into the element. */
  clipId: Id | null = null;
  /** Clip the slot is active for; null while idle. */
  activeClip: Id | null = null;
  /** Became active (start, seek, cut) and hasn't been played since. */
  fresh = false;
  /** Since the last play() or resync seek (issued at `since`, ms): has currentTime moved? */
  started = false;
  since = 0;
  /** When currentTime last changed (ms). */
  moved = 0;
  /** playbackRate nudge in effect: 1 faster, -1 slower. */
  nudge = 0;
  private last = NaN;
  private pending: number | null = null;

  constructor(public el: HTMLVideoElement | HTMLAudioElement) {
    el.preload = "auto";
    el.addEventListener("seeked", () => this.flush());
    el.addEventListener("loadedmetadata", () => this.flush());
    el.addEventListener("error", () => {
      this.pending = null;
    });
  }

  load(url: string) {
    if (this.url === url) return;
    this.url = url;
    this.pending = null;
    this.activeClip = null;
    this.el.src = url;
  }

  seek(t: number, tolerance: number) {
    if (!Number.isFinite(t)) return;
    const el = this.el;
    if (el.readyState < 1 || el.seeking) {
      this.pending = t;
      return;
    }
    if (Math.abs(el.currentTime - t) > tolerance) {
      try {
        el.currentTime = t;
      } catch {
        this.pending = t;
      }
    }
  }

  private flush() {
    if (this.pending == null || this.el.seeking || this.el.readyState < 1) return;
    const t = this.pending;
    this.pending = null;
    if (Math.abs(this.el.currentTime - t) > 0.002) this.el.currentTime = t;
  }

  get ready(): boolean {
    return !this.el.seeking && this.pending == null && this.el.readyState >= 3;
  }

  /** The element couldn't load its media (unsupported, unreadable): it will never be ready. */
  get failed(): boolean {
    return !!this.el.error;
  }

  /** Start watching for movement again (after play() or a resync seek). */
  restart(now: number) {
    this.started = false;
    this.since = now;
    this.last = NaN;
  }

  /** Track a playing element's currentTime: has it started moving, and when did it last move? */
  observe(now: number) {
    const el = this.el;
    if (el.seeking || this.pending != null) {
      this.last = NaN;
      return;
    }
    const pos = el.currentTime;
    if (pos === this.last) return;
    if (pos > this.last) this.started = true;
    this.last = pos;
    this.moved = now;
  }

  hide() {
    const el = this.el;
    if (!el.paused) el.pause();
    el.muted = true;
    this.activeClip = null;
    if ("videoWidth" in el && el.style.visibility !== "hidden") el.style.visibility = "hidden";
  }
}

/** A clip active at the current time and the slot playing it. */
export interface Voice {
  slot: Slot;
  clip: Clip;
  video: boolean;
  /** May lead the clock: video on a visible track, or audio that's heard. */
  lead: boolean;
}

/** Timeline time according to the voice's element. */
function timeOf(v: Voice): number {
  return v.clip.start + (v.slot.el.currentTime - v.clip.in) / speedOf(v.clip);
}

/** How far ahead (+) or behind the element is at timeline time `t`, scaled down for fast shuttle. */
function drift(v: Voice, t: number, rate: number): number {
  return (v.slot.el.currentTime - mediaTime(v.clip, t)) / speedOf(v.clip) / Math.max(1, rate);
}

function applyRate(el: HTMLMediaElement, r: number) {
  if (Math.abs(el.playbackRate - r) > 1e-3) el.playbackRate = r;
}

export class Transport {
  playing = false;
  rate = 1;
  /** Timeline time of the latest frame. */
  time = 0;
  prerolling = false;
  private prerollSince = 0;
  /** When the clock was last read (ms). */
  private last = 0;
  private master: Slot | null = null;
  private voices: Voice[] = [];

  play(now: number, from: number) {
    this.playing = true;
    this.time = from;
    this.last = now;
    this.master = null;
    this.preroll(now);
  }

  pause() {
    this.playing = false;
    this.prerolling = false;
  }

  seek(now: number, t: number) {
    this.time = t;
    if (this.playing) this.preroll(now);
  }

  setRate(rate: number) {
    this.rate = rate || 1;
  }

  /** Clock reading for a frame drawn at `now` (ms). */
  advance(now: number): number {
    const dt = Math.max(0, now - this.last) / 1000;
    this.last = now;
    if (!this.playing || this.prerolling) return this.time;
    const lead = this.lead(now);
    this.master = lead?.slot ?? null;
    let t = this.time + dt * this.rate;
    if (lead && !lead.slot.started) t = this.time; // wait for it to get going
    else if (lead) t += (timeOf(lead) - t) * (1 - Math.exp(-dt / SLEW));
    // Never backwards: a master that's behind holds the clock until it catches up.
    this.time = this.rate > 0 ? Math.max(this.time, t) : Math.min(this.time, t);
    return this.time;
  }

  /** Drive the elements of the clips active at `t`, as laid out by the engine for this frame. */
  sync(now: number, t: number, voices: Voice[], fps: number) {
    this.voices = voices;
    for (const { slot, clip } of voices) {
      if (slot.activeClip === clip.id) continue;
      slot.activeClip = clip.id;
      slot.fresh = true;
    }
    const rolling = this.playing && this.rate > 0;
    if (rolling && !this.prerolling) {
      // Line newly active clips up; any that can't play right away pre-roll.
      for (const v of voices) {
        if (v.slot.fresh && (v.slot.el.paused || Math.abs(drift(v, t, this.rate)) > CONTIGUOUS)) v.slot.seek(mediaTime(v.clip, t), 0.03);
      }
      if (voices.some((v) => v.slot.fresh && !v.slot.ready && !v.slot.failed)) this.preroll(now);
    }
    if (this.prerolling) {
      for (const v of voices) this.cue(v, t, fps);
      // Media that failed to load is never waited for: the rest plays on without it.
      if (voices.every((v) => v.slot.ready || v.slot.failed) || now - this.prerollSince > PREROLL_MS) this.prerolling = false;
      if (this.prerolling || !rolling) return;
    }
    for (const v of voices) {
      if (rolling) this.run(v, t, now);
      else this.cue(v, t, fps);
    }
  }

  private preroll(now: number) {
    this.prerolling = true;
    this.prerollSince = now;
  }

  /** The voice whose element leads the clock, if any can. */
  private lead(now: number): Voice | null {
    if (this.rate <= 0) return null;
    const order = [...this.voices.filter((v) => v.lead && v.video).reverse(), ...this.voices.filter((v) => v.lead && !v.video)];
    for (const v of order) {
      const { slot, clip } = v;
      const el = slot.el;
      const want = speedOf(clip) * this.rate;
      if (el.paused || el.ended || !slot.ready || clampRate(want) !== want) continue;
      slot.observe(now);
      if (slot.started ? now - slot.moved > STALL_MS : now - slot.since > STARTUP_MS) continue;
      // Out of step with the timeline (e.g. edited mid-play): it gets resynced as a follower.
      if (Math.abs(drift(v, this.time, this.rate)) > SEEK_AT) continue;
      return v;
    }
    return null;
  }

  /** Play a voice, keeping followers in step with the clock. The master is never corrected. */
  private run(v: Voice, t: number, now: number) {
    const { slot, clip } = v;
    const el = slot.el;
    slot.fresh = false;
    if (slot.failed) return;
    const base = clampRate(speedOf(clip) * this.rate);
    if (el.paused) {
      slot.nudge = 0;
      slot.seek(mediaTime(clip, t), 0.03);
      if (el.ended) return; // ran out of media: hold its last frame
      applyRate(el, base);
      el.play().catch(() => {});
      slot.restart(now);
      return;
    }
    slot.observe(now);
    if (slot === this.master) slot.nudge = 0;
    else if (slot.started || now - slot.since > STARTUP_MS) {
      const d = drift(v, t, this.rate);
      if (Math.abs(d) > SEEK_AT) {
        slot.nudge = 0;
        slot.seek(mediaTime(clip, t), 0);
        slot.restart(now);
      } else if (Math.abs(d) > NUDGE_AT) slot.nudge = d > 0 ? -1 : 1;
      else if (Math.abs(d) < SETTLED || d * slot.nudge > 0) slot.nudge = 0;
    }
    applyRate(el, clampRate(base * (1 + slot.nudge * NUDGE)));
  }

  /** Hold a voice paused on the frame at `t`. */
  private cue(v: Voice, t: number, fps: number) {
    const el = v.slot.el;
    if (!el.paused) el.pause();
    v.slot.nudge = 0;
    v.slot.seek(mediaTime(v.clip, t), this.playing ? 0.02 : 0.5 / (fps || 30));
  }
}

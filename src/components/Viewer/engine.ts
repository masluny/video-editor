// Real-time preview compositor.
//
// The stage is a div sized to the project resolution (scaled to fit by CSS).
// Each video track owns a layer containing two <video> elements (current + preloaded
// next clip, for gapless cuts) and one <img> (stills & titles). Audio tracks own two
// <audio> elements. Geometry and colour mirror the export engine (graph.rs).
//
// A single wall clock drives playback; media elements are slaved to it. When an
// element that should be playing isn't ready yet (seeking/buffering) the clock holds
// ("pre-roll") so tracks never drift apart.

import type { Clip, Id, MediaAsset, Project, Track } from "../../lib/types";
import { clipAt, clipEnd, EPS, projectDuration, speedOf } from "../../lib/timeline";
import { cssClipPath, cssFilter, fadeFactor, fitBox } from "../../lib/visual";
import { titleImageUrl } from "../../lib/title";

export interface EngineHost {
  project(): Project;
  /** Playable URL for a media asset (proxy if needed), or null while unavailable. */
  source(media: MediaAsset): string | null;
  /** Called ~30×/s during playback. */
  onTime(t: number): void;
  onEnded(t: number): void;
}

class Slot {
  url = "";
  clipId: Id | null = null;
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

  hide() {
    const el = this.el;
    if (!el.paused) el.pause();
    el.muted = true;
    if (el instanceof HTMLVideoElement && el.style.visibility !== "hidden") el.style.visibility = "hidden";
  }
}

interface Layer {
  track: Id;
  kind: "video" | "audio";
  root: HTMLDivElement | null;
  slots: [Slot, Slot];
  current: Slot | null;
  img: HTMLImageElement | null;
  imgKey: string;
}

function newVideo(): HTMLVideoElement {
  const v = document.createElement("video");
  v.playsInline = true;
  v.muted = true;
  v.disablePictureInPicture = true;
  v.setAttribute("playsinline", "");
  Object.assign(v.style, { position: "absolute", objectFit: "fill", visibility: "hidden", transformOrigin: "50% 50%", pointerEvents: "none" });
  return v;
}

export class Engine {
  private layers = new Map<Id, Layer>();
  private raf = 0;
  private playing = false;
  private rate = 1;
  private time = 0;
  private origin = { perf: 0, time: 0 };
  private prerolling = false;
  private prerollSince = 0;
  private lastPublish = 0;
  private master = { volume: 1, muted: false };
  private titles = new Map<Id, { key: string; url: string | null }>();
  private renderQueued = false;
  private active: Slot[] = [];
  private geometry = new WeakMap<HTMLElement, string>();

  constructor(private stage: HTMLDivElement, private host: EngineHost) {}

  destroy() {
    cancelAnimationFrame(this.raf);
    for (const l of this.layers.values()) this.disposeLayer(l);
    this.layers.clear();
  }

  setMaster(volume: number, muted: boolean) {
    this.master = { volume, muted };
    this.invalidate();
  }

  setRate(rate: number) {
    if (this.playing) this.origin = { perf: performance.now(), time: this.time };
    this.rate = rate || 1;
    this.invalidate();
  }

  play(from: number) {
    const end = projectDuration(this.host.project());
    this.time = from >= end - 1e-3 && this.rate > 0 ? 0 : from;
    if (this.time !== from) this.host.onTime(this.time);
    this.playing = true;
    this.prerolling = true;
    this.prerollSince = performance.now();
    this.origin = { perf: performance.now(), time: this.time };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.render(this.time);
  }

  seek(t: number) {
    this.time = Math.max(0, t);
    if (this.playing) {
      this.prerolling = true;
      this.prerollSince = performance.now();
      this.origin = { perf: performance.now(), time: this.time };
    }
    this.render(this.time);
  }

  /** Something changed (project, media sources): redraw the current frame. */
  invalidate() {
    if (this.playing || this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (!this.playing) this.render(this.time);
    });
  }

  get currentTime() {
    return this.time;
  }

  private tick = (now: number) => {
    if (!this.playing) return;
    const p = this.host.project();
    const end = projectDuration(p);
    let t = this.prerolling ? this.origin.time : this.origin.time + ((now - this.origin.perf) / 1000) * this.rate;

    if ((this.rate > 0 && t >= end) || (this.rate < 0 && t <= 0)) {
      t = Math.max(0, Math.min(end, t));
      this.time = t;
      this.playing = false;
      this.render(t);
      this.host.onTime(t);
      this.host.onEnded(t);
      return;
    }

    this.time = t;
    this.render(t);
    const ready = this.active.every((s) => s.ready);

    if (this.prerolling) {
      if (ready || now - this.prerollSince > 2500) {
        this.prerolling = false;
        this.origin = { perf: now, time: t };
        this.render(t); // starts playback of the (now ready) elements
      }
    } else if (!ready && this.rate > 0) {
      // A newly active clip is still seeking/buffering: hold the clock.
      this.prerolling = true;
      this.prerollSince = now;
      this.origin = { perf: now, time: t };
      for (const s of this.active) if (!s.el.paused) s.el.pause();
    }

    if (now - this.lastPublish > 33) {
      this.lastPublish = now;
      this.host.onTime(t);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  // ------------------------------------------------------------------ render

  private render(t: number) {
    const p = this.host.project();
    this.syncLayers(p);
    this.stage.style.background = p.settings.background || "#000";
    const anySolo = p.tracks.some((tr) => tr.solo);
    this.active = [];
    let z = 0;
    for (const track of p.tracks) {
      const layer = this.layers.get(track.id)!;
      const audible = !track.muted && (!anySolo || track.solo);
      if (track.kind === "video") this.renderVideoTrack(p, layer, track, t, audible, z++);
      else this.renderAudioTrack(p, layer, track, t, audible);
    }
  }

  private syncLayers(p: Project) {
    const ids = new Set(p.tracks.map((t) => t.id));
    for (const [id, layer] of this.layers) {
      if (!ids.has(id)) {
        this.disposeLayer(layer);
        this.layers.delete(id);
      }
    }
    for (const track of p.tracks) {
      let layer = this.layers.get(track.id);
      if (layer && layer.kind !== track.kind) {
        this.disposeLayer(layer);
        layer = undefined;
      }
      if (!layer) {
        layer = this.createLayer(track);
        this.layers.set(track.id, layer);
      }
    }
    // Keep DOM order = stacking order (V1 at the bottom).
    let prev: HTMLElement | null = null;
    for (const track of p.tracks) {
      const root = this.layers.get(track.id)!.root;
      if (!root) continue;
      const want: ChildNode | null = prev ? prev.nextSibling : this.stage.firstChild;
      if (root !== want) this.stage.insertBefore(root, want);
      prev = root;
    }
  }

  private createLayer(track: Track): Layer {
    if (track.kind === "audio") {
      const mk = () => {
        const a = document.createElement("audio");
        a.style.display = "none";
        this.stage.appendChild(a);
        return new Slot(a);
      };
      return { track: track.id, kind: "audio", root: null, slots: [mk(), mk()], current: null, img: null, imgKey: "" };
    }
    const root = document.createElement("div");
    Object.assign(root.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    root.dataset.track = track.id;
    const a = newVideo();
    const b = newVideo();
    const img = document.createElement("img");
    img.decoding = "sync";
    img.draggable = false;
    Object.assign(img.style, { position: "absolute", visibility: "hidden", transformOrigin: "50% 50%", pointerEvents: "none" });
    root.append(a, b, img);
    this.stage.appendChild(root);
    return { track: track.id, kind: "video", root, slots: [new Slot(a), new Slot(b)], current: null, img, imgKey: "" };
  }

  private disposeLayer(l: Layer) {
    for (const s of l.slots) {
      s.el.pause();
      s.el.removeAttribute("src");
      s.el.load();
      s.el.remove();
    }
    l.root?.remove();
  }

  /** Slot that should play `clip` from `url`, reusing whatever is already loaded. */
  private acquire(layer: Layer, clipId: Id, url: string): Slot {
    const s =
      layer.slots.find((x) => x.clipId === clipId && x.url === url) ??
      (layer.current && layer.current.url === url ? layer.current : undefined) ??
      layer.slots.find((x) => x.url === url) ??
      layer.slots.find((x) => x !== layer.current) ??
      layer.slots[0];
    s.clipId = clipId;
    s.load(url);
    layer.current = s;
    return s;
  }

  private mediaFor(p: Project, clip: Clip | undefined): MediaAsset | undefined {
    return clip?.type === "media" ? p.media.find((m) => m.id === clip.mediaId) : undefined;
  }

  /** The clip that follows `t` on a track soon enough to be worth preloading. */
  private upcoming(track: Track, t: number, active: Clip | undefined): Clip | undefined {
    const from = active ? clipEnd(active) - EPS : t;
    let best: Clip | undefined;
    for (const c of track.clips) {
      if (c === active || c.start < from || c.start - t > 3) continue;
      if (!best || c.start < best.start) best = c;
    }
    return best;
  }

  private drivePlayback(slot: Slot, clip: Clip, t: number, fps: number) {
    const el = slot.el;
    const sp = speedOf(clip);
    const mediaTime = clip.in + (t - clip.start) * sp;
    this.active.push(slot);
    if (this.playing && this.rate > 0 && !this.prerolling) {
      const rate = Math.min(16, Math.max(0.0625, sp * this.rate));
      if (Math.abs(el.playbackRate - rate) > 1e-3) el.playbackRate = rate;
      if (el.paused) {
        slot.seek(mediaTime, 0.03);
        el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - mediaTime) > 0.25 * Math.max(1, rate)) {
        slot.seek(mediaTime, 0);
      }
    } else {
      if (!el.paused) el.pause();
      slot.seek(mediaTime, this.playing ? 0.02 : 0.5 / (fps || 30));
    }
  }

  private gain(track: Track, clip: Clip, t: number, audible: boolean): number {
    if (!audible || clip.muted || this.master.muted) return 0;
    const g = this.master.volume * track.volume * clip.volume * fadeFactor(clip, t - clip.start);
    return Math.max(0, Math.min(1, g));
  }

  /** Position/transform/colour an element like graph.rs does; geometry writes are cached. */
  private place(el: HTMLElement, clip: Clip, mw: number, mh: number, W: number, H: number, t: number) {
    const tf = clip.transform;
    const box = fitBox(mw, mh, W, H, tf.fit);
    const sx = tf.scale * (tf.flipH ? -1 : 1);
    const sy = tf.scale * (tf.flipV ? -1 : 1);
    const filter = cssFilter(clip.color);
    const clipPath = cssClipPath(clip.crop);
    const key = `${W}x${H}|${box.width}|${box.height}|${tf.x}|${tf.y}|${tf.rotation}|${sx}|${sy}|${filter}|${clipPath}`;
    const s = el.style;
    if (this.geometry.get(el) !== key) {
      this.geometry.set(el, key);
      s.width = `${box.width}px`;
      s.height = `${box.height}px`;
      s.left = `${(W - box.width) / 2}px`;
      s.top = `${(H - box.height) / 2}px`;
      s.transform = `translate(${tf.x}px, ${tf.y}px) rotate(${tf.rotation}deg) scale(${sx}, ${sy})`;
      s.filter = filter;
      s.clipPath = clipPath;
    }
    const opacity = String(Math.max(0, Math.min(1, clip.opacity * fadeFactor(clip, t - clip.start))));
    if (s.opacity !== opacity) s.opacity = opacity;
    if (s.visibility !== "visible") s.visibility = "visible";
  }

  private renderVideoTrack(p: Project, layer: Layer, track: Track, t: number, audible: boolean, z: number) {
    const { width: W, height: H, fps } = p.settings;
    if (layer.root) {
      layer.root.style.zIndex = String(z + 1);
      layer.root.style.visibility = track.hidden ? "hidden" : "visible";
    }
    const clip = clipAt(track, t);
    const media = this.mediaFor(p, clip);
    let videoSlot: Slot | null = null;
    let showImg = false;

    if (clip && media && media.kind === "video") {
      const url = this.host.source(media);
      if (url) {
        videoSlot = this.acquire(layer, clip.id, url);
        const el = videoSlot.el as HTMLVideoElement;
        this.place(el, clip, media.width, media.height, W, H, t);
        this.drivePlayback(videoSlot, clip, t, fps);
        const g = this.gain(track, clip, t, audible && media.hasAudio);
        el.muted = g <= 0;
        if (g > 0 && Math.abs(el.volume - g) > 0.005) el.volume = g;
      }
    } else if (clip && (clip.type === "title" || media?.kind === "image")) {
      showImg = this.renderStill(layer, clip, media, W, H, t);
    }

    // Preload the next clip into the idle element.
    const next = this.upcoming(track, t, clip);
    const nextMedia = this.mediaFor(p, next);
    if (next && nextMedia?.kind === "video") {
      const url = this.host.source(nextMedia);
      const continuous =
        clip && media && url && videoSlot && videoSlot.url === url && Math.abs(clip.out - next.in) < 0.5 / (fps || 30) && speedOf(clip) === speedOf(next) && Math.abs(clipEnd(clip) - next.start) < 1e-3;
      if (url && !continuous) {
        const idle = layer.slots.find((s) => s !== videoSlot)!;
        if (idle.clipId !== next.id || idle.url !== url) {
          idle.clipId = next.id;
          idle.load(url);
        }
        idle.seek(next.in, 0.01);
      }
    } else if (next && next.type === "title" && next.title) {
      this.titleUrl(next, W, H); // warm the title cache
    }

    for (const s of layer.slots) if (s !== videoSlot) s.hide();
    if (!showImg && layer.img && layer.img.style.visibility !== "hidden") layer.img.style.visibility = "hidden";
  }

  private titleUrl(clip: Clip, W: number, H: number): string | null {
    if (!clip.title) return null;
    const key = `${W}x${H}|${JSON.stringify(clip.title)}`;
    const hit = this.titles.get(clip.id);
    if (hit && hit.key === key) return hit.url;
    const entry: { key: string; url: string | null } = { key, url: hit?.url ?? null };
    this.titles.set(clip.id, entry);
    titleImageUrl(clip.title, W, H).then((url) => {
      if (this.titles.get(clip.id) === entry) {
        entry.url = url;
        this.invalidate();
      }
    });
    return entry.url;
  }

  private renderStill(layer: Layer, clip: Clip, media: MediaAsset | undefined, W: number, H: number, t: number): boolean {
    const img = layer.img!;
    let url: string | null;
    let mw = W;
    let mh = H;
    if (clip.type === "title") url = this.titleUrl(clip, W, H);
    else {
      url = media ? this.host.source(media) : null;
      mw = media?.width || W;
      mh = media?.height || H;
    }
    if (!url) return false;
    if (layer.imgKey !== url) {
      layer.imgKey = url;
      img.src = url;
    }
    this.place(img, clip, mw, mh, W, H, t);
    return true;
  }

  private renderAudioTrack(p: Project, layer: Layer, track: Track, t: number, audible: boolean) {
    const clip = clipAt(track, t);
    const media = this.mediaFor(p, clip);
    let slot: Slot | null = null;
    if (clip && media && media.hasAudio && media.kind !== "image") {
      const url = this.host.source(media);
      if (url) {
        slot = this.acquire(layer, clip.id, url);
        this.drivePlayback(slot, clip, t, p.settings.fps);
        const g = this.gain(track, clip, t, audible);
        slot.el.muted = g <= 0;
        if (g > 0 && Math.abs(slot.el.volume - g) > 0.005) slot.el.volume = g;
      }
    }
    const next = this.upcoming(track, t, clip);
    const nextMedia = this.mediaFor(p, next);
    if (next && nextMedia?.hasAudio) {
      const url = this.host.source(nextMedia);
      if (url) {
        const idle = layer.slots.find((s) => s !== slot)!;
        if (!(slot && slot.url === url && clip && Math.abs(clip.out - next.in) < 0.02)) {
          if (idle.clipId !== next.id || idle.url !== url) {
            idle.clipId = next.id;
            idle.load(url);
          }
          idle.seek(next.in, 0.01);
        }
      }
    }
    for (const s of layer.slots) if (s !== slot) s.hide();
  }
}

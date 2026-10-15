// Real-time preview compositor.
//
// The stage is a div sized to the project resolution (scaled to fit by CSS).
// Each video track owns a layer containing two <video> elements (current + preloaded
// next clip, for gapless cuts) and one <img> (stills & titles). Audio tracks own two
// <audio> elements. Geometry and colour mirror the export engine (graph.rs).
//
// A cross-dissolve shows the clip we're not playing in the track's other element (or
// second <img>), held on its first / last frame, exactly as graph.rs renders it.
//
// Timing lives in playback.ts: while playing, the topmost video (else audible audio) is
// the master clock and the other elements follow it; the wall clock only covers gaps,
// titles and stills. A clip that becomes active without being ready (start, seek, cut)
// still pre-rolls: the clock holds until it can play.

import type { Clip, Id, MediaAsset, Project, Track } from "../../lib/types";
import { clipAt, clipDuration, clipEnd, EPS, projectDuration, speedOf } from "../../lib/timeline";
import { backdropBlur, cssClipPath, cssFilter, fadeFactor, fitBox } from "../../lib/visual";
import { titleImageUrl } from "../../lib/title";
import { dissolveAt, dissolveGain, dissolveMix } from "../../lib/transitions";
import { motionAt, motionProgress } from "../../lib/motion";
import { gainAt } from "../../lib/envelope";
import { mediaTime, Slot, Transport, type Voice } from "./playback";

export interface EngineHost {
  project(): Project;
  /** Playable URL for a media asset (proxy if needed), or null while unavailable. */
  source(media: MediaAsset): string | null;
  /** Called ~30×/s during playback. */
  onTime(t: number): void;
  onEnded(t: number): void;
}

interface Layer {
  track: Id;
  kind: "video" | "audio";
  root: HTMLDivElement | null;
  slots: [Slot, Slot];
  current: Slot | null;
  /** Stills & titles: the active clip, and the other side of a dissolve. */
  imgs: [HTMLImageElement, HTMLImageElement] | null;
  /** Blurred copy of the active clip filling the frame behind it ("blur" backdrop). */
  backdrop: HTMLCanvasElement | null;
  imgKeys: [string, string];
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
  private tp = new Transport();
  private lastPublish = 0;
  private master = { volume: 1, muted: false };
  private titles = new Map<Id, { key: string; url: string | null }>();
  private renderQueued = false;
  private voices: Voice[] = [];
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
    this.tp.setRate(rate);
    this.invalidate();
  }

  play(from: number) {
    const end = projectDuration(this.host.project());
    const t = from >= end - 1e-3 && this.tp.rate > 0 ? 0 : from;
    if (t !== from) this.host.onTime(t);
    this.tp.play(performance.now(), t);
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
  }

  pause() {
    this.tp.pause();
    cancelAnimationFrame(this.raf);
    this.render(this.tp.time);
  }

  seek(t: number) {
    this.tp.seek(performance.now(), Math.max(0, t));
    this.render(this.tp.time);
  }

  /** Something changed (project, media sources): redraw the current frame. */
  invalidate() {
    if (this.tp.playing || this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (!this.tp.playing) this.render(this.tp.time);
    });
  }

  get currentTime() {
    return this.tp.time;
  }

  private tick = (now: number) => {
    const tp = this.tp;
    if (!tp.playing) return;
    const end = projectDuration(this.host.project());
    let t = tp.advance(now);

    if ((tp.rate > 0 && t >= end) || (tp.rate < 0 && t <= 0)) {
      t = Math.max(0, Math.min(end, t));
      tp.pause();
      tp.seek(now, t);
      this.render(t);
      this.host.onTime(t);
      this.host.onEnded(t);
      return;
    }

    this.render(t, now);
    if (now - this.lastPublish > 33) {
      this.lastPublish = now;
      this.host.onTime(t);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  // ------------------------------------------------------------------ render

  private render(t: number, now = performance.now()) {
    const p = this.host.project();
    this.syncLayers(p);
    this.stage.style.background = p.settings.background || "#000";
    // Paused right at the end: show the last frame, not the black just past it.
    const end = projectDuration(p);
    if (!this.tp.playing && end > 0 && t >= end - EPS) t = Math.max(0, end - 0.5 / (p.settings.fps || 30));
    const anySolo = p.tracks.some((tr) => tr.solo);
    this.voices = [];
    let z = 0;
    for (const track of p.tracks) {
      const layer = this.layers.get(track.id)!;
      const audible = !track.muted && (!anySolo || track.solo);
      if (track.kind === "video") this.renderVideoTrack(p, layer, track, t, audible, z++);
      else this.renderAudioTrack(p, layer, track, t, audible);
    }
    this.tp.sync(now, t, this.voices, p.settings.fps);
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
      return { track: track.id, kind: "audio", root: null, slots: [mk(), mk()], current: null, imgs: null, imgKeys: ["", ""], backdrop: null };
    }
    const root = document.createElement("div");
    Object.assign(root.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    root.dataset.track = track.id;
    const a = newVideo();
    const b = newVideo();
    const mkImg = () => {
      const img = document.createElement("img");
      img.decoding = "sync";
      img.draggable = false;
      Object.assign(img.style, { position: "absolute", visibility: "hidden", transformOrigin: "50% 50%", pointerEvents: "none" });
      return img;
    };
    const imgs: [HTMLImageElement, HTMLImageElement] = [mkImg(), mkImg()];
    const backdrop = document.createElement("canvas");
    Object.assign(backdrop.style, { position: "absolute", left: "0", top: "0", visibility: "hidden", pointerEvents: "none", zIndex: "0" });
    root.append(backdrop, a, b, ...imgs);
    this.stage.appendChild(root);
    return { track: track.id, kind: "video", root, slots: [new Slot(a), new Slot(b)], current: null, imgs, imgKeys: ["", ""], backdrop };
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

  private gain(track: Track, clip: Clip, t: number, audible: boolean): number {
    if (!audible || clip.muted || this.master.muted) return 0;
    const g = this.master.volume * track.volume * clip.volume * fadeFactor(clip, t - clip.start) * dissolveGain(track, clip, t) * gainAt(clip.volumePoints, mediaTime(clip, t));
    return Math.max(0, Math.min(1, g));
  }

  /** Position/transform/colour an element like graph.rs does; geometry writes are cached. */
  private place(el: HTMLElement, clip: Clip, mw: number, mh: number, W: number, H: number, t: number, alpha = 1, z = 1) {
    const m = clip.motion ? motionAt(clip.motion, motionProgress(clip.motion, t - clip.start, clipDuration(clip))) : null;
    const tf = m ? { ...clip.transform, scale: clip.transform.scale * m.scale, x: clip.transform.x + m.x, y: clip.transform.y + m.y } : clip.transform;
    const box = fitBox(mw, mh, W, H, tf.fit);
    // Boxes bigger than the frame (Fill into another shape) are laid out at frame size and
    // scaled up by the transform instead: huge video layout boxes can fail to paint.
    const q = Math.max(1, box.width / W, box.height / H);
    const [bw, bh] = [box.width / q, box.height / q];
    const sx = tf.scale * q * (tf.flipH ? -1 : 1);
    const sy = tf.scale * q * (tf.flipV ? -1 : 1);
    const filter = cssFilter(clip.color, 1 / q);
    const clipPath = cssClipPath(clip.crop);
    const key = `${W}x${H}|${bw}|${bh}|${tf.x}|${tf.y}|${tf.rotation}|${sx}|${sy}|${filter}|${clipPath}`;
    const s = el.style;
    if (this.geometry.get(el) !== key) {
      this.geometry.set(el, key);
      s.width = `${bw}px`;
      s.height = `${bh}px`;
      s.left = `${(W - bw) / 2}px`;
      s.top = `${(H - bh) / 2}px`;
      s.transform = `translate(${tf.x}px, ${tf.y}px) rotate(${tf.rotation}deg) scale(${sx}, ${sy})`;
      s.filter = filter;
      s.clipPath = clipPath;
    }
    const opacity = String(Math.max(0, Math.min(1, clip.opacity * fadeFactor(clip, t - clip.start) * alpha)));
    if (s.opacity !== opacity) s.opacity = opacity;
    if (s.zIndex !== String(z)) s.zIndex = String(z);
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
    const showImg = [false, false];

    // Mid-dissolve the incoming clip sits on top: fading in over the frozen outgoing one
    // (second half, while it plays), or frozen itself over the playing outgoing one.
    const dz = clip ? dissolveAt(track, t) : null;
    const mix = dz ? dissolveMix(dz, t) : 1;
    const incoming = !!dz && clip === dz.to;

    let backdrop = false;
    if (clip && media && media.kind === "video") {
      const url = this.host.source(media);
      if (url) {
        videoSlot = this.acquire(layer, clip.id, url);
        const el = videoSlot.el as HTMLVideoElement;
        this.place(el, clip, media.width, media.height, W, H, t, incoming ? mix : 1, incoming ? 2 : 1);
        if (clip.backdrop === "blur") backdrop = this.drawBackdrop(layer, el, clip, media, W, H, t, incoming ? mix : 1);
        if (clip.freeze) {
          // A frame hold isn't played: it just shows its frame, silently.
          if (!el.paused) el.pause();
          el.muted = true;
          videoSlot.activeClip = null;
          videoSlot.seek(clip.in, 0.5 / (fps || 30));
        } else {
          this.voices.push({ slot: videoSlot, clip, video: true, lead: !track.hidden });
          const g = this.gain(track, clip, t, audible && media.hasAudio);
          el.muted = g <= 0;
          if (g > 0 && Math.abs(el.volume - g) > 0.005) el.volume = g;
        }
      }
    } else if (clip && (clip.type === "title" || media?.kind === "image")) {
      showImg[0] = this.renderStill(layer, 0, clip, media, W, H, t, incoming ? mix : 1, incoming ? 2 : 1);
      if (showImg[0] && media && clip.backdrop === "blur") backdrop = this.drawBackdrop(layer, layer.imgs![0], clip, media, W, H, t, incoming ? mix : 1);
    }
    if (!backdrop && layer.backdrop && layer.backdrop.style.visibility !== "hidden") layer.backdrop.style.visibility = "hidden";

    let held: Slot | null = null;
    if (dz) {
      const other = incoming ? dz.from : dz.to;
      const om = this.mediaFor(p, other);
      // Evaluate its own fades at the frame it holds.
      const at = incoming ? clipEnd(other) - EPS : other.start;
      const [alpha, z] = incoming ? [1, 1] : [mix, 2];
      if (om?.kind === "video") {
        const url = this.host.source(om);
        if (url) {
          held = layer.slots.find((s) => s !== videoSlot)!;
          if (held.clipId !== other.id || held.url !== url) {
            held.clipId = other.id;
            held.load(url);
          }
          if (!held.el.paused) held.el.pause();
          held.el.muted = true;
          held.activeClip = null; // not a voice: re-cue it like a new clip if it plays again
          held.seek(incoming && !other.freeze ? other.out - (0.5 / (fps || 30)) * speedOf(other) : other.in, 0.01);
          this.place(held.el as HTMLVideoElement, other, om.width, om.height, W, H, at, alpha, z);
        }
      } else if (other.type === "title" || om?.kind === "image") {
        showImg[1] = this.renderStill(layer, 1, other, om, W, H, at, alpha, z);
      }
    }

    // Preload the next clip into the idle element (busy holding a frame mid-dissolve).
    const next = incoming ? undefined : this.upcoming(track, t, clip);
    const nextMedia = this.mediaFor(p, next);
    if (next && nextMedia?.kind === "video" && !held) {
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

    for (const s of layer.slots) if (s !== videoSlot && s !== held) s.hide();
    layer.imgs!.forEach((img, i) => {
      if (!showImg[i] && img.style.visibility !== "hidden") img.style.visibility = "hidden";
    });
  }

  /** Paint a blurred, frame-filling copy of `source` behind the clip (cheap: 1/8 size, CSS blur). */
  private drawBackdrop(layer: Layer, source: HTMLVideoElement | HTMLImageElement, clip: Clip, media: MediaAsset, W: number, H: number, t: number, alpha: number): boolean {
    const cv = layer.backdrop!;
    const f = 1 / 8;
    const blur = backdropBlur(W, H);
    // Overscan by the blur's reach so its darkened edges fall outside the (clipped) stage.
    const m = Math.ceil(3 * blur * f);
    const [iw, ih] = [Math.max(2, Math.round(W * f)), Math.max(2, Math.round(H * f))];
    const [cw, ch] = [iw + 2 * m, ih + 2 * m];
    if (cv.width !== cw || cv.height !== ch) [cv.width, cv.height] = [cw, ch];
    const [mw, mh] = [media.width || W, media.height || H];
    const k = Math.max(iw / mw, ih / mh);
    const g = cv.getContext("2d");
    try {
      g?.drawImage(source, 0, 0, cw, ch); // rough fill for the overscan
      g?.drawImage(source, m + (iw - mw * k) / 2, m + (ih - mh * k) / 2, mw * k, mh * k); // the frame: cover, as exported
    } catch {
      return false; // no frame decoded yet
    }
    const colour = cssFilter({ ...clip.color, blur: 0 });
    const s = cv.style;
    const filter = `${colour === "none" ? "" : colour} blur(${blur}px)`.trim();
    if (s.filter !== filter) s.filter = filter;
    const box = [`${-m / f}px`, `${cw / f}px`, `${ch / f}px`];
    if (s.width !== box[1] || s.height !== box[2]) [s.left, s.top, s.width, s.height] = [box[0], box[0], box[1], box[2]];
    s.opacity = String(Math.max(0, Math.min(1, clip.opacity * fadeFactor(clip, t - clip.start) * alpha)));
    if (s.visibility !== "visible") s.visibility = "visible";
    return true;
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

  private renderStill(layer: Layer, which: 0 | 1, clip: Clip, media: MediaAsset | undefined, W: number, H: number, t: number, alpha: number, z: number): boolean {
    const img = layer.imgs![which];
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
    if (layer.imgKeys[which] !== url) {
      layer.imgKeys[which] = url;
      img.src = url;
    }
    this.place(img, clip, mw, mh, W, H, t, alpha, z);
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
        this.voices.push({ slot, clip, video: false, lead: audible && !clip.muted });
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

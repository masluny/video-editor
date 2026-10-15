// Turns whatever JSON we load (v1 .vproj files, v2 files, autosaves) into a valid
// v2 Project. Unknown or broken values fall back to defaults instead of failing.

import type { Clip, ColorAdjust, Crop, Marker, MediaAsset, MediaKind, Project, TitleStyle, Track, Transform } from "./types";
import { defaultColor, defaultCrop, defaultTitleStyle, defaultTransform, newProject, newTrack } from "./defaults";
import { uid } from "./uid";
import { basename } from "./format";
import type { Motion, MotionPreset } from "./motion";
import type { VolumePoint } from "./envelope";

type Json = Record<string, any>;

const num = (v: unknown, d: number, min = -Infinity, max = Infinity): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const str = (v: unknown, d: string): string => (typeof v === "string" && v.length ? v : d);
const bool = (v: unknown, d = false): boolean => (typeof v === "boolean" ? v : d);
const color = (v: unknown, d: string): string => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : d);

export function migrateProject(raw: unknown): Project {
  if (!raw || typeof raw !== "object") throw new Error("This file is not a Revind project.");
  const j = raw as Json;
  if (!Array.isArray(j.tracks) || !Array.isArray(j.media)) throw new Error("This file is not a Revind project.");
  return j.version === 2 || j.settings ? fromV2(j) : fromV1(j);
}

function media(m: Json): MediaAsset | null {
  const path = str(m?.path, "");
  if (!path) return null;
  const hasVideo = bool(m.hasVideo);
  const hasAudio = bool(m.hasAudio);
  const kind: MediaKind = ["video", "audio", "image"].includes(m.kind) ? m.kind : hasVideo ? "video" : hasAudio ? "audio" : "video";
  return {
    id: str(m.id, uid()),
    path,
    name: str(m.name, basename(path)),
    kind,
    duration: num(m.duration ?? m.durationSec, 0, 0),
    width: num(m.width, 0, 0),
    height: num(m.height, 0, 0),
    fps: num(m.fps, 0, 0),
    hasVideo: hasVideo || kind !== "audio",
    hasAudio,
    videoCodec: typeof m.videoCodec === "string" ? m.videoCodec : undefined,
    audioCodec: typeof m.audioCodec === "string" ? m.audioCodec : undefined,
    container: typeof m.container === "string" ? m.container : undefined,
    size: typeof m.size === "number" ? m.size : undefined,
  };
}

function transform(t: Json | undefined): Transform {
  const d = defaultTransform();
  if (!t) return d;
  return {
    x: num(t.x, 0),
    y: num(t.y, 0),
    scale: num(t.scale, 1, 0.01, 20),
    rotation: num(t.rotation, 0),
    fit: ["contain", "cover", "stretch"].includes(t.fit) ? t.fit : "contain",
    flipH: bool(t.flipH),
    flipV: bool(t.flipV),
  };
}

function motion(m: Json | undefined): Motion | undefined {
  if (!m || typeof m !== "object" || !m.from || !m.to) return undefined;
  const point = (p: Json) => ({ scale: num(p.scale, 1, 0.05, 20), x: num(p.x, 0), y: num(p.y, 0) });
  const presets: MotionPreset[] = ["zoom-in", "zoom-out", "pan-left", "pan-right", "pan-up", "pan-down", "pop-in", "rise-in", "slide-in"];
  return {
    preset: presets.includes(m.preset) ? m.preset : undefined,
    from: point(m.from),
    to: point(m.to),
    duration: num(m.duration, 0, 0, 3600) || undefined,
    easeOut: m.easeOut === true || undefined,
  };
}

function volumePoints(v: Json | undefined): VolumePoint[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const pts = v
    .filter((p: Json) => p && Number.isFinite(p.t))
    .map((p: Json) => ({ t: p.t as number, gain: num(p.gain, 1, 0, 4) }))
    .sort((a: VolumePoint, b: VolumePoint) => a.t - b.t);
  return pts.length ? pts : undefined;
}

function crop(c: Json | undefined): Crop {
  if (!c) return defaultCrop();
  return { top: num(c.top, 0, 0, 0.95), right: num(c.right, 0, 0, 0.95), bottom: num(c.bottom, 0, 0, 0.95), left: num(c.left, 0, 0, 0.95) };
}

function colorAdjust(c: Json | undefined): ColorAdjust {
  if (!c) return defaultColor();
  return {
    brightness: num(c.brightness, 1, 0, 2),
    contrast: num(c.contrast, 1, 0, 3),
    saturation: num(c.saturation, 1, 0, 3),
    sepia: num(c.sepia, 0, 0, 1),
    hue: num(c.hue, 0, -180, 180),
    blur: num(c.blur, 0, 0, 100),
  };
}

function titleStyle(t: Json | undefined): TitleStyle {
  const d = defaultTitleStyle();
  if (!t) return d;
  return {
    text: typeof t.text === "string" ? t.text : d.text,
    fontFamily: str(t.fontFamily, d.fontFamily),
    fontSize: num(t.fontSize, d.fontSize, 4, 1000),
    fontWeight: num(t.fontWeight, d.fontWeight, 100, 900),
    italic: bool(t.italic),
    color: color(t.color, d.color),
    align: ["left", "center", "right"].includes(t.align) ? t.align : d.align,
    x: num(t.x, d.x),
    y: num(t.y, d.y),
    lineHeight: num(t.lineHeight, d.lineHeight, 0.5, 4),
    letterSpacing: num(t.letterSpacing, d.letterSpacing, -50, 200),
    maxWidth: num(t.maxWidth, d.maxWidth, 5, 200),
    strokeWidth: num(t.strokeWidth, d.strokeWidth, 0, 50),
    strokeColor: color(t.strokeColor, d.strokeColor),
    shadow: num(t.shadow, d.shadow, 0, 100),
    shadowColor: color(t.shadowColor, d.shadowColor),
    box: bool(t.box),
    boxColor: color(t.boxColor, d.boxColor),
    boxOpacity: num(t.boxOpacity, d.boxOpacity, 0, 1),
    boxPadding: num(t.boxPadding, d.boxPadding, 0, 400),
    boxRadius: num(t.boxRadius, d.boxRadius, 0, 400),
  };
}

function clip(c: Json, mediaIds: Set<string>): Clip | null {
  const type = c.type === "title" ? "title" : "media";
  const mediaId = typeof c.mediaId === "string" ? c.mediaId : undefined;
  if (type === "media" && (!mediaId || !mediaIds.has(mediaId))) return null;
  const inP = num(c.in, 0);
  const outP = num(c.out, inP + 1);
  if (outP - inP <= 1e-4) return null;
  return {
    id: str(c.id, uid()),
    type,
    mediaId: type === "media" ? mediaId : undefined,
    start: num(c.start, 0, 0),
    in: inP,
    out: outP,
    speed: num(c.speed, 1, 0.05, 20),
    volume: num(c.volume, 1, 0, 4),
    muted: bool(c.muted),
    opacity: num(c.opacity, 1, 0, 1),
    transform: transform(c.transform),
    crop: crop(c.crop),
    color: colorAdjust(c.color),
    fadeIn: num(c.fadeIn, 0, 0),
    fadeOut: num(c.fadeOut, 0, 0),
    transitionIn: num(c.transitionIn, 0, 0, 10) || undefined,
    motion: motion(c.motion),
    volumePoints: volumePoints(c.volumePoints),
    title: type === "title" ? titleStyle(c.title) : undefined,
    label: typeof c.label === "string" && c.label ? c.label : undefined,
  };
}

function track(t: Json, mediaIds: Set<string>): Track {
  const kind = t.kind === "audio" ? "audio" : "video";
  return {
    id: str(t.id, uid()),
    kind,
    name: str(t.name, kind === "video" ? "V" : "A"),
    clips: (Array.isArray(t.clips) ? t.clips : [])
      .map((c: Json) => clip(c, mediaIds))
      .filter((c: Clip | null): c is Clip => !!c)
      .sort((a: Clip, b: Clip) => a.start - b.start),
    muted: bool(t.muted),
    solo: bool(t.solo),
    locked: bool(t.locked),
    hidden: bool(t.hidden),
    volume: num(t.volume, 1, 0, 2),
  };
}

function ensureTracks(p: Project): Project {
  if (!p.tracks.some((t) => t.kind === "video")) p.tracks.unshift(newTrack("video", "V1"));
  if (!p.tracks.some((t) => t.kind === "audio")) p.tracks.push(newTrack("audio", "A1"));
  return p;
}

function fromV2(j: Json): Project {
  const base = newProject();
  const s = j.settings || {};
  const mediaList = (j.media as Json[]).map(media).filter((m): m is MediaAsset => !!m);
  const ids = new Set(mediaList.map((m) => m.id));
  const markers: Marker[] = (Array.isArray(j.markers) ? j.markers : [])
    .filter((m: Json) => m && Number.isFinite(Number(m.time)))
    .map((m: Json) => ({ id: str(m.id, uid()), time: num(m.time, 0, 0), label: typeof m.label === "string" ? m.label : "", color: color(m.color, "#f5b84b") }));
  return ensureTracks({
    version: 2,
    id: str(j.id, base.id),
    name: str(j.name, base.name),
    settings: {
      width: Math.round(num(s.width, 1920, 16, 8192)),
      height: Math.round(num(s.height, 1080, 16, 8192)),
      fps: num(s.fps, 30, 1, 240),
      sampleRate: Math.round(num(s.sampleRate, 48000, 8000, 192000)),
      background: color(s.background, "#000000"),
    },
    media: mediaList,
    tracks: (j.tracks as Json[]).map((t) => track(t, ids)),
    markers,
  });
}

/** v0.x projects: snake_case clips, additive brightness, text attached to clips. */
function fromV1(j: Json): Project {
  const base = newProject();
  const mediaList = (j.media as Json[]).map(media).filter((m): m is MediaAsset => !!m);
  const ids = new Set(mediaList.map((m) => m.id));
  const titleClips: Clip[] = [];
  const tracks: Track[] = (j.tracks as Json[]).map((t) => {
    const kind = t.kind === "audio" ? "audio" : "video";
    const clips: Clip[] = [];
    for (const c of Array.isArray(t.clips) ? t.clips : []) {
      const mediaId = String(c.media_id ?? "");
      if (!ids.has(mediaId)) continue;
      const inP = num(c.source_in, 0, 0);
      const outP = num(c.source_out, inP + 1);
      if (outP - inP <= 1e-4) continue;
      const cc = c.color || {};
      const v2: Clip = {
        id: str(c.id, uid()),
        type: "media",
        mediaId,
        start: num(c.timeline_start, 0, 0),
        in: inP,
        out: outP,
        speed: num(c.speed, 1, 0.05, 20),
        volume: num(c.volume, 1, 0, 4),
        muted: bool(c.muted),
        opacity: num(c.opacity, 1, 0, 1),
        transform: { ...defaultTransform(), scale: num(c.transform?.scale, 1, 0.01, 20), rotation: num(c.transform?.rotation, 0) },
        crop: defaultCrop(),
        color: {
          ...defaultColor(),
          brightness: num(1 + num(cc.brightness, 0), 1, 0, 2),
          contrast: num(cc.contrast, 1, 0, 3),
          saturation: num(cc.saturation, 1, 0, 3),
          hue: num(cc.hue, 0, -180, 180),
          blur: num(cc.blur, 0, 0, 100),
        },
        fadeIn: num(c.fade_in, 0, 0),
        fadeOut: num(c.fade_out, 0, 0),
      };
      clips.push(v2);
      if (c.text && typeof c.text.text === "string" && c.text.text.trim()) {
        titleClips.push({
          ...v2,
          id: uid(),
          type: "title",
          mediaId: undefined,
          in: 0,
          out: (outP - inP) / v2.speed,
          speed: 1,
          transform: defaultTransform(),
          color: defaultColor(),
          opacity: 1,
          title: {
            ...defaultTitleStyle(),
            text: c.text.text,
            color: color(c.text.color, "#ffffff"),
            fontSize: num(c.text.font_size, 48, 4, 1000) * 2,
            fontWeight: c.text.bold ? 700 : 400,
            italic: bool(c.text.italic),
            x: num(c.text.x, 50),
            y: num(c.text.y, 50),
          },
        });
      }
    }
    return {
      id: str(t.id, uid()),
      kind,
      name: str(t.name, kind === "video" ? "V1" : "A1"),
      clips: clips.sort((a, b) => a.start - b.start),
      muted: bool(t.muted),
      solo: bool(t.solo),
      locked: bool(t.locked),
      hidden: false,
      volume: num(t.volume, 1, 0, 2),
    } satisfies Track;
  });

  // Order video tracks first (bottom→top), then audio.
  const videos = tracks.filter((t) => t.kind === "video");
  const audios = tracks.filter((t) => t.kind === "audio");
  if (titleClips.length) {
    const titleTrack = newTrack("video", `V${videos.length + 1}`);
    titleTrack.clips = titleClips.sort((a, b) => a.start - b.start);
    videos.push(titleTrack);
  }
  return ensureTracks({
    version: 2,
    id: str(j.id, base.id),
    name: str(j.name, base.name),
    settings: {
      width: Math.round(num(j.width, 1920, 16, 8192)),
      height: Math.round(num(j.height, 1080, 16, 8192)),
      fps: num(j.fps, 30, 1, 240),
      sampleRate: Math.round(num(j.sample_rate, 48000, 8000, 192000)),
      background: "#000000",
    },
    media: mediaList,
    tracks: [...videos, ...audios],
    markers: [],
  });
}

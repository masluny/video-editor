import type { Clip, ColorAdjust, Crop, MediaAsset, Project, TitleStyle, Track, TrackKind, Transform } from "./types";
import { uid } from "./uid";

export const DEFAULT_STILL_DURATION = 5;
export const DEFAULT_TITLE_DURATION = 4;

export const defaultTransform = (): Transform => ({ x: 0, y: 0, scale: 1, rotation: 0, fit: "contain", flipH: false, flipV: false });
export const defaultCrop = (): Crop => ({ top: 0, right: 0, bottom: 0, left: 0 });
export const defaultColor = (): ColorAdjust => ({ brightness: 1, contrast: 1, saturation: 1, sepia: 0, hue: 0, blur: 0 });

export function newTrack(kind: TrackKind, name: string): Track {
  return { id: uid(), kind, name, clips: [], muted: false, solo: false, locked: false, hidden: false, volume: 1 };
}

export function newProject(name = "Untitled"): Project {
  return {
    version: 2,
    id: uid(),
    name,
    settings: { width: 1920, height: 1080, fps: 30, sampleRate: 48000, background: "#000000" },
    media: [],
    tracks: [newTrack("video", "V1"), newTrack("video", "V2"), newTrack("audio", "A1"), newTrack("audio", "A2")],
    markers: [],
  };
}

export function mediaClip(media: MediaAsset, start: number, range?: { in: number; out: number }): Clip {
  const length = media.kind === "image" || !(media.duration > 0) ? DEFAULT_STILL_DURATION : media.duration;
  return {
    id: uid(),
    type: "media",
    mediaId: media.id,
    start,
    in: range?.in ?? 0,
    out: range?.out ?? length,
    speed: 1,
    volume: 1,
    muted: false,
    opacity: 1,
    transform: defaultTransform(),
    crop: defaultCrop(),
    color: defaultColor(),
    fadeIn: 0,
    fadeOut: 0,
  };
}

export function defaultTitleStyle(): TitleStyle {
  return {
    text: "Your title",
    fontFamily: "Inter Variable",
    fontSize: 96,
    fontWeight: 700,
    italic: false,
    color: "#ffffff",
    align: "center",
    x: 50,
    y: 50,
    lineHeight: 1.15,
    letterSpacing: 0,
    maxWidth: 80,
    strokeWidth: 0,
    strokeColor: "#000000",
    shadow: 12,
    shadowColor: "#000000",
    box: false,
    boxColor: "#000000",
    boxOpacity: 0.6,
    boxPadding: 24,
    boxRadius: 12,
  };
}

export function titleClip(start: number, style: Partial<TitleStyle> = {}, duration = DEFAULT_TITLE_DURATION): Clip {
  return {
    id: uid(),
    type: "title",
    start,
    in: 0,
    out: duration,
    speed: 1,
    volume: 1,
    muted: false,
    opacity: 1,
    transform: defaultTransform(),
    crop: defaultCrop(),
    color: defaultColor(),
    fadeIn: 0.3,
    fadeOut: 0.3,
    title: { ...defaultTitleStyle(), ...style },
  };
}

export interface TitlePreset {
  id: string;
  name: string;
  style: Partial<TitleStyle>;
}

/** Positions/sizes are relative to a 1080p frame and rescaled for other resolutions. */
export const TITLE_PRESETS: TitlePreset[] = [
  { id: "headline", name: "Headline", style: { text: "Headline", fontSize: 120, fontWeight: 800, y: 50 } },
  {
    id: "lower-third",
    name: "Lower third",
    style: { text: "Name Surname\nRole or subtitle", fontSize: 54, fontWeight: 600, align: "left", x: 26, y: 80, box: true, boxOpacity: 0.55, shadow: 0, maxWidth: 46 },
  },
  { id: "subtitle", name: "Subtitle", style: { text: "Spoken words go here", fontSize: 56, fontWeight: 600, y: 88, box: true, boxOpacity: 0.65, shadow: 0, boxPadding: 16 } },
  { id: "impact", name: "Impact", style: { text: "WOW", fontFamily: "Bebas Neue", fontSize: 260, fontWeight: 400, letterSpacing: 4, strokeWidth: 6, shadow: 0 } },
  { id: "elegant", name: "Elegant", style: { text: "Chapter One", fontFamily: "Playfair Display", fontSize: 110, fontWeight: 400, italic: true, shadow: 18 } },
  { id: "caption", name: "Caption", style: { text: "Caption", fontFamily: "Montserrat Variable", fontSize: 44, fontWeight: 500, align: "left", x: 18, y: 10, shadow: 8, maxWidth: 40 } },
];

export const TITLE_FONTS = [
  "Inter Variable",
  "Montserrat Variable",
  "Bebas Neue",
  "Playfair Display",
  "Helvetica Neue",
  "Arial",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Impact",
];

export interface FormatPreset {
  id: string;
  name: string;
  width: number;
  height: number;
}

export const FORMAT_PRESETS: FormatPreset[] = [
  { id: "1080p", name: "Landscape 1080p (16:9)", width: 1920, height: 1080 },
  { id: "4k", name: "Landscape 4K (16:9)", width: 3840, height: 2160 },
  { id: "720p", name: "Landscape 720p (16:9)", width: 1280, height: 720 },
  { id: "vertical", name: "Vertical 1080×1920 (9:16)", width: 1080, height: 1920 },
  { id: "square", name: "Square 1080×1080 (1:1)", width: 1080, height: 1080 },
  { id: "portrait", name: "Portrait 1080×1350 (4:5)", width: 1080, height: 1350 },
  { id: "cinema", name: "Cinema 2048×858 (2.39:1)", width: 2048, height: 858 },
];

export const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

export const MARKER_COLORS = ["#f5b84b", "#5ec7f7", "#ef6b73", "#8be28b", "#b49cff"];

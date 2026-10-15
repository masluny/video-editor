// Project document (v2). Mirrored in src-tauri/src/model.rs — keep in sync.

import type { Motion } from "./motion";
import type { VolumePoint } from "./envelope";
import type { Keyframes } from "./keyframes";

export type Id = string;

export type MediaKind = "video" | "audio" | "image";

export interface MediaAsset {
  id: Id;
  path: string;
  name: string;
  kind: MediaKind;
  /** Seconds. 0 for stills. */
  duration: number;
  /** Display size (rotation already applied). */
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  container?: string;
  size?: number;
}

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  background: string;
}

export interface Marker {
  id: Id;
  time: number;
  label: string;
  color: string;
}

export interface Project {
  version: 2;
  id: Id;
  name: string;
  settings: ProjectSettings;
  media: MediaAsset[];
  /** Video tracks stack bottom→top in array order (V1 is the lowest layer). */
  tracks: Track[];
  markers: Marker[];
}

export type TrackKind = "video" | "audio";

export interface Track {
  id: Id;
  kind: TrackKind;
  name: string;
  clips: Clip[];
  /** Silences the track's audio (video tracks: the clips' own audio). */
  muted: boolean;
  solo: boolean;
  locked: boolean;
  /** Hides a video track's picture. */
  hidden: boolean;
  /** Linear gain, 0..2. */
  volume: number;
}

export type Fit = "contain" | "cover" | "stretch";

export interface Transform {
  /** Layer centre offset from frame centre, project pixels. */
  x: number;
  y: number;
  scale: number;
  /** Degrees, clockwise. */
  rotation: number;
  fit: Fit;
  flipH: boolean;
  flipV: boolean;
}

/** Fraction (0..1) of the layer removed from each edge. */
export interface Crop {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Same semantics as the CSS filter functions of the same name. */
export interface ColorAdjust {
  brightness: number;
  contrast: number;
  saturation: number;
  sepia: number;
  hue: number;
  blur: number;
}

export type TextAlign = "left" | "center" | "right";

export interface TitleStyle {
  text: string;
  fontFamily: string;
  /** Project pixels. */
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  color: string;
  align: TextAlign;
  /** Anchor (centre of the text block) as % of the frame. */
  x: number;
  y: number;
  lineHeight: number;
  letterSpacing: number;
  /** Wrap width, % of frame width. */
  maxWidth: number;
  strokeWidth: number;
  strokeColor: string;
  shadow: number;
  shadowColor: string;
  box: boolean;
  boxColor: string;
  boxOpacity: number;
  boxPadding: number;
  boxRadius: number;
}

export type ClipType = "media" | "title";

export interface Clip {
  id: Id;
  type: ClipType;
  mediaId?: Id;
  /** Timeline start, seconds. */
  start: number;
  /** Source in/out, seconds of media time. For titles & stills, out-in is the length. */
  in: number;
  out: number;
  speed: number;
  /** Linear gain, 0..2. */
  volume: number;
  muted: boolean;
  opacity: number;
  transform: Transform;
  crop: Crop;
  color: ColorAdjust;
  fadeIn: number;
  fadeOut: number;
  /** Cross-dissolve (seconds) from the clip that ends where this one starts. */
  transitionIn?: number;
  /** Zoom / pan across the clip (see lib/motion.ts). */
  motion?: Motion;
  /** Position / scale / rotation / opacity over time, on the clip clock (see lib/keyframes.ts). */
  keyframes?: Keyframes;
  /** Volume envelope in source time, e.g. from ducking (see lib/envelope.ts). */
  volumePoints?: VolumePoint[];
  /** Fill the frame behind the clip with a blurred, enlarged copy of it (bars → blur). */
  backdrop?: "blur";
  /** A frame hold: shows the source frame at `in` for the whole clip, silently. */
  freeze?: boolean;
  title?: TitleStyle;
  /** Optional user label shown on the clip. */
  label?: string;
}

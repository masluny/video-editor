export type Id = string;

export interface MediaAsset {
  id: Id;
  path: string;
  name: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  thumbnail?: string;
}

export interface Project {
  id: Id;
  version: number;
  name: string;
  fps: number;
  width: number;
  height: number;
  sample_rate: number;
  tracks: Track[];
  media: MediaAsset[];
}

export interface Track {
  id: Id;
  kind: "video" | "audio";
  name: string;
  clips: Clip[];
  locked: boolean;
  muted: boolean;
  solo: boolean;
  volume: number;
}

export interface Clip {
  id: Id;
  media_id: Id;
  source_in: number;
  source_out: number;
  timeline_start: number;
  speed: number;
  volume: number;
  muted: boolean;
  opacity: number;
  transform: Transform;
  color: ColorGrade;
  fade_in?: number;
  fade_out?: number;
  transition_in?: Transition;
  transition_out?: Transition;
  text?: TextOverlay;
  keyframes: Keyframe[];
}

export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export interface ColorGrade {
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
  hue: number;
  blur: number;
}

export interface Transition {
  kind: "crossfade" | "cut" | "fadeblack" | "fadewhite";
  duration: number;
}

export interface TextOverlay {
  text: string;
  x: number;
  y: number;
  font_size: number;
  color: string;
  font_family: string;
  bold: boolean;
  italic: boolean;
}

export interface Keyframe {
  time: number;
  property: "opacity" | "scale" | "positionx" | "positiony" | "rotation" | "volume";
  value: number;
  easing: "linear" | "easein" | "easeout" | "easeinout";
}

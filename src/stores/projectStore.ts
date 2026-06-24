import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { current, isDraft } from "immer";
import type { Project, Track, Clip, MediaAsset, Id } from "../lib/types";
import { v4 as uuid } from "../lib/uuid";
import {
  getClipDuration,
  snapToFrame,
  overwriteInto,
  insertInto,
  rippleDeleteFrom,
} from "../lib/utils";

export type Tool = "select" | "razor";
export type PlaceMode = "overwrite" | "insert";

interface ProjectState {
  project: Project;
  playhead: number;
  seekGeneration: number;
  isPlaying: boolean;
  playRate: number; // signed shuttle rate for J/K/L (negative = reverse)
  selectedClipId: Id | null; // "primary" selection (drives the Inspector)
  selectedTrackId: Id | null;
  selectedClipIds: Id[]; // full multi-selection
  zoom: number;
  activeTool: Tool;
  snapEnabled: boolean;
  targetTrackId: Id | null; // destination for insert/overwrite/blade (null = first video)
  // Source-trim state for the Clip Trimmer modal. Placement on the timeline is
  // automatic on commit, so the trimmer only tracks the in/out of the source.
  clipping: { mediaId: Id; sourceIn: number; sourceOut: number } | null;
  // Export work area range. When set, only this portion of the timeline is exported.
  exportRange: { inPoint: number; outPoint: number } | null;
  history: Project[];
  historyIndex: number;

  startClipping: (mediaId: Id) => void;
  updateClipping: (patch: Partial<{ sourceIn: number; sourceOut: number }>) => void;
  commitClipping: (trackId?: Id) => void;
  cancelClipping: () => void;

  setExportRange: (inPoint: number, outPoint: number) => void;
  setExportIn: (t: number) => void;
  setExportOut: (t: number) => void;
  clearExportRange: () => void;

  setProject: (p: Project) => void;
  setPlayhead: (t: number, source?: "user" | "playback") => void;
  togglePlay: () => void;
  setIsPlaying: (v: boolean) => void;
  setPlayRate: (r: number) => void;
  selectClip: (clipId: Id | null, trackId?: Id | null) => void;
  toggleClipSelection: (clipId: Id, trackId: Id) => void;
  setZoom: (z: number) => void;
  setTool: (t: Tool) => void;
  toggleSnap: () => void;
  setTargetTrack: (trackId: Id) => void;

  // Lightweight, non-blocking notifications (replaces jarring alert() dialogs).
  toasts: { id: Id; msg: string; kind: "error" | "info" }[];
  pushToast: (msg: string, kind?: "error" | "info") => void;
  dismissToast: (id: Id) => void;

  // Ephemeral filmstrip thumbnail cache (mediaId -> PNG paths). Not part of the
  // project, so it is never serialized/saved.
  thumbs: Record<Id, string[]>;
  setThumbs: (mediaId: Id, paths: string[]) => void;

  addMedia: (assets: MediaAsset[], autoPlace?: boolean) => void;
  addTrack: (kind: "video" | "audio") => void;
  removeTrack: (trackId: Id) => void;
  addClipToTrack: (trackId: Id, clip: Clip) => void;
  placeClip: (trackId: Id, clip: Clip, mode: PlaceMode) => void;
  updateClip: (trackId: Id, clipId: Id, patch: Partial<Clip>) => void;
  removeClip: (trackId: Id, clipId: Id) => void;
  removeClipAndCleanupMedia: (trackId: Id, clipId: Id) => void;
  removeMedia: (mediaId: Id) => void;
  deleteSelected: (ripple: boolean) => void;
  splitClip: (trackId: Id, clipId: Id, time: number) => void;
  moveClip: (fromTrackId: Id, toTrackId: Id, clipId: Id, newStart: number) => void;
  moveSelectedBy: (deltaTime: number) => void;
  toggleTrackMute: (trackId: Id) => void;
  toggleTrackSolo: (trackId: Id) => void;
  toggleTrackLock: (trackId: Id) => void;
  setTrackVolume: (trackId: Id, vol: number) => void;

  undo: () => void;
  redo: () => void;
  pushHistory: () => void;
}

const defaultProject: Project = {
  id: uuid(),
  version: 1,
  name: "Untitled Project",
  fps: 30,
  width: 1920,
  height: 1080,
  sample_rate: 48000,
  tracks: [
    { id: uuid(), kind: "video", name: "V1", clips: [], locked: false, muted: false, solo: false, volume: 1 },
    { id: uuid(), kind: "audio", name: "A1", clips: [], locked: false, muted: false, solo: false, volume: 1 },
  ],
  media: [],
};

function snapshot<T>(value: T): T {
  return structuredClone(isDraft(value) ? current(value as any) : value) as T;
}

function sanitizeMediaAsset(asset: MediaAsset): MediaAsset | null {
  const path = typeof asset?.path === "string" ? asset.path : "";
  if (!path) return null;
  const name = typeof asset.name === "string" && asset.name ? asset.name : path.split("/").pop() || path;
  return {
    id: typeof asset.id === "string" && asset.id ? asset.id : uuid(),
    path,
    name,
    durationSec: Number.isFinite(Number(asset.durationSec)) ? Number(asset.durationSec) : 0,
    width: Number.isFinite(Number(asset.width)) ? Number(asset.width) : 0,
    height: Number.isFinite(Number(asset.height)) ? Number(asset.height) : 0,
    fps: Number.isFinite(Number(asset.fps)) ? Number(asset.fps) : 0,
    hasVideo: Boolean(asset.hasVideo),
    hasAudio: Boolean(asset.hasAudio),
    thumbnail: typeof asset.thumbnail === "string" ? asset.thumbnail : undefined,
  };
}

export const useProjectStore = create<ProjectState>()(
  immer((set) => ({
    project: defaultProject,
    playhead: 0,
    seekGeneration: 0,
    isPlaying: false,
    playRate: 1,
    selectedClipId: null,
    selectedTrackId: null,
    selectedClipIds: [],
    zoom: 50,
    activeTool: "select",
    snapEnabled: true,
    targetTrackId: null,
    clipping: null,
    exportRange: null,
    history: [structuredClone(defaultProject)],
    historyIndex: 0,

    setProject: (p) =>
      set((s) => {
        // Loading/replacing the whole project resets the undo baseline so undo
        // can't jump back to a previously-open (or empty) project.
        s.project = snapshot(p);
        s.history = [snapshot(p)];
        s.historyIndex = 0;
      }),

    setPlayhead: (t, source = "user") =>
      set((s) => {
        s.playhead = snapToFrame(t, s.project.fps);
        if (source !== "playback") s.seekGeneration += 1;
      }),

    togglePlay: () =>
      set((s) => {
        s.isPlaying = !s.isPlaying;
        if (s.isPlaying) s.playRate = 1; // normal-speed play
      }),

    setIsPlaying: (v) => set({ isPlaying: v }),

    setPlayRate: (r) => set({ playRate: r }),

    selectClip: (clipId, trackId) =>
      set((s) => {
        s.selectedClipId = clipId;
        s.selectedTrackId = trackId ?? null;
        s.selectedClipIds = clipId ? [clipId] : [];
      }),

    toggleClipSelection: (clipId, trackId) =>
      set((s) => {
        const has = s.selectedClipIds.includes(clipId);
        s.selectedClipIds = has
          ? s.selectedClipIds.filter((i) => i !== clipId)
          : [...s.selectedClipIds, clipId];
        if (!has) {
          s.selectedClipId = clipId;
          s.selectedTrackId = trackId;
        } else if (s.selectedClipId === clipId) {
          const last = s.selectedClipIds[s.selectedClipIds.length - 1] ?? null;
          s.selectedClipId = last;
          s.selectedTrackId = last
            ? s.project.tracks.find((t) => t.clips.some((c) => c.id === last))?.id ?? null
            : null;
        }
      }),

    setZoom: (z) => set({ zoom: Math.max(5, Math.min(200, z)) }),

    setTool: (t) => set({ activeTool: t }),

    toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),

    setTargetTrack: (trackId) => set({ targetTrackId: trackId }),

    toasts: [],
    pushToast: (msg, kind = "info") => set((s) => { s.toasts.push({ id: uuid(), msg, kind }); }),
    dismissToast: (id) => set((s) => { s.toasts = s.toasts.filter((t) => t.id !== id); }),

    thumbs: {},
    setThumbs: (mediaId, paths) => set((s) => { s.thumbs[mediaId] = paths; }),

    addMedia: (assets, autoPlace = true) =>
      set((s) => {
        const cleaned = assets
          .map(sanitizeMediaAsset)
          .filter((a): a is MediaAsset => !!a);
        const existing = new Set(s.project.media.map((m) => m.path));
        const unique = cleaned.filter((a) => !existing.has(a.path));
        if (unique.length === 0) return;

        s.project.media = [...s.project.media, ...unique];

        // When dropping directly onto a track the caller places the clip itself,
        // so skip auto-placement to avoid creating a duplicate clip.
        if (!autoPlace) return;

        // Drop imported media onto the timeline at the PLAYHEAD (like an NLE), not
        // dumped at the end. Route each asset to the track that matches the streams
        // it contains; multiple files lay out back-to-back from the playhead.
        const vtrack = s.project.tracks.find((t) => t.kind === "video");
        const atrack = s.project.tracks.find((t) => t.kind === "audio");

        let t = snapToFrame(s.playhead, s.project.fps);

        for (const a of unique) {
          const dur = (a.durationSec && a.durationSec > 0) ? a.durationSec : 10;

          // A video file goes on the video track and carries its own embedded audio
          // (export extracts it). Only audio-only files go on the audio track — adding
          // both would double the audio on export. Unknown stubs default to video.
          const audioOnly = a.hasAudio && !a.hasVideo;
          const dest = audioOnly ? atrack : vtrack;

          if (dest && !dest.locked) {
            const clip: Clip = {
              id: uuid(),
              media_id: a.id,
              source_in: 0,
              source_out: dur,
              timeline_start: t,
              speed: 1,
              volume: 1,
              muted: false,
              opacity: 1,
              transform: { x: 0, y: 0, scale: 1, rotation: 0 },
              color: { brightness: 0, contrast: 1, saturation: 1, gamma: 1, hue: 0, blur: 0 },
              keyframes: [],
            };
            dest.clips = overwriteInto(current(dest.clips) as Clip[], clip);
          }
          t += dur;
        }
      }),

    addTrack: (kind) =>
      set((s) => {
        const existing = s.project.tracks.filter((t) => t.kind === kind).length;
        const prefix = kind === "video" ? "V" : "A";
        const track: Track = {
          id: uuid(),
          kind,
          name: `${prefix}${existing + 1}`,
          clips: [],
          locked: false,
          muted: false,
          solo: false,
          volume: 1,
        };
        s.project.tracks.push(track);
      }),

    removeTrack: (trackId) =>
      set((s) => {
        s.project.tracks = s.project.tracks.filter((t) => t.id !== trackId);
      }),

    addClipToTrack: (trackId, clip) =>
      set((s) => {
        const track = s.project.tracks.find((t) => t.id === trackId);
        if (track && !track.locked) {
          // dropping onto a track resolves overlaps by overwrite (Premiere-style)
          track.clips = overwriteInto(current(track.clips) as Clip[], clip);
        }
      }),

    placeClip: (trackId, clip, mode) =>
      set((s) => {
        const track = s.project.tracks.find((t) => t.id === trackId);
        if (!track || track.locked) return;
        const plain = current(track.clips) as Clip[];
        track.clips = mode === "insert" ? insertInto(plain, clip) : overwriteInto(plain, clip);
        s.selectedClipId = clip.id;
        s.selectedTrackId = track.id;
        s.selectedClipIds = [clip.id];
      }),

    updateClip: (trackId, clipId, patch) =>
      set((s) => {
        const track = s.project.tracks.find((t) => t.id === trackId);
        if (!track || track.locked) return;
        const clip = track.clips.find((c) => c.id === clipId);
        if (!clip) return;
        Object.assign(clip, patch);
      }),

    removeClip: (trackId, clipId) =>
      set((s) => {
        const track = s.project.tracks.find((t) => t.id === trackId);
        if (!track || track.locked) return;
        track.clips = track.clips.filter((c) => c.id !== clipId);
      }),

    removeClipAndCleanupMedia: (trackId, clipId) =>
      set((s) => {
        const track = s.project.tracks.find((t) => t.id === trackId);
        if (!track || track.locked) return;
        const clip = track.clips.find((c) => c.id === clipId);
        if (!clip) return;
        const mediaId = clip.media_id;
        track.clips = track.clips.filter((c) => c.id !== clipId);
        const stillUsed = s.project.tracks.some((t) => t.clips.some((c) => c.media_id === mediaId));
        if (!stillUsed) {
          s.project.media = s.project.media.filter((m) => m.id !== mediaId);
          delete s.thumbs[mediaId];
        }
        s.selectedClipId = null;
        s.selectedTrackId = null;
        s.selectedClipIds = [];
      }),

    removeMedia: (mediaId) =>
      set((s) => {
        s.project.media = s.project.media.filter((m) => m.id !== mediaId);
        for (const track of s.project.tracks) {
          track.clips = track.clips.filter((c) => c.media_id !== mediaId);
        }
        delete s.thumbs[mediaId];
        s.selectedClipIds = s.selectedClipIds.filter((id) =>
          s.project.tracks.some((t) => t.clips.some((c) => c.id === id))
        );
        if (s.selectedClipId && !s.selectedClipIds.includes(s.selectedClipId)) {
          s.selectedClipId = null;
          s.selectedTrackId = null;
        }
      }),

    deleteSelected: (ripple) =>
      set((s) => {
        const ids = new Set(
          s.selectedClipIds.length
            ? s.selectedClipIds
            : s.selectedClipId
            ? [s.selectedClipId]
            : []
        );
        if (ids.size === 0) return;
        for (const track of s.project.tracks) {
          if (track.locked) continue;
          if (!track.clips.some((c) => ids.has(c.id))) continue;
          const plain = current(track.clips) as Clip[];
          track.clips = ripple
            ? rippleDeleteFrom(plain, ids) // close the gaps (Shift+Delete)
            : plain.filter((c) => !ids.has(c.id)); // lift, leave gap (Delete)
        }
        s.selectedClipId = null;
        s.selectedTrackId = null;
        s.selectedClipIds = [];
      }),

    splitClip: (trackId, clipId, time) =>
      set((s) => {
        const track = s.project.tracks.find((t) => t.id === trackId);
        if (!track || track.locked) return;
        const idx = track.clips.findIndex((c) => c.id === clipId);
        if (idx < 0) return;
        const clip = track.clips[idx];
        const localTime = time - clip.timeline_start;
        if (localTime <= 0 || localTime >= getClipDuration(clip as any)) return;

        const splitPoint = clip.source_in + localTime * clip.speed;

        const newClip: Clip = {
          ...snapshot(clip),
          id: uuid(),
          source_in: splitPoint,
          timeline_start: time,
          fade_in: undefined,
        };

        clip.source_out = splitPoint;
        clip.fade_out = undefined;

        track.clips.splice(idx + 1, 0, newClip);
      }),

    moveClip: (fromTrackId, toTrackId, clipId, newStart) =>
      set((s) => {
        const fromTrack = s.project.tracks.find((t) => t.id === fromTrackId);
        const toTrack = s.project.tracks.find((t) => t.id === toTrackId);
        if (!fromTrack || !toTrack || toTrack.locked || fromTrack.locked) return;
        // Snapshot to plain arrays up front (calling current() after reassigning a
        // draft to a plain value throws).
        const fromPlain = current(fromTrack.clips) as Clip[];
        const moving = fromPlain.find((c) => c.id === clipId);
        if (!moving) return;
        const clip: Clip = { ...moving, timeline_start: Math.max(0, newStart) };
        const remaining = fromPlain.filter((c) => c.id !== clipId);
        if (fromTrackId === toTrackId) {
          toTrack.clips = overwriteInto(remaining, clip);
        } else {
          const toPlain = current(toTrack.clips) as Clip[];
          fromTrack.clips = remaining;
          toTrack.clips = overwriteInto(toPlain, clip);
        }
      }),

    moveSelectedBy: (deltaTime) =>
      set((s) => {
        const ids = new Set(s.selectedClipIds);
        if (ids.size === 0) return;
        // Clamp so no selected clip crosses 0.
        let minStart = Infinity;
        for (const t of s.project.tracks)
          for (const c of t.clips) if (ids.has(c.id)) minStart = Math.min(minStart, c.timeline_start);
        if (!isFinite(minStart)) return;
        const d = Math.max(deltaTime, -minStart);

        for (const track of s.project.tracks) {
          if (track.locked) continue;
          const plain = current(track.clips) as Clip[];
          if (!plain.some((c) => ids.has(c.id))) continue;
          const moving = plain
            .filter((c) => ids.has(c.id))
            .map((c) => ({ ...c, timeline_start: Math.max(0, c.timeline_start + d) }));
          let resolved = plain.filter((c) => !ids.has(c.id));
          for (const mc of moving) resolved = overwriteInto(resolved, mc);
          track.clips = resolved;
        }
      }),

    toggleTrackMute: (trackId) =>
      set((s) => {
        const track = s.project.tracks.find((t) => t.id === trackId);
        if (track) track.muted = !track.muted;
      }),

    toggleTrackSolo: (trackId) =>
      set((s) => {
        const track = s.project.tracks.find((t) => t.id === trackId);
        if (track) track.solo = !track.solo;
      }),

    toggleTrackLock: (trackId) =>
      set((s) => {
        const track = s.project.tracks.find((t) => t.id === trackId);
        if (track) track.locked = !track.locked;
      }),

    setTrackVolume: (trackId, vol) =>
      set((s) => {
        const track = s.project.tracks.find((t) => t.id === trackId);
        if (track) track.volume = vol;
      }),

    startClipping: (mediaId) =>
      set((s) => {
        const asset = s.project.media.find((m) => m.id === mediaId);
        const full = (asset && asset.durationSec > 0) ? asset.durationSec : 10;
        // Open the trimmer on the WHOLE media; the user trims in from both ends.
        s.clipping = { mediaId, sourceIn: 0, sourceOut: full };
        s.isPlaying = false;
      }),

    updateClipping: (patch) =>
      set((s) => {
        if (!s.clipping) return;
        const asset = s.project.media.find((m) => m.id === s.clipping!.mediaId);
        const maxDur = (asset && asset.durationSec > 0) ? asset.durationSec : 1e9;
        const MIN = 0.05;

        if (patch.sourceIn !== undefined) {
          s.clipping.sourceIn = Math.max(0, Math.min(patch.sourceIn, s.clipping.sourceOut - MIN));
        }
        if (patch.sourceOut !== undefined) {
          s.clipping.sourceOut = Math.max(s.clipping.sourceIn + MIN, Math.min(patch.sourceOut, maxDur));
        }
      }),

    commitClipping: (targetTrackId) =>
      set((s) => {
        if (!s.clipping) return;
        const asset = s.project.media.find((m) => m.id === s.clipping!.mediaId);
        if (!asset) { s.clipping = null; return; }

        // Pick a target track. An explicit target wins; otherwise route by the
        // media's stream type so audio-only clips land on an audio track.
        let track = targetTrackId
          ? s.project.tracks.find((t) => t.id === targetTrackId)
          : undefined;
        if (!track) {
          const preferred: "video" | "audio" =
            asset.hasVideo ? "video" : asset.hasAudio ? "audio" : "video";
          track =
            s.project.tracks.find((t) => t.kind === preferred && !t.locked) ??
            s.project.tracks.find((t) => t.kind === preferred) ??
            s.project.tracks.find((t) => !t.locked) ??
            s.project.tracks[0];
        }
        if (track && track.locked) {
          track = s.project.tracks.find((t) => !t.locked) ?? track;
        }
        if (!track || track.locked) { s.clipping = null; return; }

        // Place at the playhead (overwrite), like an NLE — not dumped at the end.
        const start = snapToFrame(s.playhead, s.project.fps);

        const newClip: Clip = {
          id: uuid(),
          media_id: asset.id,
          source_in: s.clipping.sourceIn,
          source_out: s.clipping.sourceOut,
          timeline_start: start,
          speed: 1,
          volume: 1,
          muted: false,
          opacity: 1,
          transform: { x: 0, y: 0, scale: 1, rotation: 0 },
          color: { brightness: 0, contrast: 1, saturation: 1, gamma: 1, hue: 0, blur: 0 },
          keyframes: [],
        };
        track.clips = overwriteInto(current(track.clips) as Clip[], newClip);
        s.clipping = null;
        s.selectedClipId = newClip.id;
        s.selectedTrackId = track.id;
        s.selectedClipIds = [newClip.id];
      }),

    cancelClipping: () =>
      set((s) => { s.clipping = null; }),

    setExportRange: (inPoint, outPoint) =>
      set((s) => {
        s.exportRange = { inPoint: Math.max(0, inPoint), outPoint: Math.max(inPoint + 0.05, outPoint) };
      }),

    setExportIn: (t) =>
      set((s) => {
        const total = s.project.tracks.reduce(
          (max, tr) => tr.clips.reduce((m, c) => Math.max(m, c.timeline_start + (c.source_out - c.source_in) / (c.speed || 1)), max), 0
        );
        if (!s.exportRange) {
          s.exportRange = { inPoint: Math.max(0, t), outPoint: total || 10 };
        } else {
          s.exportRange.inPoint = Math.max(0, Math.min(t, s.exportRange.outPoint - 0.05));
        }
      }),

    setExportOut: (t) =>
      set((s) => {
        if (!s.exportRange) {
          s.exportRange = { inPoint: 0, outPoint: Math.max(0.05, t) };
        } else {
          s.exportRange.outPoint = Math.max(s.exportRange.inPoint + 0.05, t);
        }
      }),

    clearExportRange: () =>
      set((s) => { s.exportRange = null; }),

    pushHistory: () =>
      set((s) => {
        const newHistory = snapshot(s.history).slice(0, s.historyIndex + 1);
        newHistory.push(snapshot(s.project));
        if (newHistory.length > 50) newHistory.shift();
        s.history = newHistory;
        s.historyIndex = newHistory.length - 1;
      }),

    undo: () =>
      set((s) => {
        if (s.historyIndex <= 0) return;
        s.historyIndex -= 1;
        s.project = snapshot(s.history[s.historyIndex]);
      }),

    redo: () =>
      set((s) => {
        if (s.historyIndex >= s.history.length - 1) return;
        s.historyIndex += 1;
        s.project = snapshot(s.history[s.historyIndex]);
      }),
  }))
);

// Dev-only: expose the store for preview-driven verification (no-op in production builds).
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as any).__veditStore = useProjectStore;
}

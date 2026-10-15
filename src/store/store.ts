import { create } from "zustand";
import { current, isDraft, produce, type Draft } from "immer";
import type { Clip, Id, MediaAsset, Project, ProjectSettings, TitleStyle, Track, TrackKind } from "../lib/types";
import { mediaClip, newProject, newTrack, titleClip, MARKER_COLORS, TITLE_PRESETS } from "../lib/defaults";
import {
  clipDuration,
  clipEnd,
  closeAllGaps,
  cutToBeats,
  isUnbounded,
  EPS,
  gapAt,
  closeGap,
  insert,
  keepSourceRanges,
  MIN_CLIP,
  overwrite,
  projectDuration,
  removeRange,
  rippleDelete,
  rippleTrim,
  snapToEdit,
  snapToFrame,
  sortClips,
  speedOf,
  split,
  videoEnd,
} from "../lib/timeline";
import { uid } from "../lib/uid";
import type { Waveform } from "../lib/backend";
import { seconds, stripExtension } from "../lib/format";
import { clipBefore, DEFAULT_DISSOLVE } from "../lib/transitions";
import type { Cue } from "../lib/subtitles";
import { activeLevel, DUCK_DEFAULTS, duckingPoints, speechRegions } from "../lib/envelope";

export type Tool = "select" | "blade";
export type PlaceMode = "overwrite" | "insert";

export interface MediaRuntime {
  thumbs?: string[];
  waveform?: Waveform;
  /** Playable stand-in for formats the webview can't decode. */
  proxy?: string;
  proxyProgress?: number;
  proxyError?: string;
  /** Original file can't be played by the webview. */
  needsProxy?: boolean;
  missing?: boolean;
}

export interface Toast {
  id: Id;
  /** "busy" shows a spinner and stays until dismissed (work in progress). */
  kind: "info" | "success" | "error" | "busy";
  message: string;
  action?: { label: string; run: () => void };
  /** A second, alternative action shown after the first. */
  secondary?: { label: string; run: () => void };
}

export type Dialog =
  | { kind: "export" }
  | { kind: "settings" }
  | { kind: "shortcuts" }
  | { kind: "silence"; clipId: Id }
  | { kind: "source"; mediaId: Id }
  | { kind: "commands" }
  | null;

interface ClipboardEntry {
  clip: Clip;
  /** Index among tracks of the same kind. */
  laneIndex: number;
  kind: TrackKind;
}

interface State {
  project: Project;
  past: Project[];
  future: Project[];
  /** Project as it was before an in-progress drag (live edits). */
  liveBase: Project | null;
  savedProject: Project;
  filePath: string | null;

  playhead: number;
  playing: boolean;
  /** Shuttle rate for J/K/L; 1 = normal. */
  rate: number;
  /** Bumped whenever the user (not playback) moves the playhead. */
  seekNonce: number;

  selection: Id[];
  selectedMedia: Id | null;
  tool: Tool;
  snapping: boolean;
  /** Pixels per second. */
  zoom: number;
  /** The viewer fills the window (F). */
  fullscreen: boolean;
  range: { in: number; out: number } | null;

  runtime: Record<Id, MediaRuntime>;
  toasts: Toast[];
  dialog: Dialog;
  clipboard: ClipboardEntry[];

  // --- document --------------------------------------------------------------
  apply: (recipe: (p: Draft<Project>) => void, opts?: { live?: boolean }) => void;
  commit: () => void;
  cancelLive: () => void;
  undo: () => void;
  redo: () => void;
  loadProject: (p: Project, path: string | null, opts?: { dirty?: boolean }) => void;
  newProject: () => void;
  markSaved: (path: string) => void;

  // --- media -----------------------------------------------------------------
  addMedia: (assets: MediaAsset[]) => MediaAsset[];
  removeMedia: (id: Id) => void;
  /** Drop media no clip uses (one undo step). Returns how many went. */
  removeUnusedMedia: () => number;
  relinkMedia: (id: Id, asset: Omit<MediaAsset, "id">) => void;
  setRuntime: (id: Id, patch: Partial<MediaRuntime>) => void;
  /** Put media on the timeline. Returns the new clip id. */
  placeMedia: (mediaId: Id, opts?: { trackId?: Id; at?: number; mode?: PlaceMode; range?: { in: number; out: number } }) => Id | null;
  placeTitle: (style: Partial<Clip["title"]> | undefined, opts?: { trackId?: Id; at?: number }) => Id | null;
  /** Put subtitle cues on a new captions track on top (shifted by `offset`). Returns the count. */
  addCaptions: (cues: Cue[], offset?: number) => number;

  // --- clips -----------------------------------------------------------------
  updateClip: (id: Id, fn: (c: Draft<Clip>) => void, opts?: { live?: boolean }) => void;
  updateClips: (ids: Id[], fn: (c: Draft<Clip>) => void, opts?: { live?: boolean }) => void;
  /** Live (uncommitted) move of clips, possibly across tracks; overlaps are resolved by settleClips. */
  moveClipsLive: (moves: { id: Id; trackId: Id; start: number }[]) => void;
  /** Live copies of clips at the same place (Alt-drag). Returns old id -> new id. */
  duplicateInPlaceLive: (ids: Id[]) => Map<Id, Id>;
  /** Resolve overlaps after a drag: moved clips overwrite whatever they now cover. */
  settleClips: (ids: Id[]) => void;
  deleteClips: (ids: Id[], ripple: boolean) => void;
  splitAtPlayhead: () => void;
  splitClipAt: (id: Id, time: number) => void;
  /** Split one clip at several timeline times (one undo step). Returns how many cuts were made. */
  splitClipAtTimes: (id: Id, times: number[]) => number;
  /** Hold the frame under the playhead for `seconds`, pushing the rest of that track along. */
  freezeFrame: (seconds?: number) => Id | null;
  /** Q / W: ripple-trim the clips under the playhead so they start / end there. */
  rippleTrimToPlayhead: (side: "head" | "tail") => void;
  /** Move clips by whole frames, overwriting whatever they land on. */
  nudgeClips: (ids: Id[], frames: number) => void;
  /** Trim audio clips that run past the picture so they end with it. Returns how many changed. */
  matchVideoLength: (ids: Id[], fadeOut?: number) => number;
  /** Repeat an audio clip until it reaches the end of the picture. Returns the copies added. */
  loopToVideoLength: (id: Id) => number;
  /**
   * Lower audio-track clips wherever other audible clips have sound (dialogue, voice-over),
   * from their waveforms. Returns how many clips got ducked, or -1 while waveforms load.
   */
  duckUnderVoice: (ids: Id[]) => number;
  clearVolumeChanges: (ids: Id[]) => void;
  /**
   * Set clip volumes so the selected clips sound equally loud (to their median), from their
   * waveforms. Returns how many changed, or -1 while waveforms load.
   */
  evenOutVolume: (ids: Id[]) => number;
  /** Cross-dissolve into a clip from the one before it (0 removes it). */
  setDissolve: (id: Id, seconds: number) => void;
  /** Turn the cut into a clip into a dip to black: fade out, then in. */
  dipToBlack: (id: Id, seconds: number) => void;
  /** T: add a dissolve at the cut nearest the playhead (on every track cut there). Returns how many. */
  dissolveAtPlayhead: () => number;
  duplicateClips: (ids: Id[]) => void;
  copy: () => void;
  cut: () => void;
  paste: () => void;
  detachAudio: (id: Id) => void;
  replaceWithRanges: (id: Id, ranges: [number, number][]) => number;
  closeGapAt: (trackId: Id, time: number) => void;
  closeTrackGaps: (trackId: Id) => void;
  /**
   * Re-cut the run of clips from the first to the last of `ids` (per track) so every cut
   * lands on a marker, packing them end to end; later clips on the track ripple along.
   * `every` gives each clip that many beats. Returns how many clips changed, or -1 when
   * there's no marker after the run's start.
   */
  cutToBeat: (ids: Id[], every?: number) => number;
  /** Set how picture clips (all, or just `ids`) fit the frame. Returns how many changed. */
  fitClips: (fit: Clip["transform"]["fit"], ids?: Id[]) => number;
  /** Fill the bars behind picture clips (all, or `ids`) with their blurred copy, or not. */
  setBackdrop: (backdrop: Clip["backdrop"], ids?: Id[]) => number;

  // --- tracks ----------------------------------------------------------------
  addTrack: (kind: TrackKind) => void;
  removeTrack: (id: Id) => void;
  updateTrack: (id: Id, patch: Partial<Omit<Track, "id" | "clips" | "kind">>) => void;

  // --- markers / range / settings ---------------------------------------------
  addMarker: (time?: number) => void;
  /** Add many markers in one undo step (skipping duplicates). Returns how many were added. */
  addMarkers: (times: number[], color?: string) => number;
  clearMarkers: () => void;
  removeMarker: (id: Id) => void;
  updateMarker: (id: Id, patch: { label?: string; color?: string; time?: number }) => void;
  setRange: (range: { in: number; out: number } | null) => void;
  setRangeIn: (t: number) => void;
  setRangeOut: (t: number) => void;
  /** Remove the In–Out range from every unlocked track, leaving a gap. */
  liftRange: () => void;
  /** Remove the In–Out range from every unlocked track and close it up. */
  extractRange: () => void;
  updateSettings: (patch: Partial<ProjectSettings>) => void;
  renameProject: (name: string) => void;

  // --- transport & view -------------------------------------------------------
  seek: (t: number) => void;
  setPlayheadFromPlayback: (t: number) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  setRate: (r: number) => void;
  select: (ids: Id[]) => void;
  toggleSelect: (id: Id) => void;
  selectAll: () => void;
  setSelectedMedia: (id: Id | null) => void;
  setTool: (t: Tool) => void;
  toggleSnapping: () => void;
  setZoom: (z: number) => void;
  setFullscreen: (on: boolean) => void;

  /** Show a toast; returns its id (for dismissing a progress message early). */
  toast: (message: string, kind?: Toast["kind"], action?: Toast["action"], secondary?: Toast["secondary"]) => Id;
  dismissToast: (id: Id) => void;
  openDialog: (d: Dialog) => void;
}

/** Plain snapshot of a draft value, so pure helpers never see immer proxies. */
function plain<T>(v: T | Draft<T>): T {
  return (isDraft(v) ? current(v as Draft<T>) : v) as T;
}

export const ZOOM_MIN = 2;
export const ZOOM_MAX = 600;
const HISTORY_LIMIT = 200;

const initial = newProject();

export function findClip(p: Project, id: Id): { track: Track; clip: Clip; index: number } | null {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === id);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
}

/** Presets are authored for 1080p; scale their sizes to the project frame. */
function scaledTitleStyle(style: Partial<TitleStyle> | undefined, settings: ProjectSettings): Partial<TitleStyle> {
  const k = Math.min(settings.width, settings.height) / 1080;
  const s = { ...style };
  if (s.fontSize) s.fontSize = Math.round(s.fontSize * k);
  if (s.boxPadding) s.boxPadding = Math.round(s.boxPadding * k);
  if (s.boxRadius) s.boxRadius = Math.round(s.boxRadius * k);
  if (s.strokeWidth) s.strokeWidth = Math.max(1, Math.round(s.strokeWidth * k));
  return s;
}

/** Clips strictly under the playhead: the selected ones if any are, else every unlocked one. */
function clipsUnder(p: Project, t: number, selection: Id[]): Clip[] {
  const sel = new Set(selection);
  const targets = p.tracks.flatMap((tr) => (tr.locked ? [] : tr.clips.filter((c) => t > c.start + EPS && t < clipEnd(c) - EPS)));
  return sel.size && targets.some((c) => sel.has(c.id)) ? targets.filter((c) => sel.has(c.id)) : targets;
}

/** First track of `kind` that is unlocked and has room for [start, start+len). */
function pickTrack(p: Draft<Project> | Project, kind: TrackKind, start: number, len: number, preferred?: Id): Draft<Track> | Track | null {
  const fits = (t: Track) => !t.locked && t.clips.every((c) => clipEnd(c) <= start + EPS || c.start >= start + len - EPS);
  const tracks = p.tracks.filter((t) => t.kind === kind) as Track[];
  const pref = tracks.find((t) => t.id === preferred && !t.locked);
  if (pref) return pref;
  return tracks.find(fits) ?? tracks.find((t) => !t.locked) ?? null;
}

function nextTrackName(p: Project, kind: TrackKind) {
  const prefix = kind === "video" ? "V" : "A";
  let n = p.tracks.filter((t) => t.kind === kind).length + 1;
  while (p.tracks.some((t) => t.name === `${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Insert a new track keeping video tracks before audio tracks. */
function insertTrack(p: Draft<Project>, track: Track) {
  if (track.kind === "video") {
    const lastVideo = p.tracks.map((t) => t.kind).lastIndexOf("video");
    p.tracks.splice(lastVideo + 1, 0, track);
  } else p.tracks.push(track);
}

export const useStore = create<State>()((set, get) => ({
  project: initial,
  past: [],
  future: [],
  liveBase: null,
  savedProject: initial,
  filePath: null,

  playhead: 0,
  playing: false,
  rate: 1,
  seekNonce: 0,

  selection: [],
  selectedMedia: null,
  tool: "select",
  snapping: true,
  zoom: 60,
  fullscreen: false,
  range: null,

  runtime: {},
  toasts: [],
  dialog: null,
  clipboard: [],

  // ---------------------------------------------------------------- document
  apply: (recipe, opts) => {
    const { project, liveBase, past } = get();
    const next = produce(project, recipe);
    if (next === project) return;
    if (opts?.live) {
      set({ project: next, liveBase: liveBase ?? project });
    } else {
      const base = liveBase ?? project;
      set({ project: next, past: [...past, base].slice(-HISTORY_LIMIT), future: [], liveBase: null });
    }
  },

  commit: () => {
    const { liveBase, project, past } = get();
    if (!liveBase) return;
    if (liveBase !== project) set({ past: [...past, liveBase].slice(-HISTORY_LIMIT), future: [], liveBase: null });
    else set({ liveBase: null });
  },

  cancelLive: () => {
    const { liveBase } = get();
    if (liveBase) set({ project: liveBase, liveBase: null });
  },

  undo: () => {
    get().commit();
    const { past, project, future } = get();
    if (!past.length) return;
    const prev = past[past.length - 1];
    set({ project: prev, past: past.slice(0, -1), future: [project, ...future] });
    pruneSelection();
  },

  redo: () => {
    get().commit();
    const { past, project, future } = get();
    if (!future.length) return;
    set({ project: future[0], future: future.slice(1), past: [...past, project] });
    pruneSelection();
  },

  loadProject: (p, path, opts) =>
    set({
      project: p,
      savedProject: opts?.dirty ? newProject() : p,
      filePath: path,
      past: [],
      future: [],
      liveBase: null,
      selection: [],
      selectedMedia: null,
      playhead: 0,
      playing: false,
      range: null,
      seekNonce: get().seekNonce + 1,
    }),

  newProject: () => {
    const p = newProject();
    get().loadProject(p, null);
  },

  markSaved: (path) => set({ savedProject: get().project, filePath: path }),

  // ------------------------------------------------------------------- media
  addMedia: (assets) => {
    const known = new Map(get().project.media.map((m) => [m.path, m]));
    const added: MediaAsset[] = [];
    const result: MediaAsset[] = [];
    for (const a of assets) {
      const existing = known.get(a.path);
      if (existing) result.push(existing);
      else {
        known.set(a.path, a);
        added.push(a);
        result.push(a);
      }
    }
    if (added.length) get().apply((p) => void p.media.push(...added));
    return result;
  },

  removeMedia: (id) => {
    get().apply((p) => {
      p.media = p.media.filter((m) => m.id !== id);
      for (const t of p.tracks) t.clips = t.clips.filter((c) => c.mediaId !== id);
    });
    pruneSelection();
    if (get().selectedMedia === id) set({ selectedMedia: null });
  },

  removeUnusedMedia: () => {
    const used = new Set(get().project.tracks.flatMap((t) => t.clips.map((c) => c.mediaId)));
    const unused = get().project.media.filter((m) => !used.has(m.id));
    if (!unused.length) return 0;
    get().apply((p) => void (p.media = p.media.filter((m) => used.has(m.id))));
    if (unused.some((m) => m.id === get().selectedMedia)) set({ selectedMedia: null });
    return unused.length;
  },

  relinkMedia: (id, asset) => {
    get().apply((p) => {
      const m = p.media.find((x) => x.id === id);
      if (m) Object.assign(m, asset, { id });
    });
    get().setRuntime(id, { missing: false, thumbs: undefined, waveform: undefined, proxy: undefined, needsProxy: undefined });
  },

  setRuntime: (id, patch) => set((s) => ({ runtime: { ...s.runtime, [id]: { ...s.runtime[id], ...patch } } })),

  placeMedia: (mediaId, opts = {}) => {
    const st = get();
    const media = st.project.media.find((m) => m.id === mediaId);
    if (!media) return null;
    const fps = st.project.settings.fps;
    const at = snapToEdit(opts.at ?? st.playhead, st.project.tracks, fps);
    const clip = mediaClip(media, at, opts.range);
    const len = clipDuration(clip);
    const kind: TrackKind = media.kind === "audio" ? "audio" : "video";
    const firstVisual = kind === "video" && !st.project.tracks.some((t) => t.clips.some((c) => c.type === "media" && st.project.media.find((m) => m.id === c.mediaId)?.hasVideo));

    let placedOn: Id | null = null;
    st.apply((p) => {
      let track = (opts.trackId && p.tracks.find((t) => t.id === opts.trackId && t.kind === kind && !t.locked)) || pickTrack(p, kind, at, len);
      if (!track) {
        const t = newTrack(kind, nextTrackName(p as Project, kind));
        insertTrack(p, t);
        track = p.tracks.find((x) => x.id === t.id)!;
      }
      track.clips = (opts.mode === "insert" ? insert : overwrite)(plain(track.clips) as Clip[], clip) as Draft<Clip>[];
      placedOn = track.id;
      // First real footage in an empty project: adopt its size & frame rate.
      if (firstVisual && media.kind === "video" && media.width > 0 && media.height > 0) {
        const s = p.settings;
        if (s.width !== media.width || s.height !== media.height || (media.fps > 0 && Math.abs(s.fps - media.fps) > 0.01)) {
          s.width = media.width % 2 ? media.width + 1 : media.width;
          s.height = media.height % 2 ? media.height + 1 : media.height;
          if (media.fps >= 10 && media.fps <= 120) s.fps = Math.round(media.fps * 1000) / 1000;
          adopted = { w: s.width, h: s.height, fps: s.fps };
        }
      }
    });
    if (adopted) {
      const a = adopted as { w: number; h: number; fps: number };
      get().toast(`Project set to ${a.w}×${a.h} · ${+a.fps.toFixed(3)} fps to match “${stripExtension(media.name)}”.`, "info", {
        label: "Settings",
        run: () => get().openDialog({ kind: "settings" }),
      });
      adopted = null;
    }
    if (placedOn) set({ selection: [clip.id] });
    if (placedOn && kind === "audio") {
      const end = videoEnd(get().project.tracks);
      const over = at + len - end;
      if (end > 0 && at < end - MIN_CLIP && over > 0.5) {
        get().toast(`“${stripExtension(media.name)}” runs ${seconds(over)} past the end of the video.`, "info", {
          label: "Trim to video",
          run: () => get().matchVideoLength([clip.id]),
        });
      }
    }
    return placedOn ? clip.id : null;
  },

  placeTitle: (style, opts = {}) => {
    const st = get();
    const s = scaledTitleStyle(style, st.project.settings);
    const at = snapToEdit(opts.at ?? st.playhead, st.project.tracks, st.project.settings.fps);
    const clip = titleClip(at, s);
    const len = clipDuration(clip);
    let placed = false;
    st.apply((p) => {
      // Titles go on the highest video track that has room, else a new top track.
      const videos = p.tracks.filter((t) => t.kind === "video");
      const free = (t: Track) => !t.locked && t.clips.every((c) => clipEnd(c) <= at + EPS || c.start >= at + len - EPS);
      let track = (opts.trackId && p.tracks.find((t) => t.id === opts.trackId && t.kind === "video" && !t.locked)) || null;
      if (!track) {
        const top = [...videos].reverse().find((t) => free(t as Track));
        // Never put a title *under* footage: only reuse a track above every occupied one.
        const highestUsed = videos.map((t) => t.clips.some((c) => clipEnd(c) > at + EPS && c.start < at + len - EPS)).lastIndexOf(true);
        if (top && videos.indexOf(top) > highestUsed) track = top;
      }
      if (!track) {
        const t = newTrack("video", nextTrackName(p as Project, "video"));
        insertTrack(p, t);
        track = p.tracks.find((x) => x.id === t.id)!;
      }
      track.clips = overwrite(plain(track.clips) as Clip[], clip) as Draft<Clip>[];
      placed = true;
    });
    if (placed) set({ selection: [clip.id] });
    return placed ? clip.id : null;
  },

  addCaptions: (cues, offset = 0) => {
    const usable = cues.filter((c) => c.end - c.start >= MIN_CLIP && c.start + offset >= 0);
    if (!usable.length) return 0;
    const style = scaledTitleStyle(TITLE_PRESETS.find((x) => x.id === "subtitle")?.style, get().project.settings);
    let trackId: Id = "";
    get().apply((p) => {
      const t = newTrack("video", "Captions");
      if (p.tracks.some((x) => x.name === t.name)) t.name = nextTrackName(p as Project, "video");
      // Overlapping cues: the later one wins, as `overwrite` does for any clip.
      t.clips = usable.reduce<Clip[]>((clips, cue) => {
        const c = { ...titleClip(cue.start + offset, { ...style, text: cue.text }, cue.end - cue.start), fadeIn: 0, fadeOut: 0 };
        return overwrite(clips, c);
      }, []);
      insertTrack(p, t);
      trackId = t.id;
    });
    set({ selection: [] });
    return get().project.tracks.find((t) => t.id === trackId)?.clips.length ?? 0;
  },

  // ------------------------------------------------------------------- clips
  updateClip: (id, fn, opts) => get().updateClips([id], fn, opts),

  updateClips: (ids, fn, opts) => {
    const set_ = new Set(ids);
    get().apply((p) => {
      for (const t of p.tracks) {
        if (t.locked) continue;
        for (const c of t.clips) if (set_.has(c.id)) fn(c);
      }
    }, opts);
  },

  moveClipsLive: (moves) => {
    const byId = new Map(moves.map((m) => [m.id, m]));
    get().apply((p) => {
      const pulled: { clip: Clip; dest: Id }[] = [];
      for (const t of p.tracks) {
        if (!t.clips.some((c) => byId.has(c.id))) continue;
        const keep: Draft<Clip>[] = [];
        for (const c of t.clips) {
          const m = byId.get(c.id);
          if (m && m.trackId !== t.id) pulled.push({ clip: { ...plain(c), start: Math.max(0, m.start) }, dest: m.trackId });
          else {
            if (m) c.start = Math.max(0, m.start);
            keep.push(c);
          }
        }
        t.clips = keep;
      }
      for (const { clip, dest } of pulled) {
        const t = p.tracks.find((x) => x.id === dest);
        if (t) t.clips.push(clip as Draft<Clip>);
      }
    }, { live: true });
  },

  duplicateInPlaceLive: (ids) => {
    const map = new Map<Id, Id>();
    const want = new Set(ids);
    get().apply((p) => {
      for (const t of p.tracks) {
        if (t.locked) continue;
        for (const c of plain(t.clips) as Clip[]) {
          if (!want.has(c.id)) continue;
          const copy = { ...structuredClone(c), id: uid() };
          map.set(c.id, copy.id);
          t.clips.push(copy as Draft<Clip>);
        }
      }
    }, { live: true });
    return map;
  },

  settleClips: (ids) => {
    const moving = new Set(ids);
    get().apply((p) => {
      for (const t of p.tracks) {
        const all = plain(t.clips) as Clip[];
        const movers = all.filter((c) => moving.has(c.id));
        if (!movers.length) continue;
        let resolved = all.filter((c) => !moving.has(c.id));
        for (const m of sortClips(movers)) resolved = overwrite(resolved, { ...m, start: Math.max(0, m.start) });
        t.clips = resolved as Draft<Clip>[];
      }
    }, { live: true });
    get().commit();
  },

  deleteClips: (ids, ripple) => {
    if (!ids.length) return;
    const del = new Set(ids);
    get().apply((p) => {
      for (const t of p.tracks) {
        if (t.locked || !t.clips.some((c) => del.has(c.id))) continue;
        const all = plain(t.clips) as Clip[];
        t.clips = (ripple ? rippleDelete(all, del) : all.filter((c) => !del.has(c.id))) as Draft<Clip>[];
      }
    });
    pruneSelection();
  },

  splitAtPlayhead: () => {
    const { playhead, selection, project } = get();
    const sel = new Set(selection);
    const chosen = clipsUnder(project, playhead, selection);
    if (!chosen.length) return;
    const ids = new Set(chosen.map((c) => c.id));
    const newSel: Id[] = [];
    get().apply((p) => {
      for (const t of p.tracks) {
        if (t.locked) continue;
        const out: Clip[] = [];
        for (const c of plain(t.clips) as Clip[]) {
          const parts = ids.has(c.id) ? split(c, playhead) : null;
          if (parts) {
            out.push(...parts);
            if (sel.has(c.id)) newSel.push(parts[1].id);
          } else out.push(c);
        }
        t.clips = out as Draft<Clip>[];
      }
    });
    if (newSel.length) set({ selection: newSel });
  },

  splitClipAt: (id, time) => {
    get().apply((p) => {
      for (const t of p.tracks) {
        if (t.locked) continue;
        const i = t.clips.findIndex((c) => c.id === id);
        if (i < 0) continue;
        const parts = split(plain(t.clips[i]) as Clip, time);
        if (parts) t.clips.splice(i, 1, ...(parts as Draft<Clip>[]));
      }
    });
  },

  splitClipAtTimes: (id, times) => {
    const hit = findClip(get().project, id);
    if (!hit || hit.track.locked) return 0;
    const pieces: Clip[] = [];
    let rest: Clip = hit.clip;
    for (const t of [...times].sort((a, b) => a - b)) {
      // Keep every piece at least a frame-ish long.
      if (t - rest.start < MIN_CLIP || clipEnd(rest) - t < MIN_CLIP) continue;
      const parts = split(rest, t);
      if (!parts) continue;
      pieces.push(parts[0]);
      rest = parts[1];
    }
    if (!pieces.length) return 0;
    pieces.push(rest);
    get().apply((p) => {
      const t = p.tracks.find((x) => x.id === hit.track.id)!;
      const i = t.clips.findIndex((c) => c.id === id);
      if (i >= 0) t.clips.splice(i, 1, ...(pieces as Draft<Clip>[]));
    });
    return pieces.length - 1;
  },

  freezeFrame: (seconds = 2) => {
    const { playhead, selection, project } = get();
    // The selected picture clip under the playhead, else the topmost one.
    const picture = (c: Clip) => c.type === "media" && !c.freeze && project.media.find((m) => m.id === c.mediaId)?.kind === "video";
    const under = clipsUnder(project, playhead, selection).filter(picture);
    const pick = under.find((c) => selection.includes(c.id)) ?? under[under.length - 1];
    if (!pick) return null;
    const hit = findClip(project, pick.id)!;
    const at = snapToFrame(playhead, project.settings.fps);
    const hold: Clip = {
      ...structuredClone(pick),
      id: uid(),
      start: at,
      in: pick.in + (at - pick.start) * speedOf(pick),
      out: pick.in + (at - pick.start) * speedOf(pick) + seconds,
      speed: 1,
      freeze: true,
      muted: true,
      fadeIn: 0,
      fadeOut: 0,
      transitionIn: undefined,
      volumePoints: undefined,
      motion: undefined,
    };
    get().apply((p) => {
      const t = p.tracks.find((x) => x.id === hit.track.id)!;
      t.clips = insert(plain(t.clips) as Clip[], hold) as Draft<Clip>[];
    });
    set({ selection: [hold.id] });
    return hold.id;
  },

  rippleTrimToPlayhead: (side) => {
    const { playhead, selection, project } = get();
    const chosen = clipsUnder(project, playhead, selection);
    if (!chosen.length) return;
    const ids = new Set(chosen.map((c) => c.id));
    get().apply((p) => {
      for (const t of p.tracks) {
        if (t.locked || !t.clips.some((c) => ids.has(c.id))) continue;
        let clips = plain(t.clips) as Clip[];
        for (const c of clips.filter((x) => ids.has(x.id))) clips = rippleTrim(clips, c.id, playhead, side);
        t.clips = clips as Draft<Clip>[];
      }
    });
    // Trimming a head pulls the frame under the playhead back to where the clip starts.
    if (side === "head") get().seek(Math.min(...chosen.map((c) => c.start)));
  },

  nudgeClips: (ids, frames) => {
    const { project } = get();
    const hits = ids.map((id) => findClip(project, id)).filter((h): h is NonNullable<typeof h> => !!h && !h.track.locked);
    if (!hits.length || !frames) return;
    const delta = Math.max(frames / (project.settings.fps || 30), -Math.min(...hits.map((h) => h.clip.start)));
    if (Math.abs(delta) < EPS) return;
    get().moveClipsLive(hits.map((h) => ({ id: h.clip.id, trackId: h.track.id, start: h.clip.start + delta })));
    get().settleClips(hits.map((h) => h.clip.id));
  },

  matchVideoLength: (ids, fadeOut = 0) => {
    const end = videoEnd(get().project.tracks);
    if (end <= 0) return 0;
    const want = new Set(ids);
    let changed = 0;
    get().apply((p) => {
      for (const t of p.tracks) {
        if (t.kind !== "audio" || t.locked) continue;
        for (const c of t.clips) {
          // Only clips that reach the end of the picture; ones ending earlier are left alone.
          if (!want.has(c.id) || c.start >= end - MIN_CLIP || clipEnd(c as Clip) < end - EPS) continue;
          const before = { out: c.out, fadeOut: c.fadeOut };
          c.out = c.in + (end - c.start) * speedOf(c as Clip);
          const d = clipDuration(c as Clip);
          c.fadeOut = Math.min(fadeOut || c.fadeOut, d);
          c.fadeIn = Math.min(c.fadeIn, d - c.fadeOut);
          if (Math.abs(before.out - c.out) > EPS || Math.abs(before.fadeOut - c.fadeOut) > EPS) changed++;
        }
      }
    });
    return changed;
  },

  loopToVideoLength: (id) => {
    const { project } = get();
    const hit = findClip(project, id);
    const end = videoEnd(project.tracks);
    if (!hit || hit.track.kind !== "audio" || hit.track.locked) return 0;
    const c = hit.clip;
    const len = clipDuration(c);
    // Nothing to fill, or so short a loop it would litter the track.
    if (len < MIN_CLIP || clipEnd(c) >= end - MIN_CLIP || (end - clipEnd(c)) / len > 200) return 0;
    const copies: Clip[] = [];
    for (let at = clipEnd(c); at < end - MIN_CLIP; at += len) {
      const piece: Clip = { ...structuredClone(c), id: uid(), start: at, fadeIn: 0, fadeOut: 0 };
      if (at + len > end) piece.out = piece.in + (end - at) * speedOf(c);
      copies.push(piece);
    }
    // A fade-out belongs at the very end, not at every loop seam.
    const last = copies[copies.length - 1];
    last.fadeOut = Math.min(c.fadeOut, clipDuration(last));
    get().apply((p) => {
      const t = p.tracks.find((x) => x.id === hit.track.id)!;
      let clips = (plain(t.clips) as Clip[]).map((x) => (x.id === id ? { ...x, fadeOut: 0 } : x));
      for (const piece of copies) clips = overwrite(clips, piece);
      t.clips = clips as Draft<Clip>[];
    });
    set({ selection: [id, ...copies.map((x) => x.id)] });
    return copies.length;
  },

  duckUnderVoice: (ids) => {
    const { project, runtime } = get();
    const targets = ids.map((id) => findClip(project, id)).filter((h): h is NonNullable<typeof h> => !!h && h.track.kind === "audio" && !h.track.locked);
    if (!targets.length) return 0;
    // Speech is whatever other audible clips play: everything off the music's own tracks.
    const musicTracks = new Set(targets.map((h) => h.track.id));
    const anySolo = project.tracks.some((t) => t.solo);
    const speech: [number, number][] = [];
    for (const t of project.tracks) {
      if (musicTracks.has(t.id) || t.muted || (anySolo && !t.solo)) continue;
      for (const c of t.clips) {
        const m = c.type === "media" ? project.media.find((x) => x.id === c.mediaId) : undefined;
        if (!m?.hasAudio || m.kind === "image" || c.muted || c.volume <= 0) continue;
        const wf = runtime[m.id]?.waveform;
        if (!wf) return -1;
        const first = Math.floor(c.in * wf.rate);
        const levels = wf.peaks.slice(first, Math.ceil(c.out * wf.rate)).map((v) => v / 255);
        const toTimeline = (s: number) => c.start + (Math.min(c.out, Math.max(c.in, s)) - c.in) / speedOf(c);
        for (const [a, b] of speechRegions(levels, wf.rate)) speech.push([toTimeline(first / wf.rate + a), toTimeline(first / wf.rate + b)]);
      }
    }
    const want = new Set(targets.map((h) => h.clip.id));
    let ducked = 0;
    get().apply((p) => {
      for (const t of p.tracks)
        for (const c of t.clips) {
          if (!want.has(c.id)) continue;
          const pts = duckingPoints(speech, [c.start, clipEnd(c as Clip)], (x) => c.in + (x - c.start) * speedOf(c as Clip), DUCK_DEFAULTS);
          if (pts.length) {
            c.volumePoints = pts;
            ducked++;
          } else delete c.volumePoints;
        }
    });
    return ducked;
  },

  clearVolumeChanges: (ids) => get().updateClips(ids, (c) => void delete c.volumePoints),

  evenOutVolume: (ids) => {
    const { project, runtime } = get();
    const levels = new Map<Id, number>();
    for (const id of ids) {
      const hit = findClip(project, id);
      const c = hit?.clip;
      const m = c?.type === "media" ? project.media.find((x) => x.id === c.mediaId) : undefined;
      if (!c || !m?.hasAudio || m.kind === "image" || c.freeze || hit.track.locked) continue;
      const wf = runtime[m.id]?.waveform;
      if (!wf) return -1;
      const level = activeLevel(wf.peaks.slice(Math.floor(c.in * wf.rate), Math.ceil(c.out * wf.rate)).map((v) => v / 255), wf.rate);
      if (level > 0) levels.set(id, level);
    }
    if (levels.size < 2) return 0;
    // Heard loudness = clip volume x source level; meet in the middle.
    const heard = [...levels].map(([id, l]) => findClip(project, id)!.clip.volume * l).sort((a, b) => a - b);
    const target = heard[Math.floor(heard.length / 2)];
    let changed = 0;
    get().apply((p) => {
      for (const t of p.tracks)
        for (const c of t.clips) {
          const l = levels.get(c.id);
          if (l == null) continue;
          const v = Math.round(Math.min(4, Math.max(0.05, target / l)) * 100) / 100;
          if (Math.abs(v - c.volume) > 0.005) {
            c.volume = v;
            changed++;
          }
        }
    });
    return changed;
  },

  setDissolve: (id, seconds) =>
    get().updateClip(id, (c) => {
      if (seconds > 0) c.transitionIn = Math.min(10, seconds);
      else delete c.transitionIn;
    }),

  dipToBlack: (id, seconds) => {
    const hit = findClip(get().project, id);
    const prev = hit && clipBefore(hit.track, hit.clip);
    if (!hit || !prev || hit.track.locked) return;
    const half = Math.min(seconds / 2, clipDuration(prev), clipDuration(hit.clip));
    get().apply((p) => {
      for (const c of p.tracks.find((t) => t.id === hit.track.id)!.clips) {
        if (c.id === prev.id) c.fadeOut = Math.min(half, clipDuration(c as Clip) - c.fadeIn);
        if (c.id === id) {
          c.fadeIn = Math.min(half, clipDuration(c as Clip) - c.fadeOut);
          delete c.transitionIn;
        }
      }
    });
  },

  dissolveAtPlayhead: () => {
    const { project, playhead } = get();
    // Cuts on unlocked tracks within a second of the playhead; take the nearest time.
    const cuts = project.tracks.flatMap((t) => (t.locked ? [] : t.clips.filter((c) => clipBefore(t, c) && Math.abs(c.start - playhead) <= 1)));
    if (!cuts.length) return 0;
    const at = cuts.reduce((best, c) => (Math.abs(c.start - playhead) < Math.abs(best - playhead) ? c.start : best), cuts[0].start);
    const ids = cuts.filter((c) => Math.abs(c.start - at) < 1e-3 && !(c.transitionIn && c.transitionIn > 0)).map((c) => c.id);
    if (ids.length) get().updateClips(ids, (c) => void (c.transitionIn = DEFAULT_DISSOLVE));
    return ids.length;
  },

  duplicateClips: (ids) => {
    const { project } = get();
    const picked = ids.map((id) => findClip(project, id)).filter((x): x is NonNullable<typeof x> => !!x && !x.track.locked);
    if (!picked.length) return;
    const lo = Math.min(...picked.map((x) => x.clip.start));
    const hi = Math.max(...picked.map((x) => clipEnd(x.clip)));
    const shift = hi - lo;
    const created: Id[] = [];
    get().apply((p) => {
      for (const { track, clip } of picked) {
        const t = p.tracks.find((x) => x.id === track.id)!;
        const copy = { ...structuredClone(clip), id: uid(), start: clip.start + shift };
        t.clips = overwrite(plain(t.clips) as Clip[], copy) as Draft<Clip>[];
        created.push(copy.id);
      }
    });
    set({ selection: created });
  },

  copy: () => {
    const { project, selection } = get();
    const entries: ClipboardEntry[] = [];
    for (const id of selection) {
      const hit = findClip(project, id);
      if (!hit) continue;
      const lanes = project.tracks.filter((t) => t.kind === hit.track.kind);
      entries.push({ clip: structuredClone(hit.clip), kind: hit.track.kind, laneIndex: lanes.indexOf(hit.track) });
    }
    if (entries.length) {
      set({ clipboard: entries });
      get().toast(`Copied ${entries.length} clip${entries.length > 1 ? "s" : ""}.`, "info");
    }
  },

  cut: () => {
    const { selection } = get();
    if (!selection.length) return;
    get().copy();
    get().deleteClips(selection, false);
  },

  paste: () => {
    const { clipboard, playhead, project } = get();
    if (!clipboard.length) return;
    const lo = Math.min(...clipboard.map((e) => e.clip.start));
    const at = snapToEdit(playhead, project.tracks, project.settings.fps);
    const created: Id[] = [];
    get().apply((p) => {
      for (const e of clipboard) {
        // Media might have been removed since copying.
        if (e.clip.type === "media" && !p.media.some((m) => m.id === e.clip.mediaId)) continue;
        let lanes = p.tracks.filter((t) => t.kind === e.kind);
        while (lanes.length <= e.laneIndex) {
          insertTrack(p, newTrack(e.kind, nextTrackName(p as Project, e.kind)));
          lanes = p.tracks.filter((t) => t.kind === e.kind);
        }
        const t = lanes[e.laneIndex];
        if (t.locked) continue;
        const c = { ...structuredClone(e.clip), id: uid(), start: at + (e.clip.start - lo) };
        t.clips = overwrite(plain(t.clips) as Clip[], c) as Draft<Clip>[];
        created.push(c.id);
      }
    });
    if (created.length) set({ selection: created });
  },

  detachAudio: (id) => {
    const { project } = get();
    const hit = findClip(project, id);
    if (!hit || hit.track.kind !== "video" || hit.clip.type !== "media") return;
    const media = project.media.find((m) => m.id === hit.clip.mediaId);
    if (!media?.hasAudio) {
      get().toast("This clip has no audio to detach.", "info");
      return;
    }
    if (hit.clip.muted) {
      get().toast("This clip's audio is already detached or muted.", "info");
      return;
    }
    const len = clipDuration(hit.clip);
    const audio: Clip = {
      ...structuredClone(hit.clip),
      id: uid(),
      opacity: 1,
      label: undefined,
    };
    get().apply((p) => {
      let track = pickTrack(p, "audio", audio.start, len) as Draft<Track> | null;
      if (!track || track.clips.some((c) => clipEnd(c) > audio.start + EPS && c.start < audio.start + len - EPS)) {
        const t = newTrack("audio", nextTrackName(p as Project, "audio"));
        insertTrack(p, t);
        track = p.tracks.find((x) => x.id === t.id)!;
      }
      track.clips = overwrite(plain(track.clips) as Clip[], audio) as Draft<Clip>[];
      const v = p.tracks.find((t) => t.id === hit.track.id)!.clips.find((c) => c.id === id)!;
      v.muted = true;
    });
    set({ selection: [audio.id] });
    get().toast("Audio detached to its own track.", "success");
  },

  replaceWithRanges: (id, ranges) => {
    const { project } = get();
    const hit = findClip(project, id);
    if (!hit) return 0;
    const pieces = keepSourceRanges(hit.clip, ranges);
    if (!pieces.length) return 0;
    const before = clipDuration(hit.clip);
    const after = pieces.reduce((s, c) => s + clipDuration(c), 0);
    const removed = before - after;
    const end = clipEnd(hit.clip);
    get().apply((p) => {
      const t = p.tracks.find((x) => x.id === hit.track.id)!;
      const rest = (plain(t.clips) as Clip[]).filter((c) => c.id !== id).map((c) => (c.start >= end - EPS ? { ...c, start: c.start - removed } : c));
      t.clips = sortClips([...rest, ...pieces]) as Draft<Clip>[];
    });
    set({ selection: pieces.map((c) => c.id) });
    return removed;
  },

  closeGapAt: (trackId, time) => {
    const t = get().project.tracks.find((x) => x.id === trackId);
    if (!t || t.locked) return;
    const gap = gapAt(t, time);
    if (!gap) return;
    get().apply((p) => {
      const tr = p.tracks.find((x) => x.id === trackId)!;
      tr.clips = closeGap(plain(tr.clips) as Clip[], gap.end, gap.end - gap.start) as Draft<Clip>[];
    });
  },

  fitClips: (fit, ids) => reframe(ids, (c) => (c.transform.fit === fit ? false : ((c.transform.fit = fit), true))),

  setBackdrop: (backdrop, ids) =>
    reframe(ids, (c) => {
      if (c.backdrop === backdrop) return false;
      if (backdrop) {
        c.backdrop = backdrop;
        c.transform.fit = "contain";
      } else delete c.backdrop;
      return true;
    }),

  closeTrackGaps: (trackId) => {
    const t = get().project.tracks.find((x) => x.id === trackId);
    if (!t || t.locked) return;
    const sorted = sortClips(t.clips);
    const packed = closeAllGaps(sorted);
    if (packed.every((c, i) => c === sorted[i])) return;
    get().apply((p) => void (p.tracks.find((x) => x.id === trackId)!.clips = packed as Draft<Clip>[]));
  },

  cutToBeat: (ids, every) => {
    const { project } = get();
    const fps = project.settings.fps;
    const beats = [...new Set(project.markers.map((m) => snapToFrame(m.time, fps)))];
    const want = new Set(ids);
    const plans: { trackId: Id; clips: Clip[] }[] = [];
    let changed = 0;
    let anyBeats = false;
    for (const t of project.tracks) {
      const sel = t.locked ? [] : t.clips.filter((c) => want.has(c.id));
      if (!sel.length) continue;
      const first = Math.min(...sel.map((c) => c.start));
      const last = Math.max(...sel.map((c) => c.start));
      if (!beats.some((b) => b > first + MIN_CLIP)) continue;
      anyBeats = true;
      const run = sortClips(t.clips.filter((c) => c.start >= first - EPS && c.start <= last + EPS));
      const room = (c: Clip) => {
        const m = project.media.find((x) => x.id === c.mediaId);
        return isUnbounded(c, m) ? Infinity : (m!.duration - c.in) / speedOf(c);
      };
      const laid = cutToBeats(run, beats, room, every);
      const oldEnd = Math.max(...run.map(clipEnd));
      const shift = clipEnd(laid[laid.length - 1]) - oldEnd;
      const inRun = new Set(run.map((c) => c.id));
      const rest = t.clips.filter((c) => !inRun.has(c.id)).map((c) => (c.start >= oldEnd - EPS && Math.abs(shift) > EPS ? { ...c, start: c.start + shift } : c));
      changed += laid.filter((c, i) => Math.abs(c.start - run[i].start) > EPS || Math.abs(c.out - run[i].out) > EPS).length;
      plans.push({ trackId: t.id, clips: sortClips([...rest, ...laid]) });
    }
    if (!anyBeats) return -1;
    if (!changed) return 0;
    get().apply((p) => {
      for (const plan of plans) p.tracks.find((x) => x.id === plan.trackId)!.clips = plan.clips as Draft<Clip>[];
    });
    return changed;
  },

  // ------------------------------------------------------------------ tracks
  addTrack: (kind) => get().apply((p) => insertTrack(p, newTrack(kind, nextTrackName(p as Project, kind)))),

  removeTrack: (id) => {
    const { project } = get();
    const t = project.tracks.find((x) => x.id === id);
    if (!t) return;
    if (project.tracks.filter((x) => x.kind === t.kind).length <= 1) {
      get().toast(`Keep at least one ${t.kind} track.`, "info");
      return;
    }
    get().apply((p) => void (p.tracks = p.tracks.filter((x) => x.id !== id)));
    pruneSelection();
  },

  updateTrack: (id, patch) =>
    get().apply((p) => {
      const t = p.tracks.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
    }),

  // ---------------------------------------------- markers / range / settings
  addMarker: (time) => {
    const t = snapToFrame(time ?? get().playhead, get().project.settings.fps);
    if (get().project.markers.some((m) => Math.abs(m.time - t) < 1e-3)) return;
    get().apply((p) => {
      p.markers.push({ id: uid(), time: t, label: "", color: MARKER_COLORS[p.markers.length % MARKER_COLORS.length] });
      p.markers.sort((a, b) => a.time - b.time);
    });
  },

  addMarkers: (times, color = MARKER_COLORS[1]) => {
    const taken = get().project.markers.map((m) => m.time);
    const fresh = [...new Set(times.map((t) => Math.round(t * 1e4) / 1e4))].filter((t) => t >= 0 && !taken.some((x) => Math.abs(x - t) < 1e-3));
    if (!fresh.length) return 0;
    get().apply((p) => {
      for (const time of fresh) p.markers.push({ id: uid(), time, label: "", color });
      p.markers.sort((a, b) => a.time - b.time);
    });
    return fresh.length;
  },

  clearMarkers: () => {
    if (get().project.markers.length) get().apply((p) => void (p.markers = []));
  },

  removeMarker: (id) => get().apply((p) => void (p.markers = p.markers.filter((m) => m.id !== id))),

  updateMarker: (id, patch) =>
    get().apply((p) => {
      const m = p.markers.find((x) => x.id === id);
      if (m) Object.assign(m, patch);
      p.markers.sort((a, b) => a.time - b.time);
    }),

  setRange: (range) => set({ range: range && range.out - range.in > 1e-3 ? range : null }),

  setRangeIn: (t) => {
    const { range, project } = get();
    const out = range && range.out > t + 1e-3 ? range.out : Math.max(t + 1, projectDuration(project));
    set({ range: { in: Math.max(0, t), out } });
  },

  setRangeOut: (t) => {
    const { range } = get();
    const inP = range && range.in < t - 1e-3 ? range.in : 0;
    if (t <= inP + 1e-3) return;
    set({ range: { in: inP, out: t } });
  },

  liftRange: () => cutRange(false),
  extractRange: () => cutRange(true),

  updateSettings: (patch) => get().apply((p) => void Object.assign(p.settings, patch)),

  renameProject: (name) => get().apply((p) => void (p.name = name.trim() || "Untitled")),

  // -------------------------------------------------------- transport & view
  seek: (t) => set((s) => ({ playhead: Math.max(0, t), seekNonce: s.seekNonce + 1 })),
  setPlayheadFromPlayback: (t) => set({ playhead: Math.max(0, t) }),
  play: () => set({ playing: true }),
  pause: () => set({ playing: false, rate: 1 }),
  togglePlay: () => set((s) => ({ playing: !s.playing, rate: 1 })),
  setRate: (r) => set({ rate: r }),

  select: (ids) => set({ selection: ids }),
  toggleSelect: (id) => set((s) => ({ selection: s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id] })),
  selectAll: () => set((s) => ({ selection: s.project.tracks.flatMap((t) => (t.locked ? [] : t.clips.map((c) => c.id))) })),
  setSelectedMedia: (id) => set({ selectedMedia: id }),
  setTool: (t) => set({ tool: t }),
  toggleSnapping: () => set((s) => ({ snapping: !s.snapping })),
  setZoom: (z) => set({ zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) }),
  setFullscreen: (on) => set({ fullscreen: on }),

  toast: (message, kind = "info", action, secondary) => {
    const t: Toast = { id: uid(), kind, message, action, secondary };
    // A few at a time: older ones make way (work in progress is kept while it runs).
    set((s) => {
      const busy = s.toasts.filter((x) => x.kind === "busy");
      const rest = s.toasts.filter((x) => x.kind !== "busy").slice(-Math.max(0, 2 - busy.length));
      return { toasts: [...s.toasts.filter((x) => busy.includes(x) || rest.includes(x)), t] };
    });
    return t.id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  openDialog: (d) => set({ dialog: d }),
}));

// Set inside placeMedia's recipe, read right after it (immer recipes can't return extra data).
let adopted: { w: number; h: number; fps: number } | null = null;

/** Change picture clips (all, or `ids`) on unlocked video tracks; `fn` says if it changed one. */
function reframe(ids: Id[] | undefined, fn: (c: Draft<Clip>) => boolean): number {
  const { project, apply } = useStore.getState();
  const want = ids && new Set(ids);
  const picture = new Set(project.media.filter((m) => m.hasVideo).map((m) => m.id));
  let n = 0;
  apply((p) => {
    for (const t of p.tracks) {
      if (t.kind !== "video" || t.locked) continue;
      for (const c of t.clips) if (c.type === "media" && picture.has(c.mediaId!) && (!want || want.has(c.id)) && fn(c)) n++;
    }
  });
  return n;
}

/** Lift / extract the In–Out range across every unlocked track (markers follow an extract). */
function cutRange(ripple: boolean) {
  const { range, project, apply } = useStore.getState();
  if (!range) return;
  const { in: a, out: b } = range;
  const touched = (c: Clip) => clipEnd(c) > a + EPS && (ripple || c.start < b - EPS);
  if (!project.tracks.some((t) => !t.locked && t.clips.some(touched))) return;
  apply((p) => {
    for (const t of p.tracks) {
      if (!t.locked && t.clips.some((c) => touched(c as Clip))) t.clips = removeRange(plain(t.clips) as Clip[], a, b, ripple) as Draft<Clip>[];
    }
    if (ripple) {
      p.markers = p.markers.filter((m) => m.time < a - EPS || m.time >= b - EPS);
      for (const m of p.markers) if (m.time >= b - EPS) m.time -= b - a;
    }
  });
  useStore.setState({ range: null });
  useStore.getState().seek(a);
  pruneSelection();
}

function pruneSelection() {
  const { project, selection } = useStore.getState();
  if (!selection.length) return;
  const ids = new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  const next = selection.filter((id) => ids.has(id));
  if (next.length !== selection.length) useStore.setState({ selection: next });
}

/** Non-reactive access for event handlers. */
export const store = () => useStore.getState();

let commitTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Commit pending live edits after a short pause. For inputs that fire a burst of
 * changes with no clear end (colour pickers), so the burst becomes one undo step.
 */
export function commitSoon(delay = 450) {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(() => useStore.getState().commit(), delay);
}

export function isDirty(s: Pick<State, "project" | "savedProject">): boolean {
  return s.project !== s.savedProject;
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __revind: typeof useStore }).__revind = useStore;
}

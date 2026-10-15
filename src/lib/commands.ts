// Every action the editor offers, searchable from the command palette (⌘K): a way to
// find features without knowing which menu or panel they live in.

import { findClip, store } from "../store/store";
import { clipEnd, EPS, videoEnd } from "./timeline";
import { clipBefore } from "./transitions";
import { addBeatMarkers, duckUnderVoice, evenOutVolume, exportCaptions, importViaDialog, splitAtShotChanges, newProject, openProject, saveProject } from "./actions";

export interface Command {
  id: string;
  label: string;
  group: "Edit" | "Timeline" | "Audio" | "Picture" | "Titles" | "View" | "Project";
  shortcut?: string;
  /** Extra words people might search for. */
  keywords?: string;
  /** Why it can't run right now; false when it can. */
  blocked?: () => string | false;
  run: () => void;
}

const selected = () => {
  const s = store();
  return s.selection.map((id) => findClip(s.project, id)).filter((h): h is NonNullable<typeof h> => !!h);
};
const underPlayhead = () => {
  const { project, playhead } = store();
  return project.tracks.some((t) => !t.locked && t.clips.some((c) => playhead > c.start + EPS && playhead < clipEnd(c) - EPS));
};
const shotClip = () => {
  const { project } = store();
  return selected().find((h) => h.track.kind === "video" && !h.clip.freeze && project.media.find((m) => m.id === h.clip.mediaId)?.kind === "video");
};
const need = (ok: boolean, why: string) => (ok ? false : why);
const audioClips = () => selected().filter((h) => h.track.kind === "audio");
const withSound = () => {
  const { project } = store();
  return selected().filter((h) => !!project.media.find((m) => m.id === h.clip.mediaId)?.hasAudio);
};

export function commands(): Command[] {
  const s = store;
  return [
    // ---------------------------------------------------------------- edit
    { id: "split", label: "Split at playhead", group: "Edit", shortcut: "S", keywords: "cut razor blade", blocked: () => need(underPlayhead(), "No clip under the playhead"), run: () => s().splitAtPlayhead() },
    { id: "trim-start", label: "Trim clip start to playhead", group: "Edit", shortcut: "Q", keywords: "ripple trim head", blocked: () => need(underPlayhead(), "No clip under the playhead"), run: () => s().rippleTrimToPlayhead("head") },
    { id: "trim-end", label: "Trim clip end to playhead", group: "Edit", shortcut: "W", keywords: "ripple trim tail", blocked: () => need(underPlayhead(), "No clip under the playhead"), run: () => s().rippleTrimToPlayhead("tail") },
    { id: "delete", label: "Delete selection", group: "Edit", shortcut: "⌫", keywords: "remove", blocked: () => need(s().selection.length > 0, "Nothing selected"), run: () => s().deleteClips(s().selection, false) },
    { id: "ripple-delete", label: "Ripple delete (close the gap)", group: "Edit", shortcut: "⇧⌫", blocked: () => need(s().selection.length > 0, "Nothing selected"), run: () => s().deleteClips(s().selection, true) },
    { id: "duplicate", label: "Duplicate", group: "Edit", shortcut: "⌘D", keywords: "copy clone", blocked: () => need(s().selection.length > 0, "Nothing selected"), run: () => s().duplicateClips(s().selection) },
    { id: "copy", label: "Copy", group: "Edit", shortcut: "⌘C", blocked: () => need(s().selection.length > 0, "Nothing selected"), run: () => s().copy() },
    { id: "paste", label: "Paste at playhead", group: "Edit", shortcut: "⌘V", blocked: () => need(s().clipboard.length > 0, "Clipboard is empty"), run: () => s().paste() },
    { id: "select-all", label: "Select all", group: "Edit", shortcut: "⌘A", run: () => s().selectAll() },
    { id: "undo", label: "Undo", group: "Edit", shortcut: "⌘Z", blocked: () => need(s().past.length > 0, "Nothing to undo"), run: () => s().undo() },
    { id: "redo", label: "Redo", group: "Edit", shortcut: "⇧⌘Z", blocked: () => need(s().future.length > 0, "Nothing to redo"), run: () => s().redo() },
    // ------------------------------------------------------------ timeline
    { id: "dissolve", label: "Cross dissolve at the nearest cut", group: "Timeline", shortcut: "T", keywords: "transition crossfade fade blend", run: () => void (s().dissolveAtPlayhead() || s().toast("No cut without a transition within a second of the playhead.", "info")) },
    {
      id: "dip",
      label: "Dip to black at this cut",
      group: "Timeline",
      keywords: "transition fade black",
      blocked: () => need(selected().some((h) => clipBefore(h.track, h.clip)), "Select the clip after a cut"),
      run: () => {
        const h = selected().find((x) => clipBefore(x.track, x.clip));
        if (h) s().dipToBlack(h.clip.id, 1);
      },
    },
    { id: "freeze", label: "Freeze frame (2s)", group: "Timeline", shortcut: "⌥F", keywords: "hold still pause frame", run: () => void (s().freezeFrame() || s().toast("Put the playhead over a video clip to freeze its frame.", "info")) },
    {
      id: "shots",
      label: "Split at shot changes",
      group: "Timeline",
      keywords: "scene detect cut detection edit shots auto",
      blocked: () => need(!!shotClip(), "Select a video clip"),
      run: () => void splitAtShotChanges(shotClip()!.clip.id),
    },
    { id: "lift", label: "Lift the In–Out range", group: "Timeline", shortcut: ";", keywords: "remove range gap", blocked: () => need(!!s().range, "Set a range with I and O first"), run: () => s().liftRange() },
    { id: "extract", label: "Extract the In–Out range", group: "Timeline", shortcut: "'", keywords: "remove range ripple close", blocked: () => need(!!s().range, "Set a range with I and O first"), run: () => s().extractRange() },
    {
      id: "close-gaps",
      label: "Close all gaps on this track",
      group: "Timeline",
      keywords: "pack ripple",
      blocked: () => need(selected().length > 0, "Select a clip on the track"),
      run: () => s().closeTrackGaps(selected()[0].track.id),
    },
    { id: "marker", label: "Add marker", group: "Timeline", shortcut: "M", keywords: "flag", run: () => s().addMarker() },
    { id: "clear-markers", label: "Clear all markers", group: "Timeline", blocked: () => need(s().project.markers.length > 0, "No markers"), run: () => s().clearMarkers() },
    { id: "snapping", label: "Toggle snapping", group: "Timeline", shortcut: "N", keywords: "magnet magnetic snap", run: () => s().toggleSnapping() },
    // ---------------------------------------------------------------- audio
    {
      id: "match-video",
      label: "Match video length",
      group: "Audio",
      keywords: "music song trim end",
      blocked: () => need(audioClips().length > 0 && videoEnd(s().project.tracks) > 0, "Select music on an audio track (with video on the timeline)"),
      run: () => void (s().matchVideoLength(s().selection) || s().toast("Nothing to trim: no selected audio runs past the end of the video.", "info")),
    },
    {
      id: "loop-video",
      label: "Loop to video length",
      group: "Audio",
      keywords: "music song repeat fill",
      blocked: () => need(audioClips().length === 1, "Select one music clip"),
      run: () => void (s().loopToVideoLength(audioClips()[0].clip.id) || s().toast("This clip is too short to loop, or already reaches the end of the video.", "info")),
    },
    { id: "duck", label: "Duck under voice", group: "Audio", keywords: "lower music speech dialogue ducking", blocked: () => need(audioClips().length > 0, "Select music on an audio track"), run: () => duckUnderVoice(s().selection) },
    { id: "even-out", label: "Even out volume", group: "Audio", keywords: "loudness level normalize match", blocked: () => need(withSound().length > 1, "Select two or more clips with sound"), run: () => evenOutVolume(s().selection) },
    { id: "beats", label: "Add beat markers", group: "Audio", keywords: "music rhythm tempo bpm", blocked: () => need(withSound().length > 0, "Select a clip with sound"), run: () => void addBeatMarkers(withSound()[0].clip.id) },
    { id: "detach", label: "Detach audio", group: "Audio", keywords: "separate unlink", blocked: () => need(selected().some((h) => h.track.kind === "video"), "Select a video clip"), run: () => selected().forEach((h) => h.track.kind === "video" && s().detachAudio(h.clip.id)) },
    // -------------------------------------------------------------- picture
    { id: "fill-all", label: "Fill the frame with every clip", group: "Picture", keywords: "crop cover reframe vertical", run: () => s().fitClips("cover") },
    { id: "fit-all", label: "Fit every clip whole", group: "Picture", keywords: "letterbox contain", run: () => s().fitClips("contain") },
    { id: "blur-all", label: "Blur the bars behind every clip", group: "Picture", keywords: "background backdrop vertical tiktok", run: () => s().setBackdrop("blur") },
    { id: "fullscreen", label: "Full-screen preview", group: "View", shortcut: "F", keywords: "maximize viewer", run: () => s().setFullscreen(!s().fullscreen) },
    // --------------------------------------------------------------- titles
    { id: "title", label: "Add title at playhead", group: "Titles", keywords: "text caption", run: () => s().placeTitle(undefined) },
    {
      id: "export-srt",
      label: "Export titles as captions (.srt)",
      group: "Titles",
      keywords: "subtitles srt youtube",
      blocked: () => need(selected().some((h) => h.clip.type === "title"), "Select a title on the captions track"),
      run: () => void exportCaptions(selected().find((h) => h.clip.type === "title")!.track.id),
    },
    { id: "import-srt", label: "Import captions (.srt / .vtt)…", group: "Titles", keywords: "subtitles", run: () => void importViaDialog() },
    // ---------------------------------------------------------------- project
    { id: "import", label: "Import media…", group: "Project", shortcut: "⌘I", run: () => void importViaDialog() },
    { id: "export", label: "Export…", group: "Project", shortcut: "⌘E", keywords: "render save video mp4", run: () => s().openDialog({ kind: "export" }) },
    { id: "save", label: "Save project", group: "Project", shortcut: "⌘S", run: () => void saveProject() },
    { id: "save-as", label: "Save project as…", group: "Project", shortcut: "⇧⌘S", run: () => void saveProject(true) },
    { id: "open", label: "Open project…", group: "Project", shortcut: "⌘O", run: () => void openProject() },
    { id: "new", label: "New project", group: "Project", shortcut: "⌘N", run: () => void newProject() },
    { id: "settings", label: "Project settings…", group: "Project", keywords: "format size resolution frame rate vertical", run: () => s().openDialog({ kind: "settings" }) },
    { id: "unused", label: "Remove unused media", group: "Project", keywords: "clean library", run: () => void s().removeUnusedMedia() },
    { id: "shortcuts", label: "Keyboard shortcuts", group: "View", shortcut: "?", keywords: "help keys", run: () => s().openDialog({ kind: "shortcuts" }) },
  ];
}

/** Commands matching every word of `query` (label, group, keywords), best matches first. */
export function searchCommands(list: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  const q = query.trim().toLowerCase();
  const rank = (c: Command) => {
    const label = c.label.toLowerCase();
    if (label.startsWith(q)) return 0;
    if (label.split(/\W+/).some((w) => w.startsWith(words[0]))) return 1;
    return 2;
  };
  return list
    .filter((c) => {
      const hay = `${c.label} ${c.group} ${c.keywords ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

// Document-level actions shared by the top bar, menus and keyboard shortcuts.

import type { Clip, Id, MediaAsset } from "./types";
import { backend, confirmDialog, fileUrl, pickMedia, pickProjectToOpen, pickSavePath } from "./backend";
import { migrateProject } from "./migrate";
import { uid } from "./uid";
import { basename, stripExtension } from "./format";
import { clipDuration, snapToFrame, speedOf } from "./timeline";
import { isDirty, store, findClip, useStore } from "../store/store";
import { captionsOf, isSubtitlePath, parseSubtitles, toSrt } from "./subtitles";
import { BEAT_RATE, beatsFromPeaks, detectBeats, mono, toBeatRate, type Beats } from "./beats";
import { forgetProject, rememberProject } from "./recent";
import { adjusted, autoColor, matchColor, type PictureStats } from "./autocolor";

export async function importFiles(paths: string[], place?: { trackId?: Id; at: number }): Promise<MediaAsset[]> {
  // Subtitle files become a captions track; everything else is probed as media.
  const subs = paths.filter(isSubtitlePath);
  for (const path of subs) await importCaptions(path, place?.at ?? 0);
  paths = paths.filter((p) => !isSubtitlePath(p));
  if (!paths.length) return [];
  const s = store();
  let outcomes;
  try {
    outcomes = await backend.probe(paths);
  } catch (e) {
    s.toast(String(e), "error");
    return [];
  }
  const ok = outcomes.filter((o) => o.info);
  const failed = outcomes.filter((o) => !o.info);
  const assets = s.addMedia(ok.map((o) => ({ ...(o.info as Omit<MediaAsset, "id">), id: uid() })));

  if (failed.length) {
    const list = failed.slice(0, 4).map((f) => `• ${basename(f.path)} — ${f.error ?? "unsupported"}`).join("\n");
    s.toast(`Couldn't import ${failed.length} file${failed.length > 1 ? "s" : ""}:\n${list}${failed.length > 4 ? "\n…" : ""}`, "error");
  }
  if (place && assets.length) {
    let at = place.at;
    for (const a of assets) {
      const clipId = store().placeMedia(a.id, { trackId: place.trackId, at });
      const hit = clipId ? findClip(store().project, clipId) : null;
      if (hit) at = hit.clip.start + clipDuration(hit.clip);
    }
  } else if (assets.length && !failed.length) {
    s.toast(`Imported ${assets.length} item${assets.length > 1 ? "s" : ""}. Drag to the timeline or press ⏎ to add at the playhead.`, "success");
  }
  return assets;
}

async function importCaptions(path: string, offset: number) {
  const s = store();
  try {
    const n = s.addCaptions(parseSubtitles(await backend.readText(path)), offset);
    if (n) s.toast(`Added ${n} caption${n > 1 ? "s" : ""} from “${basename(path)}” on a new Captions track. Select one to restyle it.`, "success");
    else s.toast(`No captions found in “${basename(path)}”.`, "error");
  } catch (e) {
    s.toast(`Couldn't read ${basename(path)}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

/** Save the titles on a track as an .srt file (for YouTube, players, translators). */
export async function exportCaptions(trackId: Id) {
  const s = store();
  const track = s.project.tracks.find((t) => t.id === trackId);
  const cues = track ? captionsOf(track) : [];
  if (!cues.length) {
    s.toast("This track has no titles to save as captions.", "info");
    return;
  }
  const path = await pickSavePath("Export captions", `${stripExtension(s.project.name || "Captions")}.srt`, "SubRip subtitles", ["srt"]);
  if (!path) return;
  const out = /\.srt$/i.test(path) ? path : `${path}.srt`;
  try {
    await backend.writeText(out, toSrt(cues));
    s.toast(`Saved ${cues.length} caption${cues.length > 1 ? "s" : ""} to ${basename(out)}.`, "success");
  } catch (e) {
    s.toast(`Couldn't save captions: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

/** Lower music under the speech on other tracks, with feedback. */
export function duckUnderVoice(ids: Id[]) {
  const s = store();
  const n = s.duckUnderVoice(ids);
  if (n < 0) s.toast("Still reading the sound of your clips. Try again in a moment.", "info");
  else if (n === 0) s.toast("No speech or other sound found on the other tracks to duck under.", "info");
  else s.toast(`Lowered ${n > 1 ? `${n} clips` : "the music"} under speech. The line on the clip shows its volume.`, "success");
}

/** Beats in a clip's source range (seconds after its `in`): decoded audio, else the waveform. */
async function clipBeats(c: Clip, media: MediaAsset, path: string): Promise<Beats> {
  try {
    const data = await (await fetch(fileUrl(path))).arrayBuffer();
    let ctx: OfflineAudioContext;
    try {
      ctx = new OfflineAudioContext(1, 1, BEAT_RATE);
    } catch {
      ctx = new OfflineAudioContext(1, 1, 44100); // some WebKits only decode at common rates
    }
    const audio = await ctx.decodeAudioData(data);
    const [a, b] = [Math.floor(c.in * audio.sampleRate), Math.min(audio.length, Math.ceil(c.out * audio.sampleRate))];
    const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i).subarray(a, b));
    const beats = detectBeats(toBeatRate(mono(channels), audio.sampleRate));
    return { ...beats, times: beats.times.map((t) => t + a / audio.sampleRate - c.in) };
  } catch (e) {
    // The webview can't fetch or decode it: fall back on the waveform the app computed.
    const wf = store().runtime[media.id]?.waveform;
    if (!wf) throw e;
    const first = Math.floor(c.in * wf.rate);
    const beats = beatsFromPeaks(wf.peaks.slice(first, Math.ceil(c.out * wf.rate)).map((v) => v / 255), wf.rate);
    return { ...beats, times: beats.times.map((t) => t + first / wf.rate - c.in) };
  }
}

/** Make the selected clips equally loud, with feedback. */
export function evenOutVolume(ids: Id[]) {
  const s = store();
  const n = s.evenOutVolume(ids);
  if (n < 0) s.toast("Still reading the sound of your clips. Try again in a moment.", "info");
  else if (n === 0) s.toast("These clips are already about as loud as each other (or have no sound).", "info");
  else s.toast(`Evened out the volume of ${n} clip${n > 1 ? "s" : ""}. Undo to compare.`, "success");
}

/** Find the beat of a clip's sound and put a marker on every `every`-th beat. */
export async function addBeatMarkers(clipId: Id, every = 1): Promise<number> {
  const s = store();
  const hit = findClip(s.project, clipId);
  const media = hit?.clip.mediaId ? s.project.media.find((m) => m.id === hit.clip.mediaId) : undefined;
  if (!hit || !media?.hasAudio) return 0;
  const rt = s.runtime[media.id];
  const path = rt?.needsProxy ? rt.proxy : media.path;
  if (!path || rt?.missing) {
    s.toast("This clip's sound isn't available yet. Try again once its preview is ready.", "info");
    return 0;
  }
  const busy = s.toast("Listening for the beat…", "busy");
  try {
    const c = hit.clip;
    const { bpm, times } = await clipBeats(c, media, path);
    const at = times.filter((_, i) => i % every === 0).map((t) => c.start + t / speedOf(c)).filter((t) => t >= c.start && t <= c.start + clipDuration(c));
    const n = store().addMarkers(at);
    s.dismissToast(busy);
    if (n) s.toast(`Added ${n} beat marker${n > 1 ? "s" : ""} at ${Math.round(bpm * speedOf(c))} BPM. Clip edges now snap to the beat.`, "success");
    else s.toast("Couldn't find a steady beat in this clip.", "info");
    return n;
  } catch (e) {
    s.dismissToast(busy);
    s.toast(`Couldn't analyse the sound: ${e instanceof Error ? e.message : String(e)}`, "error");
    return 0;
  }
}

/** The music under some clips: the audio-track clip with sound that overlaps them most. */
function musicUnder(ids: Id[]) {
  const { project } = store();
  const picked = ids.map((id) => findClip(project, id)?.clip).filter((c): c is Clip => !!c);
  if (!picked.length) return undefined;
  const a = Math.min(...picked.map((c) => c.start));
  const b = Math.max(...picked.map((c) => c.start + clipDuration(c)));
  let best: { clip: Clip; overlap: number } | undefined;
  for (const t of project.tracks)
    for (const c of t.kind === "audio" ? t.clips : [])
      if (project.media.find((m) => m.id === c.mediaId)?.hasAudio) {
        const overlap = Math.min(b, c.start + clipDuration(c)) - Math.max(a, c.start);
        if (overlap > 0 && overlap > (best?.overlap ?? 0)) best = { clip: c, overlap };
      }
  return best?.clip;
}

/**
 * Re-cut clips so every cut lands on a beat marker (`every` beats per clip, or as many as
 * fit). With no markers yet, finds the beat of the music under them first.
 */
export async function cutToBeat(ids: Id[], every?: number) {
  let n = store().cutToBeat(ids, every);
  if (n < 0) {
    const music = musicUnder(ids);
    if (!music) {
      store().toast("Cutting to the beat needs beat markers. Put music on an audio track under these clips, or add markers (M) where the cuts should go.", "info");
      return;
    }
    if (!(await addBeatMarkers(music.id))) return;
    n = store().cutToBeat(ids, every);
  }
  if (n > 0) store().toast(`${n} clip${n > 1 ? "s" : ""} re-cut to the beat.`, "success", { label: "Undo", run: () => store().undo() });
  else if (n === 0) store().toast("These clips already cut on the beat.", "info");
}

/** Scene-detection sensitivities (ffmpeg scdet scores): lower finds softer changes. */
export const SHOT_THRESHOLD = { normal: 10, more: 5 } as const;

/** Cut a video clip wherever its picture changes shot (one undo step). */
export async function splitAtShotChanges(clipId: Id, threshold: number = SHOT_THRESHOLD.normal) {
  const s = store();
  const hit = findClip(s.project, clipId);
  const media = hit?.clip.mediaId ? s.project.media.find((m) => m.id === hit.clip.mediaId) : undefined;
  if (!hit || !media?.hasVideo || media.kind !== "video" || hit.clip.freeze) return;
  if (s.runtime[media.id]?.missing) {
    s.toast(`“${media.name}” is offline. Relink it to find its shots.`, "info");
    return;
  }
  const busy = s.toast("Looking for shot changes…", "busy");
  try {
    const c = hit.clip;
    const found = await backend.detectScenes(media.path, c.in, c.out, threshold);
    store().dismissToast(busy);
    // The clip may have been trimmed or moved meanwhile: map with its current timing.
    const now = findClip(store().project, clipId)?.clip;
    if (!now) return;
    const fps = store().project.settings.fps;
    const times = found.filter((t) => t > now.in && t < now.out).map((t) => snapToFrame(now.start + (t - now.in) / speedOf(now), fps));
    const n = store().splitClipAtTimes(clipId, times);
    if (n) store().toast(`Split into ${n + 1} shots.`, "success", { label: "Undo", run: () => store().undo() });
    else if (threshold > SHOT_THRESHOLD.more)
      store().toast("No clear shot changes in this clip.", "info", { label: "Look harder", run: () => void splitAtShotChanges(clipId, SHOT_THRESHOLD.more) });
    else store().toast("Still no shot changes: this looks like one continuous shot.", "info");
  } catch (e) {
    store().dismissToast(busy);
    store().toast(`Couldn't analyse the picture: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

/** ⌥⌘V: the copied clip's look onto the selection, with feedback either way. */
export function pasteLook(ids: Id[]) {
  const s = store();
  if (!s.clipboard.length) return void s.toast("Copy a clip first (⌘C), then paste its look onto other clips.", "info");
  const n = s.pasteLook(ids);
  if (n) s.toast(`Pasted the look onto ${n} clip${n > 1 ? "s" : ""}.`, "success", { label: "Undo", run: () => store().undo() });
  else s.toast("Select clips on a video track to paste the look onto.", "info");
}

/** Picture stats of a clip's source range, measured by ffmpeg. */
async function clipStats(c: Clip): Promise<PictureStats | null> {
  const media = store().project.media.find((m) => m.id === c.mediaId);
  if (!media?.hasVideo || store().runtime[media.id]?.missing) return null;
  const still = media.kind === "image" || c.freeze;
  return backend.pictureStats(media.path, c.in, still ? c.in + 0.1 : c.out);
}

/** The picture clips among `ids` (video tracks, real footage). */
function pictureClips(ids: Id[]): Clip[] {
  const { project } = store();
  return ids
    .map((id) => findClip(project, id))
    .filter((h): h is NonNullable<typeof h> => !!h && h.track.kind === "video" && !h.track.locked && h.clip.type === "media" && !!project.media.find((m) => m.id === h.clip.mediaId)?.hasVideo)
    .map((h) => h.clip);
}

/** Measure clips, then give each a new tone in one undo step. */
async function recolour(clips: Clip[], tone: (s: PictureStats, c: Clip) => Partial<Clip["color"]>, busyText: string, done: (n: number) => string) {
  const s = store();
  const busy = s.toast(busyText, "busy");
  try {
    const measured = await Promise.all(clips.map(async (c) => [c.id, await clipStats(c)] as const));
    const tones = new Map(measured.filter((m): m is readonly [Id, PictureStats] => !!m[1]).map(([id, st]) => [id, tone(st, clips.find((c) => c.id === id)!)]));
    store().dismissToast(busy);
    if (!tones.size) return void store().toast("Couldn't read the picture of these clips (offline?).", "info");
    store().apply((p) => {
      for (const t of p.tracks) for (const c of t.clips) if (tones.has(c.id)) Object.assign(c.color, tones.get(c.id));
    });
    store().toast(done(tones.size), "success", { label: "Undo", run: () => store().undo() });
  } catch (e) {
    store().dismissToast(busy);
    store().toast(`Couldn't analyse the picture: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

/** One-click colour: a full tonal range and livelier colour for each clip, from its own picture. */
export async function autoColorClips(ids: Id[]) {
  const clips = pictureClips(ids);
  if (!clips.length) return void store().toast("Select video or photo clips to correct.", "info");
  await recolour(clips, (st) => autoColor(st), "Looking at the picture…", (n) => `Corrected the colour of ${n} clip${n > 1 ? "s" : ""}.`);
}

/** Make clips look like a reference clip (as it's shown, adjustments and look included). */
export async function matchColorTo(ids: Id[], refId: Id) {
  const ref = findClip(store().project, refId)?.clip;
  const clips = pictureClips(ids.filter((id) => id !== refId));
  if (!ref || !clips.length) return;
  const refStats = await clipStats(ref).catch(() => null);
  if (!refStats) return void store().toast("Couldn't read the reference clip's picture.", "info");
  const shown = adjusted(refStats, ref.color);
  await recolour(
    clips,
    (st) => ({ ...matchColor(st, shown), sepia: ref.color.sepia, hue: ref.color.hue }),
    "Matching colour…",
    (n) => `Matched ${n} clip${n > 1 ? "s" : ""} to “${stripExtension(store().project.media.find((m) => m.id === ref.mediaId)?.name ?? "the reference")}”.`,
  );
}

export async function importViaDialog() {
  const paths = await pickMedia();
  if (paths.length) await importFiles(paths);
}

async function confirmDiscard(): Promise<boolean> {
  const s = store();
  if (!isDirty(s) || !hasContent()) return true;
  return confirmDialog(`“${s.project.name}” has unsaved changes. Discard them?`, "Unsaved changes", "Discard", "Cancel");
}

function hasContent() {
  const p = store().project;
  return p.media.length > 0 || p.tracks.some((t) => t.clips.length > 0);
}

export async function newProject() {
  if (!(await confirmDiscard())) return;
  store().newProject();
  backend.autosaveClear().catch(() => {});
}

export async function openProject(path?: string) {
  if (!(await confirmDiscard())) return;
  const file = path ?? (await pickProjectToOpen());
  if (!file) return;
  try {
    const text = await backend.readText(file);
    const project = migrateProject(JSON.parse(text));
    if (!path && project.name === "Untitled") project.name = stripExtension(basename(file));
    store().loadProject(project, file);
    rememberProject(file);
    backend.autosaveClear().catch(() => {});
    await reportMissing();
  } catch (e) {
    if (path) forgetProject(path);
    store().toast(`Couldn't open project: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

async function reportMissing() {
  const media = store().project.media;
  if (!media.length) return;
  const exists = await backend.pathsExist(media.map((m) => m.path)).catch(() => media.map(() => true));
  const missing = media.filter((_, i) => !exists[i]);
  if (missing.length)
    store().toast(
      `${missing.length} media file${missing.length > 1 ? "s are" : " is"} missing (moved or deleted). Right-click ${missing.length > 1 ? "them" : "it"} in the library to relink.`,
      "error",
    );
}

export function serialize(): string {
  return JSON.stringify(store().project, null, 2);
}

export async function saveProject(saveAs = false): Promise<boolean> {
  const s = store();
  let path = s.filePath;
  if (!path || saveAs) {
    path = await pickSavePath("Save project", `${s.project.name || "Untitled"}.vproj`, "Revind project", ["vproj"]);
    if (!path) return false;
    if (!/\.vproj$/i.test(path)) path += ".vproj";
  }
  try {
    // Name the project after its file the first time it is saved.
    if (s.project.name === "Untitled") s.renameProject(stripExtension(basename(path)));
    const snapshot = store().project;
    await backend.writeText(path, JSON.stringify(snapshot, null, 2));
    // Edits made while writing keep the document dirty.
    useStore.setState({ savedProject: snapshot, filePath: path });
    rememberProject(path);
    backend.autosaveClear().catch(() => {});
    s.toast(`Saved ${basename(path)}`, "success");
    return true;
  } catch (e) {
    s.toast(`Save failed: ${String(e)}`, "error");
    return false;
  }
}

/** Offer to restore an autosave left by a crash or force-quit. */
export async function checkRecovery() {
  const auto = await backend.autosaveRead().catch(() => null);
  if (!auto) return;
  let project;
  try {
    const parsed = JSON.parse(auto.contents);
    project = migrateProject(parsed.project ?? parsed);
    if (!project.media.length && !project.tracks.some((t) => t.clips.length)) return;
    const when = new Date(auto.modified).toLocaleString();
    store().toast(`Found unsaved work from ${when}.`, "info", {
      label: "Restore",
      run: () => {
        store().loadProject(project!, typeof parsed.filePath === "string" ? parsed.filePath : null, { dirty: true });
        reportMissing();
      },
    });
  } catch {
    backend.autosaveClear().catch(() => {});
  }
}
